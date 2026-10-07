package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"msgnr/internal/gen/queries"
	"msgnr/internal/tasks"
)

type botTaskFieldResolver struct {
	svc         *Service
	users       map[uuid.UUID]bool
	enums       map[uuid.UUID][]queries.ListBotCurrentEnumItemsRow
	enumMatches map[botTaskEnumKey][]queries.ListBotCurrentEnumItemsRow
}

type botTaskEnumKey struct {
	dictionaryID uuid.UUID
	value        string
}

func (s *Service) resolveBotTaskFields(ctx context.Context, defs []tasks.FieldRow, entries []taskFieldWrite) (map[uuid.UUID]*tasks.FieldValueInput, error) {
	byCode := make(map[string]tasks.FieldRow, len(defs))
	candidates := make([]string, 0, len(defs))
	for _, def := range defs {
		byCode[def.Code] = def
		candidates = append(candidates, def.Code)
	}
	resolved := make(map[uuid.UUID]*tasks.FieldValueInput, len(entries))
	resolver := botTaskFieldResolver{svc: s, enums: make(map[uuid.UUID][]queries.ListBotCurrentEnumItemsRow)}
	for _, entry := range entries {
		def, ok := byCode[entry.Code]
		if !ok {
			return nil, fmt.Errorf("%w: unknown field %q; valid fields: %s", tasks.ErrBadRequest, entry.Code, taskCandidates(candidates))
		}
		if _, duplicate := resolved[def.ID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate field %s", tasks.ErrBadRequest, entry.Code)
		}
		value, err := resolver.convert(ctx, def, entry.Value)
		if err != nil {
			return nil, err
		}
		resolved[def.ID] = value
	}
	return resolved, nil
}

func (v *botTaskFieldResolver) convert(ctx context.Context, def tasks.FieldRow, raw json.RawMessage) (*tasks.FieldValueInput, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	value := tasks.FieldValueInput{FieldDefinitionID: def.ID}
	switch def.Type {
	case "text", "enum", "user", "date", "datetime":
		text, err := botTaskFieldString(raw, def.Code)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid payload for %s field %q: expected string", tasks.ErrBadRequest, def.Type, def.Code)
		}
		switch def.Type {
		case "text":
			value.ValueText = &text
		case "enum":
			item, err := v.enumItem(ctx, def, text)
			if err != nil {
				return nil, err
			}
			version := int32(item.CurrentVersion)
			value.ValueText = &item.ValueCode
			value.EnumDictionaryID, value.EnumVersion = &item.DictionaryID, &version
		case "user":
			id, err := v.userID(ctx, text)
			if err != nil {
				return nil, err
			}
			value.ValueUserID = &id
		case "date":
			date, err := time.Parse("2006-01-02", text)
			if err != nil || date.Year() < 1 {
				return nil, fmt.Errorf("%w: field %q requires a real date in YYYY-MM-DD format", tasks.ErrBadRequest, def.Code)
			}
			value.ValueDate = &text
		case "datetime":
			datetime, err := time.Parse(time.RFC3339, text)
			if err != nil || datetime.Year() < 1 || !botTaskRFC3339.MatchString(text) {
				return nil, fmt.Errorf("%w: field %q requires an RFC3339 datetime", tasks.ErrBadRequest, def.Code)
			}
			value.ValueDatetime = &datetime
		}
	case "number":
		number := string(bytes.TrimSpace(raw))
		if strings.HasPrefix(number, "\"") {
			var err error
			number, err = botTaskFieldString(raw, def.Code)
			if err != nil {
				return nil, err
			}
		}
		number, err := normalizeBotTaskNumber(number)
		if err != nil {
			return nil, fmt.Errorf("%w: field %q requires a number or numeric string exactly representable in numeric(20,6)", tasks.ErrBadRequest, def.Code)
		}
		value.ValueNumber = &number
	case "users", "multi_enum":
		var entries []json.RawMessage
		if err := json.Unmarshal(raw, &entries); err != nil {
			return nil, fmt.Errorf("%w: field %q requires an array of strings", tasks.ErrBadRequest, def.Code)
		}
		if len(entries) == 0 {
			return nil, nil
		}
		codes := make([]string, 0, len(entries))
		seen := make(map[string]bool, len(entries))
		for _, entry := range entries {
			text, err := botTaskFieldString(entry, def.Code)
			if err != nil {
				return nil, fmt.Errorf("%w: field %q requires an array of strings", tasks.ErrBadRequest, def.Code)
			}
			var canonical string
			if def.Type == "users" {
				id, err := v.userID(ctx, text)
				if err != nil {
					return nil, err
				}
				canonical = id.String()
				if seen[canonical] {
					return nil, fmt.Errorf("%w: duplicate user %q in field %q", tasks.ErrBadRequest, canonical, def.Code)
				}
			} else {
				item, err := v.enumItem(ctx, def, text)
				if err != nil {
					return nil, err
				}
				canonical = item.ValueCode
				if seen[canonical] {
					return nil, fmt.Errorf("%w: duplicate value %q in field %q", tasks.ErrBadRequest, canonical, def.Code)
				}
				version := int32(item.CurrentVersion)
				value.EnumDictionaryID, value.EnumVersion = &item.DictionaryID, &version
			}
			seen[canonical] = true
			codes = append(codes, canonical)
		}
		value.ValueJSON, _ = json.Marshal(codes)
	default:
		return nil, fmt.Errorf("%w: unsupported field type %q", tasks.ErrBadRequest, def.Type)
	}
	return &value, nil
}

func botTaskFieldString(raw json.RawMessage, code string) (string, error) {
	var text *string
	if err := json.Unmarshal(raw, &text); err != nil || text == nil {
		return "", fmt.Errorf("%w: field %q requires a string", tasks.ErrBadRequest, code)
	}
	return *text, nil
}

func (v *botTaskFieldResolver) userID(ctx context.Context, raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return uuid.Nil, fmt.Errorf("%w: unknown user %s", tasks.ErrBadRequest, raw)
	}
	if v.users == nil {
		users, err := v.svc.q.ListActiveUsers(ctx)
		if err != nil {
			return uuid.Nil, fmt.Errorf("botapi: list assignable users: %w", err)
		}
		v.users = make(map[uuid.UUID]bool, len(users))
		for _, user := range users {
			v.users[user.ID] = true
		}
	}
	if !v.users[id] {
		return uuid.Nil, fmt.Errorf("%w: unknown user %s", tasks.ErrBadRequest, raw)
	}
	return id, nil
}

func (v *botTaskFieldResolver) enumItem(ctx context.Context, def tasks.FieldRow, raw string) (queries.ListBotCurrentEnumItemsRow, error) {
	if def.EnumDictionaryID == nil {
		return queries.ListBotCurrentEnumItemsRow{}, fmt.Errorf("botapi: enum field %s has no dictionary", def.ID)
	}
	text := strings.TrimSpace(raw)
	key := botTaskEnumKey{dictionaryID: *def.EnumDictionaryID, value: text}
	matches, ok := v.enumMatches[key]
	if !ok {
		rows, err := v.svc.q.FindBotCurrentEnumItems(ctx, queries.FindBotCurrentEnumItemsParams{
			EnumDictionaryID: *def.EnumDictionaryID, EnumValue: text,
		})
		if err != nil {
			return queries.ListBotCurrentEnumItemsRow{}, fmt.Errorf("botapi: match current enum items: %w", err)
		}
		matches = make([]queries.ListBotCurrentEnumItemsRow, len(rows))
		for i, row := range rows {
			matches[i] = queries.ListBotCurrentEnumItemsRow(row)
		}
		if v.enumMatches == nil {
			v.enumMatches = make(map[botTaskEnumKey][]queries.ListBotCurrentEnumItemsRow)
		}
		v.enumMatches[key] = matches
	}
	for _, item := range matches {
		if item.ValueCode == text {
			return item, nil
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	items, ok := v.enums[*def.EnumDictionaryID]
	if !ok {
		var err error
		items, err = v.svc.q.ListBotCurrentEnumItems(ctx, *def.EnumDictionaryID)
		if err != nil {
			return queries.ListBotCurrentEnumItemsRow{}, fmt.Errorf("botapi: load current enum items: %w", err)
		}
		v.enums[*def.EnumDictionaryID] = items
	}
	candidates := make([]string, 0, len(items))
	for _, item := range items {
		candidates = append(candidates, fmt.Sprintf("%s (%s)", item.ValueCode, item.ValueName))
	}
	reason := "unknown"
	if len(matches) > 1 {
		reason = "ambiguous"
	}
	return queries.ListBotCurrentEnumItemsRow{}, fmt.Errorf("%w: %s value %q in field %q; valid values: %s", tasks.ErrBadRequest, reason, text, def.Code, taskCandidates(candidates))
}

var (
	botTaskDecimal = regexp.MustCompile(`^([+-]?)([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?$`)
	botTaskRFC3339 = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$`)
)

// Work on the decimal coefficient and scale so neither JSON numbers nor
// scientific notation pass through floating point or get rounded by Postgres.
// Check the resulting bounds before adding zeros, even for enormous exponents.
func normalizeBotTaskNumber(raw string) (string, error) {
	parts := botTaskDecimal.FindStringSubmatch(strings.TrimSpace(raw))
	if parts == nil {
		return "", fmt.Errorf("invalid decimal")
	}
	whole, fractional, _ := strings.Cut(parts[2], ".")
	digits := strings.TrimLeft(whole+fractional, "0")
	if digits == "" {
		return "0", nil
	}
	var exponent int64
	if parts[3] != "" {
		var err error
		exponent, err = strconv.ParseInt(parts[3], 10, 64)
		if err != nil || exponent > int64(len(parts[2]))+14 || exponent < -int64(len(parts[2]))-6 {
			return "", fmt.Errorf("decimal out of range")
		}
	}
	coefficient := strings.TrimRight(digits, "0")
	scale := int64(len(fractional)) - exponent - int64(len(digits)-len(coefficient))
	integerDigits := int64(len(coefficient)) - scale
	if scale > 6 || integerDigits > 14 {
		return "", fmt.Errorf("decimal out of range")
	}
	var value string
	switch {
	case scale <= 0:
		value = coefficient + strings.Repeat("0", int(-scale))
	case integerDigits <= 0:
		value = "0." + strings.Repeat("0", int(-integerDigits)) + coefficient
	default:
		value = coefficient[:int(integerDigits)] + "." + coefficient[int(integerDigits):]
	}
	if parts[1] == "-" {
		value = "-" + value
	}
	return value, nil
}
