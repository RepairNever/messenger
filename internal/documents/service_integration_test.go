//go:build integration

package documents_test

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/documents"
	"msgnr/internal/testdb"
)

func seedDocumentUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if role == "" {
		role = "member"
	}
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, $3)
		 RETURNING id`,
		"documents_test_"+uuid.NewString()+"@example.com",
		displayName,
		role,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func TestIntegration_ListTeamspacesVisibilityAndJoin(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	publicSpace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Public space",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	_, err = svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Private space",
		IsPrivate: true,
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	rows, err := svc.ListTeamspaces(ctx, outsiderID, "member")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, publicSpace.ID, rows[0].ID)
	assert.False(t, rows[0].IsMember)
	assert.Equal(t, 2, rows[0].MemberCount)

	joined, err := svc.JoinTeamspace(ctx, publicSpace.ID, outsiderID, "member")
	require.NoError(t, err)
	assert.True(t, joined.IsMember)

	rows, err = svc.ListTeamspaces(ctx, outsiderID, "member")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].IsMember)
	assert.Equal(t, 3, rows[0].MemberCount)
}

func TestIntegration_DeleteTeamspaceArchivesDocsAndHidesIt(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Delete docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	rootDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Root doc",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	childDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      teamspace.ID,
		ParentDocumentID: &rootDoc.ID,
		Title:            "Child doc",
		ActorID:          memberID,
	})
	require.NoError(t, err)

	_, err = svc.FavoriteDocument(ctx, rootDoc.ID, ownerID)
	require.NoError(t, err)
	_, err = svc.FavoriteDocument(ctx, childDoc.ID, memberID)
	require.NoError(t, err)

	err = svc.DeleteTeamspace(ctx, teamspace.ID, ownerID, "member")
	require.NoError(t, err)

	var teamspaceDeletedAt sql.NullTime
	require.NoError(t, pool.QueryRow(ctx, `SELECT deleted_at FROM teamspace WHERE id = $1`, teamspace.ID).Scan(&teamspaceDeletedAt))
	require.True(t, teamspaceDeletedAt.Valid)

	for _, documentID := range []uuid.UUID{rootDoc.ID, childDoc.ID} {
		var archivedAt sql.NullTime
		require.NoError(t, pool.QueryRow(ctx, `SELECT archived_at FROM document WHERE id = $1`, documentID).Scan(&archivedAt))
		require.True(t, archivedAt.Valid)

		_, err = svc.GetDocument(ctx, documentID, ownerID)
		require.ErrorIs(t, err, documents.ErrNotFound)
	}

	var favoriteCount int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*)
		   FROM document_favorite
		  WHERE document_id IN ($1, $2)`,
		rootDoc.ID, childDoc.ID,
	).Scan(&favoriteCount))
	assert.Zero(t, favoriteCount)

	rows, err := svc.ListTeamspaces(ctx, ownerID, "member")
	require.NoError(t, err)
	require.Empty(t, rows)

	sidebar, err := svc.ListSidebar(ctx, ownerID)
	require.NoError(t, err)
	require.Empty(t, sidebar)

	sidebar, err = svc.ListSidebar(ctx, memberID)
	require.NoError(t, err)
	require.Empty(t, sidebar)

	rows, err = svc.ListTeamspaces(ctx, outsiderID, "member")
	require.NoError(t, err)
	require.Empty(t, rows)
}

func TestIntegration_DeleteTeamspaceRejectsNonManagers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:    "Managed docs",
		ActorID: ownerID,
	}, "member")
	require.NoError(t, err)

	err = svc.DeleteTeamspace(ctx, teamspace.ID, outsiderID, "member")
	require.ErrorIs(t, err, documents.ErrForbidden)

	rows, err := svc.ListTeamspaces(ctx, ownerID, "member")
	require.NoError(t, err)
	require.Len(t, rows, 1)
}

func TestIntegration_SidebarHierarchyMemberOnly(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	rootDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Root doc",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	_, err = svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      teamspace.ID,
		ParentDocumentID: &rootDoc.ID,
		Title:            "Child doc",
		ActorID:          memberID,
	})
	require.NoError(t, err)

	sidebar, err := svc.ListSidebar(ctx, memberID)
	require.NoError(t, err)
	require.Len(t, sidebar, 1)
	require.Len(t, sidebar[0].Documents, 1)
	assert.Equal(t, "Root doc", sidebar[0].Documents[0].Title)
	require.Len(t, sidebar[0].Documents[0].Children, 1)
	assert.Equal(t, "Child doc", sidebar[0].Documents[0].Children[0].Title)

	sidebar, err = svc.ListSidebar(ctx, outsiderID)
	require.NoError(t, err)
	assert.Empty(t, sidebar)
}

func TestIntegration_DocumentFavoritesArePerUserAndSidebarOnlyShowsVisibleDocuments(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Favorites",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	rootDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Root favorite",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	childDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      teamspace.ID,
		ParentDocumentID: &rootDoc.ID,
		Title:            "Child favorite",
		ActorID:          memberID,
	})
	require.NoError(t, err)

	favorite, err := svc.FavoriteDocument(ctx, childDoc.ID, memberID)
	require.NoError(t, err)
	assert.Equal(t, childDoc.ID, favorite.DocumentID)
	assert.True(t, favorite.IsFavorite)
	require.NotNil(t, favorite.FavoritedAt)

	_, err = svc.FavoriteDocument(ctx, childDoc.ID, outsiderID)
	require.ErrorIs(t, err, documents.ErrForbidden)

	sidebar, err := svc.ListSidebar(ctx, memberID)
	require.NoError(t, err)
	require.Len(t, sidebar, 1)
	require.Len(t, sidebar[0].Documents, 1)
	require.Len(t, sidebar[0].Documents[0].Children, 1)
	memberChild := sidebar[0].Documents[0].Children[0]
	assert.True(t, memberChild.IsFavorite)
	require.NotNil(t, memberChild.FavoritedAt)

	sidebar, err = svc.ListSidebar(ctx, ownerID)
	require.NoError(t, err)
	require.Len(t, sidebar, 1)
	require.Len(t, sidebar[0].Documents, 1)
	require.Len(t, sidebar[0].Documents[0].Children, 1)
	assert.False(t, sidebar[0].Documents[0].Children[0].IsFavorite)
	assert.Nil(t, sidebar[0].Documents[0].Children[0].FavoritedAt)

	unfavorite, err := svc.UnfavoriteDocument(ctx, childDoc.ID, memberID)
	require.NoError(t, err)
	assert.False(t, unfavorite.IsFavorite)

	unfavorite, err = svc.UnfavoriteDocument(ctx, childDoc.ID, memberID)
	require.NoError(t, err)
	assert.False(t, unfavorite.IsFavorite)

	_, err = svc.FavoriteDocument(ctx, rootDoc.ID, memberID)
	require.NoError(t, err)
	require.NoError(t, svc.DeleteDocument(ctx, rootDoc.ID, ownerID))

	unfavorite, err = svc.UnfavoriteDocument(ctx, rootDoc.ID, memberID)
	require.NoError(t, err)
	assert.False(t, unfavorite.IsFavorite)

	var favoriteCount int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*)
		   FROM document_favorite
		  WHERE document_id = $1`,
		rootDoc.ID,
	).Scan(&favoriteCount))
	assert.Zero(t, favoriteCount)

	sidebar, err = svc.ListSidebar(ctx, memberID)
	require.NoError(t, err)
	require.Len(t, sidebar, 1)
	assert.Empty(t, sidebar[0].Documents)
}

func TestIntegration_DocumentMemberEditAndNonMemberForbidden(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Shared docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	doc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     teamspace.ID,
		Title:           "Shared note",
		ContentMarkdown: ptr("first"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	updated, err := svc.UpdateDocument(ctx, doc.ID, documents.UpdateDocumentParams{
		ContentMarkdown: ptr("second"),
		ActorID:         memberID,
	})
	require.NoError(t, err)
	require.NotNil(t, updated.ContentMarkdown)
	assert.Equal(t, "second", *updated.ContentMarkdown)
	assert.Equal(t, memberID, updated.UpdatedBy)

	_, err = svc.GetDocument(ctx, doc.ID, outsiderID)
	require.ErrorIs(t, err, documents.ErrForbidden)

	_, err = svc.UpdateDocument(ctx, doc.ID, documents.UpdateDocumentParams{
		ContentMarkdown: ptr("third"),
		ActorID:         outsiderID,
	})
	require.ErrorIs(t, err, documents.ErrForbidden)
}

func TestIntegration_DocumentContentCollabHelpersRespectMembership(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Shared docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	doc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     teamspace.ID,
		Title:           "Shared note",
		ContentMarkdown: ptr("first"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	content, err := svc.GetDocumentContent(ctx, doc.ID, memberID)
	require.NoError(t, err)
	require.NotNil(t, content)
	assert.Equal(t, "first", *content)

	updated, err := svc.UpdateDocumentContent(ctx, doc.ID, documents.UpdateDocumentContentParams{
		ContentMarkdown: ptr("second"),
		ActorID:         memberID,
		ForceSnapshot:   true,
	})
	require.NoError(t, err)
	require.NotNil(t, updated.ContentMarkdown)
	assert.Equal(t, "second", *updated.ContentMarkdown)
	assert.Equal(t, memberID, updated.UpdatedBy)

	_, err = svc.GetDocumentContent(ctx, doc.ID, outsiderID)
	require.ErrorIs(t, err, documents.ErrForbidden)

	_, err = svc.UpdateDocumentContent(ctx, doc.ID, documents.UpdateDocumentContentParams{
		ContentMarkdown: ptr("third"),
		ActorID:         outsiderID,
	})
	require.ErrorIs(t, err, documents.ErrForbidden)
}

func TestIntegration_SearchDocumentsRejectsBlankQuery(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)
	userID := seedDocumentUser(t, ctx, pool, "Searcher", "member")

	results, err := svc.SearchDocuments(ctx, userID, "   ")
	require.ErrorIs(t, err, documents.ErrBadRequest)
	require.Nil(t, results)
}

func TestIntegration_SearchDocumentsRespectsVisibilityAndOrdering(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")

	visibleSpace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Visible docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	titleMatch, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     visibleSpace.ID,
		Title:           "Spec overview",
		ContentMarkdown: ptrString("A short design summary for the team."),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	bodyMatch, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     visibleSpace.ID,
		Title:           "Operations notes",
		ContentMarkdown: ptrString("This body includes the keyword spec deep in the paragraph for search."),
		ActorID:         memberID,
	})
	require.NoError(t, err)

	bodyNeedle, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     visibleSpace.ID,
		Title:           "Runbook",
		ContentMarkdown: ptrString("Start here, then follow the precise needle instructions to recover service."),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	privateSpace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:    "Private docs",
		ActorID: ownerID,
	}, "member")
	require.NoError(t, err)

	_, err = svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     privateSpace.ID,
		Title:           "Secret spec",
		ContentMarkdown: ptrString("Private spec details"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	archivedDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     visibleSpace.ID,
		Title:           "Archived spec",
		ContentMarkdown: ptrString("Old spec content"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE document SET archived_at = now() WHERE id = $1`, archivedDoc.ID)
	require.NoError(t, err)

	deletedSpace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Deleted docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)
	_, err = svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     deletedSpace.ID,
		Title:           "Deleted spec",
		ContentMarkdown: ptrString("Deleted teamspace content"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)
	require.NoError(t, svc.DeleteTeamspace(ctx, deletedSpace.ID, ownerID, "member"))

	results, err := svc.SearchDocuments(ctx, memberID, "spec")
	require.NoError(t, err)
	require.Len(t, results, 2)
	assert.Equal(t, titleMatch.ID, results[0].ID)
	assert.Equal(t, bodyMatch.ID, results[1].ID)
	assert.Equal(t, "Visible docs", results[0].TeamspaceName)
	assert.NotEmpty(t, results[0].Snippet)

	needleResults, err := svc.SearchDocuments(ctx, memberID, "needle")
	require.NoError(t, err)
	require.Len(t, needleResults, 1)
	assert.Equal(t, bodyNeedle.ID, needleResults[0].ID)
	assert.True(t, strings.Contains(strings.ToLower(needleResults[0].Snippet), "needle"))
}

func ptrString(value string) *string {
	return &value
}

func TestIntegration_DocumentHistoryDeduplicatesAndPrunes(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)
	svc.SetHistoryLimit(3)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:    "History docs",
		ActorID: ownerID,
	}, "member")
	require.NoError(t, err)

	doc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     teamspace.ID,
		Title:           "v1",
		ContentMarkdown: ptr("one"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	_, err = svc.UpdateDocument(ctx, doc.ID, documents.UpdateDocumentParams{
		ContentMarkdown: ptr("one"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	_, err = svc.UpdateDocument(ctx, doc.ID, documents.UpdateDocumentParams{
		Title:   ptr("v2"),
		ActorID: ownerID,
	})
	require.NoError(t, err)

	_, err = svc.UpdateDocument(ctx, doc.ID, documents.UpdateDocumentParams{
		ContentMarkdown: ptr("two"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	_, err = svc.UpdateDocument(ctx, doc.ID, documents.UpdateDocumentParams{
		ContentMarkdown: ptr("three"),
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	history, err := svc.ListDocumentHistory(ctx, doc.ID, ownerID)
	require.NoError(t, err)
	require.Len(t, history, 3)
	assert.Equal(t, "v2", history[0].Title)
	require.NotNil(t, history[0].ContentMarkdown)
	assert.Equal(t, "three", *history[0].ContentMarkdown)
	require.NotNil(t, history[1].ContentMarkdown)
	assert.Equal(t, "two", *history[1].ContentMarkdown)
	assert.Equal(t, "v2", history[1].Title)
	assert.Equal(t, "v2", history[2].Title)
	require.NotNil(t, history[2].ContentMarkdown)
	assert.Equal(t, "one", *history[2].ContentMarkdown)
}

func TestIntegration_DeleteDocumentArchivesSubtree(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := documents.NewService(pool, nil)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:    "Delete docs",
		ActorID: ownerID,
	}, "member")
	require.NoError(t, err)

	rootDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Root doc",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	childDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      teamspace.ID,
		ParentDocumentID: &rootDoc.ID,
		Title:            "Child doc",
		ActorID:          ownerID,
	})
	require.NoError(t, err)

	grandchildDoc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      teamspace.ID,
		ParentDocumentID: &childDoc.ID,
		Title:            "Grandchild doc",
		ActorID:          ownerID,
	})
	require.NoError(t, err)

	err = svc.DeleteDocument(ctx, rootDoc.ID, ownerID)
	require.NoError(t, err)

	sidebar, err := svc.ListSidebar(ctx, ownerID)
	require.NoError(t, err)
	require.Len(t, sidebar, 1)
	assert.Empty(t, sidebar[0].Documents)

	_, err = svc.GetDocument(ctx, rootDoc.ID, ownerID)
	require.ErrorIs(t, err, documents.ErrNotFound)
	_, err = svc.GetDocument(ctx, childDoc.ID, ownerID)
	require.ErrorIs(t, err, documents.ErrNotFound)
	_, err = svc.GetDocument(ctx, grandchildDoc.ID, ownerID)
	require.ErrorIs(t, err, documents.ErrNotFound)

	err = svc.DeleteDocument(ctx, rootDoc.ID, outsiderID)
	require.ErrorIs(t, err, documents.ErrNotFound)
}

func TestIntegration_DocumentAttachment_UploadListDownloadDelete(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := documents.NewService(pool, minioClient)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Attachment docs",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	doc, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Doc with file",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	content := []byte("image-bytes")
	uploaded, err := svc.UploadAttachment(ctx, documents.UploadAttachmentParams{
		DocumentID: doc.ID,
		ActorID:    memberID,
		FileName:   "diagram.png",
		MimeType:   "image/png",
		Size:       int64(len(content)),
		Body:       bytes.NewReader(content),
	}, 50, nil)
	require.NoError(t, err)
	assert.Equal(t, doc.ID, uploaded.DocumentID)
	assert.Equal(t, "diagram.png", uploaded.FileName)

	list, err := svc.ListAttachments(ctx, doc.ID, ownerID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, uploaded.ID, list[0].ID)

	body, _, mimeType, fileName, err := svc.DownloadAttachment(ctx, doc.ID, ownerID, uploaded.ID)
	require.NoError(t, err)
	defer body.Close()
	raw, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Equal(t, content, raw)
	assert.Equal(t, "image/png", mimeType)
	assert.Equal(t, "diagram.png", fileName)

	err = svc.DeleteAttachment(ctx, doc.ID, ownerID, uploaded.ID)
	require.NoError(t, err)

	list, err = svc.ListAttachments(ctx, doc.ID, ownerID)
	require.NoError(t, err)
	assert.Empty(t, list)
}

func TestIntegration_DocumentAttachment_RejectsForbiddenAndMismatchedDocument(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	minioClient := testdb.NewMinio(t)
	svc := documents.NewService(pool, minioClient)

	ownerID := seedDocumentUser(t, ctx, pool, "Owner", "member")
	memberID := seedDocumentUser(t, ctx, pool, "Member", "member")
	outsiderID := seedDocumentUser(t, ctx, pool, "Outsider", "member")

	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Shared attachments",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	doc1, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Doc one",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	doc2, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspace.ID,
		Title:       "Doc two",
		ActorID:     ownerID,
	})
	require.NoError(t, err)

	uploaded, err := svc.UploadAttachment(ctx, documents.UploadAttachmentParams{
		DocumentID: doc1.ID,
		ActorID:    ownerID,
		FileName:   "note.txt",
		MimeType:   "text/plain",
		Size:       int64(len("hello")),
		Body:       bytes.NewReader([]byte("hello")),
	}, 50, nil)
	require.NoError(t, err)

	_, err = svc.ListAttachments(ctx, doc1.ID, outsiderID)
	require.ErrorIs(t, err, documents.ErrForbidden)

	_, _, _, _, err = svc.DownloadAttachment(ctx, doc2.ID, memberID, uploaded.ID)
	require.ErrorIs(t, err, documents.ErrNotFound)

	err = svc.DeleteAttachment(ctx, doc2.ID, ownerID, uploaded.ID)
	require.ErrorIs(t, err, documents.ErrNotFound)
}

func ptr(value string) *string {
	return &value
}
