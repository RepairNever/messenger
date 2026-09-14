//go:build integration

package documents

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/testdb"
)

func seedHandlerUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName string) uuid.UUID {
	t.Helper()
	email := "handler_delete_teamspace_" + uuid.NewString() + "@example.com"
	var id uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, 'member')
		 RETURNING id`,
		email,
		displayName,
	).Scan(&id); err != nil {
		t.Fatalf("seed user %s: %v", email, err)
	}
	return id
}

func TestHandler_DeleteTeamspace(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	h := NewHandler(svc, nil, zap.NewNop(), 50)

	ownerID := seedHandlerUser(t, ctx, pool, "Owner")

	teamspace, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{
		Name:    "Handler delete",
		ActorID: ownerID,
	}, "member")
	if err != nil {
		t.Fatalf("create teamspace: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/documents/teamspaces/"+teamspace.ID.String(), nil)
	rec := httptest.NewRecorder()
	h.teamspaceItem(rec, req, auth.Principal{UserID: ownerID, Role: "member"}, teamspace.ID)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
}

func TestHandler_DeleteTeamspaceForbidden(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	h := NewHandler(svc, nil, zap.NewNop(), 50)

	ownerID := seedHandlerUser(t, ctx, pool, "Owner")
	outsiderID := seedHandlerUser(t, ctx, pool, "Outsider")

	teamspace, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{
		Name:    "Handler delete forbidden",
		ActorID: ownerID,
	}, "member")
	if err != nil {
		t.Fatalf("create teamspace: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/documents/teamspaces/"+teamspace.ID.String(), nil)
	rec := httptest.NewRecorder()
	h.teamspaceItem(rec, req, auth.Principal{UserID: outsiderID, Role: "member"}, teamspace.ID)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestHandler_SearchDocumentsBlankQuery(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	h := NewHandler(svc, nil, zap.NewNop(), 50)

	userID := seedHandlerUser(t, ctx, pool, "Searcher")

	req := httptest.NewRequest(http.MethodGet, "/api/documents/search?q=%20%20", nil)
	rec := httptest.NewRecorder()
	h.searchCollection(rec, req, auth.Principal{UserID: userID, Role: "member"})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestHandler_DocumentContentItem(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	h := NewHandler(svc, nil, zap.NewNop(), 50)

	ownerID := seedHandlerUser(t, ctx, pool, "Owner")

	teamspace, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{
		Name:    "Handler content",
		ActorID: ownerID,
	}, "member")
	if err != nil {
		t.Fatalf("create teamspace: %v", err)
	}

	initialContent := "first"
	doc, err := svc.CreateDocument(ctx, CreateDocumentParams{
		TeamspaceID:     teamspace.ID,
		Title:           "Spec",
		ContentMarkdown: &initialContent,
		ActorID:         ownerID,
	})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/documents/"+doc.ID.String()+"/content", bytes.NewBufferString(`{"content_markdown":"second","force_snapshot":true}`))
	rec := httptest.NewRecorder()
	h.documentContentItem(rec, req, auth.Principal{UserID: ownerID, Role: "member"}, doc.ID)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestHandler_DocumentFavoriteItem(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	h := NewHandler(svc, nil, zap.NewNop(), 50)

	ownerID := seedHandlerUser(t, ctx, pool, "Owner")

	teamspace, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{
		Name:    "Handler favorite",
		ActorID: ownerID,
	}, "member")
	if err != nil {
		t.Fatalf("create teamspace: %v", err)
	}

	doc, err := svc.CreateDocument(ctx, CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Favorite me",
		ActorID:     ownerID,
	})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/documents/"+doc.ID.String()+"/favorite", nil)
	rec := httptest.NewRecorder()
	h.documentFavoriteItem(rec, req, auth.Principal{UserID: ownerID, Role: "member"}, doc.ID)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var favorite DocumentFavoriteResponse
	if err := json.NewDecoder(rec.Body).Decode(&favorite); err != nil {
		t.Fatalf("decode favorite response: %v", err)
	}
	if favorite.DocumentID != doc.ID || !favorite.IsFavorite || favorite.FavoritedAt == nil {
		t.Fatalf("unexpected favorite response: %#v", favorite)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/documents/"+doc.ID.String()+"/favorite", nil)
	rec = httptest.NewRecorder()
	h.documentFavoriteItem(rec, req, auth.Principal{UserID: ownerID, Role: "member"}, doc.ID)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var unfavorite DocumentFavoriteResponse
	if err := json.NewDecoder(rec.Body).Decode(&unfavorite); err != nil {
		t.Fatalf("decode unfavorite response: %v", err)
	}
	if unfavorite.DocumentID != doc.ID || unfavorite.IsFavorite || unfavorite.FavoritedAt != nil {
		t.Fatalf("unexpected unfavorite response: %#v", unfavorite)
	}
}
