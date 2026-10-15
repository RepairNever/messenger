package documents

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSpreadsheetAuthoredSchema(t *testing.T) {
	t.Run("formula source with formatting and literal richtext", func(t *testing.T) {
		raw := []byte(`{"id":"formula","base_revision":0,"structure_epoch":0,"kind":"cells","cells":[{"sheet_id":"sheet-1","row":0,"col":0,"cell":{"f":"=RAND()+A2","ft":0,"fd":1,"s":{"bl":1,"n":{"pattern":"0.00"}}}},{"sheet_id":"sheet-1","row":1,"col":0,"cell":{"p":{"id":"cell","body":{"dataStream":"hello\r\n","textRuns":[{"st":0,"ed":5,"ts":{"bl":1}}],"paragraphs":[{"startIndex":5}]},"documentStyle":{},"drawings":{},"drawingsOrder":[],"footers":{},"headers":{},"tableSource":{}},"t":1,"v":"hello"}}]}`)
		_, _, err := parseSpreadsheetAction(raw)
		require.NoError(t, err)
	})
	for _, test := range []struct{ name, cell string }{
		{"formula cache value", `{"f":"=A1","v":7}`},
		{"formula cache type", `{"f":"=A1","t":2}`},
		{"shared formula", `{"si":"shared"}`},
		{"formula shared id null", `{"f":"=A1","si":null}`},
		{"non-object style", `{"s":[]}`},
		{"style reference in patch", `{"s":"new-style"}`},
		{"invalid style font", `{"s":{"fs":"twelve"}}`},
		{"invalid nested color", `{"s":{"bg":{"rgb":42}}}`},
		{"invalid nested border", `{"s":{"bd":{"t":{"s":"thin"}}}}`},
		{"richtext run out of bounds", `{"p":{"body":{"dataStream":"x\r\n","textRuns":[{"st":0,"ed":99}]}}}`},
		{"invalid number format", `{"s":{"n":{"pattern":false}}}`},
		{"richtext lacks body", `{"p":{"documentStyle":{}}}`},
		{"richtext scalar run", `{"p":{"body":{"dataStream":"x\r\n","textRuns":[1]}}}`},
		{"unexpected field", `{"runtimeValue":1}`},
		{"huge numeric value", `{"v":1e1000000}`},
		{"underflow numeric value", `{"v":1e-1000000}`},
		{"JSONB unsupported NUL", `{"v":"\u0000"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := []byte(`{"id":"bad","base_revision":0,"structure_epoch":0,"kind":"cells","cells":[{"sheet_id":"sheet-1","row":0,"col":0,"cell":` + test.cell + `}]}`)
			_, _, err := parseSpreadsheetAction(raw)
			require.Error(t, err)
		})
	}
	for _, raw := range []string{
		`{"id":"first","id":"second","base_revision":0,"structure_epoch":0,"kind":"cells","cells":[]}`,
		`{"id":"test","base_revision":0,"structure_epoch":0,"kind":"cells","cells":[{"sheet_id":"sheet-1","row":0,"col":0,"cell":null},{"sheet_id":"sheet-1","row":0,"col":0,"cell":null}]}`,
		`{"id":"test","base_revision":0,"structure_epoch":0,"kind":"cells","cells":[{"sheet_id":"sheet-1","row":0,"col":0,"cell":{"__proto__":{}}}]}`,
	} {
		_, _, err := parseSpreadsheetAction([]byte(raw))
		require.Error(t, err)
	}
}

func TestSpreadsheetWorkbookResourcesAndRanges(t *testing.T) {
	blank := `{"id":"book","name":"Book","locale":"enUS","styles":{},"sheetOrder":["one"],"sheets":{"one":{"id":"one","name":"One","rowCount":100,"columnCount":26,"cellData":{}}},"resources":[]}`
	test := func(t *testing.T, mutate func(map[string]any), valid bool) {
		t.Helper()
		value, err := spreadsheetDecodeJSON([]byte(blank))
		require.NoError(t, err)
		book := value.(map[string]any)
		mutate(book)
		err = validateSpreadsheetWorkbook(book, "book")
		if valid {
			require.NoError(t, err)
		} else {
			require.Error(t, err)
		}
	}
	test(t, func(book map[string]any) {
		book["dateSystem"] = "date1904"
		book["resources"] = []any{map[string]any{"name": "SHEET_DEFINED_NAME_PLUGIN", "data": "{}"}}
	}, true)
	test(t, func(book map[string]any) {
		book["resources"] = []any{map[string]any{"name": "SHEET_UNKNOWN_PLUGIN", "data": "{}"}}
	}, false)
	test(t, func(book map[string]any) {
		book["resources"] = []any{map[string]any{"name": "SHEET_DEFINED_NAME_PLUGIN", "data": "{bad"}}
	}, false)
	test(t, func(book map[string]any) {
		book["sheets"].(map[string]any)["one"].(map[string]any)["mergeData"] = []any{map[string]any{"startRow": json.Number("0"), "endRow": json.Number("1"), "startColumn": json.Number("0"), "endColumn": json.Number("1")}}
	}, true)
	test(t, func(book map[string]any) {
		book["sheets"].(map[string]any)["one"].(map[string]any)["mergeData"] = []any{map[string]any{"startRow": json.Number("0"), "endRow": json.Number("100"), "startColumn": json.Number("0"), "endColumn": json.Number("1")}}
	}, false)
	test(t, func(book map[string]any) {
		sheet := book["sheets"].(map[string]any)["one"].(map[string]any)
		sheet["rowCount"] = json.Number("10000")
		sheet["columnCount"] = json.Number("256")
		sheet["cellData"] = map[string]any{"9999": map[string]any{"255": map[string]any{"v": "sparse edge"}}}
	}, true)
	for _, dimensions := range [][2]string{{"10001", "256"}, {"10000", "257"}} {
		test(t, func(book map[string]any) {
			sheet := book["sheets"].(map[string]any)["one"].(map[string]any)
			sheet["rowCount"] = json.Number(dimensions[0])
			sheet["columnCount"] = json.Number(dimensions[1])
		}, false)
	}
}

func TestSpreadsheetHTTPBodyBoundaries(t *testing.T) {
	for _, test := range []struct {
		content, body string
		status        int
	}{
		{"text/plain", "{}", http.StatusUnsupportedMediaType},
		{"application/json", strings.Repeat(" ", SpreadsheetMaxBodyBytes+1), http.StatusRequestEntityTooLarge},
	} {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
		request.Header.Set("Content-Type", test.content)
		response := httptest.NewRecorder()
		_, ok := readSpreadsheetBody(response, request)
		require.False(t, ok)
		require.Equal(t, test.status, response.Code)
	}
}

func TestSpreadsheetLargeMergedRangesStayBounded(t *testing.T) {
	value, err := spreadsheetDecodeJSON([]byte(`{"id":"book","name":"Book","styles":{},"sheetOrder":["one"],"sheets":{"one":{"id":"one","name":"One","rowCount":10000,"columnCount":256,"cellData":{},"mergeData":[{"startRow":0,"endRow":9999,"startColumn":0,"endColumn":255}]}}}`))
	require.NoError(t, err)
	book := value.(map[string]any)
	// This tiny sparse snapshot covers 2.56M coordinates. Validation may
	// allocate one bounded bitmap, but never one hash entry per coordinate.
	allocations := testing.AllocsPerRun(2, func() { err = validateSpreadsheetWorkbook(book, "book") })
	require.NoError(t, err)
	require.Less(t, allocations, float64(128), "merge validation expanded the covered coordinates")
	sheet := book["sheets"].(map[string]any)["one"].(map[string]any)
	sheet["mergeData"] = append(sheet["mergeData"].([]any), map[string]any{"startRow": json.Number("9999"), "endRow": json.Number("9999"), "startColumn": json.Number("255"), "endColumn": json.Number("255")})
	require.ErrorContains(t, validateSpreadsheetWorkbook(book, "book"), "overlapping merge ranges")
}

func TestSpreadsheetMergeWordBoundaries(t *testing.T) {
	value, err := spreadsheetDecodeJSON([]byte(`{"id":"book","name":"Book","styles":{},"sheetOrder":["one"],"sheets":{"one":{"id":"one","name":"One","rowCount":3,"columnCount":256,"cellData":{},"mergeData":[{"startRow":0,"endRow":0,"startColumn":0,"endColumn":63},{"startRow":0,"endRow":0,"startColumn":64,"endColumn":127},{"startRow":0,"endRow":0,"startColumn":128,"endColumn":255},{"startRow":1,"endRow":1,"startColumn":63,"endColumn":64},{"startRow":2,"endRow":2,"startColumn":255,"endColumn":255}]}}}`))
	require.NoError(t, err)
	book := value.(map[string]any)
	require.NoError(t, validateSpreadsheetWorkbook(book, "book"))
	sheet := book["sheets"].(map[string]any)["one"].(map[string]any)
	for _, column := range []string{"63", "64", "255"} {
		ranges := sheet["mergeData"].([]any)
		sheet["mergeData"] = append(ranges, map[string]any{"startRow": json.Number("0"), "endRow": json.Number("0"), "startColumn": json.Number(column), "endColumn": json.Number(column)})
		require.ErrorContains(t, validateSpreadsheetWorkbook(book, "book"), "overlapping merge ranges")
		sheet["mergeData"] = ranges
	}
}
