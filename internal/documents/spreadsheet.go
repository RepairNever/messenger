package documents

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/userstatus"
)

// Pinned Univer OSS 1.0.3 canonical authored defaults, including resource hooks.
//
//go:embed spreadsheet_blank.json
var spreadsheetBlankJSON []byte

type SpreadsheetState struct {
	Revision       int64           `json:"revision"`
	StructureEpoch int64           `json:"structure_epoch"`
	LastEventSeq   int64           `json:"last_event_seq"`
	Workbook       json.RawMessage `json:"workbook"`
}

type SpreadsheetOperation struct {
	ID             string `json:"id"`
	Outcome        string `json:"outcome"`
	Revision       int64  `json:"revision"`
	StructureEpoch int64  `json:"structure_epoch"`
	EventSeq       int64  `json:"event_seq"`
	Code           string `json:"code,omitempty"`
	Message        string `json:"message,omitempty"`
}

type SpreadsheetActionResponse struct {
	Operation SpreadsheetOperation `json:"operation"`
	State     SpreadsheetState     `json:"state"`
}

type SpreadsheetHistorySnapshot struct {
	ID             uuid.UUID             `json:"id"`
	Title          string                `json:"title"`
	Revision       int64                 `json:"revision"`
	StructureEpoch int64                 `json:"structure_epoch"`
	Workbook       json.RawMessage       `json:"workbook"`
	EditedBy       uuid.UUID             `json:"edited_by"`
	CreatedAt      time.Time             `json:"created_at"`
	Editor         DocumentHistoryEditor `json:"editor"`
}

type spreadsheetCellKey struct {
	SheetID  string
	Row, Col int
}
type lockedDocument struct {
	Kind, Title string
	Content     sql.NullString
}

// Handwritten queries keep this multi-table lock order and atomic event append
// explicit, matching the existing document service's transaction patterns.
func (s *Service) lockDocumentInTx(ctx context.Context, tx pgx.Tx, documentID, actorID uuid.UUID) (lockedDocument, error) {
	var doc lockedDocument
	var teamspaceID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT teamspace_id FROM document WHERE id=$1`, documentID).Scan(&teamspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return doc, fmt.Errorf("%w: document", ErrNotFound)
	}
	if err != nil {
		return doc, err
	}
	var marker int
	err = tx.QueryRow(ctx, `SELECT 1 FROM teamspace WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, teamspaceID).Scan(&marker)
	if errors.Is(err, pgx.ErrNoRows) {
		return doc, fmt.Errorf("%w: document", ErrNotFound)
	}
	if err != nil {
		return doc, err
	}
	var member bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM teamspace_member WHERE teamspace_id=$1 AND user_id=$2)`, teamspaceID, actorID).Scan(&member); err != nil {
		return doc, err
	}
	if !member {
		return doc, fmt.Errorf("%w: document", ErrForbidden)
	}
	err = tx.QueryRow(ctx, `SELECT kind,title,content_markdown FROM document WHERE id=$1 AND teamspace_id=$2 AND archived_at IS NULL FOR UPDATE`, documentID, teamspaceID).Scan(&doc.Kind, &doc.Title, &doc.Content)
	if errors.Is(err, pgx.ErrNoRows) {
		return doc, fmt.Errorf("%w: document", ErrNotFound)
	}
	return doc, err
}

func (s *Service) createSpreadsheetInTx(ctx context.Context, tx pgx.Tx, documentID uuid.UUID, title string) error {
	value, err := spreadsheetDecodeJSON(spreadsheetBlankJSON)
	if err != nil {
		return fmt.Errorf("invalid spreadsheet template: %w", err)
	}
	workbook := value.(map[string]any)
	workbook["id"] = documentID.String()
	workbook["name"] = title
	if err = validateSpreadsheetWorkbook(workbook, documentID.String()); err != nil {
		return err
	}
	raw, _ := json.Marshal(workbook)
	_, err = tx.Exec(ctx, `INSERT INTO document_spreadsheet(document_id,workbook_json) VALUES($1,$2)`, documentID, raw)
	return err
}

func (s *Service) GetSpreadsheet(ctx context.Context, documentID, actorID uuid.UUID) (SpreadsheetState, error) {
	var state SpreadsheetState
	err := s.pool.QueryRow(ctx, `SELECT w.revision,w.structure_epoch,w.last_event_seq,w.workbook_json
 FROM document_spreadsheet w JOIN document d ON d.id=w.document_id
 JOIN teamspace t ON t.id=d.teamspace_id AND t.deleted_at IS NULL
 JOIN teamspace_member m ON m.teamspace_id=t.id AND m.user_id=$2
 WHERE d.id=$1 AND d.archived_at IS NULL AND d.kind='spreadsheet'`, documentID, actorID).Scan(&state.Revision, &state.StructureEpoch, &state.LastEventSeq, &state.Workbook)
	if errors.Is(err, pgx.ErrNoRows) {
		doc, accessErr := s.GetDocument(ctx, documentID, actorID)
		if accessErr != nil {
			return state, accessErr
		}
		if doc.Kind != DocumentKindSpreadsheet {
			return state, fmt.Errorf("%w: document is not a spreadsheet", ErrBadRequest)
		}
		return state, fmt.Errorf("%w: spreadsheet state missing", ErrUnavailable)
	}
	return state, err
}

func (s *Service) ApplySpreadsheetAction(ctx context.Context, documentID, actorID uuid.UUID, raw []byte) (SpreadsheetActionResponse, error) {
	action, hash, err := parseSpreadsheetAction(raw)
	if err != nil {
		return SpreadsheetActionResponse{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	return s.applySpreadsheet(ctx, documentID, actorID, action, hash, nil)
}

func (s *Service) RestoreSpreadsheetHistory(ctx context.Context, documentID, historyID, actorID uuid.UUID, raw []byte) (SpreadsheetActionResponse, error) {
	value, err := spreadsheetDecodeJSON(raw)
	if err != nil {
		return SpreadsheetActionResponse{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	canonical, _ := json.Marshal(value)
	var request SpreadsheetRestoreRequest
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		return SpreadsheetActionResponse{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if err = validateSpreadsheetPreconditions(request.ID, request.BaseRevision, request.StructureEpoch); err != nil {
		return SpreadsheetActionResponse{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	identity, _ := json.Marshal(struct {
		HistoryID uuid.UUID                 `json:"history_id"`
		Request   SpreadsheetRestoreRequest `json:"request"`
	}{historyID, request})
	action := SpreadsheetAction{ID: request.ID, BaseRevision: request.BaseRevision, StructureEpoch: request.StructureEpoch, Kind: "structure"}
	return s.applySpreadsheet(ctx, documentID, actorID, action, sha256.Sum256(identity), &historyID)
}

func (s *Service) applySpreadsheet(ctx context.Context, documentID, actorID uuid.UUID, action SpreadsheetAction, hash [32]byte, historyID *uuid.UUID) (SpreadsheetActionResponse, error) {
	var response SpreadsheetActionResponse
	tx, err := events.BeginTx(ctx, s.pool)
	if err != nil {
		return response, err
	}
	defer tx.Rollback(ctx)
	doc, err := s.lockDocumentInTx(ctx, tx, documentID, actorID)
	if err != nil {
		return response, err
	}
	if doc.Kind != DocumentKindSpreadsheet {
		return response, fmt.Errorf("%w: document is not a spreadsheet", ErrBadRequest)
	}
	var epochStart int64
	err = tx.QueryRow(ctx, `SELECT revision,structure_epoch,last_event_seq,workbook_json,epoch_start_revision FROM document_spreadsheet WHERE document_id=$1 FOR UPDATE`, documentID).Scan(&response.State.Revision, &response.State.StructureEpoch, &response.State.LastEventSeq, &response.State.Workbook, &epochStart)
	if err != nil {
		return response, err
	}
	var storedActor uuid.UUID
	var storedHash []byte
	response.Operation.ID = action.ID
	err = tx.QueryRow(ctx, `SELECT actor_id,request_hash,outcome,revision,structure_epoch,event_seq,code,message FROM document_spreadsheet_operation WHERE document_id=$1 AND operation_id=$2`, documentID, action.ID).Scan(&storedActor, &storedHash, &response.Operation.Outcome, &response.Operation.Revision, &response.Operation.StructureEpoch, &response.Operation.EventSeq, &response.Operation.Code, &response.Operation.Message)
	if err == nil {
		if storedActor != actorID || !bytes.Equal(storedHash, hash[:]) {
			response.Operation = SpreadsheetOperation{ID: action.ID, Outcome: "conflict", Revision: response.State.Revision, StructureEpoch: response.State.StructureEpoch, Code: "OPERATION_ID_REUSED", Message: "operation ID already used with a different payload or actor"}
		}
		// Compact immutable receipt, fresh authorized state. Nothing is reapplied.
		if err = tx.Commit(ctx); err != nil {
			return SpreadsheetActionResponse{}, err
		}
		return response, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return response, err
	}
	if *action.BaseRevision > response.State.Revision {
		return response, fmt.Errorf("%w: base_revision is ahead of server state", ErrBadRequest)
	}
	conflict := func(message string) (SpreadsheetActionResponse, error) {
		response.Operation = SpreadsheetOperation{ID: action.ID, Outcome: "conflict", Revision: response.State.Revision, StructureEpoch: response.State.StructureEpoch, Code: "CONFLICT", Message: message}
		if err := saveSpreadsheetReceipt(ctx, tx, documentID, actorID, hash, response.Operation); err != nil {
			return SpreadsheetActionResponse{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return SpreadsheetActionResponse{}, err
		}
		return response, nil
	}
	if *action.StructureEpoch != response.State.StructureEpoch {
		return conflict("workbook structure changed; the prepared action was not saved")
	}
	if response.State.Revision == spreadsheetMaxSafeRevision || response.State.StructureEpoch == spreadsheetMaxSafeRevision {
		return response, fmt.Errorf("%w: spreadsheet revision limit reached", ErrUnavailable)
	}
	if action.Kind == "structure" && *action.BaseRevision != response.State.Revision {
		return conflict("structural actions require the exact current workbook revision")
	}
	if action.Kind == "cells" && *action.BaseRevision < epochStart {
		return conflict("base_revision predates the current workbook structure")
	}
	decoded, err := spreadsheetDecodeJSON(response.State.Workbook)
	if err != nil {
		return response, err
	}
	current := decoded.(map[string]any)
	var next map[string]any
	var sheetIDs []string
	var rows, cols []int32
	if action.Kind == "structure" {
		if historyID != nil {
			err = tx.QueryRow(ctx, `SELECT title,workbook_json FROM document_history WHERE document_id=$1 AND id=$2 AND kind='spreadsheet'`, documentID, *historyID).Scan(&doc.Title, &action.Workbook)
			if errors.Is(err, pgx.ErrNoRows) {
				return response, fmt.Errorf("%w: history snapshot", ErrNotFound)
			}
			if err != nil {
				return response, err
			}
		}
		decoded, err = spreadsheetDecodeJSON(action.Workbook)
		if err != nil {
			return response, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		var ok bool
		next, ok = decoded.(map[string]any)
		if !ok {
			return response, fmt.Errorf("%w: workbook must be an object", ErrBadRequest)
		}
	} else {
		next = current
		sheets := next["sheets"].(map[string]any)
		for _, patch := range action.Cells {
			sheet, ok := sheets[patch.SheetID].(map[string]any)
			if !ok {
				return response, fmt.Errorf("%w: nonexistent worksheet", ErrBadRequest)
			}
			nr, _ := spreadsheetInt(sheet["rowCount"])
			nc, _ := spreadsheetInt(sheet["columnCount"])
			if *patch.Row >= nr || *patch.Col >= nc {
				return response, fmt.Errorf("%w: coordinates outside worksheet", ErrBadRequest)
			}
			sheetIDs = append(sheetIDs, patch.SheetID)
			rows = append(rows, int32(*patch.Row))
			cols = append(cols, int32(*patch.Col))
		}
		var newer bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM document_spreadsheet_cell_version v
   JOIN unnest($2::text[],$3::integer[],$4::integer[]) p(sheet_id,row_index,column_index)
   USING(sheet_id,row_index,column_index) WHERE v.document_id=$1 AND v.last_revision>$5)`, documentID, sheetIDs, rows, cols, *action.BaseRevision).Scan(&newer)
		if err != nil {
			return response, err
		}
		if newer {
			return conflict("a target cell changed after this action was prepared; nothing was saved")
		}
		for _, patch := range action.Cells {
			sheet := sheets[patch.SheetID].(map[string]any)
			matrix, _ := sheet["cellData"].(map[string]any)
			if matrix == nil {
				matrix = map[string]any{}
				sheet["cellData"] = matrix
			}
			rowKey, colKey := strconv.Itoa(*patch.Row), strconv.Itoa(*patch.Col)
			row, _ := matrix[rowKey].(map[string]any)
			cell, _ := spreadsheetDecodeJSON(patch.Cell)
			if cell == nil {
				delete(row, colKey)
				if len(row) == 0 {
					delete(matrix, rowKey)
				}
			} else {
				if row == nil {
					row = map[string]any{}
					matrix[rowKey] = row
				}
				row[colKey] = cell
			}
		}
	}
	if err = validateSpreadsheetWorkbook(next, current["id"].(string)); err != nil {
		return response, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	nextRaw, _ := json.Marshal(next)
	if len(nextRaw) > SpreadsheetMaxBodyBytes {
		return response, fmt.Errorf("%w: workbook exceeds size limit", ErrBadRequest)
	}
	response.State.Revision++
	response.State.Workbook = nextRaw
	if action.Kind == "structure" {
		response.State.StructureEpoch++
		epochStart = response.State.Revision
		if _, err = tx.Exec(ctx, `DELETE FROM document_spreadsheet_cell_version WHERE document_id=$1`, documentID); err != nil {
			return response, err
		}
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO document_spreadsheet_cell_version(document_id,sheet_id,row_index,column_index,last_revision)
   SELECT $1,p.sheet_id,p.row_index,p.column_index,$5 FROM unnest($2::text[],$3::integer[],$4::integer[]) p(sheet_id,row_index,column_index)
   ON CONFLICT(document_id,sheet_id,row_index,column_index) DO UPDATE SET last_revision=EXCLUDED.last_revision`, documentID, sheetIDs, rows, cols, response.State.Revision)
		if err != nil {
			return response, err
		}
	}
	payload := &packetspb.SpreadsheetChangedEvent{DocumentId: documentID.String(), ActorId: actorID.String(), OperationId: action.ID, Revision: response.State.Revision, StructureEpoch: response.State.StructureEpoch, Kind: action.Kind}
	if action.Kind == "cells" {
		for _, patch := range action.Cells {
			p := &packetspb.SpreadsheetCellPatch{SheetId: patch.SheetID, Row: int32(*patch.Row), Col: int32(*patch.Col)}
			if bytes.Equal(patch.Cell, []byte("null")) {
				p.Clear = true
			} else {
				p.CellJson = string(patch.Cell)
			}
			payload.Cells = append(payload.Cells, p)
		}
	}
	occurredAt := time.Now().UTC()
	event := &packetspb.ServerEvent{EventType: packetspb.EventType_EVENT_TYPE_SPREADSHEET_CHANGED, OccurredAt: timestamppb.New(occurredAt), Payload: &packetspb.ServerEvent_SpreadsheetChanged{SpreadsheetChanged: payload}}
	payloadJSON, err := protojson.Marshal(payload)
	if err != nil {
		return response, err
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{EventID: uuid.NewString(), EventType: "spreadsheet_changed", PayloadJSON: payloadJSON, OccurredAt: occurredAt, ProtoPayload: event})
	if err != nil {
		return response, err
	}
	response.State.LastEventSeq = stored.Seq
	_, err = tx.Exec(ctx, `UPDATE document_spreadsheet SET workbook_json=$2,revision=$3,structure_epoch=$4,epoch_start_revision=$5,last_event_seq=$6 WHERE document_id=$1`, documentID, nextRaw, response.State.Revision, response.State.StructureEpoch, epochStart, stored.Seq)
	if err != nil {
		return response, err
	}
	_, err = tx.Exec(ctx, `UPDATE document SET title=$2,updated_by=$3,updated_at=now() WHERE id=$1`, documentID, doc.Title, actorID)
	if err != nil {
		return response, err
	}
	if err = s.createSpreadsheetSnapshotInTx(ctx, tx, documentID, doc.Title, actorID); err != nil {
		return response, err
	}
	response.Operation = SpreadsheetOperation{ID: action.ID, Outcome: "accepted", Revision: response.State.Revision, StructureEpoch: response.State.StructureEpoch, EventSeq: stored.Seq}
	if err = saveSpreadsheetReceipt(ctx, tx, documentID, actorID, hash, response.Operation); err != nil {
		return response, err
	}
	if err = s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return response, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SpreadsheetActionResponse{}, err
	}
	return response, nil
}

func saveSpreadsheetReceipt(ctx context.Context, tx pgx.Tx, documentID, actorID uuid.UUID, hash [32]byte, operation SpreadsheetOperation) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_spreadsheet_operation(document_id,operation_id,actor_id,request_hash,outcome,revision,structure_epoch,event_seq,code,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, documentID, operation.ID, actorID, hash[:], operation.Outcome, operation.Revision, operation.StructureEpoch, operation.EventSeq, operation.Code, operation.Message)
	return err
}

func (s *Service) createSpreadsheetSnapshotInTx(ctx context.Context, tx pgx.Tx, documentID uuid.UUID, title string, actorID uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_history(document_id,title,kind,workbook_json,spreadsheet_revision,spreadsheet_structure_epoch,edited_by,created_at)
 SELECT w.document_id,$2,'spreadsheet',w.workbook_json,w.revision,w.structure_epoch,$3,
 GREATEST(clock_timestamp(),COALESCE((SELECT max(created_at)+interval '1 microsecond' FROM document_history WHERE document_id=$1),'-infinity'::timestamptz)) FROM document_spreadsheet w WHERE w.document_id=$1
 AND NOT EXISTS(SELECT 1 FROM (SELECT title,spreadsheet_revision FROM document_history WHERE document_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1) latest WHERE latest.title=$2 AND latest.spreadsheet_revision=w.revision)`, documentID, title, actorID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `WITH ranked AS(SELECT id,row_number() OVER(ORDER BY created_at DESC,id DESC) rn FROM document_history WHERE document_id=$1) DELETE FROM document_history h USING ranked r WHERE h.id=r.id AND r.rn>$2`, documentID, s.historyLimit)
	return err
}

func (s *Service) GetSpreadsheetHistory(ctx context.Context, documentID, historyID, actorID uuid.UUID) (SpreadsheetHistorySnapshot, error) {
	var snapshot SpreadsheetHistorySnapshot
	var statusText, statusEmoji string
	var statusExpires sql.NullTime
	err := s.pool.QueryRow(ctx, `SELECT h.id,h.title,h.spreadsheet_revision,h.spreadsheet_structure_epoch,h.workbook_json,h.edited_by,h.created_at,u.id,COALESCE(NULLIF(u.display_name,''),u.email),u.avatar_url,u.custom_status_text,u.custom_status_emoji,u.custom_status_expires_at
 FROM document_history h JOIN document d ON d.id=h.document_id AND d.kind='spreadsheet' AND d.archived_at IS NULL
 JOIN teamspace t ON t.id=d.teamspace_id AND t.deleted_at IS NULL JOIN teamspace_member m ON m.teamspace_id=t.id AND m.user_id=$3 JOIN users u ON u.id=h.edited_by
 WHERE h.document_id=$1 AND h.id=$2 AND h.kind='spreadsheet'`, documentID, historyID, actorID).Scan(&snapshot.ID, &snapshot.Title, &snapshot.Revision, &snapshot.StructureEpoch, &snapshot.Workbook, &snapshot.EditedBy, &snapshot.CreatedAt, &snapshot.Editor.ID, &snapshot.Editor.DisplayName, &snapshot.Editor.AvatarURL, &statusText, &statusEmoji, &statusExpires)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, accessErr := s.GetSpreadsheet(ctx, documentID, actorID); accessErr != nil {
			return snapshot, accessErr
		}
		return snapshot, fmt.Errorf("%w: history snapshot", ErrNotFound)
	}
	snapshot.Editor.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(statusText, statusEmoji, statusExpires, time.Now().UTC()))
	return snapshot, err
}
