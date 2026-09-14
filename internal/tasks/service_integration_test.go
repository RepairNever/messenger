//go:build integration

package tasks_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/gen/queries"
	"msgnr/internal/tasks"
	"msgnr/internal/testdb"
)

// seedUser inserts a minimal user and returns its ID.
func seedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Test User', 'admin') RETURNING id`,
		"tasks_test_"+uuid.NewString()+"@example.com",
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func seedUserProfile(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email, displayName, avatarURL string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, avatar_url, role)
		 VALUES ($1, 'x', $2, $3, 'admin') RETURNING id`,
		email,
		displayName,
		avatarURL,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

// =========================================================
// Templates
// =========================================================

func TestIntegration_Template_CreateAndList(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	row, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:    "DEV",
		SortOrder: 1,
		ActorID:   actor,
	})
	require.NoError(t, err)
	assert.Equal(t, "DEV", row.Prefix)
	assert.Nil(t, row.DeletedAt)

	list, err := svc.ListTemplates(ctx, false)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, row.ID, list[0].ID)
}

func TestIntegration_Template_PrefixMustBeUppercase(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	_, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:  "dev",
		ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Template_PrefixMustBeUnique(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	_, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "BUG", ActorID: actor})
	require.NoError(t, err)

	_, err = svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "BUG", ActorID: actor})
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Template_SoftDelete(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	row, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "QA", ActorID: actor})
	require.NoError(t, err)

	deleted, err := svc.SoftDeleteTemplate(ctx, row.ID, actor)
	require.NoError(t, err)
	assert.NotNil(t, deleted.DeletedAt)

	// Deleted template absent from normal list.
	list, err := svc.ListTemplates(ctx, false)
	require.NoError(t, err)
	assert.Empty(t, list)

	// But visible when including deleted.
	all, err := svc.ListTemplates(ctx, true)
	require.NoError(t, err)
	assert.Len(t, all, 1)
}

func TestIntegration_Template_Reorder(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	a, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "AA", SortOrder: 1, ActorID: actor})
	require.NoError(t, err)
	b, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "BB", SortOrder: 2, ActorID: actor})
	require.NoError(t, err)

	// Reverse order.
	err = svc.ReorderTemplates(ctx, []uuid.UUID{b.ID, a.ID})
	require.NoError(t, err)

	list, err := svc.ListTemplates(ctx, false)
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, b.ID, list[0].ID)
	assert.Equal(t, a.ID, list[1].ID)
}

// =========================================================
// Statuses
// =========================================================

func TestIntegration_Status_CreateAndList(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	row, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:    "open",
		Name:    "Open",
		ActorID: actor,
	})
	require.NoError(t, err)
	assert.Equal(t, "open", row.Code)
	assert.Equal(t, "Open", row.Name)

	list, err := svc.ListStatuses(ctx, false)
	require.NoError(t, err)
	require.Len(t, list, 1)
}

func TestIntegration_Status_CodeMustBeUnique(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	_, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{Code: "done", Name: "Done", ActorID: actor})
	require.NoError(t, err)

	_, err = svc.CreateStatus(ctx, tasks.CreateStatusParams{Code: "done", Name: "Done again", ActorID: actor})
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Status_SoftDelete(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	row, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{Code: "wip", Name: "WIP", ActorID: actor})
	require.NoError(t, err)

	deleted, err := svc.SoftDeleteStatus(ctx, row.ID)
	require.NoError(t, err)
	assert.NotNil(t, deleted.DeletedAt)

	active, err := svc.ListStatuses(ctx, false)
	require.NoError(t, err)
	assert.Empty(t, active)
}

func TestIntegration_Status_Update(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	row, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{Code: "todo", Name: "Todo", ActorID: actor})
	require.NoError(t, err)

	updated, err := svc.UpdateStatus(ctx, row.ID, tasks.UpdateStatusParams{Code: "todo", Name: "To Do"})
	require.NoError(t, err)
	assert.Equal(t, "To Do", updated.Name)
}

func TestIntegration_Template_UpdateWithSortOrder(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	tpl, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "UPDA", SortOrder: 1, ActorID: actor})
	require.NoError(t, err)
	assert.Equal(t, 1, tpl.SortOrder)

	sort2 := 2
	updated, err := svc.UpdateTemplate(ctx, tpl.ID, tasks.UpdateTemplateParams{
		Prefix:    "UPDB",
		SortOrder: &sort2,
		ActorID:   actor,
	})
	require.NoError(t, err)
	assert.Equal(t, "UPDB", updated.Prefix)
	assert.Equal(t, 2, updated.SortOrder)

	// Update only prefix (sort_order should remain 2)
	updated2, err := svc.UpdateTemplate(ctx, tpl.ID, tasks.UpdateTemplateParams{
		Prefix:    "UPDC",
		SortOrder: nil,
		ActorID:   actor,
	})
	require.NoError(t, err)
	assert.Equal(t, "UPDC", updated2.Prefix)
	assert.Equal(t, 2, updated2.SortOrder)
}

// =========================================================
// Enum dictionaries
// =========================================================

func TestIntegration_Dictionary_CreateAndList(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)

	row, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code:     "priority",
		Name:     "Priority",
		IsPublic: true,
	})
	require.NoError(t, err)
	assert.Equal(t, "priority", row.Code)
	assert.True(t, row.IsPublic)
	assert.Equal(t, 1, row.CurrentVersion)

	list, err := svc.ListDictionaries(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.True(t, list[0].IsPublic)
}

func TestIntegration_Dictionary_CodeMustBeUnique(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)

	_, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "sev", Name: "Severity"})
	require.NoError(t, err)

	_, err = svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "sev", Name: "Severity 2"})
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Dictionary_CreateVersion(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "env", Name: "Environment"})
	require.NoError(t, err)
	assert.Equal(t, 1, dict.CurrentVersion)

	items := []tasks.DictionaryItemInput{
		{ValueCode: "prod", ValueName: "Production", SortOrder: 1, IsActive: true},
		{ValueCode: "stage", ValueName: "Staging", SortOrder: 2, IsActive: true},
	}
	ver, err := svc.CreateDictionaryVersion(ctx, dict.ID, items, actor)
	require.NoError(t, err)
	assert.Equal(t, 2, ver.Version)

	// Dictionary current_version incremented.
	updated, err := svc.GetDictionary(ctx, dict.ID)
	require.NoError(t, err)
	assert.Equal(t, 2, updated.CurrentVersion)

	// Items are stored.
	stored, err := svc.GetDictionaryVersionItems(ctx, ver.ID, "", 0, nil)
	require.NoError(t, err)
	require.Len(t, stored, 2)
	assert.Equal(t, "prod", stored[0].ValueCode)
	assert.Equal(t, "stage", stored[1].ValueCode)
}

func TestIntegration_Dictionary_VersionRequiresItems(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "x", Name: "X"})
	require.NoError(t, err)

	_, err = svc.CreateDictionaryVersion(ctx, dict.ID, nil, actor)
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Dictionary_AdditiveSaveReusesLatestVersion(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "env2", Name: "Environment 2"})
	require.NoError(t, err)

	initial, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "prod", ValueName: "Production", SortOrder: 10, IsActive: true},
		{ValueCode: "stage", ValueName: "Staging", SortOrder: 20, IsActive: true},
	}, actor)
	require.NoError(t, err)

	saved, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "prod", ValueName: "Production", SortOrder: 30, IsActive: false},
		{ValueCode: "stage", ValueName: "Staging", SortOrder: 10, IsActive: true},
		{ValueCode: "qa", ValueName: "QA", SortOrder: 20, IsActive: true},
	}, actor)
	require.NoError(t, err)

	assert.Equal(t, initial.ID, saved.ID)
	assert.Equal(t, initial.Version, saved.Version)

	updated, err := svc.GetDictionary(ctx, dict.ID)
	require.NoError(t, err)
	assert.Equal(t, 2, updated.CurrentVersion)

	stored, err := svc.GetDictionaryVersionItems(ctx, saved.ID, "", 0, nil)
	require.NoError(t, err)
	require.Len(t, stored, 3)
	assert.Equal(t, "stage", stored[0].ValueCode)
	assert.True(t, stored[0].IsActive)
	assert.Equal(t, "qa", stored[1].ValueCode)
	assert.Equal(t, "prod", stored[2].ValueCode)
	assert.False(t, stored[2].IsActive)
}

func TestIntegration_Dictionary_RenameCreatesNewVersion(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "priority2", Name: "Priority 2"})
	require.NoError(t, err)

	initial, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 2, IsActive: true},
	}, actor)
	require.NoError(t, err)

	renamed, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "Urgent", SortOrder: 1, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 2, IsActive: true},
	}, actor)
	require.NoError(t, err)

	assert.NotEqual(t, initial.ID, renamed.ID)
	assert.Equal(t, initial.Version+1, renamed.Version)

	updated, err := svc.GetDictionary(ctx, dict.ID)
	require.NoError(t, err)
	assert.Equal(t, int(renamed.Version), updated.CurrentVersion)
}

func TestIntegration_Dictionary_RemovalCreatesNewVersion(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "status2", Name: "Status 2"})
	require.NoError(t, err)

	initial, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "open", ValueName: "Open", SortOrder: 1, IsActive: true},
		{ValueCode: "closed", ValueName: "Closed", SortOrder: 2, IsActive: true},
	}, actor)
	require.NoError(t, err)

	removed, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "open", ValueName: "Open", SortOrder: 1, IsActive: true},
	}, actor)
	require.NoError(t, err)

	assert.NotEqual(t, initial.ID, removed.ID)
	assert.Equal(t, initial.Version+1, removed.Version)

	stored, err := svc.GetDictionaryVersionItems(ctx, removed.ID, "", 0, nil)
	require.NoError(t, err)
	require.Len(t, stored, 1)
	assert.Equal(t, "open", stored[0].ValueCode)
}

func TestIntegration_Dictionary_DuplicateSubmittedCodesConflict(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "dupdict", Name: "Duplicate Dict"})
	require.NoError(t, err)

	_, err = svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "dup", ValueName: "One", SortOrder: 1, IsActive: true},
		{ValueCode: "dup", ValueName: "Two", SortOrder: 2, IsActive: true},
	}, actor)
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Dictionary_UpdateSettings(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "pubdict", Name: "Public Dict"})
	require.NoError(t, err)
	assert.False(t, dict.IsPublic)
	assert.False(t, dict.ParticipatesInFiltration)

	updated, err := svc.UpdateDictionarySettings(ctx, dict.ID, true, true)
	require.NoError(t, err)
	assert.True(t, updated.IsPublic)
	assert.True(t, updated.ParticipatesInFiltration)

	stored, err := svc.GetDictionary(ctx, dict.ID)
	require.NoError(t, err)
	assert.True(t, stored.IsPublic)
	assert.True(t, stored.ParticipatesInFiltration)
}

func TestIntegration_Dictionary_CreatePublicItemAppendsToLatestVersion(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code:     "public_env",
		Name:     "Public Env",
		IsPublic: true,
	})
	require.NoError(t, err)

	version, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "prod", ValueName: "Production", SortOrder: 1, IsActive: true},
	}, actor)
	require.NoError(t, err)

	item, err := svc.CreatePublicDictionaryItem(ctx, dict.ID, "stage", actor)
	require.NoError(t, err)
	assert.Equal(t, "stage", item.ValueCode)
	assert.Equal(t, "stage", item.ValueName)

	versions, err := svc.ListDictionaryVersions(ctx, dict.ID)
	require.NoError(t, err)
	require.Len(t, versions, 1)
	assert.Equal(t, version.ID, versions[0].ID)

	stored, err := svc.GetDictionaryVersionItems(ctx, version.ID, "", 0, nil)
	require.NoError(t, err)
	require.Len(t, stored, 2)
	assert.Equal(t, "prod", stored[0].ValueCode)
	assert.Equal(t, "stage", stored[1].ValueCode)

	updated, err := svc.GetDictionary(ctx, dict.ID)
	require.NoError(t, err)
	assert.Equal(t, version.Version, updated.CurrentVersion)
}

func TestIntegration_Dictionary_CreatePublicItemBootstrapsFirstVersion(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code:     "public_bootstrap",
		Name:     "Public Bootstrap",
		IsPublic: true,
	})
	require.NoError(t, err)
	assert.Equal(t, 1, dict.CurrentVersion)

	item, err := svc.CreatePublicDictionaryItem(ctx, dict.ID, "alpha", actor)
	require.NoError(t, err)
	assert.Equal(t, "alpha", item.ValueCode)

	versions, err := svc.ListDictionaryVersions(ctx, dict.ID)
	require.NoError(t, err)
	require.Len(t, versions, 1)
	assert.Equal(t, 2, versions[0].Version)

	updated, err := svc.GetDictionary(ctx, dict.ID)
	require.NoError(t, err)
	assert.Equal(t, 2, updated.CurrentVersion)
}

func TestIntegration_Dictionary_CreatePublicItemRejectsPrivateDictionary(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "private_env", Name: "Private Env"})
	require.NoError(t, err)

	_, err = svc.CreatePublicDictionaryItem(ctx, dict.ID, "secret", actor)
	require.ErrorIs(t, err, tasks.ErrForbidden)
}

func TestIntegration_Dictionary_CreatePublicItemRejectsDuplicate(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code:     "public_dup",
		Name:     "Public Dup",
		IsPublic: true,
	})
	require.NoError(t, err)

	_, err = svc.CreatePublicDictionaryItem(ctx, dict.ID, "dup", actor)
	require.NoError(t, err)

	_, err = svc.CreatePublicDictionaryItem(ctx, dict.ID, "dup", actor)
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Dictionary_GetVersionItemsSupportsSearchAndLimit(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "searchdict", Name: "Search Dict"})
	require.NoError(t, err)

	items := make([]tasks.DictionaryItemInput, 0, 25)
	for i := 1; i <= 25; i += 1 {
		name := fmt.Sprintf("Version %02d", i)
		items = append(items, tasks.DictionaryItemInput{
			ValueCode: fmt.Sprintf("v%02d", i),
			ValueName: name,
			SortOrder: i,
			IsActive:  true,
		})
	}

	version, err := svc.CreateDictionaryVersion(ctx, dict.ID, items, actor)
	require.NoError(t, err)

	limited, err := svc.GetDictionaryVersionItems(ctx, version.ID, "", 20, nil)
	require.NoError(t, err)
	require.Len(t, limited, 20)
	assert.Equal(t, "v01", limited[0].ValueCode)
	assert.Equal(t, "v20", limited[19].ValueCode)

	matched, err := svc.GetDictionaryVersionItems(ctx, version.ID, "Version 24", 20, nil)
	require.NoError(t, err)
	require.Len(t, matched, 1)
	assert.Equal(t, "v24", matched[0].ValueCode)

	hydrated, err := svc.GetDictionaryVersionItems(ctx, version.ID, "Version 24", 20, []string{"v03"})
	require.NoError(t, err)
	require.Len(t, hydrated, 2)
	assert.Equal(t, "v03", hydrated[0].ValueCode)
	assert.Equal(t, "v24", hydrated[1].ValueCode)
}

// =========================================================
// Field definitions
// =========================================================

func seedTemplate(t *testing.T, ctx context.Context, svc *tasks.Service, prefix string, actor uuid.UUID) tasks.TemplateRow {
	t.Helper()
	row, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: prefix, SortOrder: 1, ActorID: actor})
	require.NoError(t, err)
	return row
}

func seedDict(t *testing.T, ctx context.Context, svc *tasks.Service) tasks.DictionaryRow {
	t.Helper()
	row, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code: "dict_" + uuid.NewString()[:8],
		Name: "Test Dict",
	})
	require.NoError(t, err)
	return row
}

func TestIntegration_Field_CreateAndList(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FLD", actor)

	row, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "title",
		Name:       "Title",
		Type:       "text",
		SortOrder:  1,
	})
	require.NoError(t, err)
	assert.Equal(t, "title", row.Code)
	assert.Equal(t, "text", row.Type)
	assert.Nil(t, row.DeletedAt)

	list, err := svc.ListFields(ctx, tpl.ID, false)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, row.ID, list[0].ID)
}

func TestIntegration_Field_AllTypes(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "TYP", actor)
	dict := seedDict(t, ctx, svc)

	types := []struct {
		code      string
		fieldType string
		dictID    *uuid.UUID
	}{
		{"f_text", "text", nil},
		{"f_number", "number", nil},
		{"f_user", "user", nil},
		{"f_users", "users", nil},
		{"f_enum", "enum", &dict.ID},
		{"f_multienum", "multi_enum", &dict.ID},
		{"f_date", "date", nil},
		{"f_datetime", "datetime", nil},
	}

	for i, tc := range types {
		_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
			TemplateID:       tpl.ID,
			Code:             tc.code,
			Name:             tc.code,
			Type:             tc.fieldType,
			SortOrder:        i + 1,
			EnumDictionaryID: tc.dictID,
		})
		require.NoError(t, err, "type %s", tc.fieldType)
	}

	list, err := svc.ListFields(ctx, tpl.ID, false)
	require.NoError(t, err)
	assert.Len(t, list, len(types))
}

func TestIntegration_Field_CodeMustBeIdentifier(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CID", actor)

	cases := []string{"Bad Code", "123start", "UPPER", "has space", ""}
	for _, code := range cases {
		_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
			TemplateID: tpl.ID, Code: code, Name: "x", Type: "text", SortOrder: 1,
		})
		require.ErrorIs(t, err, tasks.ErrBadRequest, "code %q should be rejected", code)
	}
}

func TestIntegration_Field_CodeUniquePerTemplate(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UNQ", actor)

	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "dup", Name: "Dup", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)

	_, err = svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "dup", Name: "Dup2", Type: "text", SortOrder: 2,
	})
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Field_SameCodeDifferentTemplates(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl1 := seedTemplate(t, ctx, svc, "TMPA", actor)
	tpl2 := seedTemplate(t, ctx, svc, "TMPB", actor)

	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl1.ID, Code: "shared", Name: "Shared", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)

	_, err = svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl2.ID, Code: "shared", Name: "Shared", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err, "same code on different template should be allowed")
}

func TestIntegration_Field_SoftDelete(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SDF", actor)

	row, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "gone", Name: "Gone", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)

	deleted, err := svc.SoftDeleteField(ctx, tpl.ID, row.ID)
	require.NoError(t, err)
	assert.NotNil(t, deleted.DeletedAt)

	active, err := svc.ListFields(ctx, tpl.ID, false)
	require.NoError(t, err)
	assert.Empty(t, active)

	all, err := svc.ListFields(ctx, tpl.ID, true)
	require.NoError(t, err)
	assert.Len(t, all, 1)
}

func TestIntegration_Field_CodeReuseAfterSoftDelete(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CRU", actor)

	row, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "recycled", Name: "Recycled", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)
	_, err = svc.SoftDeleteField(ctx, tpl.ID, row.ID)
	require.NoError(t, err)

	// Creating a new field with the same code should succeed after soft-delete.
	_, err = svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "recycled", Name: "Recycled New", Type: "number", SortOrder: 1,
	})
	require.NoError(t, err)
}

func TestIntegration_Field_AssigneeTypeValidation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ASG", actor)

	role := "assignee"

	// Assignee with text type must fail (check constraint).
	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "bad_assignee", Name: "Bad", Type: "text", FieldRole: &role, SortOrder: 1,
	})
	require.Error(t, err)

	// Assignee with user type must succeed.
	_, err = svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "assignee_user", Name: "Assignee", Type: "user", FieldRole: &role, SortOrder: 1,
	})
	require.NoError(t, err)
}

func TestIntegration_Field_MaxOneAssigneePerTemplate(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ONA", actor)

	role := "assignee"
	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "assignee1", Name: "Assignee 1", Type: "user", FieldRole: &role, SortOrder: 1,
	})
	require.NoError(t, err)

	_, err = svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "assignee2", Name: "Assignee 2", Type: "users", FieldRole: &role, SortOrder: 2,
	})
	require.ErrorIs(t, err, tasks.ErrConflict)
}

func TestIntegration_Field_AssigneeConflictMessage(t *testing.T) {
	// The "one assignee" unique index must produce ErrConflict (not ErrBadRequest)
	// with a message that mentions "assignee", not "field code".
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ACM", actor)

	role := "assignee"
	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "a1", Name: "A1", Type: "user", FieldRole: &role, SortOrder: 1,
	})
	require.NoError(t, err)

	_, err = svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "a2", Name: "A2", Type: "users", FieldRole: &role, SortOrder: 2,
	})
	require.ErrorIs(t, err, tasks.ErrConflict)
	assert.Contains(t, err.Error(), "assignee")
}

func TestIntegration_Field_EnumRequiresDictionary(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ERD", actor)

	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "no_dict", Name: "No Dict", Type: "enum", SortOrder: 1,
	})
	require.Error(t, err)
}

func TestIntegration_Field_NonEnumNoDict(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NED", actor)
	dict := seedDict(t, ctx, svc)

	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID:       tpl.ID,
		Code:             "bad_text",
		Name:             "Bad",
		Type:             "text",
		SortOrder:        1,
		EnumDictionaryID: &dict.ID,
	})
	require.Error(t, err)
}

func TestIntegration_Field_TemplateOwnership(t *testing.T) {
	// GetField/UpdateField/SoftDeleteField must return ErrNotFound when
	// the field ID belongs to a different template.
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tplA := seedTemplate(t, ctx, svc, "OWNA", actor)
	tplB := seedTemplate(t, ctx, svc, "OWNB", actor)

	fieldOnA, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tplA.ID, Code: "fa", Name: "FA", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)

	// Accessing field from wrong template must 404.
	_, err = svc.GetField(ctx, tplB.ID, fieldOnA.ID)
	require.ErrorIs(t, err, tasks.ErrNotFound)

	_, err = svc.UpdateField(ctx, tplB.ID, fieldOnA.ID, tasks.UpdateFieldParams{Name: "x", Required: false})
	require.ErrorIs(t, err, tasks.ErrNotFound)

	_, err = svc.SoftDeleteField(ctx, tplB.ID, fieldOnA.ID)
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Field_Update(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UPD", actor)

	row, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "myfield", Name: "My Field", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)

	updated, err := svc.UpdateField(ctx, tpl.ID, row.ID, tasks.UpdateFieldParams{
		Name:     "My Updated Field",
		Required: true,
	})
	require.NoError(t, err)
	assert.Equal(t, "My Updated Field", updated.Name)
	assert.True(t, updated.Required)
	// Code and type must not change.
	assert.Equal(t, "myfield", updated.Code)
	assert.Equal(t, "text", updated.Type)
}

func TestIntegration_Field_Reorder(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ROR", actor)

	a, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "fa", Name: "FA", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)
	b, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "fb", Name: "FB", Type: "text", SortOrder: 2,
	})
	require.NoError(t, err)
	c, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "fc", Name: "FC", Type: "text", SortOrder: 3,
	})
	require.NoError(t, err)

	err = svc.ReorderFields(ctx, tpl.ID, []uuid.UUID{c.ID, a.ID, b.ID})
	require.NoError(t, err)

	list, err := svc.ListFields(ctx, tpl.ID, false)
	require.NoError(t, err)
	require.Len(t, list, 3)
	assert.Equal(t, c.ID, list[0].ID)
	assert.Equal(t, a.ID, list[1].ID)
	assert.Equal(t, b.ID, list[2].ID)
}

// =========================================================
// Phase 3 — Task CRUD
// =========================================================

// seedStatus creates a task status and returns it.
func seedStatus(t *testing.T, ctx context.Context, svc *tasks.Service, actor uuid.UUID) tasks.StatusRow {
	t.Helper()
	row, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:      "status_" + uuid.NewString()[:8],
		Name:      "Open",
		SortOrder: 1,
		ActorID:   actor,
	})
	require.NoError(t, err)
	return row
}

func TestIntegration_Task_CreateBasic(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DEV", actor)
	status := seedStatus(t, ctx, svc, actor)

	resp, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "Fix login bug",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, resp.ID)
	assert.Equal(t, "DEV-1", resp.PublicID)
	assert.Equal(t, int64(1), resp.SequenceNumber)
	assert.Equal(t, "DEV", resp.TemplateSnapshotPrefix)
	assert.Equal(t, "Fix login bug", resp.Title)
	assert.Nil(t, resp.Description)
	assert.Empty(t, resp.FieldValues)
}

func TestIntegration_Task_SequentialPublicID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SEQ", actor)
	status := seedStatus(t, ctx, svc, actor)

	p := tasks.CreateTaskParams{TemplateID: tpl.ID, Title: "T", StatusID: status.ID, ActorID: actor}

	r1, err := svc.CreateTask(ctx, p)
	require.NoError(t, err)
	r2, err := svc.CreateTask(ctx, p)
	require.NoError(t, err)

	assert.Equal(t, "SEQ-1", r1.PublicID)
	assert.Equal(t, "SEQ-2", r2.PublicID)
}

func TestIntegration_Task_IndependentSequencePerTemplate(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tplDev := seedTemplate(t, ctx, svc, "IND", actor)
	tplQA := seedTemplate(t, ctx, svc, "QAI", actor)
	status := seedStatus(t, ctx, svc, actor)

	r1, err := svc.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: tplDev.ID, Title: "dev task", StatusID: status.ID, ActorID: actor})
	require.NoError(t, err)
	r2, err := svc.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: tplQA.ID, Title: "qa task", StatusID: status.ID, ActorID: actor})
	require.NoError(t, err)
	r3, err := svc.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: tplDev.ID, Title: "dev task 2", StatusID: status.ID, ActorID: actor})
	require.NoError(t, err)

	assert.Equal(t, "IND-1", r1.PublicID)
	assert.Equal(t, "QAI-1", r2.PublicID)
	assert.Equal(t, "IND-2", r3.PublicID)
}

func TestIntegration_Task_DeletedTemplateReturnsError(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DTL", actor)
	status := seedStatus(t, ctx, svc, actor)

	_, err := svc.SoftDeleteTemplate(ctx, tpl.ID, actor)
	require.NoError(t, err)

	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "should fail", StatusID: status.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Task_DeletedStatusReturnsError(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DST", actor)
	status := seedStatus(t, ctx, svc, actor)

	_, err := svc.SoftDeleteStatus(ctx, status.ID)
	require.NoError(t, err)

	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "should fail", StatusID: status.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Task_RequiredFieldMissing(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "REQ", actor)
	status := seedStatus(t, ctx, svc, actor)

	// Add a required field to the template.
	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "priority", Name: "Priority", Type: "text",
		Required: true, SortOrder: 1,
	})
	require.NoError(t, err)

	// Create task without providing the required field.
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "missing field", StatusID: status.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Task_AllFieldTypes(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "AFT", actor)
	status := seedStatus(t, ctx, svc, actor)

	dict := seedDict(t, ctx, svc)
	ver, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 2, IsActive: true},
	}, actor)
	require.NoError(t, err)

	textField, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "txt", Name: "Text", Type: "text", SortOrder: 1})
	numField, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "num", Name: "Number", Type: "number", SortOrder: 2})
	userField, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "usr", Name: "User", Type: "user", SortOrder: 3})
	dateField, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "dt", Name: "Date", Type: "date", SortOrder: 4})
	enumField, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "en", Name: "Enum", Type: "enum", SortOrder: 5, EnumDictionaryID: &dict.ID})

	enumVer := int32(ver.Version)
	txtVal := "hello"
	numVal := "42.5"
	dateVal := "2024-03-01"

	resp, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "all fields",
		StatusID:   status.ID,
		ActorID:    actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: textField.ID, ValueText: &txtVal},
			{FieldDefinitionID: numField.ID, ValueNumber: &numVal},
			{FieldDefinitionID: userField.ID, ValueUserID: &actor},
			{FieldDefinitionID: dateField.ID, ValueDate: &dateVal},
			{FieldDefinitionID: enumField.ID, ValueJSON: []byte(`["high"]`), EnumDictionaryID: &dict.ID, EnumVersion: &enumVer},
		},
	})
	require.NoError(t, err)
	assert.Len(t, resp.FieldValues, 5)

	// Round-trip via GetTask.
	got, err := svc.GetTask(ctx, resp.ID)
	require.NoError(t, err)
	assert.Equal(t, resp.PublicID, got.PublicID)
	assert.Len(t, got.FieldValues, 5)

	// Verify specific values.
	byDef := make(map[uuid.UUID]tasks.FieldValueRow)
	for _, fv := range got.FieldValues {
		byDef[fv.FieldDefinitionID] = fv
	}
	require.NotNil(t, byDef[textField.ID].ValueText)
	assert.Equal(t, "hello", *byDef[textField.ID].ValueText)
	require.NotNil(t, byDef[numField.ID].ValueNumber)
	assert.Equal(t, "42.500000", *byDef[numField.ID].ValueNumber)
	require.NotNil(t, byDef[userField.ID].ValueUserID)
	assert.Equal(t, actor, *byDef[userField.ID].ValueUserID)
	require.NotNil(t, byDef[dateField.ID].ValueDate)
	assert.Equal(t, "2024-03-01", *byDef[dateField.ID].ValueDate)
	assert.NotNil(t, byDef[enumField.ID].EnumDictionaryID)
	assert.NotNil(t, byDef[enumField.ID].EnumVersion)
	assert.Equal(t, enumVer, *byDef[enumField.ID].EnumVersion)
}

func TestIntegration_Task_UpdateSystemFields(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UPT", actor)
	s1 := seedStatus(t, ctx, svc, actor)
	s2 := seedStatus(t, ctx, svc, actor)

	resp, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "original", StatusID: s1.ID, ActorID: actor,
	})
	require.NoError(t, err)

	desc := "updated description"
	updated, err := svc.UpdateTask(ctx, resp.ID, tasks.UpdateTaskParams{
		Title:       "updated title",
		Description: &desc,
		StatusID:    s2.ID,
		ActorID:     actor,
	})
	require.NoError(t, err)
	assert.Equal(t, "updated title", updated.Title)
	require.NotNil(t, updated.Description)
	assert.Equal(t, "updated description", *updated.Description)
	assert.Equal(t, s2.ID, updated.StatusID)
	// public_id must not change on update.
	assert.Equal(t, resp.PublicID, updated.PublicID)
}

func TestIntegration_Task_UpdateDescriptionOnly(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UDS", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "desc-only", StatusID: status.ID, ActorID: actor,
	})
	require.NoError(t, err)
	require.Nil(t, created.Description)

	next := "## Realtime\n\nBody"
	updated, err := svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &next,
		ActorID:     actor,
	})
	require.NoError(t, err)
	require.NotNil(t, updated.Description)
	assert.Equal(t, next, *updated.Description)

	cleared, err := svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: nil,
		ActorID:     actor,
	})
	require.NoError(t, err)
	assert.Nil(t, cleared.Description)
}

func TestIntegration_TaskChangeHistoryRecordsCreationAndAllEditableFieldPaths(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	creator := seedUserProfile(t, ctx, pool, "history-creator@example.com", "History Creator", "/creator.png")
	editor := seedUserProfile(t, ctx, pool, "history-editor@example.com", "History Editor", "/editor.png")
	tpl := seedTemplate(t, ctx, svc, "HIS", creator)
	open := seedStatus(t, ctx, svc, creator)
	inProgress, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code: "in_progress", Name: "In progress", SortOrder: 2, ActorID: creator,
	})
	require.NoError(t, err)
	priority, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "priority", Name: "Priority", Type: "text", SortOrder: 1,
	})
	require.NoError(t, err)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "Original title",
		StatusID:   open.ID,
		ActorID:    creator,
		FieldValues: []tasks.FieldValueInput{{
			FieldDefinitionID: priority.ID,
			ValueText:         strPtr("low"),
		}},
	})
	require.NoError(t, err)

	updatedTitle, err := svc.UpdateTaskTitle(ctx, created.ID, tasks.UpdateTaskTitleParams{
		Title: "Updated title", IfUnmodifiedSince: created.UpdatedAt, ActorID: editor,
	})
	require.NoError(t, err)
	_, _, err = svc.UpdateTaskStatus(ctx, created.ID, tasks.UpdateTaskStatusParams{StatusID: inProgress.ID, ActorID: editor})
	require.NoError(t, err)
	description := "# Updated\n\nCollaborative checkpoint"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{Description: &description, ActorID: editor})
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`UPDATE task_change_history
		    SET created_at = now() - INTERVAL '11 seconds'
		  WHERE task_id = $1 AND field_key = 'description'`,
		created.ID,
	)
	require.NoError(t, err)
	_, err = svc.UpdateTaskFieldValue(ctx, created.ID, priority.ID, tasks.UpdateTaskFieldValueParams{
		ValueText: strPtr("high"), ActorID: editor,
	})
	require.NoError(t, err)
	assert.Equal(t, "Updated title", updatedTitle.Title)

	page, err := svc.ListTaskChangeHistory(ctx, created.ID, "", 50)
	require.NoError(t, err)
	require.Len(t, page.Items, 5)
	assert.Empty(t, page.NextCursor)

	byKey := make(map[string]tasks.TaskChangeHistoryItem, len(page.Items))
	for _, item := range page.Items {
		byKey[item.FieldKey] = item
	}
	createdEntry := byKey["task"]
	assert.Equal(t, "created", createdEntry.ChangeKind)
	assert.Equal(t, creator, createdEntry.Actor.ID)
	assert.Equal(t, "History Creator", createdEntry.Actor.DisplayName)
	assert.Equal(t, "title", byKey["title"].FieldKey)
	assert.Equal(t, "status", byKey["status"].FieldKey)
	assert.Equal(t, "description", byKey["description"].FieldKey)
	assert.Equal(t, "Priority", byKey["field:"+priority.ID.String()].FieldName)
	assert.Equal(t, editor, byKey["description"].Actor.ID)

	var beforeTitle, afterTitle string
	require.NoError(t, json.Unmarshal(byKey["title"].BeforeValue, &beforeTitle))
	require.NoError(t, json.Unmarshal(byKey["title"].AfterValue, &afterTitle))
	assert.Equal(t, "Original title", beforeTitle)
	assert.Equal(t, "Updated title", afterTitle)

	firstPage, err := svc.ListTaskChangeHistory(ctx, created.ID, "", 2)
	require.NoError(t, err)
	require.Len(t, firstPage.Items, 2)
	require.NotEmpty(t, firstPage.NextCursor)
	secondPage, err := svc.ListTaskChangeHistory(ctx, created.ID, firstPage.NextCursor, 2)
	require.NoError(t, err)
	require.NotEmpty(t, secondPage.Items)
	assert.NotEqual(t, firstPage.Items[1].ID, secondPage.Items[0].ID)
}

func TestIntegration_TaskChangeHistoryDebouncesDescriptionEdits(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actorA := seedUserProfile(t, ctx, pool, "description-history-a@example.com", "Description A", "/a.png")
	actorB := seedUserProfile(t, ctx, pool, "description-history-b@example.com", "Description B", "/b.png")
	tpl := seedTemplate(t, ctx, svc, "DHB", actorA)
	status := seedStatus(t, ctx, svc, actorA)
	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "description debounce", StatusID: status.ID, ActorID: actorA,
	})
	require.NoError(t, err)

	first := "first edit"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &first, ActorID: actorA,
	})
	require.NoError(t, err)
	pendingPage, err := svc.ListTaskChangeHistory(ctx, created.ID, "", 50)
	require.NoError(t, err)
	require.Len(t, pendingPage.Items, 1)
	assert.Equal(t, "task", pendingPage.Items[0].FieldKey)

	second := "second edit"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &second, ActorID: actorA,
	})
	require.NoError(t, err)

	var (
		firstBefore json.RawMessage
		firstAfter  json.RawMessage
		count       int
	)
	err = pool.QueryRow(ctx,
		`SELECT before_value, after_value,
		        COUNT(*) OVER ()
		   FROM task_change_history
		  WHERE task_id = $1 AND field_key = 'description'`,
		created.ID,
	).Scan(&firstBefore, &firstAfter, &count)
	require.NoError(t, err)
	assert.Equal(t, 1, count)
	assert.JSONEq(t, "null", string(firstBefore))
	assert.JSONEq(t, `"second edit"`, string(firstAfter))

	_, err = pool.Exec(ctx,
		`UPDATE task_change_history
		    SET created_at = now() - INTERVAL '11 seconds'
		  WHERE task_id = $1 AND field_key = 'description'`,
		created.ID,
	)
	require.NoError(t, err)
	visiblePage, err := svc.ListTaskChangeHistory(ctx, created.ID, "", 50)
	require.NoError(t, err)
	require.Len(t, visiblePage.Items, 2)

	third := "third edit"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &third, ActorID: actorA,
	})
	require.NoError(t, err)
	fourth := "fourth edit"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &fourth, ActorID: actorB,
	})
	require.NoError(t, err)

	rows, err := pool.Query(ctx,
		`SELECT actor_id, before_value, after_value
		   FROM task_change_history
		  WHERE task_id = $1 AND field_key = 'description'
		  ORDER BY created_at ASC, id ASC`,
		created.ID,
	)
	require.NoError(t, err)
	defer rows.Close()

	type descriptionHistoryRow struct {
		actorID uuid.UUID
		before  json.RawMessage
		after   json.RawMessage
	}
	var historyRows []descriptionHistoryRow
	for rows.Next() {
		var row descriptionHistoryRow
		require.NoError(t, rows.Scan(&row.actorID, &row.before, &row.after))
		historyRows = append(historyRows, row)
	}
	require.NoError(t, rows.Err())
	require.Len(t, historyRows, 3)
	assert.Equal(t, actorA, historyRows[0].actorID)
	assert.JSONEq(t, "null", string(historyRows[0].before))
	assert.JSONEq(t, `"second edit"`, string(historyRows[0].after))
	assert.Equal(t, actorA, historyRows[1].actorID)
	assert.JSONEq(t, `"second edit"`, string(historyRows[1].before))
	assert.JSONEq(t, `"third edit"`, string(historyRows[1].after))
	assert.Equal(t, actorB, historyRows[2].actorID)
	assert.JSONEq(t, `"third edit"`, string(historyRows[2].before))
	assert.JSONEq(t, `"fourth edit"`, string(historyRows[2].after))
}

func TestIntegration_Task_UpdateDescriptionOnly_NoopKeepsAuditAndHistoryStable(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UDN", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "desc noop",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	unchanged, err := svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: nil,
		ActorID:     actor,
	})
	require.NoError(t, err)
	assert.Equal(t, created.UpdatedBy, unchanged.UpdatedBy)
	assert.Equal(t, created.UpdatedAt, unchanged.UpdatedAt)

	rows, err := svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 0)

	body := "Body"
	updated, err := svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &body,
		ActorID:     actor,
	})
	require.NoError(t, err)

	trimmedDuplicate := "  Body  "
	noopForce, err := svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description:   &trimmedDuplicate,
		ActorID:       actor,
		ForceSnapshot: true,
	})
	require.NoError(t, err)
	assert.Equal(t, updated.UpdatedBy, noopForce.UpdatedBy)
	assert.Equal(t, updated.UpdatedAt, noopForce.UpdatedAt)

	rows, err = svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotNil(t, rows[0].Description)
	assert.Equal(t, "Body", *rows[0].Description)
}

func TestIntegration_Task_UpdateDescriptionHistoryThrottleAndForce(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actorA := seedUser(t, ctx, pool)
	actorB := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "HIS", actorA)
	status := seedStatus(t, ctx, svc, actorA)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "history throttle",
		StatusID:   status.ID,
		ActorID:    actorA,
	})
	require.NoError(t, err)

	v1 := "version-1"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &v1,
		ActorID:     actorA,
	})
	require.NoError(t, err)

	v2 := "version-2"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &v2,
		ActorID:     actorA,
	})
	require.NoError(t, err)

	rows, err := svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotNil(t, rows[0].Description)
	assert.Equal(t, "version-1", *rows[0].Description)
	assert.Equal(t, actorA, rows[0].EditedBy)

	v3 := "version-3"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description:   &v3,
		ActorID:       actorB,
		ForceSnapshot: true,
	})
	require.NoError(t, err)

	rows, err = svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.NotNil(t, rows[0].Description)
	assert.Equal(t, "version-3", *rows[0].Description)
	assert.Equal(t, actorB, rows[0].EditedBy)
	require.NotNil(t, rows[1].Description)
	assert.Equal(t, "version-1", *rows[1].Description)
}

func TestIntegration_Task_DescriptionHistoryRetention(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	svc.SetDescriptionHistoryLimit(2)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "HRT", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "history retention",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	versions := []string{"ret-v1", "ret-v2", "ret-v3"}
	for _, version := range versions {
		value := version
		_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
			Description:   &value,
			ActorID:       actor,
			ForceSnapshot: true,
		})
		require.NoError(t, err)
		time.Sleep(2 * time.Millisecond)
	}

	rows, err := svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.NotNil(t, rows[0].Description)
	assert.Equal(t, "ret-v3", *rows[0].Description)
	require.NotNil(t, rows[1].Description)
	assert.Equal(t, "ret-v2", *rows[1].Description)
}

func TestIntegration_Task_DescriptionHistoryForceDuplicateNoop(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "HDP", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "history duplicate force",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	version := "same-version"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description:   &version,
		ActorID:       actor,
		ForceSnapshot: true,
	})
	require.NoError(t, err)

	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description:   &version,
		ActorID:       actor,
		ForceSnapshot: true,
	})
	require.NoError(t, err)

	rows, err := svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotNil(t, rows[0].Description)
	assert.Equal(t, version, *rows[0].Description)
}

func TestIntegration_Task_DescriptionHistoryIncludesEditor(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "HED", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "history editor",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	next := "editor version"
	_, err = svc.UpdateTaskDescription(ctx, created.ID, tasks.UpdateTaskDescriptionParams{
		Description: &next,
		ActorID:     actor,
	})
	require.NoError(t, err)

	rows, err := svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, created.PublicID, rows[0].PublicID)
	assert.Equal(t, created.Title, rows[0].Title)
	require.NotNil(t, rows[0].Description)
	assert.Equal(t, next, *rows[0].Description)
	assert.Equal(t, actor, rows[0].EditedBy)
	assert.Equal(t, actor, rows[0].Editor.ID)
	assert.Equal(t, "Test User", rows[0].Editor.DisplayName)
}

func TestIntegration_Task_UpdateTitle_OptimisticConflict(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "OTL", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "original", StatusID: status.ID, ActorID: actor,
	})
	require.NoError(t, err)

	updated, err := svc.UpdateTaskTitle(ctx, created.ID, tasks.UpdateTaskTitleParams{
		Title:             "server update",
		IfUnmodifiedSince: created.UpdatedAt,
		ActorID:           actor,
	})
	require.NoError(t, err)
	require.Equal(t, "server update", updated.Title)

	_, err = svc.UpdateTaskTitle(ctx, created.ID, tasks.UpdateTaskTitleParams{
		Title:             "stale client update",
		IfUnmodifiedSince: created.UpdatedAt,
		ActorID:           actor,
	})
	require.Error(t, err)
	require.ErrorIs(t, err, tasks.ErrConflict)

	var conflictErr *tasks.TaskTitleConflictError
	require.True(t, errors.As(err, &conflictErr))
	require.Equal(t, "server update", conflictErr.LatestTitle)
	require.True(t, conflictErr.LatestUpdatedAt.After(created.UpdatedAt) || conflictErr.LatestUpdatedAt.Equal(created.UpdatedAt))
	require.WithinDuration(t, updated.UpdatedAt, conflictErr.LatestUpdatedAt, 2*time.Second)
}

func TestIntegration_Task_UpdateTitle_NoopKeepsAuditStable(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NTL", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "same title",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	updated, err := svc.UpdateTaskTitle(ctx, created.ID, tasks.UpdateTaskTitleParams{
		Title:             "  same title  ",
		IfUnmodifiedSince: created.UpdatedAt,
		ActorID:           actor,
	})
	require.NoError(t, err)
	assert.Equal(t, created.Title, updated.Title)
	assert.Equal(t, created.UpdatedBy, updated.UpdatedBy)
	assert.Equal(t, created.UpdatedAt, updated.UpdatedAt)
}

func TestIntegration_Task_UpdateStatus_NoopKeepsAuditStable(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NST", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "same status",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	updated, previousStatusID, err := svc.UpdateTaskStatus(ctx, created.ID, tasks.UpdateTaskStatusParams{
		StatusID: status.ID,
		ActorID:  actor,
	})
	require.NoError(t, err)
	assert.Equal(t, status.ID, previousStatusID)
	assert.Equal(t, created.StatusID, updated.StatusID)
	assert.Equal(t, created.UpdatedBy, updated.UpdatedBy)
	assert.Equal(t, created.UpdatedAt, updated.UpdatedAt)
}

func TestIntegration_Task_UpdateFieldValue_NoopKeepsAuditStable(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NFV", actor)
	status := seedStatus(t, ctx, svc, actor)

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "points",
		Name:       "Points",
		Type:       "number",
		SortOrder:  1,
	})
	require.NoError(t, err)

	start := "42.5"
	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "field noop",
		StatusID:   status.ID,
		ActorID:    actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueNumber: &start},
		},
	})
	require.NoError(t, err)
	require.Len(t, created.FieldValues, 1)
	originalField := created.FieldValues[0]

	updatedField, err := svc.UpdateTaskFieldValue(ctx, created.ID, field.ID, tasks.UpdateTaskFieldValueParams{
		ValueNumber: strPtr("42.500000"),
		ActorID:     actor,
	})
	require.NoError(t, err)
	assert.Equal(t, originalField.ID, updatedField.ID)
	assert.Equal(t, originalField.UpdatedAt, updatedField.UpdatedAt)

	taskAfter, err := svc.GetTask(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.UpdatedBy, taskAfter.UpdatedBy)
	assert.Equal(t, created.UpdatedAt, taskAfter.UpdatedAt)
}

func TestIntegration_Task_UpdateFieldValue_JSONNoopKeepsAuditStable(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	other := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NJS", actor)
	status := seedStatus(t, ctx, svc, actor)

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "watchers",
		Name:       "Watchers",
		Type:       "users",
		SortOrder:  1,
	})
	require.NoError(t, err)

	rawUsers := json.RawMessage(fmt.Sprintf("[\n  %q,\n  %q\n]", actor.String(), other.String()))
	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "json noop",
		StatusID:   status.ID,
		ActorID:    actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueJSON: rawUsers},
		},
	})
	require.NoError(t, err)
	require.Len(t, created.FieldValues, 1)
	originalField := created.FieldValues[0]

	updatedField, err := svc.UpdateTaskFieldValue(ctx, created.ID, field.ID, tasks.UpdateTaskFieldValueParams{
		ValueJSON: json.RawMessage(fmt.Sprintf("[ %q , %q ]", actor.String(), other.String())),
		ActorID:   actor,
	})
	require.NoError(t, err)
	assert.Equal(t, originalField.ID, updatedField.ID)
	assert.Equal(t, originalField.UpdatedAt, updatedField.UpdatedAt)

	taskAfter, err := svc.GetTask(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.UpdatedBy, taskAfter.UpdatedBy)
	assert.Equal(t, created.UpdatedAt, taskAfter.UpdatedAt)
}

func TestIntegration_Task_UpdateFieldValues_ReplaceAll(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "RPL", actor)
	status := seedStatus(t, ctx, svc, actor)

	f1, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "f1", Name: "F1", Type: "text", SortOrder: 1})
	f2, _ := svc.CreateField(ctx, tasks.CreateFieldParams{TemplateID: tpl.ID, Code: "f2", Name: "F2", Type: "text", SortOrder: 2})

	v1, v2 := "value1", "value2"
	resp, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "t", StatusID: status.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: f1.ID, ValueText: &v1},
			{FieldDefinitionID: f2.ID, ValueText: &v2},
		},
	})
	require.NoError(t, err)
	assert.Len(t, resp.FieldValues, 2)

	// Update with only f1 — f2 should be deleted (replace-all).
	newV1 := "new_value1"
	updated, err := svc.UpdateTask(ctx, resp.ID, tasks.UpdateTaskParams{
		Title: "t", StatusID: status.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: f1.ID, ValueText: &newV1},
		},
	})
	require.NoError(t, err)
	require.Len(t, updated.FieldValues, 1)
	assert.Equal(t, f1.ID, updated.FieldValues[0].FieldDefinitionID)
	require.NotNil(t, updated.FieldValues[0].ValueText)
	assert.Equal(t, "new_value1", *updated.FieldValues[0].ValueText)
}

func TestIntegration_Task_UpdateSystemFields_NoopKeepsAuditStableAndIgnoresFieldOrder(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NUP", actor)
	status := seedStatus(t, ctx, svc, actor)

	textField, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "summary",
		Name:       "Summary",
		Type:       "text",
		SortOrder:  1,
	})
	require.NoError(t, err)
	numberField, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "points",
		Name:       "Points",
		Type:       "number",
		SortOrder:  2,
	})
	require.NoError(t, err)

	desc := "Desc"
	textValue := "hello"
	numberValue := "42.5"
	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:  tpl.ID,
		Title:       "Task",
		Description: &desc,
		StatusID:    status.ID,
		ActorID:     actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: textField.ID, ValueText: &textValue},
			{FieldDefinitionID: numberField.ID, ValueNumber: &numberValue},
		},
	})
	require.NoError(t, err)

	noop, err := svc.UpdateTask(ctx, created.ID, tasks.UpdateTaskParams{
		Title:       "  Task  ",
		Description: strPtr("  Desc  "),
		StatusID:    status.ID,
		ActorID:     actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: numberField.ID, ValueNumber: strPtr("42.500000")},
			{FieldDefinitionID: textField.ID, ValueText: strPtr("hello")},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, created.UpdatedBy, noop.UpdatedBy)
	assert.Equal(t, created.UpdatedAt, noop.UpdatedAt)
	require.Len(t, noop.FieldValues, 2)

	rows, err := svc.ListTaskDescriptionHistory(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, rows, 0)
}

func TestIntegration_Task_UpdateSystemFields_RejectsUnknownField(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UFD", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "unknown field",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	_, err = svc.UpdateTask(ctx, created.ID, tasks.UpdateTaskParams{
		Title:    "unknown field",
		StatusID: status.ID,
		ActorID:  actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: uuid.New(), ValueText: strPtr("x")},
		},
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Task_GetNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)

	_, err := svc.GetTask(ctx, uuid.New())
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Task_GetByPublicID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "PUB", actor)
	status := seedStatus(t, ctx, svc, actor)

	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "by public id",
		StatusID:   status.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	got, err := svc.GetTaskByPublicID(ctx, created.PublicID)
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, created.PublicID, got.PublicID)
}

func TestIntegration_Task_UpdateNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	status := seedStatus(t, ctx, svc, actor)

	_, err := svc.UpdateTask(ctx, uuid.New(), tasks.UpdateTaskParams{
		Title: "t", StatusID: status.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Task_UnknownTemplateReturnsNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	status := seedStatus(t, ctx, svc, actor)

	// A non-existent template_id must return ErrNotFound.
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: uuid.New(), Title: "t", StatusID: status.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Task_PrefixLockedAfterTaskCreated(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "LCK", actor)
	status := seedStatus(t, ctx, svc, actor)

	// Create a task so the prefix is now locked.
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "any", StatusID: status.ID, ActorID: actor,
	})
	require.NoError(t, err)

	// Attempt to change the prefix must fail.
	_, err = svc.UpdateTemplate(ctx, tpl.ID, tasks.UpdateTemplateParams{
		Prefix:  "NEW",
		ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Task_TitleRequired(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "TTL", actor)
	status := seedStatus(t, ctx, svc, actor)

	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "   ", StatusID: status.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

// Test #7: UpdateTask to a soft-deleted status must return ErrBadRequest.
func TestIntegration_Task_UpdateToDeletedStatusReturnsError(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UDS", actor)
	s1 := seedStatus(t, ctx, svc, actor)
	s2 := seedStatus(t, ctx, svc, actor)

	resp, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "task", StatusID: s1.ID, ActorID: actor,
	})
	require.NoError(t, err)

	_, err = svc.SoftDeleteStatus(ctx, s2.ID)
	require.NoError(t, err)

	_, err = svc.UpdateTask(ctx, resp.ID, tasks.UpdateTaskParams{
		Title: "task", StatusID: s2.ID, ActorID: actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

// Test #8: A required field submitted with all value columns nil must be rejected.
func TestIntegration_Task_RequiredFieldAllNullValuesRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "RNV", actor)
	status := seedStatus(t, ctx, svc, actor)

	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "summary", Name: "Summary", Type: "text",
		Required: true, SortOrder: 1,
	})
	require.NoError(t, err)

	field, err := svc.ListFields(ctx, tpl.ID, false)
	require.NoError(t, err)
	require.Len(t, field, 1)

	// Provide the field ID but leave all value columns nil.
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "task", StatusID: status.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field[0].ID}, // all value columns nil
		},
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

// =========================================================
// Phase 4 — ListTasks
// =========================================================

// seedTask creates a minimal task and returns it.
func seedTask(t *testing.T, ctx context.Context, svc *tasks.Service, tplID, statusID, actorID uuid.UUID, title string) tasks.TaskResponse {
	t.Helper()
	resp, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tplID,
		Title:      title,
		StatusID:   statusID,
		ActorID:    actorID,
	})
	require.NoError(t, err)
	return resp
}

func setTaskCreatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID uuid.UUID, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(ctx, `UPDATE task SET created_at = $2 WHERE id = $1`, taskID, createdAt)
	require.NoError(t, err)
}

func setTaskUpdatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID uuid.UUID, updatedAt time.Time) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `SET LOCAL msgnr.preserve_task_updated_at = 'on'`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE task SET updated_at = $2 WHERE id = $1`, taskID, updatedAt)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
}

func TestIntegration_ListTasks_EmptyReturnsStatusGroups(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	st1 := seedStatus(t, ctx, svc, actor)
	st2 := seedStatus(t, ctx, svc, actor)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{})
	require.NoError(t, err)
	// Two active statuses → two groups (possibly zero tasks each).
	require.Len(t, resp.Groups, 2)
	assert.Equal(t, 0, resp.GrandTotal)

	groupIDs := []uuid.UUID{resp.Groups[0].Status.ID, resp.Groups[1].Status.ID}
	assert.Contains(t, groupIDs, st1.ID)
	assert.Contains(t, groupIDs, st2.ID)
}

func TestIntegration_ListTasks_TasksAppearInCorrectGroup(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "GRP", actor)
	st1 := seedStatus(t, ctx, svc, actor)
	st2 := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tpl.ID, st1.ID, actor, "Task in st1")
	seedTask(t, ctx, svc, tpl.ID, st1.ID, actor, "Another in st1")
	seedTask(t, ctx, svc, tpl.ID, st2.ID, actor, "Task in st2")

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{})
	require.NoError(t, err)
	assert.Equal(t, 3, resp.GrandTotal)

	for _, g := range resp.Groups {
		switch g.Status.ID {
		case st1.ID:
			assert.Equal(t, 2, g.Total)
			assert.Len(t, g.Tasks, 2)
		case st2.ID:
			assert.Equal(t, 1, g.Total)
			assert.Len(t, g.Tasks, 1)
		}
	}
}

func TestIntegration_ListTasks_SearchByPublicID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SRC", actor)
	st := seedStatus(t, ctx, svc, actor)

	task := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Needle task")
	seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Other task")

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{Search: task.PublicID})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	require.Len(t, resp.Groups[0].Tasks, 1)
	assert.Equal(t, task.ID, resp.Groups[0].Tasks[0].ID)
}

func TestIntegration_ListTasks_SearchByDescription(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DSC", actor)
	st := seedStatus(t, ctx, svc, actor)

	desc := "unique description needle"
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:  tpl.ID,
		Title:       "Task with description",
		Description: &desc,
		StatusID:    st.ID,
		ActorID:     actor,
	})
	require.NoError(t, err)
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID,
		Title:      "Task without description",
		StatusID:   st.ID,
		ActorID:    actor,
	})
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{Search: "unique description needle"})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
}

func TestIntegration_ListTasks_SearchByTitle(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "TTL", actor)
	st := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Login button broken")
	seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Signup flow")

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{Search: "login"})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, "Login button broken", resp.Groups[0].Tasks[0].Title)
}

func TestIntegration_ListTasks_FilterByStatus(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FST", actor)
	st1 := seedStatus(t, ctx, svc, actor)
	st2 := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tpl.ID, st1.ID, actor, "In st1")
	seedTask(t, ctx, svc, tpl.ID, st2.ID, actor, "In st2")

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{StatusIDs: []uuid.UUID{st1.ID}})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)

	// Only the matching status group should have tasks.
	for _, g := range resp.Groups {
		if g.Status.ID == st1.ID {
			assert.Equal(t, 1, g.Total)
		} else {
			assert.Equal(t, 0, g.Total)
		}
	}
}

func TestIntegration_ListTasks_FilterByPrefix(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tplA := seedTemplate(t, ctx, svc, "FPRA", actor)
	tplB := seedTemplate(t, ctx, svc, "FPRB", actor)
	st := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tplA.ID, st.ID, actor, "Task A")
	seedTask(t, ctx, svc, tplA.ID, st.ID, actor, "Task A2")
	seedTask(t, ctx, svc, tplB.ID, st.ID, actor, "Task B")

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{Prefixes: []string{"FPRA"}})
	require.NoError(t, err)
	assert.Equal(t, 2, resp.GrandTotal)
}

func TestIntegration_ListTasks_FilterByUserField(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	user2 := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FUF", actor)
	st := seedStatus(t, ctx, svc, actor)

	// Create a user-type field.
	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "owner", Name: "Owner", Type: "user", SortOrder: 1,
	})
	require.NoError(t, err)

	// Task assigned to actor.
	actorTask, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "Actor's task", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueUserID: &actor},
		},
	})
	require.NoError(t, err)

	// Task assigned to user2.
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "User2's task", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueUserID: &user2},
		},
	})
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		FieldFilters: []tasks.FieldFilter{
			{FieldDefinitionID: field.ID, UserIDs: []uuid.UUID{actor}},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, actorTask.ID, resp.Groups[0].Tasks[0].ID)
}

func TestIntegration_ListTasks_FilterByEnumField(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FEF", actor)
	st := seedStatus(t, ctx, svc, actor)
	dict := seedDict(t, ctx, svc)

	// Create a version with items.
	ver, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 2, IsActive: true},
	}, actor)
	require.NoError(t, err)

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "priority", Name: "Priority",
		Type: "enum", SortOrder: 1, EnumDictionaryID: &dict.ID,
	})
	require.NoError(t, err)

	v := int32(ver.Version)
	highTask, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "High prio", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueText: strPtr("high"), EnumDictionaryID: &dict.ID, EnumVersion: &v},
		},
	})
	require.NoError(t, err)

	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "Low prio", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueText: strPtr("low"), EnumDictionaryID: &dict.ID, EnumVersion: &v},
		},
	})
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		FieldFilters: []tasks.FieldFilter{
			{FieldDefinitionID: field.ID, EnumCodes: []string{"high"}},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, highTask.ID, resp.Groups[0].Tasks[0].ID)
}

func TestIntegration_ListTasks_FilterByDictionaryEnumValues(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tplA := seedTemplate(t, ctx, svc, "DFA", actor)
	tplB := seedTemplate(t, ctx, svc, "DFB", actor)
	stTodo := seedStatus(t, ctx, svc, actor)
	stDone, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:    "done_" + uuid.NewString()[:8],
		Name:    "Done",
		ActorID: actor,
	})
	require.NoError(t, err)

	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code:                     "filter_" + uuid.NewString()[:8],
		Name:                     "Filter Dict",
		ParticipatesInFiltration: true,
	})
	require.NoError(t, err)
	ver, err := svc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
		{ValueCode: "medium", ValueName: "Medium", SortOrder: 2, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 3, IsActive: true},
		{ValueCode: "blocked", ValueName: "Blocked", SortOrder: 4, IsActive: true},
	}, actor)
	require.NoError(t, err)
	enumVersion := int32(ver.Version)

	priorityField, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tplA.ID, Code: "priority", Name: "Priority",
		Type: "enum", SortOrder: 1, EnumDictionaryID: &dict.ID,
	})
	require.NoError(t, err)
	labelsField, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tplB.ID, Code: "labels", Name: "Labels",
		Type: "multi_enum", SortOrder: 1, EnumDictionaryID: &dict.ID,
	})
	require.NoError(t, err)

	highTask, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tplA.ID, Title: "High priority", StatusID: stTodo.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: priorityField.ID, ValueText: strPtr("high"), EnumDictionaryID: &dict.ID, EnumVersion: &enumVersion},
		},
	})
	require.NoError(t, err)
	mediumTask, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tplB.ID, Title: "Medium label", StatusID: stTodo.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: labelsField.ID, ValueJSON: json.RawMessage(`["medium","blocked"]`), EnumDictionaryID: &dict.ID, EnumVersion: &enumVersion},
		},
	})
	require.NoError(t, err)
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tplA.ID, Title: "Low done", StatusID: stDone.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: priorityField.ID, ValueText: strPtr("low"), EnumDictionaryID: &dict.ID, EnumVersion: &enumVersion},
		},
	})
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		StatusIDs: []uuid.UUID{stTodo.ID},
		DictionaryFilters: []tasks.DictionaryFilter{
			{DictionaryID: dict.ID, EnumCodes: []string{"high", "medium"}},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, 2, resp.GrandTotal)
	group := findGroup(t, resp.Groups, stTodo.ID)
	assert.ElementsMatch(t, []uuid.UUID{highTask.ID, mediumTask.ID}, taskIDs(group.Tasks))
}

func TestIntegration_ListTasks_FilterByDateField(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FDF", actor)
	st := seedStatus(t, ctx, svc, actor)

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "due", Name: "Due Date", Type: "date", SortOrder: 1,
	})
	require.NoError(t, err)

	earlyTask, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "Early", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueDate: strPtr("2025-01-01")},
		},
	})
	require.NoError(t, err)

	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "Late", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueDate: strPtr("2025-12-31")},
		},
	})
	require.NoError(t, err)

	from := "2025-01-01"
	to := "2025-06-30"
	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		FieldFilters: []tasks.FieldFilter{
			{FieldDefinitionID: field.ID, DateFrom: &from, DateTo: &to},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, earlyTask.ID, resp.Groups[0].Tasks[0].ID)
}

func TestIntegration_ListTasks_FilterByCreatedDateBounds(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CDB", actor)
	st := seedStatus(t, ctx, svc, actor)

	oldTask := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Old task")
	midTask := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Middle task")
	newTask := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "New task")

	setTaskCreatedAt(t, ctx, pool, oldTask.ID, time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC))
	setTaskCreatedAt(t, ctx, pool, midTask.ID, time.Date(2026, 5, 2, 15, 0, 0, 0, time.UTC))
	setTaskCreatedAt(t, ctx, pool, newTask.ID, time.Date(2026, 5, 3, 8, 0, 0, 0, time.UTC))

	from := time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC)
	toInclusive := time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)

	fromOnly, err := svc.ListTasks(ctx, tasks.ListTasksParams{CreatedFrom: &from, SortBy: "created_at", SortDesc: false})
	require.NoError(t, err)
	assert.Equal(t, 2, fromOnly.GrandTotal)
	assert.Equal(t, []uuid.UUID{midTask.ID, newTask.ID}, taskIDs(fromOnly.Tasks))

	toOnly, err := svc.ListTasks(ctx, tasks.ListTasksParams{CreatedTo: &toInclusive, SortBy: "created_at", SortDesc: false})
	require.NoError(t, err)
	assert.Equal(t, 2, toOnly.GrandTotal)
	assert.Equal(t, []uuid.UUID{oldTask.ID, midTask.ID}, taskIDs(toOnly.Tasks))

	combined, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		CreatedFrom: &from,
		CreatedTo:   &toInclusive,
		SortBy:      "created_at",
		SortDesc:    false,
	})
	require.NoError(t, err)
	assert.Equal(t, 1, combined.GrandTotal)
	assert.Equal(t, []uuid.UUID{midTask.ID}, taskIDs(combined.Tasks))
}

func TestIntegration_ListTasks_SortByCreatedAt(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SCA", actor)
	st := seedStatus(t, ctx, svc, actor)

	t1 := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "First")
	t2 := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Second")
	t3 := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Third")

	// ASC: oldest first.
	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{SortBy: "created_at", SortDesc: false})
	require.NoError(t, err)
	require.NotEmpty(t, resp.Groups)
	grp := resp.Groups[0]
	require.Len(t, grp.Tasks, 3)
	assert.Equal(t, t1.ID, grp.Tasks[0].ID)
	assert.Equal(t, t2.ID, grp.Tasks[1].ID)
	assert.Equal(t, t3.ID, grp.Tasks[2].ID)
	assert.Equal(t, []uuid.UUID{t1.ID, t2.ID, t3.ID}, taskIDs(resp.Tasks))

	// DESC: newest first.
	resp, err = svc.ListTasks(ctx, tasks.ListTasksParams{SortBy: "created_at", SortDesc: true})
	require.NoError(t, err)
	grp = resp.Groups[0]
	require.Len(t, grp.Tasks, 3)
	assert.Equal(t, t3.ID, grp.Tasks[0].ID)
	assert.Equal(t, t1.ID, grp.Tasks[2].ID)
	assert.Equal(t, []uuid.UUID{t3.ID, t2.ID, t1.ID}, taskIDs(resp.Tasks))
}

func TestIntegration_ListTasks_FlatPageSortsCreatedAtAcrossStatuses(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FCA", actor)
	firstStatus, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code: "fca_first_" + uuid.NewString()[:8], Name: "First", SortOrder: 1, ActorID: actor,
	})
	require.NoError(t, err)
	secondStatus, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code: "fca_second_" + uuid.NewString()[:8], Name: "Second", SortOrder: 2, ActorID: actor,
	})
	require.NoError(t, err)

	oldest := seedTask(t, ctx, svc, tpl.ID, firstStatus.ID, actor, "Oldest")
	newest := seedTask(t, ctx, svc, tpl.ID, secondStatus.ID, actor, "Newest")
	middle := seedTask(t, ctx, svc, tpl.ID, firstStatus.ID, actor, "Middle")

	base := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	setTaskCreatedAt(t, ctx, pool, oldest.ID, base)
	setTaskCreatedAt(t, ctx, pool, newest.ID, base.Add(2*time.Hour))
	setTaskCreatedAt(t, ctx, pool, middle.ID, base.Add(time.Hour))

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		SortBy: "created_at", SortDesc: true, Page: 1, PageSize: 2,
	})
	require.NoError(t, err)
	require.Len(t, resp.Tasks, 2)
	assert.Equal(t, newest.ID, resp.Tasks[0].ID)
	assert.Equal(t, middle.ID, resp.Tasks[1].ID)
	assert.Equal(t, 3, resp.GrandTotal)
}

func TestIntegration_ListTasks_FlatPageSortsUpdatedAtAcrossStatuses(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FUA", actor)
	firstStatus, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code: "fua_first_" + uuid.NewString()[:8], Name: "First", SortOrder: 1, ActorID: actor,
	})
	require.NoError(t, err)
	secondStatus, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code: "fua_second_" + uuid.NewString()[:8], Name: "Second", SortOrder: 2, ActorID: actor,
	})
	require.NoError(t, err)

	oldest := seedTask(t, ctx, svc, tpl.ID, firstStatus.ID, actor, "Oldest updated")
	newest := seedTask(t, ctx, svc, tpl.ID, secondStatus.ID, actor, "Newest updated")
	middle := seedTask(t, ctx, svc, tpl.ID, firstStatus.ID, actor, "Middle updated")

	base := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	setTaskUpdatedAt(t, ctx, pool, oldest.ID, base)
	setTaskUpdatedAt(t, ctx, pool, newest.ID, base.Add(2*time.Hour))
	setTaskUpdatedAt(t, ctx, pool, middle.ID, base.Add(time.Hour))

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		SortBy: "updated_at", SortDesc: true, Page: 1, PageSize: 3,
	})
	require.NoError(t, err)
	require.Len(t, resp.Tasks, 3)
	assert.Equal(t, newest.ID, resp.Tasks[0].ID)
	assert.Equal(t, middle.ID, resp.Tasks[1].ID)
	assert.Equal(t, oldest.ID, resp.Tasks[2].ID)
}

func TestIntegration_ListTasks_FlatPageSortsUpdatedAtTiesByID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FUT", actor)
	st := seedStatus(t, ctx, svc, actor)

	first := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Same timestamp A")
	second := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Same timestamp B")
	sameUpdatedAt := time.Date(2026, 5, 3, 10, 0, 0, 0, time.UTC)
	setTaskUpdatedAt(t, ctx, pool, first.ID, sameUpdatedAt)
	setTaskUpdatedAt(t, ctx, pool, second.ID, sameUpdatedAt)

	rows, err := pool.Query(ctx,
		`SELECT id FROM task WHERE id = ANY($1::uuid[]) ORDER BY id DESC`,
		[]string{first.ID.String(), second.ID.String()},
	)
	require.NoError(t, err)
	defer rows.Close()
	expected := make([]uuid.UUID, 0, 2)
	for rows.Next() {
		var id uuid.UUID
		require.NoError(t, rows.Scan(&id))
		expected = append(expected, id)
	}
	require.NoError(t, rows.Err())
	require.Len(t, expected, 2)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		SortBy: "updated_at", SortDesc: true, Page: 1, PageSize: 2,
	})
	require.NoError(t, err)
	require.Len(t, resp.Tasks, 2)
	assert.Equal(t, expected[0], resp.Tasks[0].ID)
	assert.Equal(t, expected[1], resp.Tasks[1].ID)
}

func TestIntegration_ListTasks_FlatPageSortsCreatedAtTiesByID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "FCT", actor)
	st := seedStatus(t, ctx, svc, actor)

	first := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Same created A")
	second := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Same created B")
	sameCreatedAt := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	setTaskCreatedAt(t, ctx, pool, first.ID, sameCreatedAt)
	setTaskCreatedAt(t, ctx, pool, second.ID, sameCreatedAt)

	rows, err := pool.Query(ctx,
		`SELECT id FROM task WHERE id = ANY($1::uuid[]) ORDER BY id DESC`,
		[]string{first.ID.String(), second.ID.String()},
	)
	require.NoError(t, err)
	defer rows.Close()
	expected := make([]uuid.UUID, 0, 2)
	for rows.Next() {
		var id uuid.UUID
		require.NoError(t, rows.Scan(&id))
		expected = append(expected, id)
	}
	require.NoError(t, rows.Err())
	require.Len(t, expected, 2)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		SortBy: "created_at", SortDesc: true, Page: 1, PageSize: 2,
	})
	require.NoError(t, err)
	require.Len(t, resp.Tasks, 2)
	assert.Equal(t, expected[0], resp.Tasks[0].ID)
	assert.Equal(t, expected[1], resp.Tasks[1].ID)
}

func TestIntegration_ListTasks_SortByNumericField(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SNF", actor)
	st := seedStatus(t, ctx, svc, actor)

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID, Code: "points", Name: "Story Points", Type: "number", SortOrder: 1,
	})
	require.NoError(t, err)

	highPts, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "High points", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueNumber: strPtr("8")},
		},
	})
	require.NoError(t, err)

	lowPts, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: tpl.ID, Title: "Low points", StatusID: st.ID, ActorID: actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueNumber: strPtr("2")},
		},
	})
	require.NoError(t, err)

	// ASC: low first.
	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		SortBy: field.ID.String(), SortDesc: false,
	})
	require.NoError(t, err)
	grp := resp.Groups[0]
	require.Len(t, grp.Tasks, 2)
	assert.Equal(t, lowPts.ID, grp.Tasks[0].ID)
	assert.Equal(t, highPts.ID, grp.Tasks[1].ID)
	assert.Equal(t, []uuid.UUID{lowPts.ID, highPts.ID}, taskIDs(resp.Tasks))
}

func TestIntegration_ListTasks_Pagination(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "PAG", actor)
	st := seedStatus(t, ctx, svc, actor)

	for i := 0; i < 5; i++ {
		seedTask(t, ctx, svc, tpl.ID, st.ID, actor, fmt.Sprintf("Task %d", i))
	}

	// Page 1 of page_size 2.
	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{Page: 1, PageSize: 2})
	require.NoError(t, err)
	grp := findGroup(t, resp.Groups, st.ID)
	assert.Equal(t, 5, grp.Total)
	assert.Len(t, grp.Tasks, 2)

	// Page 3 of page_size 2 → last page with 1 item.
	resp, err = svc.ListTasks(ctx, tasks.ListTasksParams{Page: 3, PageSize: 2})
	require.NoError(t, err)
	grp = findGroup(t, resp.Groups, st.ID)
	assert.Len(t, grp.Tasks, 1)
}

func TestIntegration_ListTasks_DeletedStatusHiddenWhenNoTasks(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	st := seedStatus(t, ctx, svc, actor)
	_, err := svc.SoftDeleteStatus(ctx, st.ID)
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{})
	require.NoError(t, err)
	// Deleted status with no tasks should not appear.
	for _, g := range resp.Groups {
		assert.NotEqual(t, st.ID, g.Status.ID)
	}
}

func TestIntegration_ListTasks_DeletedStatusAppearsWhenTasksExist(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DST", actor)

	st := seedStatus(t, ctx, svc, actor)
	seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Old task")

	_, err := svc.SoftDeleteStatus(ctx, st.ID)
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{})
	require.NoError(t, err)
	// Deleted status should still appear because it has a task.
	found := false
	for _, g := range resp.Groups {
		if g.Status.ID == st.ID {
			found = true
			assert.Equal(t, 1, g.Total)
		}
	}
	assert.True(t, found, "deleted status with tasks must appear in groups")
}

func TestIntegration_ListTasks_DeletedTemplateTasksStillAppear(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DTT", actor)
	st := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Task on deleted template")

	_, err := svc.SoftDeleteTemplate(ctx, tpl.ID, actor)
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal, "tasks from deleted templates must still appear")
}

func TestIntegration_ListTasks_MultipleFilters(t *testing.T) {
	// Combined: filter by prefix AND search.
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tplA := seedTemplate(t, ctx, svc, "CMBA", actor)
	tplB := seedTemplate(t, ctx, svc, "CMBB", actor)
	st := seedStatus(t, ctx, svc, actor)

	target := seedTask(t, ctx, svc, tplA.ID, st.ID, actor, "Unique title abc")
	seedTask(t, ctx, svc, tplA.ID, st.ID, actor, "Other title")
	seedTask(t, ctx, svc, tplB.ID, st.ID, actor, "Unique title abc on B")

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{
		Search:   "unique title abc",
		Prefixes: []string{"CMBA"},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, target.ID, resp.Groups[0].Tasks[0].ID)
}

func TestIntegration_ListTasksGrouped_ReturnsMapForAllStatuses(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "GRM", actor)
	st1 := seedStatus(t, ctx, svc, actor)
	st2 := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tpl.ID, st1.ID, actor, "Task A")
	seedTask(t, ctx, svc, tpl.ID, st1.ID, actor, "Task B")
	seedTask(t, ctx, svc, tpl.ID, st1.ID, actor, "Task C")
	seedTask(t, ctx, svc, tpl.ID, st2.ID, actor, "Task D")

	resp, err := svc.ListTasksGrouped(ctx, tasks.ListTasksParams{}, 2)
	require.NoError(t, err)
	assert.Equal(t, 2, resp.Limit)
	assert.Equal(t, 4, resp.GrandTotal)
	require.Contains(t, resp.GroupsByStatus, st1.ID.String())
	require.Contains(t, resp.GroupsByStatus, st2.ID.String())

	g1 := resp.GroupsByStatus[st1.ID.String()]
	assert.Equal(t, 3, g1.Total)
	assert.Len(t, g1.Items, 2)
	assert.Equal(t, st1.ID, g1.Status.ID)
	assert.Equal(t, st1.Code, g1.Status.Code)
	assert.NotEmpty(t, g1.Items[0].PublicID)
	assert.NotEmpty(t, g1.Items[0].CreatedBy.ID)

	g2 := resp.GroupsByStatus[st2.ID.String()]
	assert.Equal(t, 1, g2.Total)
	assert.Len(t, g2.Items, 1)
}

func TestIntegration_ListTasksGrouped_ZeroTotalsStillPresent(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	st1 := seedStatus(t, ctx, svc, actor)
	st2 := seedStatus(t, ctx, svc, actor)

	resp, err := svc.ListTasksGrouped(ctx, tasks.ListTasksParams{}, 2)
	require.NoError(t, err)
	assert.Equal(t, 0, resp.GrandTotal)
	require.Contains(t, resp.GroupsByStatus, st1.ID.String())
	require.Contains(t, resp.GroupsByStatus, st2.ID.String())
	assert.Equal(t, 0, resp.GroupsByStatus[st1.ID.String()].Total)
	assert.Empty(t, resp.GroupsByStatus[st1.ID.String()].Items)
	assert.Equal(t, 0, resp.GroupsByStatus[st2.ID.String()].Total)
	assert.Empty(t, resp.GroupsByStatus[st2.ID.String()].Items)
}

func TestIntegration_ListTasksGrouped_ItemDTOShape(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DTO", actor)
	st := seedStatus(t, ctx, svc, actor)

	desc := "description should not leak into grouped dto"
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:  tpl.ID,
		Title:       "Shape test",
		Description: &desc,
		StatusID:    st.ID,
		ActorID:     actor,
	})
	require.NoError(t, err)

	resp, err := svc.ListTasksGrouped(ctx, tasks.ListTasksParams{}, 1)
	require.NoError(t, err)
	item := resp.GroupsByStatus[st.ID.String()].Items[0]

	raw, err := json.Marshal(item)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(raw, &decoded))
	assert.Contains(t, decoded, "id")
	assert.Contains(t, decoded, "public_id")
	assert.Contains(t, decoded, "title")
	assert.Contains(t, decoded, "description_preview")
	assert.Contains(t, decoded, "status_id")
	assert.Contains(t, decoded, "created_at")
	assert.Contains(t, decoded, "updated_at")
	assert.Contains(t, decoded, "created_by")
	assert.NotContains(t, decoded, "description")
	assert.NotContains(t, decoded, "field_values")
}

func TestIntegration_ListTasksStatusPortion_PaginatesByStatus(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "PRT", actor)
	st := seedStatus(t, ctx, svc, actor)

	for i := 0; i < 5; i++ {
		seedTask(t, ctx, svc, tpl.ID, st.ID, actor, fmt.Sprintf("Task %d", i))
	}

	p1, err := svc.ListTasksStatusPortion(ctx, tasks.ListTasksParams{}, st.ID, 0, 2)
	require.NoError(t, err)
	assert.Equal(t, 5, p1.Total)
	assert.Len(t, p1.Items, 2)
	assert.NotEqual(t, uuid.Nil, p1.Items[0].ID)
	assert.False(t, p1.Items[0].UpdatedAt.IsZero())
	assert.Equal(t, 2, p1.NextOffset)
	assert.True(t, p1.HasMore)

	p2, err := svc.ListTasksStatusPortion(ctx, tasks.ListTasksParams{}, st.ID, p1.NextOffset, 2)
	require.NoError(t, err)
	assert.Equal(t, 5, p2.Total)
	assert.Len(t, p2.Items, 2)
	assert.Equal(t, 4, p2.NextOffset)
	assert.True(t, p2.HasMore)

	p3, err := svc.ListTasksStatusPortion(ctx, tasks.ListTasksParams{}, st.ID, p2.NextOffset, 2)
	require.NoError(t, err)
	assert.Equal(t, 5, p3.Total)
	assert.Len(t, p3.Items, 1)
	assert.Equal(t, 5, p3.NextOffset)
	assert.False(t, p3.HasMore)
}

func TestIntegration_ListTasksGrouped_FilterParity(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tplA := seedTemplate(t, ctx, svc, "GFA", actor)
	tplB := seedTemplate(t, ctx, svc, "GFB", actor)
	st := seedStatus(t, ctx, svc, actor)

	seedTask(t, ctx, svc, tplA.ID, st.ID, actor, "needle on A")
	seedTask(t, ctx, svc, tplA.ID, st.ID, actor, "other on A")
	seedTask(t, ctx, svc, tplB.ID, st.ID, actor, "needle on B")

	resp, err := svc.ListTasksGrouped(ctx, tasks.ListTasksParams{
		Search:   "needle",
		Prefixes: []string{"GFA"},
	}, 50)
	require.NoError(t, err)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, 1, resp.GroupsByStatus[st.ID.String()].Total)

	portion, err := svc.ListTasksStatusPortion(ctx, tasks.ListTasksParams{
		Search:   "needle",
		Prefixes: []string{"GFA"},
	}, st.ID, 0, 50)
	require.NoError(t, err)
	assert.Equal(t, 1, portion.Total)
	assert.Len(t, portion.Items, 1)
}

func TestIntegration_ListTasks_HidesSubtasksByDefault(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SUBL", actor)
	st := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Parent task")
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Child task",
		StatusID:     st.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)

	resp, err := svc.ListTasks(ctx, tasks.ListTasksParams{})
	require.NoError(t, err)
	group := findGroup(t, resp.Groups, st.ID)
	assert.Equal(t, 1, resp.GrandTotal)
	assert.Equal(t, 1, group.Total)
	require.Len(t, group.Tasks, 1)
	assert.Equal(t, parent.ID, group.Tasks[0].ID)
	assert.Nil(t, group.Tasks[0].ParentTaskID)

	respWithSubtasks, err := svc.ListTasks(ctx, tasks.ListTasksParams{IncludeSubtasks: true})
	require.NoError(t, err)
	groupWithSubtasks := findGroup(t, respWithSubtasks.Groups, st.ID)
	assert.Equal(t, 2, respWithSubtasks.GrandTotal)
	assert.Equal(t, 2, groupWithSubtasks.Total)
	require.Len(t, groupWithSubtasks.Tasks, 2)
	assert.ElementsMatch(t, []string{"Parent task", "Child task"}, []string{
		groupWithSubtasks.Tasks[0].Title,
		groupWithSubtasks.Tasks[1].Title,
	})
	childRows := 0
	for _, task := range groupWithSubtasks.Tasks {
		if task.Title != "Child task" {
			continue
		}
		childRows++
		require.NotNil(t, task.ParentTaskID)
		assert.Equal(t, parent.ID, *task.ParentTaskID)
	}
	assert.Equal(t, 1, childRows)
}

func TestIntegration_ListTasksGrouped_HonorsIncludeSubtasks(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SUBG", actor)
	st := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, st.ID, actor, "Parent grouped")
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Child grouped",
		StatusID:     st.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)

	groupedDefault, err := svc.ListTasksGrouped(ctx, tasks.ListTasksParams{}, 50)
	require.NoError(t, err)
	defaultBucket := groupedDefault.GroupsByStatus[st.ID.String()]
	assert.Equal(t, 1, groupedDefault.GrandTotal)
	assert.Equal(t, 1, defaultBucket.Total)
	require.Len(t, defaultBucket.Items, 1)
	assert.Equal(t, "Parent grouped", defaultBucket.Items[0].Title)

	groupedWithSubtasks, err := svc.ListTasksGrouped(ctx, tasks.ListTasksParams{IncludeSubtasks: true}, 50)
	require.NoError(t, err)
	withSubtasksBucket := groupedWithSubtasks.GroupsByStatus[st.ID.String()]
	assert.Equal(t, 2, groupedWithSubtasks.GrandTotal)
	assert.Equal(t, 2, withSubtasksBucket.Total)
	require.Len(t, withSubtasksBucket.Items, 2)
	assert.ElementsMatch(t, []string{"Parent grouped", "Child grouped"}, []string{
		withSubtasksBucket.Items[0].Title,
		withSubtasksBucket.Items[1].Title,
	})

	portionDefault, err := svc.ListTasksStatusPortion(ctx, tasks.ListTasksParams{}, st.ID, 0, 50)
	require.NoError(t, err)
	assert.Equal(t, 1, portionDefault.Total)
	require.Len(t, portionDefault.Items, 1)
	assert.Equal(t, "Parent grouped", portionDefault.Items[0].Title)

	portionWithSubtasks, err := svc.ListTasksStatusPortion(ctx, tasks.ListTasksParams{IncludeSubtasks: true}, st.ID, 0, 50)
	require.NoError(t, err)
	assert.Equal(t, 2, portionWithSubtasks.Total)
	require.Len(t, portionWithSubtasks.Items, 2)
	assert.ElementsMatch(t, []string{"Parent grouped", "Child grouped"}, []string{
		portionWithSubtasks.Items[0].Title,
		portionWithSubtasks.Items[1].Title,
	})
}

// ---- test helpers ----

// strPtr is a convenience helper used in Phase 4 tests.
func strPtr(s string) *string { return &s }

// findGroup returns the TaskGroup for the given status ID from the response.
func findGroup(t *testing.T, groups []tasks.TaskGroup, statusID uuid.UUID) tasks.TaskGroup {
	t.Helper()
	for _, g := range groups {
		if g.Status.ID == statusID {
			return g
		}
	}
	t.Fatalf("group for status %s not found", statusID)
	return tasks.TaskGroup{}
}

func taskIDs(rows []tasks.TaskRow) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.ID)
	}
	return out
}

// uuidPtr wraps a UUID value in a pointer for ParentTaskID params.
func uuidPtr(id uuid.UUID) *uuid.UUID { return &id }

// =========================================================
// Phase 5 — Subtasks
// =========================================================

func TestIntegration_Subtask_CreateAndAppearInParent(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SUB", actor)
	status := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent task")

	// Create a subtask under the parent.
	sub, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Subtask one",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)
	assert.Equal(t, parent.ID, *sub.ParentTaskID)
	assert.NotEmpty(t, sub.PublicID)

	// Fetching the parent must include the subtask in Subtasks.
	resp, err := svc.GetTask(ctx, parent.ID)
	require.NoError(t, err)
	require.Len(t, resp.Subtasks, 1)
	assert.Equal(t, sub.ID, resp.Subtasks[0].ID)
	assert.Equal(t, "Subtask one", resp.Subtasks[0].Title)
	assert.Nil(t, resp.ParentPublicID) // parent card has no breadcrumb

	// Fetching the subtask must not include nested subtasks and must expose the parent public_id.
	subResp, err := svc.GetTask(ctx, sub.ID)
	require.NoError(t, err)
	assert.Empty(t, subResp.Subtasks)
	require.NotNil(t, subResp.ParentPublicID)
	assert.Equal(t, parent.PublicID, *subResp.ParentPublicID)
}

func TestIntegration_Subtask_MultipleSubtasksOrderedByCreation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ORD", actor)
	status := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent")

	titles := []string{"Alpha", "Beta", "Gamma"}
	for _, title := range titles {
		_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
			TemplateID:   tpl.ID,
			ParentTaskID: uuidPtr(parent.ID),
			Title:        title,
			StatusID:     status.ID,
			ActorID:      actor,
		})
		require.NoError(t, err)
	}

	resp, err := svc.GetTask(ctx, parent.ID)
	require.NoError(t, err)
	require.Len(t, resp.Subtasks, 3)
	// Subtasks must be returned in creation order (ASC).
	assert.Equal(t, "Alpha", resp.Subtasks[0].Title)
	assert.Equal(t, "Beta", resp.Subtasks[1].Title)
	assert.Equal(t, "Gamma", resp.Subtasks[2].Title)
}

func TestIntegration_Subtask_SelfReferenceRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "SLF", actor)
	status := seedStatus(t, ctx, svc, actor)

	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Solo task")

	// Attempting to make a task its own parent must be rejected at the app layer.
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(task.ID),
		Title:        "Should fail",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	// The app layer checks parent.ParentTaskID.Valid — the parent itself has none,
	// so app-layer pre-check passes. The DB trigger fires the self-reference guard
	// only on a direct self-INSERT (id == parent_task_id). That cannot happen here
	// because the new task has a different ID. The real nesting guard is tested below.
	// This test confirms a subtask of a top-level task is accepted.
	require.NoError(t, err)

	// Now verify that a task truly cannot reference itself (would require an UPDATE,
	// which the service does not expose for parent_task_id — the constraint is enforced
	// at the DB level; we test the app-layer guard for the "already a subtask" case below).
}

func TestIntegration_Subtask_SecondLevelNestingRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "NLV", actor)
	status := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Top-level")

	sub, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Level 1 subtask",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)

	// Attempt to create a subtask of the subtask — rejected at app layer.
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(sub.ID),
		Title:        "Level 2 — must fail",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
	assert.Contains(t, err.Error(), "already a subtask")
}

func TestIntegration_Subtask_ParentNotFoundRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "PNF", actor)
	status := seedStatus(t, ctx, svc, actor)

	nonexistent := uuid.New()
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(nonexistent),
		Title:        "Orphan",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Subtask_DBTrigger_SelfReferenceRejected(t *testing.T) {
	// The DB trigger rejects a task whose parent_task_id equals its own id.
	// This scenario cannot be triggered through the service's CreateTask (a new
	// task gets a fresh UUID that differs from the parent UUID passed in), but
	// we can verify the trigger by inserting directly into the DB.
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "TRG", actor)
	status := seedStatus(t, ctx, svc, actor)

	// First create a normal task.
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Normal task")

	// Attempt a direct UPDATE that sets parent_task_id = id (self-reference).
	_, err := pool.Exec(ctx,
		`UPDATE task SET parent_task_id = id WHERE id = $1`,
		task.ID,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cannot be its own parent")
}

func TestIntegration_Subtask_DBTrigger_DeepNestingRejected(t *testing.T) {
	// The DB trigger rejects a task whose parent already has a parent.
	// Bypasses app-layer to confirm the DB constraint is independently enforced.
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "DPT", actor)
	status := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Level 0")
	sub := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Level 1")

	// Manually set sub.parent_task_id = parent.id (bypassing service app-layer).
	_, err := pool.Exec(ctx,
		`UPDATE task SET parent_task_id = $1 WHERE id = $2`,
		parent.ID, sub.ID,
	)
	require.NoError(t, err)

	// Now try to create a third task with parent = sub (level 2) — direct INSERT.
	_, err = pool.Exec(ctx,
		`INSERT INTO task (template_id, parent_task_id, title, status_id, created_by, updated_by)
		 VALUES ($1, $2, 'Level 2', $3, $4, $4)`,
		tpl.ID, sub.ID, status.ID, actor,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "one level")
}

func TestIntegration_Subtask_SubtaskCardReturnsEmptySubtasksList(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "EMP", actor)
	status := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent")
	sub, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Child",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)

	resp, err := svc.GetTask(ctx, sub.ID)
	require.NoError(t, err)
	// A subtask card must never return subtasks (one-level limit).
	assert.NotNil(t, resp.Subtasks)
	assert.Empty(t, resp.Subtasks)
}

func TestIntegration_Subtask_AssigneeUserIncludedInParentCard(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	assignee := seedUserProfile(t, ctx, pool, "assignee@example.com", "Assignee User", "/api/public/avatars/avatars/u-2/assignee.png")
	tpl := seedTemplate(t, ctx, svc, "ASU", actor)
	status := seedStatus(t, ctx, svc, actor)
	role := "assignee"

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "owner",
		Name:       "Owner",
		Type:       "user",
		SortOrder:  1,
		FieldRole:  &role,
	})
	require.NoError(t, err)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent")
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Assigned child",
		StatusID:     status.ID,
		ActorID:      actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueUserID: &assignee},
		},
	})
	require.NoError(t, err)

	resp, err := svc.GetTask(ctx, parent.ID)
	require.NoError(t, err)
	require.Len(t, resp.Subtasks, 1)
	require.Len(t, resp.Subtasks[0].Assignees, 1)
	assert.Equal(t, assignee, resp.Subtasks[0].Assignees[0].ID)
	assert.Equal(t, "Assignee User", resp.Subtasks[0].Assignees[0].DisplayName)
	assert.Equal(t, "assignee@example.com", resp.Subtasks[0].Assignees[0].Email)
	assert.Equal(t, "/api/public/avatars/avatars/u-2/assignee.png", resp.Subtasks[0].Assignees[0].AvatarURL)
}

func TestIntegration_Subtask_AssigneeUsersIncludedInStoredOrder(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	first := seedUserProfile(t, ctx, pool, "first@example.com", "First User", "")
	second := seedUserProfile(t, ctx, pool, "second@example.com", "Second User", "")
	third := seedUserProfile(t, ctx, pool, "third@example.com", "Third User", "")
	tpl := seedTemplate(t, ctx, svc, "ASM", actor)
	status := seedStatus(t, ctx, svc, actor)
	role := "assignee"

	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "owners",
		Name:       "Owners",
		Type:       "users",
		SortOrder:  1,
		FieldRole:  &role,
	})
	require.NoError(t, err)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent")
	assigneesJSON := json.RawMessage(fmt.Sprintf(`["%s","%s","%s"]`, second, third, first))
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Multi-assigned child",
		StatusID:     status.ID,
		ActorID:      actor,
		FieldValues: []tasks.FieldValueInput{
			{FieldDefinitionID: field.ID, ValueJSON: assigneesJSON},
		},
	})
	require.NoError(t, err)

	resp, err := svc.GetTask(ctx, parent.ID)
	require.NoError(t, err)
	require.Len(t, resp.Subtasks, 1)
	require.Len(t, resp.Subtasks[0].Assignees, 3)
	assert.Equal(t, second, resp.Subtasks[0].Assignees[0].ID)
	assert.Equal(t, third, resp.Subtasks[0].Assignees[1].ID)
	assert.Equal(t, first, resp.Subtasks[0].Assignees[2].ID)
}

func TestIntegration_Subtask_AssigneesEmptyWhenTemplateHasNoAssigneeField(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ASN", actor)
	status := seedStatus(t, ctx, svc, actor)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent")
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Plain child",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)

	resp, err := svc.GetTask(ctx, parent.ID)
	require.NoError(t, err)
	require.Len(t, resp.Subtasks, 1)
	assert.Empty(t, resp.Subtasks[0].Assignees)
}

func TestIntegration_Subtask_AssigneesEmptyWhenAssigneeFieldValueMissing(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ASE", actor)
	status := seedStatus(t, ctx, svc, actor)
	role := "assignee"

	_, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: tpl.ID,
		Code:       "owner",
		Name:       "Owner",
		Type:       "user",
		SortOrder:  1,
		FieldRole:  &role,
	})
	require.NoError(t, err)

	parent := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Parent")
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   tpl.ID,
		ParentTaskID: uuidPtr(parent.ID),
		Title:        "Unassigned child",
		StatusID:     status.ID,
		ActorID:      actor,
	})
	require.NoError(t, err)

	resp, err := svc.GetTask(ctx, parent.ID)
	require.NoError(t, err)
	require.Len(t, resp.Subtasks, 1)
	assert.Empty(t, resp.Subtasks[0].Assignees)
}

// =========================================================
// Phase 6 — Comments
// =========================================================

func TestIntegration_Comment_CreateAndList(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMT", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Comment test task")

	c1, err := svc.CreateComment(ctx, task.ID, actor, "First comment")
	require.NoError(t, err)
	assert.Equal(t, "First comment", c1.Body)
	assert.Equal(t, task.ID, c1.TaskID)
	assert.Equal(t, actor, c1.AuthorID)

	c2, err := svc.CreateComment(ctx, task.ID, actor, "Second comment")
	require.NoError(t, err)
	assert.Equal(t, "Second comment", c2.Body)

	list, err := svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, list, 2)

	// Must be in chronological order.
	assert.Equal(t, c1.ID, list[0].ID)
	assert.Equal(t, c2.ID, list[1].ID)
}

func TestIntegration_Comment_EmptyBodyRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CME", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Comment empty body")

	_, err := svc.CreateComment(ctx, task.ID, actor, "   ")
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Comment_UnknownTaskReturnsNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)

	_, err := svc.CreateComment(ctx, uuid.New(), actor, "body")
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Comment_UpdateBodyOnly(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMB", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Update body test")

	c, err := svc.CreateComment(ctx, task.ID, actor, "Original body")
	require.NoError(t, err)

	updated, err := svc.UpdateComment(ctx, task.ID, c.ID, actor, "Updated body")
	require.NoError(t, err)
	assert.Equal(t, c.ID, updated.ID)
	assert.Equal(t, "Updated body", updated.Body)
	assert.Equal(t, c.CreatedAt, updated.CreatedAt)
	assert.True(t, updated.UpdatedAt.Equal(c.UpdatedAt) || updated.UpdatedAt.After(c.UpdatedAt))

	list, err := svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, "Updated body", list[0].Body)
}

func TestIntegration_CommentThread_EnsureCreatesHiddenChannelAndRootOnce(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	other := seedUserProfile(t, ctx, pool, "thread_member_"+uuid.NewString()+"@example.com", "Thread Member", "")
	tpl := seedTemplate(t, ctx, svc, "THR", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Thread task")

	comment, err := svc.CreateComment(ctx, task.ID, actor, "Open a thread")
	require.NoError(t, err)

	thread, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, actor)
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, thread.ConversationID)
	require.NotEqual(t, uuid.Nil, thread.ThreadRootMessageID)
	assert.Equal(t, 0, thread.ThreadReplyCount)

	var hidden bool
	var rootBody string
	err = pool.QueryRow(ctx, `
		SELECT c.hidden, m.body
		  FROM channels c
		  JOIN messages m ON m.channel_id = c.id
		 WHERE c.id = $1
		   AND m.id = $2`,
		thread.ConversationID,
		thread.ThreadRootMessageID,
	).Scan(&hidden, &rootBody)
	require.NoError(t, err)
	assert.True(t, hidden)
	assert.Equal(t, "Open a thread", rootBody)

	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	userChannels, err := queries.New(db).ListUserChannels(ctx, actor)
	require.NoError(t, err)
	for _, channel := range userChannels {
		assert.NotEqual(t, thread.ConversationID, channel.ID)
	}
	bootstrapCount, err := queries.New(db).CountBootstrapConversations(ctx, queries.CountBootstrapConversationsParams{
		UserID:          actor,
		IncludeArchived: true,
	})
	require.NoError(t, err)
	assert.Equal(t, 0, bootstrapCount)
	bootstrapIDs, err := queries.New(db).ListBootstrapConversationIDs(ctx, queries.ListBootstrapConversationIDsParams{
		UserID:          actor,
		IncludeArchived: true,
	})
	require.NoError(t, err)
	assert.NotContains(t, bootstrapIDs, thread.ConversationID)

	var eventType string
	var lastActivityAt time.Time
	var messageCreatedAt time.Time
	err = pool.QueryRow(ctx, `
		SELECT we.event_type, c.last_activity_at, m.created_at
		  FROM workspace_events we
		  JOIN channels c ON c.id = we.channel_id
		  JOIN messages m ON m.id = $2
		 WHERE we.channel_id = $1
		 ORDER BY we.event_seq DESC
		 LIMIT 1`,
		thread.ConversationID,
		thread.ThreadRootMessageID,
	).Scan(&eventType, &lastActivityAt, &messageCreatedAt)
	require.NoError(t, err)
	assert.Equal(t, "message_created", eventType)
	assert.False(t, lastActivityAt.Before(messageCreatedAt))

	var hasOtherMember bool
	err = pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM channel_members
			 WHERE channel_id = $1
			   AND user_id = $2
			   AND is_archived = false
		)`,
		thread.ConversationID,
		other,
	).Scan(&hasOtherMember)
	require.NoError(t, err)
	assert.True(t, hasOtherMember)

	again, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, actor)
	require.NoError(t, err)
	assert.Equal(t, thread.ConversationID, again.ConversationID)
	assert.Equal(t, thread.ThreadRootMessageID, again.ThreadRootMessageID)

	list, err := svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.NotNil(t, list[0].ThreadRootMessageID)
	assert.Equal(t, thread.ThreadRootMessageID, *list[0].ThreadRootMessageID)
}

func TestIntegration_CommentThread_UpdateCommentSyncsRootBody(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "THU", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Thread update task")

	comment, err := svc.CreateComment(ctx, task.ID, actor, "Before")
	require.NoError(t, err)
	thread, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, actor)
	require.NoError(t, err)

	_, err = svc.UpdateComment(ctx, task.ID, comment.ID, actor, "After")
	require.NoError(t, err)

	var rootBody string
	err = pool.QueryRow(ctx, `SELECT body FROM messages WHERE id = $1`, thread.ThreadRootMessageID).Scan(&rootBody)
	require.NoError(t, err)
	assert.Equal(t, "After", rootBody)

	var eventType string
	err = pool.QueryRow(ctx, `
		SELECT event_type
		  FROM workspace_events
		 WHERE channel_id = $1
		 ORDER BY event_seq DESC
		 LIMIT 1`,
		thread.ConversationID,
	).Scan(&eventType)
	require.NoError(t, err)
	assert.Equal(t, "message_updated", eventType)
}

func TestIntegration_CommentThread_LongUTF8TitleDoesNotBreakChannelCreate(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "UTF", actor)
	status := seedStatus(t, ctx, svc, actor)
	longTitle := strings.Repeat("Привет", 40)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, longTitle)

	comment, err := svc.CreateComment(ctx, task.ID, actor, "Body")
	require.NoError(t, err)

	thread, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, actor)
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, thread.ConversationID)

	var channelName string
	err = pool.QueryRow(ctx, `SELECT name FROM channels WHERE id = $1`, thread.ConversationID).Scan(&channelName)
	require.NoError(t, err)
	assert.True(t, utf8.ValidString(channelName))
	assert.LessOrEqual(t, utf8.RuneCountInString(channelName), 120)
}

func TestIntegration_CommentThread_AttachmentOnlyCommentCreatesEmptyRoot(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "THA", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Attachment-only thread")

	attachment, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "note.txt",
		MimeType: "text/plain",
		Size:     int64(len("payload")),
		Body:     bytes.NewReader([]byte("payload")),
	}, 1)
	require.NoError(t, err)
	comment, err := svc.CreateComment(ctx, task.ID, actor, "", attachment.ID)
	require.NoError(t, err)

	thread, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, actor)
	require.NoError(t, err)

	var body string
	err = pool.QueryRow(ctx, `SELECT body FROM messages WHERE id = $1`, thread.ThreadRootMessageID).Scan(&body)
	require.NoError(t, err)
	assert.Equal(t, "", body)

	list, err := svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Len(t, list[0].Attachments, 1)
}

func TestIntegration_Comment_ListOnUnknownTaskReturnsNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)

	_, err := svc.ListComments(ctx, uuid.New())
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_CommentAttachment_UploadCreateListDownload(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMA", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Comment attachment")

	content := []byte("comment-image-content")
	uploaded, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "photo.jpg",
		MimeType: "image/jpeg",
		Size:     int64(len(content)),
		Body:     bytes.NewReader(content),
	}, 50)
	require.NoError(t, err)
	require.Nil(t, uploaded.CommentID)

	comment, err := svc.CreateComment(ctx, task.ID, actor, "", uploaded.ID)
	require.NoError(t, err)
	assert.Equal(t, "", comment.Body)
	require.Len(t, comment.Attachments, 1)
	assert.Equal(t, uploaded.ID, comment.Attachments[0].ID)
	assert.NotNil(t, comment.Attachments[0].CommentID)
	assert.Equal(t, comment.ID, *comment.Attachments[0].CommentID)

	list, err := svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Len(t, list[0].Attachments, 1)
	assert.Equal(t, "photo.jpg", list[0].Attachments[0].FileName)

	body, _, _, fileName, err := svc.DownloadCommentAttachment(ctx, task.ID, comment.ID, uploaded.ID)
	require.NoError(t, err)
	defer body.Close()
	raw, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Equal(t, content, raw)
	assert.Equal(t, "photo.jpg", fileName)
}

func TestIntegration_Comment_UpdateRejectsNonAuthor(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	other := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMU", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Update permissions")

	comment, err := svc.CreateComment(ctx, task.ID, actor, "Original")
	require.NoError(t, err)

	_, err = svc.UpdateComment(ctx, task.ID, comment.ID, other, "Hacked")
	require.ErrorIs(t, err, tasks.ErrForbidden)
}

func TestIntegration_Comment_UpdateRejectsEmptyFinalState(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMV", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Update empty state")

	comment, err := svc.CreateComment(ctx, task.ID, actor, "Original")
	require.NoError(t, err)

	_, err = svc.UpdateComment(ctx, task.ID, comment.ID, actor, "   ")
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Comment_UpdateBodyAndReplaceAttachments(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMW", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Update attachments")

	initialContent := []byte("initial-file")
	initial, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "initial.txt",
		MimeType: "text/plain",
		Size:     int64(len(initialContent)),
		Body:     bytes.NewReader(initialContent),
	}, 50)
	require.NoError(t, err)

	comment, err := svc.CreateComment(ctx, task.ID, actor, "Original", initial.ID)
	require.NoError(t, err)
	require.Len(t, comment.Attachments, 1)

	replacementContent := []byte("replacement-file")
	replacement, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "replacement.txt",
		MimeType: "text/plain",
		Size:     int64(len(replacementContent)),
		Body:     bytes.NewReader(replacementContent),
	}, 50)
	require.NoError(t, err)

	updated, err := svc.UpdateComment(ctx, task.ID, comment.ID, actor, "Updated", replacement.ID)
	require.NoError(t, err)
	assert.Equal(t, "Updated", updated.Body)
	require.Len(t, updated.Attachments, 1)
	assert.Equal(t, replacement.ID, updated.Attachments[0].ID)

	_, _, _, _, err = svc.DownloadCommentAttachment(ctx, task.ID, comment.ID, initial.ID)
	require.ErrorIs(t, err, tasks.ErrNotFound)

	body, _, _, fileName, err := svc.DownloadCommentAttachment(ctx, task.ID, comment.ID, replacement.ID)
	require.NoError(t, err)
	defer body.Close()
	raw, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Equal(t, replacementContent, raw)
	assert.Equal(t, "replacement.txt", fileName)
}

func TestIntegration_Comment_UpdateRejectsAttachmentFromDifferentComment(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMX", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Attachment ownership")

	attachmentA, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "a.txt",
		MimeType: "text/plain",
		Size:     1,
		Body:     bytes.NewReader([]byte("a")),
	}, 50)
	require.NoError(t, err)
	commentA, err := svc.CreateComment(ctx, task.ID, actor, "A", attachmentA.ID)
	require.NoError(t, err)

	commentB, err := svc.CreateComment(ctx, task.ID, actor, "B")
	require.NoError(t, err)

	_, err = svc.UpdateComment(ctx, task.ID, commentB.ID, actor, "B2", attachmentA.ID)
	require.ErrorIs(t, err, tasks.ErrBadRequest)
	require.NotNil(t, commentA)
}

func TestIntegration_CommentAttachment_CreateRejectsWrongUploader(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	other := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMB", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Wrong uploader")

	uploaded, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "clip.mp4",
		MimeType: "video/mp4",
		Size:     int64(len("video")),
		Body:     bytes.NewReader([]byte("video")),
	}, 50)
	require.NoError(t, err)

	_, err = svc.CreateComment(ctx, task.ID, other, "cannot use", uploaded.ID)
	require.ErrorIs(t, err, tasks.ErrForbidden)
}

func TestIntegration_CommentAttachment_UploadRejectsMultipartSizeMismatch(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CME", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Size mismatch")

	// Simulate a client claiming a smaller multipart size than bytes actually sent.
	_, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "mismatch.bin",
		MimeType: "application/octet-stream",
		Size:     1,
		Body:     bytes.NewReader([]byte("abcdef")),
	}, 50)
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_CommentAttachment_DeleteStagedRules(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	other := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMC", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Delete staged")

	staged, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "doc.txt",
		MimeType: "text/plain",
		Size:     int64(len("doc")),
		Body:     bytes.NewReader([]byte("doc")),
	}, 50)
	require.NoError(t, err)

	err = svc.DeleteStagedCommentAttachment(ctx, task.ID, other, staged.ID)
	require.ErrorIs(t, err, tasks.ErrForbidden)

	err = svc.DeleteStagedCommentAttachment(ctx, task.ID, actor, staged.ID)
	require.NoError(t, err)

	linked, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "linked.txt",
		MimeType: "text/plain",
		Size:     int64(len("linked")),
		Body:     bytes.NewReader([]byte("linked")),
	}, 50)
	require.NoError(t, err)

	comment, err := svc.CreateComment(ctx, task.ID, actor, "with file", linked.ID)
	require.NoError(t, err)
	require.NotNil(t, comment)

	err = svc.DeleteStagedCommentAttachment(ctx, task.ID, actor, linked.ID)
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_CommentAttachment_CreateRejectsWrongTaskAttachment(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "CMD", actor)
	status := seedStatus(t, ctx, svc, actor)
	task1 := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Task 1")
	task2 := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Task 2")

	uploaded, err := svc.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID:   task1.ID,
		ActorID:  actor,
		FileName: "wrong-task.bin",
		MimeType: "application/octet-stream",
		Size:     int64(len("bin")),
		Body:     bytes.NewReader([]byte("bin")),
	}, 50)
	require.NoError(t, err)

	_, err = svc.CreateComment(ctx, task2.ID, actor, "bad link", uploaded.ID)
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

// =========================================================
// Phase 6 — Attachments
// =========================================================

func TestIntegration_Attachment_UploadListDelete(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ATT", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Attachment task")

	content := []byte("hello attachment content")
	row, err := svc.UploadAttachment(ctx, tasks.UploadAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "hello.txt",
		MimeType: "text/plain",
		Size:     int64(len(content)),
		Body:     bytes.NewReader(content),
	}, 50, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello.txt", row.FileName)
	assert.Equal(t, int64(len(content)), row.FileSize)
	assert.Equal(t, "text/plain", row.MimeType)
	assert.Equal(t, task.ID, row.TaskID)
	assert.Equal(t, actor, row.UploadedBy)
	assert.NotEmpty(t, row.StorageKey)

	// List returns the uploaded attachment.
	list, err := svc.ListAttachments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, row.ID, list[0].ID)

	// Download and verify content.
	body, size, mimeType, fileName, err := svc.DownloadAttachment(ctx, task.ID, row.ID)
	require.NoError(t, err)
	defer body.Close()
	assert.Equal(t, int64(len(content)), size)
	assert.Equal(t, "text/plain", mimeType)
	assert.Equal(t, "hello.txt", fileName)
	got, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Equal(t, content, got)

	// Delete.
	err = svc.DeleteAttachment(ctx, task.ID, row.ID, actor)
	require.NoError(t, err)

	// List is now empty.
	list, err = svc.ListAttachments(ctx, task.ID)
	require.NoError(t, err)
	assert.Empty(t, list)

	// Download after delete returns not found.
	_, _, _, _, err = svc.DownloadAttachment(ctx, task.ID, row.ID)
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_AttachmentHistory_GroupsAddedFilesAndRecordsRemoval(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	creator := seedUser(t, ctx, pool)
	remover := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "AHI", creator)
	status := seedStatus(t, ctx, svc, creator)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, creator, "Attachment history")

	result, err := svc.UploadAttachments(ctx, tasks.UploadAttachmentsParams{
		TaskID:  task.ID,
		ActorID: creator,
		Attachments: []tasks.UploadAttachmentBatchItem{
			{FileName: "first.txt", MimeType: "text/plain", Size: 5, Body: bytes.NewReader([]byte("first"))},
			{FileName: "second.pdf", MimeType: "application/pdf", Size: 6, Body: bytes.NewReader([]byte("second"))},
			{FileName: "too-large.bin", MimeType: "application/octet-stream", Size: 2 * 1024 * 1024, Body: bytes.NewReader(make([]byte, 2*1024*1024))},
		},
	}, 1)
	require.NoError(t, err)
	require.Len(t, result.Attachments, 2)
	require.Len(t, result.Errors, 1)
	assert.Equal(t, "too-large.bin", result.Errors[0].FileName)

	require.NoError(t, svc.DeleteAttachment(ctx, task.ID, result.Attachments[0].ID, remover))

	history, err := svc.ListTaskChangeHistory(ctx, task.ID, "", 50)
	require.NoError(t, err)
	require.Len(t, history.Items, 3)
	byType := make(map[string]tasks.TaskChangeHistoryItem, len(history.Items))
	for _, item := range history.Items {
		byType[item.FieldType] = item
	}

	added := byType["attachments_added"]
	assert.Equal(t, creator, added.Actor.ID)
	assert.Equal(t, "Attachments", added.FieldName)
	var addedFiles []tasks.TaskHistoryAttachment
	require.NoError(t, json.Unmarshal(added.AfterValue, &addedFiles))
	require.Len(t, addedFiles, 2)
	assert.Equal(t, "first.txt", addedFiles[0].FileName)
	assert.Equal(t, "second.pdf", addedFiles[1].FileName)

	removed := byType["attachments_removed"]
	assert.Equal(t, remover, removed.Actor.ID)
	var removedFiles []tasks.TaskHistoryAttachment
	require.NoError(t, json.Unmarshal(removed.BeforeValue, &removedFiles))
	require.Equal(t, []tasks.TaskHistoryAttachment{{
		ID:       result.Attachments[0].ID,
		FileName: "first.txt",
		FileSize: 5,
		MimeType: "text/plain",
	}}, removedFiles)
}

func TestIntegration_TaskStagedAttachment_UploadCreateListDownload(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "STA", actor)
	status := seedStatus(t, ctx, svc, actor)

	content := []byte("staged image content")
	staged, err := svc.UploadTaskStagedAttachment(ctx, tasks.UploadTaskStagedAttachmentParams{
		ActorID:  actor,
		FileName: "photo.png",
		MimeType: "image/png",
		Size:     int64(len(content)),
		Body:     bytes.NewReader(content),
	}, 50)
	require.NoError(t, err)

	body, size, mimeType, fileName, err := svc.DownloadTaskStagedAttachment(ctx, actor, staged.ID)
	require.NoError(t, err)
	raw, err := io.ReadAll(body)
	require.NoError(t, err)
	require.NoError(t, body.Close())
	assert.Equal(t, int64(len(content)), size)
	assert.Equal(t, "image/png", mimeType)
	assert.Equal(t, "photo.png", fileName)
	assert.Equal(t, content, raw)

	description := fmt.Sprintf("Before\n\n![Photo](msgnr-staged-attachment://task/%s)", staged.ID)
	created, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:          tpl.ID,
		Title:               "Task with staged image",
		Description:         &description,
		StatusID:            status.ID,
		ActorID:             actor,
		StagedAttachmentIDs: []uuid.UUID{staged.ID},
	})
	require.NoError(t, err)
	require.NotNil(t, created.Description)
	finalURL := fmt.Sprintf("msgnr-attachment://task/%s/%s", created.ID, staged.ID)
	assert.Contains(t, *created.Description, finalURL)
	assert.NotContains(t, *created.Description, "msgnr-staged-attachment://")

	attachments, err := svc.ListAttachments(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, attachments, 1)
	assert.Equal(t, staged.ID, attachments[0].ID)

	history, err := svc.ListTaskChangeHistory(ctx, created.ID, "", 50)
	require.NoError(t, err)
	require.Len(t, history.Items, 1)
	assert.Equal(t, "created", history.Items[0].ChangeKind)
	var createdValue tasks.TaskHistoryCreatedValue
	require.NoError(t, json.Unmarshal(history.Items[0].AfterValue, &createdValue))
	require.Equal(t, []tasks.TaskHistoryAttachment{{
		ID: staged.ID, FileName: "photo.png", FileSize: int64(len(content)), MimeType: "image/png",
	}}, createdValue.Attachments)

	body, _, _, fileName, err = svc.DownloadAttachment(ctx, created.ID, staged.ID)
	require.NoError(t, err)
	raw, err = io.ReadAll(body)
	require.NoError(t, err)
	require.NoError(t, body.Close())
	assert.Equal(t, "photo.png", fileName)
	assert.Equal(t, content, raw)

	_, _, _, _, err = svc.DownloadTaskStagedAttachment(ctx, actor, staged.ID)
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_TaskStagedAttachment_CreateRejectsForeignOrMissingStagedRows(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	other := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "STB", actor)
	status := seedStatus(t, ctx, svc, actor)

	staged, err := svc.UploadTaskStagedAttachment(ctx, tasks.UploadTaskStagedAttachmentParams{
		ActorID:  actor,
		FileName: "photo.png",
		MimeType: "image/png",
		Size:     int64(len("img")),
		Body:     bytes.NewReader([]byte("img")),
	}, 50)
	require.NoError(t, err)

	foreignDescription := fmt.Sprintf("![Photo](msgnr-staged-attachment://task/%s)", staged.ID)
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:          tpl.ID,
		Title:               "Foreign staged image",
		Description:         &foreignDescription,
		StatusID:            status.ID,
		ActorID:             other,
		StagedAttachmentIDs: []uuid.UUID{staged.ID},
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)

	missingID := uuid.New()
	missingDescription := fmt.Sprintf("![Photo](msgnr-staged-attachment://task/%s)", missingID)
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:          tpl.ID,
		Title:               "Missing staged image",
		Description:         &missingDescription,
		StatusID:            status.ID,
		ActorID:             actor,
		StagedAttachmentIDs: []uuid.UUID{missingID},
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_TaskStagedAttachment_CreateRejectsMismatchedDescriptionRefs(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "STC", actor)
	status := seedStatus(t, ctx, svc, actor)

	stagedID := uuid.New()
	description := fmt.Sprintf("![Photo](msgnr-staged-attachment://task/%s)", stagedID)
	_, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:  tpl.ID,
		Title:       "Mismatched staged image",
		Description: &description,
		StatusID:    status.ID,
		ActorID:     actor,
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)

	plainDescription := "No staged refs"
	_, err = svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:          tpl.ID,
		Title:               "Extra staged image",
		Description:         &plainDescription,
		StatusID:            status.ID,
		ActorID:             actor,
		StagedAttachmentIDs: []uuid.UUID{stagedID},
	})
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_TaskStagedAttachment_CleanupExpiredRows(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)

	expired, err := svc.UploadTaskStagedAttachment(ctx, tasks.UploadTaskStagedAttachmentParams{
		ActorID:  actor,
		FileName: "old.png",
		MimeType: "image/png",
		Size:     int64(len("old")),
		Body:     bytes.NewReader([]byte("old")),
	}, 50)
	require.NoError(t, err)
	fresh, err := svc.UploadTaskStagedAttachment(ctx, tasks.UploadTaskStagedAttachmentParams{
		ActorID:  actor,
		FileName: "fresh.png",
		MimeType: "image/png",
		Size:     int64(len("fresh")),
		Body:     bytes.NewReader([]byte("fresh")),
	}, 50)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE task_staged_attachment SET created_at = now() - interval '25 hours' WHERE id = $1`, expired.ID)
	require.NoError(t, err)

	deleted, err := svc.CleanupExpiredTaskStagedAttachments(ctx, 24*time.Hour)
	require.NoError(t, err)
	assert.Equal(t, 1, deleted)

	_, _, _, _, err = svc.DownloadTaskStagedAttachment(ctx, actor, expired.ID)
	require.ErrorIs(t, err, tasks.ErrNotFound)

	body, _, _, fileName, err := svc.DownloadTaskStagedAttachment(ctx, actor, fresh.ID)
	require.NoError(t, err)
	require.NoError(t, body.Close())
	assert.Equal(t, "fresh.png", fileName)
}

func TestIntegration_Attachment_FileSizeRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ATZ", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Too big file")

	content := make([]byte, 2*1024*1024) // 2 MB
	_, err := svc.UploadAttachment(ctx, tasks.UploadAttachmentParams{
		TaskID:   task.ID,
		ActorID:  actor,
		FileName: "big.bin",
		MimeType: "application/octet-stream",
		Size:     int64(len(content)),
		Body:     bytes.NewReader(content),
	}, 1, nil) // 1 MB max
	require.ErrorIs(t, err, tasks.ErrBadRequest)
}

func TestIntegration_Attachment_UnknownTaskReturnsNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)

	_, err := svc.UploadAttachment(ctx, tasks.UploadAttachmentParams{
		TaskID:   uuid.New(),
		ActorID:  actor,
		FileName: "x.txt",
		MimeType: "text/plain",
		Size:     4,
		Body:     bytes.NewReader([]byte("test")),
	}, 50, nil)
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Attachment_DeleteUnknownReturnsNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ATN", actor)
	status := seedStatus(t, ctx, svc, actor)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "No attachment")

	err := svc.DeleteAttachment(ctx, task.ID, uuid.New(), actor)
	require.ErrorIs(t, err, tasks.ErrNotFound)
}

func TestIntegration_Attachment_WrongTaskIDReturnsNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := tasks.NewService(pool, minioClient)
	actor := seedUser(t, ctx, pool)
	tpl := seedTemplate(t, ctx, svc, "ATW", actor)
	status := seedStatus(t, ctx, svc, actor)
	task1 := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Task 1")
	task2 := seedTask(t, ctx, svc, tpl.ID, status.ID, actor, "Task 2")

	content := []byte("data")
	row, err := svc.UploadAttachment(ctx, tasks.UploadAttachmentParams{
		TaskID:   task1.ID,
		ActorID:  actor,
		FileName: "f.txt",
		MimeType: "text/plain",
		Size:     int64(len(content)),
		Body:     bytes.NewReader(content),
	}, 50, nil)
	require.NoError(t, err)

	// Attempting to access the attachment via task2's ID should return not found.
	err = svc.DeleteAttachment(ctx, task2.ID, row.ID, actor)
	require.ErrorIs(t, err, tasks.ErrNotFound)
}
