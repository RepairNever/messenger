package botapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/gen/queries"
	"msgnr/internal/tasks"
)

func TestNormalizeBotTaskNumber(t *testing.T) {
	for input, expected := range map[string]string{
		"0": "0", "-0.000e999999999999999999999999": "0",
		"1.0000000": "1", "1e3": "1000", "1e-6": "0.000001",
		"10000000e-7": "1", "  +.12500  ": "0.125",
		"00042.500000": "42.5", "-42.5000000": "-42.5",
		"99999999999999.999999":  "99999999999999.999999",
		"-99999999999999.999999": "-99999999999999.999999",
		"0.1234560":              "0.123456", "10e-7": "0.000001",
		"1.23000000e2": "123", "1.": "1",
	} {
		t.Run(input, func(t *testing.T) {
			actual, err := normalizeBotTaskNumber(input)
			require.NoError(t, err)
			assert.Equal(t, expected, actual)
		})
	}
	for _, input := range []string{
		"", "true", "NaN", "Infinity", "1/2", "0x10", "1_000",
		"0.1234567", "1e-7", "100000000000000", "1e14",
		"1e9999999999999999999999999", "1e-99999999999999999999999",
		"1e9223372036854775807", "1e-9223372036854775808",
		"1e", ".", "1.2.3", "1 2",
	} {
		t.Run(input, func(t *testing.T) {
			_, err := normalizeBotTaskNumber(input)
			require.Error(t, err)
		})
	}
}

func TestDecodeTaskWrite(t *testing.T) {
	for _, tc := range []struct {
		body   string
		update bool
		error  string
	}{
		{"", false, "invalid request body"},
		{"null", true, "invalid request body"},
		{"[]", true, "invalid request body"},
		{"{} {}", true, "invalid request body"},
		{"{} trailing", true, "invalid request body"},
		{`{"Title":"lost"}`, true, "bad request: unknown key Title"},
		{`{"priority":"high"}`, false, "bad request: unknown key priority"},
		{`{"template":null}`, true, "bad request: template is not updatable"},
		{`{"parent_public_id":null}`, true, "bad request: parent_public_id is not updatable"},
		{`{"public_id":"DEV-1"}`, true, "bad request: public_id is not updatable"},
		{`{"field_values":[null]}`, true, "invalid request body"},
		{`{"field_values":[{"code":"owner"}]}`, true, `bad request: value is required for field "owner"`},
		{`{"field_values":[{"code":"owner","value":null,"enum_version":1}]}`, true, "bad request: unknown key enum_version"},
		{`{"description":123}`, true, "invalid request body"},
		{`{"title":123}`, true, "invalid request body"},
	} {
		t.Run(tc.body, func(t *testing.T) {
			_, err := decodeTaskWrite(strings.NewReader(tc.body), tc.update)
			require.EqualError(t, err, tc.error)
		})
	}
	absent, err := decodeTaskWrite(strings.NewReader(`{}`), true)
	require.NoError(t, err)
	assert.Nil(t, absent.Description)
	cleared, err := decodeTaskWrite(strings.NewReader(`{"description":null,"title":null,"status":null,"field_values":[]}`), true)
	require.NoError(t, err)
	assert.Equal(t, json.RawMessage("null"), cleared.Description)
	assert.Nil(t, cleared.Title)
	assert.Nil(t, cleared.Status)
	assert.Empty(t, cleared.FieldValues)
	req, err := decodeTaskWrite(strings.NewReader(`{"field_values":[{"code":"number","value":99999999999999.999999}]}`), false)
	require.NoError(t, err)
	assert.Equal(t, json.RawMessage("99999999999999.999999"), req.FieldValues[0].Value)
}

func TestBotTaskFieldCanonicalization(t *testing.T) {
	ctx := context.Background()
	dictID, fieldID, userID := uuid.New(), uuid.New(), uuid.New()
	def := tasks.FieldRow{ID: fieldID, Code: "version", Type: "multi_enum", EnumDictionaryID: &dictID}
	resolver := botTaskFieldResolver{
		users: map[uuid.UUID]bool{userID: true},
		enums: map[uuid.UUID][]queries.ListBotCurrentEnumItemsRow{dictID: {
			{DictionaryID: dictID, CurrentVersion: 2, ValueCode: "todo", ValueName: "To Do"},
			{DictionaryID: dictID, CurrentVersion: 2, ValueCode: "alias", ValueName: "Shared"},
			{DictionaryID: dictID, CurrentVersion: 2, ValueCode: "alias2", ValueName: "Shared"},
			{DictionaryID: dictID, CurrentVersion: 2, ValueCode: "name_collision", ValueName: "todo"},
		}},
	}
	items := resolver.enums[dictID]
	resolver.enumMatches = map[botTaskEnumKey][]queries.ListBotCurrentEnumItemsRow{
		{dictionaryID: dictID, value: "todo"}:   {items[0], items[3]},
		{dictionaryID: dictID, value: "To Do"}:  {items[0]},
		{dictionaryID: dictID, value: "to do"}:  {items[0]},
		{dictionaryID: dictID, value: "shared"}: {items[1], items[2]},
	}
	value, err := resolver.convert(ctx, def, json.RawMessage(`["todo"]`))
	require.NoError(t, err, "exact code wins over another item's name")
	assert.JSONEq(t, `["todo"]`, string(value.ValueJSON))
	assert.Equal(t, int32(2), *value.EnumVersion)
	_, err = resolver.convert(ctx, def, json.RawMessage(`["To Do","to do"]`))
	require.EqualError(t, err, `bad request: duplicate value "todo" in field "version"`)
	_, err = resolver.convert(ctx, def, json.RawMessage(`["shared"]`))
	require.ErrorContains(t, err, "ambiguous value")
	_, err = resolver.convert(ctx, def, json.RawMessage(`[null]`))
	require.ErrorContains(t, err, "array of strings")
	value, err = resolver.convert(ctx, def, json.RawMessage(`[]`))
	require.NoError(t, err)
	assert.Nil(t, value)
	def.Code, def.Type = "owners", "users"
	raw, err := json.Marshal([]string{userID.String(), strings.ToUpper(userID.String())})
	require.NoError(t, err)
	_, err = resolver.convert(ctx, def, raw)
	require.EqualError(t, err, `bad request: duplicate user "`+userID.String()+`" in field "owners"`)
	for _, tc := range []struct{ fieldType, raw string }{
		{"text", "42"}, {"users", `[null]`}, {"date", `"2026-02-30"`},
		{"date", `"0000-01-01"`}, {"datetime", `"2026-10-07T1:00:00Z"`},
		{"datetime", `"2026-10-07T01:00:00+24:00"`}, {"datetime", `"0000-01-01T00:00:00Z"`},
	} {
		def.Type = tc.fieldType
		_, err := resolver.convert(ctx, def, json.RawMessage(tc.raw))
		require.Error(t, err)
	}
}

func TestMergedBotTaskFieldsPreservesUntouchedValues(t *testing.T) {
	fieldID, emptyID, removedID, dictionaryID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	text, version := "historical", int32(1)
	defs := []tasks.FieldRow{{ID: fieldID}, {ID: emptyID}}
	current := []tasks.FieldValueRow{
		{FieldDefinitionID: fieldID, ValueText: &text, EnumDictionaryID: &dictionaryID, EnumVersion: &version},
		{FieldDefinitionID: emptyID},
		{FieldDefinitionID: removedID, ValueText: &text},
	}
	merged := mergedBotTaskFields(defs, current, nil)
	require.Len(t, merged, 1)
	assert.Equal(t, text, *merged[0].ValueText)
	assert.Equal(t, version, *merged[0].EnumVersion)
	assert.Equal(t, dictionaryID, *merged[0].EnumDictionaryID)
	assert.Empty(t, mergedBotTaskFields(defs, current, map[uuid.UUID]*tasks.FieldValueInput{fieldID: nil}))
	candidates := strings.Split(strings.Repeat("a,", 50)+"hidden", ",")
	assert.Equal(t, 50, strings.Count(taskCandidates(candidates), "a"))
	assert.NotContains(t, taskCandidates(candidates), "hidden")
	assert.True(t, strings.HasSuffix(taskCandidates(candidates), "…"))
}
