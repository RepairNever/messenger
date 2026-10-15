package documents

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSpreadsheetNativeResourceShapes(t *testing.T) {
	workbookJSON := `{"id":"book","name":"Book","styles":{},"sheetOrder":["one"],"sheets":{"one":{"id":"one","name":"One","rowCount":100,"columnCount":26,"cellData":{}}}}`
	value, err := spreadsheetDecodeJSON([]byte(workbookJSON))
	require.NoError(t, err)
	book := value.(map[string]any)
	native := map[string]string{
		"SHEET_DEFINED_NAME_PLUGIN":               `{"n":{"id":"n","name":"Foo","formulaOrRefString":"One!A1","localSheetId":"one","hidden":false}}`,
		"SHEET_WORKSHEET_PROTECTION_PLUGIN":       `{"book":[{"permissionId":"perm","unitType":2,"unitId":"book","subUnitId":"one","viewState":"othersCanView","editState":"onlyMe"}]}`,
		"SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN": `{"book":[{"permissionId":"perm","unitId":"book","subUnitId":"one"}]}`,
		"SHEET_RANGE_PROTECTION_PLUGIN":           `{"one":[{"id":"rule","permissionId":"perm","unitType":3,"unitId":"book","subUnitId":"one","viewState":"othersCanView","editState":"designedUserCanEdit","ranges":[{"startRow":0,"endRow":1,"startColumn":0,"endColumn":1}]}]}`,
		"SHEET_RANGE_THEME_MODEL_PLUGIN":          `{"rangeThemeStyleRuleMap":{"rule":{"themeName":"Custom","rangeInfo":{"unitId":"book","subUnitId":"one","range":{"startRow":0,"endRow":1,"startColumn":0,"endColumn":1}}}},"rangeThemeStyleMapJson":{"Custom":{"name":"Custom","wholeStyle":{"bg":{"rgb":"#fff"}}}}}`,
		"SHEET_AuthzIoMockService_PLUGIN":         `{"perm":{"objectType":2,"unitID":"book","name":"One","strategies":[{"action":1,"role":0}]}}`,
	}
	resources := []any{}
	for name, data := range native {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, validateSpreadsheetResource(name, data, "book", book["sheets"].(map[string]any)))
		})
		resources = append(resources, map[string]any{"name": name, "data": data})
	}
	book["resources"] = resources
	require.NoError(t, validateSpreadsheetWorkbook(book, "book"))
	for _, scope := range []string{``, `,"localSheetId":null`, `,"localSheetId":"AllDefaultWorkbook"`} {
		require.NoError(t, validateSpreadsheetResource("SHEET_DEFINED_NAME_PLUGIN", `{"n":{"id":"n","name":"Global","formulaOrRefString":"One!A1"`+scope+`}}`, "book", book["sheets"].(map[string]any)))
	}
	for name := range native {
		for _, data := range []string{"null", "[]", "1", `"text"`} {
			require.Error(t, validateSpreadsheetResource(name, data, "book", book["sheets"].(map[string]any)))
		}
	}
	for _, test := range []struct{ name, data string }{
		{"SHEET_WORKSHEET_PROTECTION_PLUGIN", `{"book":{}}`},
		{"SHEET_WORKSHEET_PROTECTION_PLUGIN", `{"foreign":[]}`},
		{"SHEET_DEFINED_NAME_PLUGIN", `{"n":{"id":"different","name":"Foo","formulaOrRefString":"One!A1"}}`},
		{"SHEET_DEFINED_NAME_PLUGIN", `{"n":{"id":"n","name":"Foo","formulaOrRefString":"One!A1","localSheetId":"missing"}}`},
		{"SHEET_RANGE_PROTECTION_PLUGIN", `{"one":[{"id":"rule","permissionId":"perm","unitType":3,"unitId":"book","subUnitId":"one","viewState":"othersCanView","editState":"onlyMe","ranges":[{"startRow":0,"endRow":100,"startColumn":0,"endColumn":1}]}]}`},
		{"SHEET_AuthzIoMockService_PLUGIN", `{"perm":{"objectType":2,"unitID":"book","name":"One","strategies":false}}`},
		{"SHEET_RANGE_THEME_MODEL_PLUGIN", `{"rangeThemeStyleRuleMap":[]}`},
	} {
		require.Error(t, validateSpreadsheetResource(test.name, test.data, "book", book["sheets"].(map[string]any)))
	}
	require.NoError(t, validateSpreadsheetResource("SHEET_RANGE_PROTECTION_PLUGIN", "", "book", book["sheets"].(map[string]any)))
	require.Error(t, validateSpreadsheetResource("SHEET_AuthzIoMockService_PLUGIN", "", "book", book["sheets"].(map[string]any)))
	// Production template includes exactly the supported native defaults.
	var template map[string]any
	require.NoError(t, json.Unmarshal(spreadsheetBlankJSON, &template))
	decoded, err := spreadsheetDecodeJSON(spreadsheetBlankJSON)
	require.NoError(t, err)
	require.NoError(t, validateSpreadsheetWorkbook(decoded.(map[string]any), template["id"].(string)))
}
