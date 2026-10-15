//go:build integration

package documents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	stdsync "sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"msgnr/internal/auth"
	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	syncsvc "msgnr/internal/sync"
	"msgnr/internal/testdb"
)

func sheetActionJSON(id string, base, epoch int64, patches ...map[string]any) []byte {
	raw, _ := json.Marshal(map[string]any{"id": id, "base_revision": base, "structure_epoch": epoch, "kind": "cells", "cells": patches})
	return raw
}
func sheetPatch(sheet string, row, col int, value any) map[string]any {
	return map[string]any{"sheet_id": sheet, "row": row, "col": col, "cell": value}
}
func sheetValue(row, col int, value any) map[string]any {
	return sheetPatch("sheet-1", row, col, map[string]any{"v": value})
}
func sheetStructure(id string, current SpreadsheetState, workbook map[string]any) []byte {
	raw, _ := json.Marshal(map[string]any{"id": id, "base_revision": current.Revision, "structure_epoch": current.StructureEpoch, "kind": "structure", "workbook": workbook})
	return raw
}
func sheetBook(t *testing.T, state SpreadsheetState) map[string]any {
	t.Helper()
	value, err := spreadsheetDecodeJSON(state.Workbook)
	require.NoError(t, err)
	return value.(map[string]any)
}
func sheetStoredCell(t *testing.T, state SpreadsheetState, sheet string, row, col int) any {
	t.Helper()
	book := sheetBook(t, state)
	matrix, _ := book["sheets"].(map[string]any)[sheet].(map[string]any)["cellData"].(map[string]any)
	rowData, _ := matrix[fmt.Sprint(row)].(map[string]any)
	return rowData[fmt.Sprint(col)]
}

func TestIntegration_SpreadsheetDurableArbitration(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	owner := seedHandlerUser(t, ctx, pool, "Spreadsheet owner")
	member := seedHandlerUser(t, ctx, pool, "Spreadsheet member")
	outsider := seedHandlerUser(t, ctx, pool, "Spreadsheet outsider")
	teamspace, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{Name: "Sheets", IsPrivate: true, MemberIDs: []uuid.UUID{member}, ActorID: owner}, "member")
	require.NoError(t, err)
	newDoc := func(t *testing.T) uuid.UUID {
		t.Helper()
		doc, err := svc.CreateDocument(ctx, CreateDocumentParams{TeamspaceID: teamspace.ID, Kind: DocumentKindSpreadsheet, Title: "Workbook", ActorID: owner})
		require.NoError(t, err)
		require.Equal(t, DocumentKindSpreadsheet, doc.Kind)
		require.Nil(t, doc.ContentMarkdown)
		return doc.ID
	}
	apply := func(t *testing.T, id, actor uuid.UUID, raw []byte) SpreadsheetActionResponse {
		t.Helper()
		response, err := svc.ApplySpreadsheetAction(ctx, id, actor, raw)
		require.NoError(t, err)
		return response
	}
	current := func(t *testing.T, id uuid.UUID) SpreadsheetState {
		t.Helper()
		state, err := svc.GetSpreadsheet(ctx, id, owner)
		require.NoError(t, err)
		return state
	}

	t.Run("first commit wins under concurrent row locks", func(t *testing.T) {
		id := newDoc(t)
		const count = 12
		start := make(chan struct{})
		responses := make(chan SpreadsheetActionResponse, count)
		failures := make(chan error, count)
		var workers stdsync.WaitGroup
		for i := 0; i < count; i++ {
			workers.Add(1)
			go func(i int) {
				defer workers.Done()
				<-start
				r, err := svc.ApplySpreadsheetAction(ctx, id, owner, sheetActionJSON(fmt.Sprintf("race-%d", i), 0, 0, sheetValue(0, 0, i)))
				responses <- r
				failures <- err
			}(i)
		}
		close(start)
		workers.Wait()
		close(responses)
		close(failures)
		for err := range failures {
			require.NoError(t, err)
		}
		accepted := 0
		var winner SpreadsheetActionResponse
		for r := range responses {
			if r.Operation.Outcome == "accepted" {
				accepted++
				winner = r
			} else {
				require.Equal(t, "conflict", r.Operation.Outcome)
			}
		}
		require.Equal(t, 1, accepted)
		require.Equal(t, int64(1), current(t, id).Revision)
		require.JSONEq(t, string(winner.State.Workbook), string(current(t, id).Workbook))
		var receipts, eventCount int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM document_spreadsheet_operation WHERE document_id=$1`, id).Scan(&receipts))
		require.Equal(t, count, receipts)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_events WHERE event_type='spreadsheet_changed' AND payload->>'documentId'=$1`, id.String()).Scan(&eventCount))
		require.Equal(t, 1, eventCount)
	})
	t.Run("independent concurrent cells both commit", func(t *testing.T) {
		id := newDoc(t)
		start := make(chan struct{})
		done := make(chan SpreadsheetActionResponse, 2)
		failures := make(chan error, 2)
		for col := 0; col < 2; col++ {
			go func(col int) {
				<-start
				response, err := svc.ApplySpreadsheetAction(ctx, id, owner, sheetActionJSON(fmt.Sprintf("independent-%d", col), 0, 0, sheetValue(0, col, col)))
				done <- response
				failures <- err
			}(col)
		}
		close(start)
		for i := 0; i < 2; i++ {
			require.NoError(t, <-failures)
			require.Equal(t, "accepted", (<-done).Operation.Outcome)
		}
		require.Equal(t, int64(2), current(t, id).Revision)
	})
	t.Run("independent edits bulk rollback tombstones and structural epochs", func(t *testing.T) {
		id := newDoc(t)
		require.Equal(t, "accepted", apply(t, id, owner, sheetActionJSON("left", 0, 0, sheetValue(0, 0, "left"))).Operation.Outcome)
		require.Equal(t, "accepted", apply(t, id, member, sheetActionJSON("right", 0, 0, sheetValue(0, 1, "right"))).Operation.Outcome)
		before := current(t, id)
		rejected := apply(t, id, owner, sheetActionJSON("paste", 0, 0, sheetValue(0, 2, "partial"), sheetValue(0, 1, "stale")))
		require.Equal(t, "conflict", rejected.Operation.Outcome)
		require.JSONEq(t, string(before.Workbook), string(rejected.State.Workbook))
		require.Equal(t, before.Revision, rejected.State.Revision)
		require.Equal(t, "conflict", apply(t, id, owner, sheetActionJSON("format", 0, 0, sheetPatch("sheet-1", 0, 0, map[string]any{"s": map[string]any{"bl": 1}}))).Operation.Outcome)
		require.Equal(t, "accepted", apply(t, id, owner, sheetActionJSON("clear", 2, 0, sheetPatch("sheet-1", 0, 0, nil))).Operation.Outcome)
		require.Equal(t, "conflict", apply(t, id, owner, sheetActionJSON("old-blank", 0, 0, sheetValue(0, 0, "ABA"))).Operation.Outcome)
		require.Nil(t, sheetStoredCell(t, current(t, id), "sheet-1", 0, 0))
		state := current(t, id)
		book := sheetBook(t, state)
		book["sheetOrder"] = []any{"sheet-1", "sheet-2"}
		book["sheets"].(map[string]any)["sheet-2"] = map[string]any{"id": "sheet-2", "name": "Other", "rowCount": 10, "columnCount": 10, "cellData": map[string]any{}}
		old := state
		old.Revision--
		require.Equal(t, "conflict", apply(t, id, owner, sheetStructure("old-structure", old, book)).Operation.Outcome)
		structural := apply(t, id, owner, sheetStructure("add-sheet", state, book))
		require.Equal(t, "accepted", structural.Operation.Outcome)
		require.Equal(t, int64(1), structural.State.StructureEpoch)
		require.Equal(t, "conflict", apply(t, id, owner, sheetActionJSON("old-epoch", state.Revision, 0, sheetPatch("sheet-2", 0, 0, map[string]any{"v": "stale"}))).Operation.Outcome)
		require.Equal(t, "conflict", apply(t, id, owner, sheetActionJSON("forged-epoch", state.Revision, 1, sheetPatch("sheet-2", 0, 0, map[string]any{"v": "stale"}))).Operation.Outcome)
		require.Equal(t, "accepted", apply(t, id, owner, sheetActionJSON("fresh-second-sheet", structural.State.Revision, 1, sheetPatch("sheet-2", 0, 0, map[string]any{"f": "=Sheet1!B1", "s": map[string]any{"bl": 1}}))).Operation.Outcome)
		event, err := events.NewStore(pool).GetEventBySeq(ctx, structural.Operation.EventSeq)
		require.NoError(t, err)
		require.Equal(t, "structure", event.Proto.GetSpreadsheetChanged().Kind)
		require.Empty(t, event.Proto.GetSpreadsheetChanged().Cells)
	})
	t.Run("compact idempotency persists after service and pool restart", func(t *testing.T) {
		id := newDoc(t)
		request := sheetActionJSON("lost-ack", 0, 0, sheetValue(0, 0, "first"))
		original := apply(t, id, owner, request)
		apply(t, id, owner, sheetActionJSON("later", 1, 0, sheetValue(0, 1, "later")))
		restartedPool, err := pgxpool.New(ctx, connStr)
		require.NoError(t, err)
		defer restartedPool.Close()
		restarted := NewService(restartedPool, nil)
		retry, err := restarted.ApplySpreadsheetAction(ctx, id, owner, request)
		require.NoError(t, err)
		require.Equal(t, original.Operation, retry.Operation)
		require.Equal(t, int64(2), retry.State.Revision)
		require.Equal(t, "OPERATION_ID_REUSED", apply(t, id, member, request).Operation.Code)
		require.Equal(t, "OPERATION_ID_REUSED", apply(t, id, owner, sheetActionJSON("lost-ack", 0, 0, sheetValue(0, 0, "different"))).Operation.Code)
		conflictRaw := sheetActionJSON("durable-conflict", 0, 0, sheetValue(0, 0, "loser"))
		conflict := apply(t, id, owner, conflictRaw)
		apply(t, id, owner, sheetActionJSON("next", 2, 0, sheetValue(0, 2, "next")))
		retry = apply(t, id, owner, conflictRaw)
		require.Equal(t, conflict.Operation, retry.Operation)
		require.Equal(t, int64(3), retry.State.Revision)
	})
	t.Run("history restoration monotonic versions bounded snapshots permanent receipts", func(t *testing.T) {
		id := newDoc(t)
		history, err := svc.ListDocumentHistory(ctx, id, owner)
		require.NoError(t, err)
		require.Len(t, history, 1)
		initial := history[0]
		require.Equal(t, DocumentKindSpreadsheet, initial.Kind)
		apply(t, id, owner, sheetActionJSON("edit-before-restore", 0, 0, sheetValue(0, 0, "will-restore")))
		title := "Renamed"
		_, err = svc.UpdateDocument(ctx, id, UpdateDocumentParams{Title: &title, ActorID: owner})
		require.NoError(t, err)
		snapshot, err := svc.GetSpreadsheetHistory(ctx, id, initial.ID, owner)
		require.NoError(t, err)
		require.Equal(t, int64(0), snapshot.Revision)
		stale, _ := json.Marshal(map[string]any{"id": "stale-restore", "base_revision": 0, "structure_epoch": 0})
		r, err := svc.RestoreSpreadsheetHistory(ctx, id, initial.ID, owner, stale)
		require.NoError(t, err)
		require.Equal(t, "conflict", r.Operation.Outcome)
		raw := []byte(`{"id":"restore","base_revision":1,"structure_epoch":0}`)
		restored, err := svc.RestoreSpreadsheetHistory(ctx, id, initial.ID, owner, raw)
		require.NoError(t, err)
		require.Equal(t, "accepted", restored.Operation.Outcome)
		require.Equal(t, int64(2), restored.State.Revision)
		require.Equal(t, int64(1), restored.State.StructureEpoch)
		require.Nil(t, sheetStoredCell(t, restored.State, "sheet-1", 0, 0))
		doc, err := svc.GetDocument(ctx, id, owner)
		require.NoError(t, err)
		require.Equal(t, "Workbook", doc.Title)
		// Default history remains 25 snapshots, independent of receipt lifetime.
		for i := 0; i < 26; i++ {
			state := current(t, id)
			apply(t, id, owner, sheetActionJSON(fmt.Sprintf("history-%d", i), state.Revision, state.StructureEpoch, sheetValue(0, 0, i)))
		}
		history, err = svc.ListDocumentHistory(ctx, id, owner)
		require.NoError(t, err)
		require.Len(t, history, 25)
		_, err = svc.GetSpreadsheetHistory(ctx, id, initial.ID, owner)
		require.ErrorIs(t, err, ErrNotFound)
		retry, err := svc.RestoreSpreadsheetHistory(ctx, id, initial.ID, owner, raw)
		require.NoError(t, err)
		require.Equal(t, restored.Operation, retry.Operation)
		require.Equal(t, int64(28), retry.State.Revision)
	})
	t.Run("old transaction snapshot remains newest at retention boundary", func(t *testing.T) {
		id := newDoc(t)
		queued, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer queued.Rollback(ctx)
		// Establish a transaction start timestamp before other commits, just as
		// a queued action does before it acquires document serialization locks.
		var oldStart time.Time
		require.NoError(t, queued.QueryRow(ctx, `SELECT now()`).Scan(&oldStart))
		for i := 0; i < 25; i++ {
			state := current(t, id)
			apply(t, id, owner, sheetActionJSON(fmt.Sprintf("before-queued-%d", i), state.Revision, state.StructureEpoch, sheetValue(0, 0, i)))
		}
		_, err = svc.lockDocumentInTx(ctx, queued, id, owner)
		require.NoError(t, err)
		_, err = queued.Exec(ctx, `UPDATE document_spreadsheet SET revision=revision+1 WHERE document_id=$1`, id)
		require.NoError(t, err)
		require.NoError(t, svc.createSpreadsheetSnapshotInTx(ctx, queued, id, "Workbook", owner))
		require.NoError(t, queued.Commit(ctx))
		history, err := svc.ListDocumentHistory(ctx, id, owner)
		require.NoError(t, err)
		require.Len(t, history, 25)
		require.NotNil(t, history[0].SpreadsheetRevision)
		require.Equal(t, int64(26), *history[0].SpreadsheetRevision)
		require.True(t, history[0].CreatedAt.After(oldStart))
	})
	t.Run("transaction rollback leaves state versions history receipts and events unchanged", func(t *testing.T) {
		id := newDoc(t)
		before := current(t, id)
		_, err := pool.Exec(ctx, `CREATE FUNCTION reject_sheet_receipt() RETURNS trigger AS $$ BEGIN IF NEW.operation_id='rollback' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_sheet_receipt BEFORE INSERT ON document_spreadsheet_operation FOR EACH ROW EXECUTE FUNCTION reject_sheet_receipt()`)
		require.NoError(t, err)
		defer func() {
			_, err := pool.Exec(ctx, `DROP TRIGGER reject_sheet_receipt ON document_spreadsheet_operation; DROP FUNCTION reject_sheet_receipt()`)
			require.NoError(t, err)
		}()
		_, err = svc.ApplySpreadsheetAction(ctx, id, owner, sheetActionJSON("rollback", 0, 0, sheetValue(0, 0, "must-not-save")))
		require.Error(t, err)
		after := current(t, id)
		require.Equal(t, before.Revision, after.Revision)
		require.Equal(t, before.LastEventSeq, after.LastEventSeq)
		require.JSONEq(t, string(before.Workbook), string(after.Workbook))
		for _, table := range []string{"document_spreadsheet_cell_version", "document_spreadsheet_operation"} {
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE document_id=$1`, id).Scan(&count))
			require.Zero(t, count)
		}
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_events WHERE payload->>'documentId'=$1`, id.String()).Scan(&count))
		require.Zero(t, count)
		history, err := svc.ListDocumentHistory(ctx, id, owner)
		require.NoError(t, err)
		require.Len(t, history, 1)
	})
	t.Run("legacy Markdown remains available spreadsheet writes and collab seed denied", func(t *testing.T) {
		id := newDoc(t)
		text := "Markdown"
		_, err := svc.UpdateDocumentContent(ctx, id, UpdateDocumentContentParams{ContentMarkdown: &text, ActorID: owner})
		require.ErrorIs(t, err, ErrBadRequest)
		_, err = svc.UpdateDocument(ctx, id, UpdateDocumentParams{ContentMarkdown: &text, ActorID: owner})
		require.ErrorIs(t, err, ErrBadRequest)
		_, err = svc.GetDocumentContent(ctx, id, owner)
		require.ErrorIs(t, err, ErrBadRequest)
		_, err = pool.Exec(ctx, `UPDATE document SET kind='markdown' WHERE id=$1`, id)
		require.Error(t, err)
		markdown, err := svc.CreateDocument(ctx, CreateDocumentParams{TeamspaceID: teamspace.ID, Title: "Markdown", ContentMarkdown: &text, ActorID: owner})
		require.NoError(t, err)
		require.Equal(t, DocumentKindMarkdown, markdown.Kind)
		_, err = svc.GetSpreadsheet(ctx, markdown.ID, owner)
		require.ErrorIs(t, err, ErrBadRequest)
		h := NewHandler(svc, nil, nil, 50)
		request := httptest.NewRequest(http.MethodPatch, "/api/documents/"+id.String(), bytes.NewReader([]byte(`{"title":"Still sheet","content_markdown":null}`)))
		rec := httptest.NewRecorder()
		h.documentItem(rec, request, auth.Principal{UserID: owner})
		require.Equal(t, http.StatusBadRequest, rec.Code)
		request = httptest.NewRequest(http.MethodPost, "/api/documents/"+id.String()+"/spreadsheet/actions", bytes.NewReader(sheetActionJSON("http", 0, 0, sheetValue(0, 0, 7))))
		request.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		h.documentItem(rec, request, auth.Principal{UserID: owner})
		require.Equal(t, http.StatusOK, rec.Code)
		request = httptest.NewRequest(http.MethodPost, "/api/documents/"+id.String()+"/spreadsheet/actions", bytes.NewReader(sheetActionJSON("http-conflict", 0, 0, sheetValue(0, 0, 8))))
		request.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		h.documentItem(rec, request, auth.Principal{UserID: owner})
		require.Equal(t, http.StatusConflict, rec.Code)
		require.Contains(t, rec.Body.String(), `"operation"`)
	})
	t.Run("ACL revocation and archive reject state receipts and event delivery", func(t *testing.T) {
		// This subtest runs after an injected rollback sequence gap: sync from the
		// current watermark, so privacy is checked on a contiguous new event window.
		var cursor int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT COALESCE(max(event_seq),0) FROM workspace_events`).Scan(&cursor))
		id := newDoc(t)
		raw := sheetActionJSON("private", 0, 0, sheetValue(0, 0, "secret"))
		accepted := apply(t, id, owner, raw)
		event, err := events.NewStore(pool).GetEventBySeq(ctx, accepted.Operation.EventSeq)
		require.NoError(t, err)
		a := auth.NewService(nil, nil, nil, pool, 0, nil)
		ownerP := auth.Principal{UserID: owner}
		memberP := auth.Principal{UserID: member}
		outsiderP := auth.Principal{UserID: outsider}
		require.True(t, a.CanReceiveEvent(ctx, ownerP, event.Proto))
		require.True(t, a.CanReceiveEvent(ctx, memberP, event.Proto))
		require.False(t, a.CanReceiveEvent(ctx, outsiderP, event.Proto))
		cached, result := a.CanReceiveEventWithConversationAccess(memberP, event.Proto, func(string) bool { return true }, nil)
		require.False(t, cached)
		require.Equal(t, "document_access_required", result)
		sy := syncsvc.NewService(pool, &config.Config{SyncEventLimit: 1000, MaxSyncBatch: 1000, SyncRetentionWindow: 72}, events.NewStore(pool), a.CanReceiveEvent)
		syncResult, err := sy.SyncSince(ctx, outsiderP, &packetspb.SyncSinceRequest{AfterSeq: cursor, MaxEvents: 1000})
		require.NoError(t, err)
		require.False(t, syncResult.NeedFullBootstrap)
		require.Empty(t, syncResult.Events)
		require.Equal(t, accepted.Operation.EventSeq, syncResult.SyncCursor)
		syncResult, err = sy.SyncSince(ctx, memberP, &packetspb.SyncSinceRequest{AfterSeq: cursor, MaxEvents: 1000})
		require.NoError(t, err)
		require.Len(t, syncResult.Events, 1)
		_, err = svc.GetSpreadsheet(ctx, id, outsider)
		require.ErrorIs(t, err, ErrForbidden)
		_, err = svc.ApplySpreadsheetAction(ctx, id, outsider, raw)
		require.ErrorIs(t, err, ErrForbidden)
		_, err = svc.UpdateTeamspace(ctx, teamspace.ID, UpdateTeamspaceParams{Name: "Sheets", IsPrivate: true, ActorID: owner, ActorRole: "member"})
		require.NoError(t, err)
		_, err = svc.GetSpreadsheet(ctx, id, member)
		require.ErrorIs(t, err, ErrForbidden)
		_, err = svc.ApplySpreadsheetAction(ctx, id, member, raw)
		require.ErrorIs(t, err, ErrForbidden)
		require.False(t, a.CanReceiveEvent(ctx, memberP, event.Proto))
		syncResult, err = sy.SyncSince(ctx, memberP, &packetspb.SyncSinceRequest{AfterSeq: cursor, MaxEvents: 1000})
		require.NoError(t, err)
		require.Empty(t, syncResult.Events)
		require.NoError(t, svc.DeleteDocument(ctx, id, owner))
		_, err = svc.GetSpreadsheet(ctx, id, owner)
		require.ErrorIs(t, err, ErrNotFound)
		_, err = svc.ApplySpreadsheetAction(ctx, id, owner, raw)
		require.ErrorIs(t, err, ErrNotFound)
		require.False(t, a.CanReceiveEvent(ctx, ownerP, event.Proto))
	})
	t.Run("archive wins while action waits on document lock", func(t *testing.T) {
		id := newDoc(t)
		archival, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer archival.Rollback(ctx)
		_, err = archival.Exec(ctx, `SELECT 1 FROM document WHERE id=$1 FOR UPDATE`, id)
		require.NoError(t, err)
		done := make(chan error, 1)
		go func() {
			_, err := svc.ApplySpreadsheetAction(ctx, id, owner, sheetActionJSON("archived-during-wait", 0, 0, sheetValue(0, 0, "denied")))
			done <- err
		}()
		select {
		case err := <-done:
			t.Fatalf("action bypassed document lock: %v", err)
		case <-time.After(50 * time.Millisecond):
		}
		_, err = archival.Exec(ctx, `UPDATE document SET archived_at=now() WHERE id=$1`, id)
		require.NoError(t, err)
		require.NoError(t, archival.Commit(ctx))
		select {
		case err := <-done:
			require.ErrorIs(t, err, ErrNotFound)
		case <-time.After(5 * time.Second):
			t.Fatal("action did not finish after archive")
		}
		var revision int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT revision FROM document_spreadsheet WHERE document_id=$1`, id).Scan(&revision))
		require.Zero(t, revision)
	})
	t.Run("concurrent membership revocation waits for action teamspace lock", func(t *testing.T) {
		_, err := svc.UpdateTeamspace(ctx, teamspace.ID, UpdateTeamspaceParams{Name: "Sheets", IsPrivate: true, MemberIDs: []uuid.UUID{member}, ActorID: owner, ActorRole: "member"})
		require.NoError(t, err)
		id := newDoc(t)
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		_, err = tx.Exec(ctx, `SELECT 1 FROM teamspace WHERE id=$1 FOR UPDATE`, teamspace.ID)
		require.NoError(t, err)
		done := make(chan error, 1)
		go func() {
			_, err := svc.ApplySpreadsheetAction(ctx, id, member, sheetActionJSON("revoked-during-wait", 0, 0, sheetValue(0, 0, "denied")))
			done <- err
		}()
		select {
		case err := <-done:
			t.Fatalf("action bypassed teamspace lock: %v", err)
		case <-time.After(50 * time.Millisecond):
		}
		_, err = tx.Exec(ctx, `DELETE FROM teamspace_member WHERE teamspace_id=$1 AND user_id=$2`, teamspace.ID, member)
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
		select {
		case err := <-done:
			require.ErrorIs(t, err, ErrForbidden)
		case <-time.After(5 * time.Second):
			t.Fatal("action did not finish after revocation")
		}
		require.Zero(t, current(t, id).Revision)
	})
}
