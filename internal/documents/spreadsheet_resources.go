package documents

import (
	"errors"
	"fmt"
)

// These shapes follow the six resource hooks registered by pinned Univer OSS
// 1.0.3 Core/Sheets. Resource validity is separate from backend authorization:
// workbook permission metadata never grants access beyond teamspace membership.
func validateSpreadsheetResource(name, data, bookID string, sheets map[string]any) error {
	if data == "" {
		if name == "SHEET_AuthzIoMockService_PLUGIN" {
			return errors.New("authz resource requires a JSON object")
		}
		return nil
	}
	value, err := spreadsheetDecodeJSON([]byte(data))
	if err != nil {
		return err
	}
	object, ok := spreadsheetObject(value)
	if !ok {
		return errors.New("resource data must encode an object")
	}
	sheetExists := func(value any) bool { id, ok := value.(string); return ok && sheets[id] != nil }
	validIdentity := func(rule map[string]any) bool {
		return rule["unitId"] == bookID && sheetExists(rule["subUnitId"]) && spreadsheetIDValue(rule["permissionId"])
	}
	validRule := func(rule map[string]any, unitType int) bool {
		return validIdentity(rule) && spreadsheetEnum(rule["unitType"], unitType, unitType) &&
			(rule["viewState"] == "othersCanView" || rule["viewState"] == "noOneElseCanView") &&
			(rule["editState"] == "designedUserCanEdit" || rule["editState"] == "onlyMe")
	}
	switch name {
	case "SHEET_DEFINED_NAME_PLUGIN":
		for id, value := range object {
			entry, ok := spreadsheetObject(value)
			if !ok || entry["id"] != id || !spreadsheetID(id) || !spreadsheetString(entry["name"], 256) || !spreadsheetString(entry["formulaOrRefString"], 65536) {
				return errors.New("invalid defined name resource")
			}
			// Univer uses this explicit sentinel for workbook-scoped names.
			if sheet := entry["localSheetId"]; sheet != nil && sheet != "AllDefaultWorkbook" && !sheetExists(sheet) {
				return errors.New("defined name references an unknown worksheet")
			}
			for _, key := range []string{"comment", "formulaOrRefStringWithPrefix"} {
				if value := entry[key]; value != nil && !spreadsheetString(value, 65536) {
					return errors.New("invalid defined name text")
				}
			}
			if v := entry["hidden"]; v != nil {
				if _, ok := v.(bool); !ok {
					return errors.New("invalid defined name visibility")
				}
			}
		}
	case "SHEET_WORKSHEET_PROTECTION_PLUGIN", "SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN":
		for unitID, value := range object {
			if unitID != bookID {
				return errors.New("protection resource references another workbook")
			}
			entries, ok := value.([]any)
			if !ok {
				return errors.New("worksheet protection entries must be arrays")
			}
			for _, value := range entries {
				entry, ok := spreadsheetObject(value)
				if !ok || !validIdentity(entry) {
					return errors.New("invalid worksheet protection identity")
				}
				if name == "SHEET_WORKSHEET_PROTECTION_PLUGIN" && !validRule(entry, 2) {
					return errors.New("invalid worksheet protection rule")
				}
				if v := entry["description"]; v != nil && !spreadsheetString(v, 4096) {
					return errors.New("invalid protection description")
				}
			}
		}
	case "SHEET_RANGE_PROTECTION_PLUGIN":
		for sheetID, value := range object {
			if !sheetExists(sheetID) {
				return errors.New("range protection references an unknown worksheet")
			}
			entries, ok := value.([]any)
			if !ok {
				return errors.New("range protection entries must be arrays")
			}
			for _, value := range entries {
				entry, ok := spreadsheetObject(value)
				if !ok || !spreadsheetIDValue(entry["id"]) || entry["subUnitId"] != sheetID || !validRule(entry, 3) {
					return errors.New("invalid range protection rule")
				}
				ranges, ok := entry["ranges"].([]any)
				if !ok || len(ranges) == 0 {
					return errors.New("range protection requires bounded ranges")
				}
				for _, r := range ranges {
					if err := validateSpreadsheetResourceRange(r, sheets[sheetID]); err != nil {
						return err
					}
				}
				if v := entry["description"]; v != nil && !spreadsheetString(v, 4096) {
					return errors.New("invalid protection description")
				}
			}
		}
	case "SHEET_RANGE_THEME_MODEL_PLUGIN":
		if err := spreadsheetKeys(object, "rangeThemeStyleRuleMap rangeThemeStyleMapJson"); err != nil {
			return err
		}
		if value, exists := object["rangeThemeStyleRuleMap"]; exists {
			entries, ok := spreadsheetObject(value)
			if !ok {
				return errors.New("invalid range theme rule map")
			}
			for _, value := range entries {
				entry, ok := spreadsheetObject(value)
				if !ok || !spreadsheetString(entry["themeName"], 256) {
					return errors.New("invalid range theme name")
				}
				info, ok := spreadsheetObject(entry["rangeInfo"])
				if !ok || info["unitId"] != bookID || !sheetExists(info["subUnitId"]) {
					return errors.New("invalid range theme identity")
				}
				if err := validateSpreadsheetResourceRange(info["range"], sheets[info["subUnitId"].(string)]); err != nil {
					return err
				}
			}
		}
		if value, exists := object["rangeThemeStyleMapJson"]; exists {
			entries, ok := spreadsheetObject(value)
			if !ok {
				return errors.New("invalid range theme style map")
			}
			for _, value := range entries {
				entry, ok := spreadsheetObject(value)
				if !ok || !spreadsheetString(entry["name"], 256) {
					return errors.New("invalid range theme style")
				}
				if err := spreadsheetKeys(entry, "name wholeStyle headerRowStyle headerColumnStyle firstRowStyle secondRowStyle lastRowStyle firstColumnStyle secondColumnStyle lastColumnStyle"); err != nil {
					return err
				}
				for key, value := range entry {
					if key != "name" {
						if err := validateSpreadsheetStyle(value, nil, true); err != nil {
							return err
						}
					}
				}
			}
		}
	case "SHEET_AuthzIoMockService_PLUGIN":
		for id, value := range object {
			entry, ok := spreadsheetObject(value)
			if !ok || !spreadsheetID(id) || !spreadsheetEnum(entry["objectType"], 0, 10) || entry["unitID"] != bookID || !spreadsheetString(entry["name"], 256) {
				return errors.New("invalid authz resource entry")
			}
			strategies, ok := entry["strategies"].([]any)
			if !ok {
				return errors.New("authz strategies must be an array")
			}
			for _, value := range strategies {
				strategy, ok := spreadsheetObject(value)
				if !ok || !spreadsheetEnum(strategy["action"], 0, 128) || !spreadsheetEnum(strategy["role"], 0, 2) {
					return errors.New("invalid authz strategy")
				}
			}
			if value := entry["selectRangeObject"]; value != nil {
				scope, ok := spreadsheetObject(value)
				if !ok || scope["unitID"] != bookID || !spreadsheetString(scope["name"], 256) {
					return errors.New("invalid select range authz object")
				}
				if _, ok := scope["collaborators"].([]any); !ok {
					return errors.New("authz collaborators must be an array")
				}
				if _, ok := spreadsheetObject(scope["scope"]); !ok {
					return errors.New("invalid authz scope")
				}
			}
		}
	default:
		return fmt.Errorf("unsupported resource %s", name)
	}
	return nil
}
func spreadsheetIDValue(value any) bool { id, ok := value.(string); return ok && spreadsheetID(id) }
func validateSpreadsheetResourceRange(value, sheetValue any) error {
	rangeData, ok := spreadsheetObject(value)
	sheet, sheetOK := spreadsheetObject(sheetValue)
	if !ok || !sheetOK {
		return errors.New("invalid resource range")
	}
	rows, _ := spreadsheetInt(sheet["rowCount"])
	cols, _ := spreadsheetInt(sheet["columnCount"])
	sr, a := spreadsheetInt(rangeData["startRow"])
	er, b := spreadsheetInt(rangeData["endRow"])
	sc, c := spreadsheetInt(rangeData["startColumn"])
	ec, d := spreadsheetInt(rangeData["endColumn"])
	if !a || !b || !c || !d || sr < 0 || sc < 0 || er < sr || ec < sc || er >= rows || ec >= cols {
		return errors.New("resource range exceeds worksheet dimensions")
	}
	if typ := rangeData["rangeType"]; typ != nil && !spreadsheetEnum(typ, 0, 3) {
		return errors.New("invalid resource range type")
	}
	return nil
}
