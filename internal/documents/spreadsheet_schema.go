package documents

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	DocumentKindMarkdown       = "markdown"
	DocumentKindSpreadsheet    = "spreadsheet"
	SpreadsheetMaxBodyBytes    = 2 << 20
	spreadsheetMaxSheets       = 8
	spreadsheetMaxRows         = 10000
	spreadsheetMaxColumns      = 256
	spreadsheetMaxCells        = 20000
	spreadsheetMaxActionCells  = 1000
	spreadsheetMaxSafeRevision = int64(1<<53 - 1)
)

type SpreadsheetCellPatch struct {
	SheetID string          `json:"sheet_id"`
	Row     *int            `json:"row"`
	Col     *int            `json:"col"`
	Cell    json.RawMessage `json:"cell"`
}

type SpreadsheetAction struct {
	ID             string                 `json:"id"`
	BaseRevision   *int64                 `json:"base_revision"`
	StructureEpoch *int64                 `json:"structure_epoch"`
	Kind           string                 `json:"kind"`
	Cells          []SpreadsheetCellPatch `json:"cells,omitempty"`
	Workbook       json.RawMessage        `json:"workbook,omitempty"`
}

type SpreadsheetRestoreRequest struct {
	ID             string `json:"id"`
	BaseRevision   *int64 `json:"base_revision"`
	StructureEpoch *int64 `json:"structure_epoch"`
}

// Parse once with duplicate-key detection and bounds, then use the same
// canonical JSON for validation, persistence and retry identity.
func spreadsheetDecodeJSON(raw []byte) (any, error) {
	if len(raw) > SpreadsheetMaxBodyBytes {
		return nil, errors.New("JSON exceeds spreadsheet size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > 32 {
			return nil, errors.New("JSON nesting exceeds spreadsheet limit")
		}
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{':
				object := map[string]any{}
				for decoder.More() {
					keyToken, err := decoder.Token()
					if err != nil {
						return nil, err
					}
					key, ok := keyToken.(string)
					if !ok || len(key) > 128 || strings.ContainsRune(key, 0) || key == "__proto__" || key == "prototype" || key == "constructor" {
						return nil, errors.New("unsupported JSON key")
					}
					if _, exists := object[key]; exists {
						return nil, errors.New("duplicate JSON key")
					}
					child, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					object[key] = child
					if len(object) > spreadsheetMaxCells {
						return nil, errors.New("JSON object exceeds spreadsheet limit")
					}
				}
				end, err := decoder.Token()
				if err != nil || end != json.Delim('}') {
					return nil, errors.New("invalid JSON object")
				}
				return object, nil
			case '[':
				array := make([]any, 0)
				for decoder.More() {
					child, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					array = append(array, child)
					if len(array) > spreadsheetMaxCells {
						return nil, errors.New("JSON array exceeds spreadsheet limit")
					}
				}
				end, err := decoder.Token()
				if err != nil || end != json.Delim(']') {
					return nil, errors.New("invalid JSON array")
				}
				return array, nil
			default:
				return nil, errors.New("invalid JSON delimiter")
			}
		case string:
			if strings.ContainsRune(value, 0) {
				return nil, errors.New("JSON strings cannot contain NUL")
			}
			if len(value) > 1<<20 {
				return nil, errors.New("JSON string exceeds spreadsheet limit")
			}
			return value, nil
		case json.Number:
			if len(value) > 128 {
				return nil, errors.New("JSON number exceeds spreadsheet precision limit")
			}
			if index := strings.IndexAny(string(value), "eE"); index >= 0 {
				exponent, err := strconv.Atoi(string(value)[index+1:])
				if err != nil || exponent < -324 || exponent > 308 {
					return nil, errors.New("JSON number exceeds spreadsheet exponent limit")
				}
			}
			if _, err := value.Float64(); err != nil {
				return nil, errors.New("JSON number exceeds finite range")
			}
			return token, nil
		case bool, nil:
			return token, nil
		default:
			return nil, errors.New("invalid JSON token")
		}
	}
	value, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, errors.New("request must contain exactly one JSON value")
	}
	return value, nil
}

func spreadsheetID(value string) bool { return strings.TrimSpace(value) != "" && len(value) <= 128 }
func spreadsheetInt(value any) (int, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	v, err := strconv.Atoi(string(n))
	return v, err == nil
}
func spreadsheetNumber(value any) (float64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	v, err := n.Float64()
	return v, err == nil
}
func spreadsheetKeys(object map[string]any, allowed string) error {
	keys := map[string]bool{}
	for _, k := range strings.Fields(allowed) {
		keys[k] = true
	}
	for k := range object {
		if !keys[k] {
			return fmt.Errorf("unsupported spreadsheet field %q", k)
		}
	}
	return nil
}
func spreadsheetObject(value any) (map[string]any, bool) {
	v, ok := value.(map[string]any)
	return v, ok
}
func spreadsheetEnum(value any, min, max int) bool {
	n, ok := spreadsheetInt(value)
	return ok && n >= min && n <= max
}
func spreadsheetString(value any, max int) bool { s, ok := value.(string); return ok && len(s) <= max }

func parseSpreadsheetAction(raw []byte) (SpreadsheetAction, [32]byte, error) {
	var action SpreadsheetAction
	value, err := spreadsheetDecodeJSON(raw)
	if err != nil {
		return action, [32]byte{}, err
	}
	if _, ok := spreadsheetObject(value); !ok {
		return action, [32]byte{}, errors.New("action must be an object")
	}
	canonical, _ := json.Marshal(value)
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&action); err != nil {
		return action, [32]byte{}, err
	}
	if err = validateSpreadsheetPreconditions(action.ID, action.BaseRevision, action.StructureEpoch); err != nil {
		return action, [32]byte{}, err
	}
	switch action.Kind {
	case "cells":
		if len(action.Cells) == 0 || len(action.Cells) > spreadsheetMaxActionCells || action.Workbook != nil {
			return action, [32]byte{}, errors.New("cells action requires 1..1000 patches and no workbook")
		}
		seen := map[spreadsheetCellKey]bool{}
		for _, patch := range action.Cells {
			if !spreadsheetID(patch.SheetID) || patch.Row == nil || patch.Col == nil || *patch.Row < 0 || *patch.Col < 0 || patch.Cell == nil {
				return action, [32]byte{}, errors.New("patch requires sheet_id, nonnegative row/col and cell")
			}
			key := spreadsheetCellKey{patch.SheetID, *patch.Row, *patch.Col}
			if seen[key] {
				return action, [32]byte{}, errors.New("duplicate cell patch")
			}
			seen[key] = true
			cell, err := spreadsheetDecodeJSON(patch.Cell)
			if err != nil {
				return action, [32]byte{}, err
			}
			if err = validateSpreadsheetCell(cell, nil, true); err != nil {
				return action, [32]byte{}, err
			}
		}
	case "structure":
		if len(action.Cells) != 0 || action.Workbook == nil {
			return action, [32]byte{}, errors.New("structure action requires a workbook and no cells")
		}
	default:
		return action, [32]byte{}, errors.New("kind must be cells or structure")
	}
	return action, sha256.Sum256(canonical), nil
}

func validateSpreadsheetPreconditions(id string, base, epoch *int64) error {
	if !spreadsheetID(id) || base == nil || epoch == nil || *base < 0 || *epoch < 0 || *base > spreadsheetMaxSafeRevision || *epoch > spreadsheetMaxSafeRevision {
		return errors.New("id and nonnegative safe-integer base_revision/structure_epoch are required")
	}
	return nil
}

func validateSpreadsheetStyle(value any, styles map[string]any, inlineOnly bool) error {
	if value == nil {
		return nil
	}
	if id, ok := value.(string); ok {
		if inlineOnly {
			return errors.New("cell patches require inline styles")
		}
		if !spreadsheetID(id) {
			return errors.New("invalid style id")
		}
		style, exists := styles[id]
		if !exists || style == nil {
			return errors.New("unknown style reference")
		}
		return nil
	}
	style, ok := spreadsheetObject(value)
	if !ok {
		return errors.New("style must be an object, reference or null")
	}
	if err := spreadsheetKeys(style, "ff eastAsiaFontFamily fs it bl ul bbl st ol bg bd cl va n stf tr td ht vt tb pd"); err != nil {
		return err
	}
	for k, v := range style {
		if v == nil {
			continue
		}
		switch k {
		case "ff", "eastAsiaFontFamily":
			if !spreadsheetString(v, 256) {
				return errors.New("font must be a bounded string")
			}
		case "fs":
			n, ok := spreadsheetNumber(v)
			if !ok || n <= 0 || n > 1000 {
				return errors.New("invalid font size")
			}
		case "it", "bl", "stf":
			if !spreadsheetEnum(v, 0, 1) {
				return errors.New("invalid BooleanNumber style")
			}
		case "va", "td", "ht", "vt", "tb":
			if !spreadsheetEnum(v, 0, 10) {
				return errors.New("invalid style enum")
			}
		default:
			obj, ok := spreadsheetObject(v)
			if !ok {
				return errors.New("style property must be an object")
			}
			if err := validateSpreadsheetStyleObject(k, obj); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateSpreadsheetCell(value any, styles map[string]any, inlineOnly bool) error {
	if value == nil {
		return nil
	}
	cell, ok := spreadsheetObject(value)
	if !ok {
		return errors.New("cell must be an object or null")
	}
	if err := spreadsheetKeys(cell, "p s v t f ft fd ref xf si custom"); err != nil {
		return err
	}
	if formula, exists := cell["f"]; exists && formula != nil {
		if !spreadsheetString(formula, 65536) {
			return errors.New("formula must be a bounded string")
		}
		if formula != "" {
			for _, key := range []string{"v", "t", "si"} {
				if _, exists := cell[key]; exists {
					return errors.New("formula cells cannot contain v/t caches or shared formula ids")
				}
			}
		}
	}
	if cell["si"] != nil {
		return errors.New("shared formulas must be expanded before submission")
	}
	if v := cell["v"]; v != nil {
		switch v.(type) {
		case string:
			if !spreadsheetString(v, 65536) {
				return errors.New("cell text exceeds limit")
			}
		case json.Number, bool:
		default:
			return errors.New("invalid cell value")
		}
	}
	for key, max := range map[string]int{"t": 10, "ft": 3, "fd": 1} {
		if v := cell[key]; v != nil && !spreadsheetEnum(v, 0, max) {
			return fmt.Errorf("invalid cell %s", key)
		}
	}
	for _, key := range []string{"ref", "xf"} {
		if v := cell[key]; v != nil && !spreadsheetString(v, 4096) {
			return fmt.Errorf("invalid cell %s", key)
		}
	}
	if err := validateSpreadsheetStyle(cell["s"], styles, inlineOnly); err != nil {
		return err
	}
	if custom := cell["custom"]; custom != nil {
		if _, ok := spreadsheetObject(custom); !ok {
			return errors.New("cell custom must be an object")
		}
	}
	if p := cell["p"]; p != nil {
		return validateSpreadsheetRichText(p)
	}
	return nil
}

func validateSpreadsheetRichText(value any) error {
	doc, ok := spreadsheetObject(value)
	if !ok {
		return errors.New("rich text must be an object")
	}
	if err := spreadsheetKeys(doc, "id rev locale title body documentStyle styles settings disabled drawings drawingsOrder footers headers tableSource"); err != nil {
		return err
	}
	for _, key := range []string{"drawings", "footers", "headers", "tableSource"} {
		if raw, exists := doc[key]; exists {
			object, ok := spreadsheetObject(raw)
			if !ok || len(object) != 0 {
				return errors.New("embedded rich-text assets are unsupported")
			}
		}
	}
	if raw, exists := doc["drawingsOrder"]; exists {
		array, ok := raw.([]any)
		if !ok || len(array) != 0 {
			return errors.New("embedded rich-text drawings are unsupported")
		}
	}
	for _, key := range []string{"id", "locale", "title"} {
		if v, exists := doc[key]; exists && !spreadsheetString(v, 256) {
			return errors.New("invalid rich-text metadata")
		}
	}
	body, ok := spreadsheetObject(doc["body"])
	if !ok || !spreadsheetString(body["dataStream"], 65536) {
		return errors.New("rich text requires a bounded body.dataStream")
	}
	if err := spreadsheetKeys(body, "dataStream textRuns paragraphs sectionBreaks customRanges customDecorations tables customBlocks"); err != nil {
		return err
	}
	for _, key := range []string{"documentStyle", "styles", "settings"} {
		if v := doc[key]; v != nil {
			if _, ok := spreadsheetObject(v); !ok {
				return errors.New("invalid rich-text configuration")
			}
		}
	}
	length := 0
	for _, r := range body["dataStream"].(string) {
		length += utf16.RuneLen(r)
	}
	for key, value := range body {
		if key == "dataStream" {
			continue
		}
		array, ok := value.([]any)
		if !ok {
			return errors.New("rich-text body entries must be arrays")
		}
		for _, value := range array {
			entry, ok := spreadsheetObject(value)
			if !ok {
				return errors.New("rich-text entries must be objects")
			}
			if key == "textRuns" {
				if err := spreadsheetKeys(entry, "st ed sId ts"); err != nil {
					return err
				}
				start, a := spreadsheetInt(entry["st"])
				end, b := spreadsheetInt(entry["ed"])
				if !a || !b || start < 0 || end < start || end > length {
					return errors.New("rich-text run exceeds dataStream")
				}
				if value := entry["sId"]; value != nil && !spreadsheetString(value, 128) {
					return errors.New("invalid rich-text style reference")
				}
				if raw := entry["ts"]; raw != nil {
					style, ok := spreadsheetObject(raw)
					if !ok {
						return errors.New("invalid rich-text style")
					}
					base := map[string]any{}
					for _, field := range strings.Fields("ff eastAsiaFontFamily fs it bl ul bbl st ol bg bd cl va n") {
						if value, exists := style[field]; exists {
							base[field] = value
						}
					}
					if err := validateSpreadsheetStyle(base, nil, true); err != nil {
						return err
					}
				}
			} else {
				start, ok := spreadsheetInt(entry["startIndex"])
				if !ok || start < 0 || start > length {
					return errors.New("rich-text entry exceeds dataStream")
				}
				if value, exists := entry["endIndex"]; exists {
					end, ok := spreadsheetInt(value)
					if !ok || end < start || end > length {
						return errors.New("rich-text range exceeds dataStream")
					}
				}
			}
		}
	}

	return nil
}

func validateSpreadsheetWorkbook(book map[string]any, expectedID string) error {
	if err := spreadsheetKeys(book, "id name appVersion locale dateSystem styles sheetOrder sheets defaultStyle resources"); err != nil {
		return err
	}
	if book["id"] != expectedID {
		return errors.New("workbook id must remain unchanged")
	}
	for _, key := range []string{"name", "appVersion", "locale"} {
		if v, exists := book[key]; exists && !spreadsheetString(v, 256) {
			return fmt.Errorf("invalid workbook %s", key)
		}
	}
	if v := book["dateSystem"]; v != nil && v != "date1900" && v != "date1904" {
		return errors.New("invalid workbook date system")
	}
	styles, ok := spreadsheetObject(book["styles"])
	if !ok {
		return errors.New("workbook styles must be an object")
	}
	for id, value := range styles {
		if !spreadsheetID(id) {
			return errors.New("invalid style identity")
		}
		if value != nil {
			if _, ok := spreadsheetObject(value); !ok {
				return errors.New("style table entry must be an object or null")
			}
			if err := validateSpreadsheetStyle(value, nil, true); err != nil {
				return err
			}
		}
	}
	if err := validateSpreadsheetStyle(book["defaultStyle"], styles, false); err != nil {
		return err
	}
	sheets, ok := spreadsheetObject(book["sheets"])
	if !ok || len(sheets) == 0 || len(sheets) > spreadsheetMaxSheets {
		return errors.New("workbook requires 1..8 sheets")
	}
	order, ok := book["sheetOrder"].([]any)
	if !ok || len(order) != len(sheets) {
		return errors.New("sheetOrder must list each sheet once")
	}
	seen := map[string]bool{}
	names := map[string]bool{}
	for _, value := range order {
		id, ok := value.(string)
		if !ok || !spreadsheetID(id) || seen[id] || sheets[id] == nil {
			return errors.New("invalid sheet order")
		}
		seen[id] = true
	}
	count := 0
	for id, value := range sheets {
		sheet, ok := spreadsheetObject(value)
		if !ok || sheet["id"] != id {
			return errors.New("sheet identity must match its map key")
		}
		if err := spreadsheetKeys(sheet, "id name tabColor hidden freeze rowCount columnCount zoomRatio scrollTop scrollLeft defaultColumnWidth defaultRowHeight mergeData cellData rowData columnData defaultStyle rowHeader columnHeader showGridlines gridlinesColor rightToLeft"); err != nil {
			return err
		}
		name, ok := sheet["name"].(string)
		if !ok || strings.TrimSpace(name) == "" || len(name) > 128 || names[strings.ToLower(name)] {
			return errors.New("sheet names must be bounded and unique")
		}
		names[strings.ToLower(name)] = true
		rows, rowsOK := spreadsheetInt(sheet["rowCount"])
		cols, colsOK := spreadsheetInt(sheet["columnCount"])
		if !rowsOK || !colsOK || rows < 1 || rows > spreadsheetMaxRows || cols < 1 || cols > spreadsheetMaxColumns {
			return errors.New("sheet dimensions exceed 10000 rows/256 columns")
		}
		for _, key := range []string{"hidden", "showGridlines", "rightToLeft"} {
			max := 1
			if key == "hidden" {
				max = 2
			}
			if v, exists := sheet[key]; exists && !spreadsheetEnum(v, 0, max) {
				return fmt.Errorf("invalid sheet %s", key)
			}
		}
		for _, key := range []string{"tabColor", "gridlinesColor"} {
			if v, exists := sheet[key]; exists && !spreadsheetString(v, 256) {
				return fmt.Errorf("invalid sheet %s", key)
			}
		}
		for _, key := range []string{"zoomRatio", "scrollTop", "scrollLeft", "defaultColumnWidth", "defaultRowHeight"} {
			if v, exists := sheet[key]; exists {
				n, ok := spreadsheetNumber(v)
				if !ok || n < 0 || n > 100000 || (key == "zoomRatio" && (n == 0 || n > 10)) {
					return fmt.Errorf("invalid sheet %s", key)
				}
			}
		}
		if err := validateSpreadsheetStyle(sheet["defaultStyle"], styles, false); err != nil {
			return err
		}
		if raw, exists := sheet["cellData"]; exists {
			matrix, ok := spreadsheetObject(raw)
			if !ok {
				return errors.New("invalid cell matrix")
			}
			for r, rawRow := range matrix {
				row, ok := spreadsheetObject(rawRow)
				if !spreadsheetCoordinate(r, rows) || !ok {
					return errors.New("invalid cell row")
				}
				for c, cell := range row {
					if !spreadsheetCoordinate(c, cols) {
						return errors.New("cell outside sheet dimensions")
					}
					if err := validateSpreadsheetCell(cell, styles, false); err != nil {
						return err
					}
					count++
					if count > spreadsheetMaxCells {
						return errors.New("workbook exceeds 20000 cell entries")
					}
				}
			}
		}
		for key, size := range map[string]int{"rowData": rows, "columnData": cols} {
			if raw, exists := sheet[key]; exists {
				data, ok := spreadsheetObject(raw)
				if !ok {
					return errors.New("invalid dimension metadata")
				}
				for coordinate, value := range data {
					if !spreadsheetCoordinate(coordinate, size) {
						return errors.New("dimension metadata outside sheet")
					}
					if value == nil {
						continue
					}
					entry, ok := spreadsheetObject(value)
					if !ok {
						return errors.New("invalid dimension entry")
					}
					allowed := "w hd s"
					if key == "rowData" {
						allowed = "h ia ah hd s"
					}
					if err := spreadsheetKeys(entry, allowed); err != nil {
						return err
					}
					if err := validateSpreadsheetStyle(entry["s"], styles, false); err != nil {
						return err
					}
					for k, v := range entry {
						if k == "s" || v == nil {
							continue
						}
						if k == "ia" || k == "hd" {
							if !spreadsheetEnum(v, 0, 1) {
								return errors.New("invalid dimension flag")
							}
						} else {
							n, ok := spreadsheetNumber(v)
							if !ok || n < 0 || n > 100000 {
								return errors.New("invalid dimension size")
							}
						}
					}
				}
			}
		}
		if raw, exists := sheet["freeze"]; exists {
			freeze, ok := spreadsheetObject(raw)
			if !ok {
				return errors.New("invalid freeze metadata")
			}
			if err := spreadsheetKeys(freeze, "startRow startColumn xSplit ySplit"); err != nil {
				return err
			}
			for k, v := range freeze {
				n, ok := spreadsheetInt(v)
				size := rows
				if k == "startColumn" || k == "xSplit" {
					size = cols
				}
				if !ok || n < -1 || n > size {
					return errors.New("invalid freeze coordinates")
				}
			}
		}
		for _, key := range []string{"rowHeader", "columnHeader"} {
			if raw, exists := sheet[key]; exists {
				header, ok := spreadsheetObject(raw)
				if !ok {
					return errors.New("invalid header metadata")
				}
				if err := spreadsheetKeys(header, "width height hidden"); err != nil {
					return err
				}
				for k, v := range header {
					if k == "hidden" {
						if !spreadsheetEnum(v, 0, 1) {
							return errors.New("invalid header visibility")
						}
					} else {
						n, ok := spreadsheetNumber(v)
						if !ok || n < 0 || n > 1000 {
							return errors.New("invalid header size")
						}
					}
				}
			}
		}
		if raw, exists := sheet["mergeData"]; exists {
			ranges, ok := raw.([]any)
			if !ok {
				return errors.New("invalid merge ranges")
			}
			// At the maximum sheet dimensions this bitmap is only 320 KiB.
			// A full-sheet merge must not allocate millions of coordinate keys.
			wordsPerRow := (cols + 63) / 64
			var occupied []uint64
			if len(ranges) != 0 {
				occupied = make([]uint64, rows*wordsPerRow)
			}
			for _, value := range ranges {
				r, ok := spreadsheetObject(value)
				if !ok {
					return errors.New("invalid merge range")
				}
				if err := spreadsheetKeys(r, "startRow endRow startColumn endColumn rangeType"); err != nil {
					return err
				}
				sr, a := spreadsheetInt(r["startRow"])
				er, b := spreadsheetInt(r["endRow"])
				sc, c := spreadsheetInt(r["startColumn"])
				ec, d := spreadsheetInt(r["endColumn"])
				if !a || !b || !c || !d || sr < 0 || sc < 0 || er < sr || ec < sc || er >= rows || ec >= cols {
					return errors.New("merge range outside sheet")
				}
				firstWord, lastWord := sc/64, ec/64
				for row := sr; row <= er; row++ {
					for word := firstWord; word <= lastWord; word++ {
						mask := ^uint64(0)
						if word == firstWord {
							mask &= ^uint64(0) << uint(sc%64)
						}
						if word == lastWord {
							mask &= ^uint64(0) >> uint(63-ec%64)
						}
						index := row*wordsPerRow + word
						if occupied[index]&mask != 0 {
							return errors.New("overlapping merge ranges")
						}
						occupied[index] |= mask
					}
				}
			}
		}
	}
	if raw, exists := book["resources"]; exists {
		resources, ok := raw.([]any)
		if !ok || len(resources) > 6 {
			return errors.New("invalid workbook resources")
		}
		names := map[string]bool{}
		supported := map[string]bool{"SHEET_RANGE_THEME_MODEL_PLUGIN": true, "SHEET_WORKSHEET_PROTECTION_PLUGIN": true, "SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN": true, "SHEET_DEFINED_NAME_PLUGIN": true, "SHEET_RANGE_PROTECTION_PLUGIN": true, "SHEET_AuthzIoMockService_PLUGIN": true}
		for _, value := range resources {
			resource, ok := spreadsheetObject(value)
			if !ok {
				return errors.New("invalid workbook resource")
			}
			if err := spreadsheetKeys(resource, "name data"); err != nil {
				return err
			}
			name, ok := resource["name"].(string)
			if !ok || !supported[name] || names[name] {
				return errors.New("unknown or duplicate workbook resource")
			}
			names[name] = true
			data, ok := resource["data"].(string)
			if !ok {
				return errors.New("resource data must be a JSON string")
			}
			if err := validateSpreadsheetResource(name, data, expectedID, sheets); err != nil {
				return fmt.Errorf("invalid %s resource: %w", name, err)
			}
		}
	}

	return nil
}
func spreadsheetCoordinate(key string, size int) bool {
	n, err := strconv.Atoi(key)
	return err == nil && n >= 0 && n < size && strconv.Itoa(n) == key
}
