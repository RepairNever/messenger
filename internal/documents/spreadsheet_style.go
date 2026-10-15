package documents

import "errors"

func validateSpreadsheetColor(value any) error {
	if value == nil {
		return nil
	}
	color, ok := spreadsheetObject(value)
	if !ok {
		return errors.New("color must be an object")
	}
	if err := spreadsheetKeys(color, "rgb th"); err != nil {
		return err
	}
	if value := color["rgb"]; value != nil && !spreadsheetString(value, 256) {
		return errors.New("invalid RGB color")
	}
	if value := color["th"]; value != nil && !spreadsheetEnum(value, 0, 11) {
		return errors.New("invalid theme color")
	}
	return nil
}
func validateSpreadsheetStyleObject(key string, object map[string]any) error {
	switch key {
	case "bg", "cl":
		return validateSpreadsheetColor(object)
	case "n":
		if err := spreadsheetKeys(object, "pattern"); err != nil {
			return err
		}
		if !spreadsheetString(object["pattern"], 4096) {
			return errors.New("invalid number format")
		}
	case "ul", "bbl", "st", "ol":
		if err := spreadsheetKeys(object, "s c cl t"); err != nil {
			return err
		}
		if !spreadsheetEnum(object["s"], 0, 1) {
			return errors.New("invalid text decoration")
		}
		if v := object["c"]; v != nil && !spreadsheetEnum(v, 0, 1) {
			return errors.New("invalid decoration flag")
		}
		if v := object["t"]; v != nil && !spreadsheetEnum(v, 0, 20) {
			return errors.New("invalid decoration type")
		}
		return validateSpreadsheetColor(object["cl"])
	case "bd":
		if err := spreadsheetKeys(object, "t r b l tl_br tl_bc tl_mr bl_tr ml_tr bc_tr"); err != nil {
			return err
		}
		for _, value := range object {
			if value == nil {
				continue
			}
			border, ok := spreadsheetObject(value)
			if !ok {
				return errors.New("invalid border")
			}
			if err := spreadsheetKeys(border, "s cl"); err != nil {
				return err
			}
			if !spreadsheetEnum(border["s"], 0, 13) {
				return errors.New("invalid border style")
			}
			if err := validateSpreadsheetColor(border["cl"]); err != nil {
				return err
			}
		}
	case "tr":
		if err := spreadsheetKeys(object, "a v"); err != nil {
			return err
		}
		angle, ok := spreadsheetNumber(object["a"])
		if !ok || angle < -360 || angle > 360 {
			return errors.New("invalid text rotation")
		}
		if v := object["v"]; v != nil && !spreadsheetEnum(v, 0, 1) {
			return errors.New("invalid vertical text flag")
		}
	case "pd":
		if err := spreadsheetKeys(object, "t r b l"); err != nil {
			return err
		}
		for _, value := range object {
			n, ok := spreadsheetNumber(value)
			if !ok || n < 0 || n > 1000 {
				return errors.New("invalid padding")
			}
		}
	}
	return nil
}
