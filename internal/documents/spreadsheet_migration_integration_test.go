//go:build integration

package documents

import (
	"context"
	"github.com/stretchr/testify/require"
	"msgnr/internal/testdb"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestIntegration_SpreadsheetMigrationPreservesMarkdown(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	owner := seedHandlerUser(t, ctx, pool, "Migration owner")
	teamspace, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{Name: "Migration", ActorID: owner}, "member")
	require.NoError(t, err)
	text := "Existing Markdown"
	doc, err := svc.CreateDocument(ctx, CreateDocumentParams{TeamspaceID: teamspace.ID, Title: "Existing", ContentMarkdown: &text, ActorID: owner})
	require.NoError(t, err)
	// Remove only the new additive schema from the isolated database to recreate
	// the pre-feature tables while retaining real document/history data.
	_, err = pool.Exec(ctx, `DROP TABLE document_spreadsheet_operation,document_spreadsheet_cell_version,document_spreadsheet;
 DROP TRIGGER trg_document_kind_immutable ON document; DROP FUNCTION prevent_document_kind_change();
 ALTER TABLE document DROP COLUMN kind;
 ALTER TABLE document_history DROP COLUMN kind,DROP COLUMN workbook_json,DROP COLUMN spreadsheet_revision,DROP COLUMN spreadsheet_structure_epoch;`)
	require.NoError(t, err)
	_, file, _, _ := runtime.Caller(0)
	migration, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "migrations", "2026-10-08-spreadsheets.sql"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(migration))
	require.NoError(t, err)
	retrieved, err := svc.GetDocument(ctx, doc.ID, owner)
	require.NoError(t, err)
	require.Equal(t, DocumentKindMarkdown, retrieved.Kind)
	require.Equal(t, &text, retrieved.ContentMarkdown)
	history, err := svc.ListDocumentHistory(ctx, doc.ID, owner)
	require.NoError(t, err)
	require.Len(t, history, 1)
	require.Equal(t, DocumentKindMarkdown, history[0].Kind)
	require.Equal(t, &text, history[0].ContentMarkdown)
	sheet, err := svc.CreateDocument(ctx, CreateDocumentParams{TeamspaceID: teamspace.ID, Title: "New sheet", Kind: DocumentKindSpreadsheet, ActorID: owner})
	require.NoError(t, err)
	accepted, err := svc.ApplySpreadsheetAction(ctx, sheet.ID, owner, sheetActionJSON("after-migration", 0, 0, sheetValue(0, 0, "accepted")))
	require.NoError(t, err)
	require.Equal(t, "accepted", accepted.Operation.Outcome)
	require.Greater(t, accepted.Operation.EventSeq, int64(0))
}
