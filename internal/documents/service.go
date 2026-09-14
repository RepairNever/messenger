package documents

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"msgnr/internal/userstatus"
)

const (
	defaultDocumentHistoryLimit = 25
	defaultDocumentSearchLimit  = 50
	documentSearchSnippetLimit  = 160
	pgErrUniqueViolation        = "23505"
	pgErrForeignKeyViolation    = "23503"
	pgErrCheckViolation         = "23514"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrConflict    = errors.New("conflict")
	ErrBadRequest  = errors.New("bad request")
	ErrForbidden   = errors.New("forbidden")
	ErrUnavailable = errors.New("unavailable")

	errAttachmentTooLarge = errors.New("attachment exceeds max size")
)

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type Service struct {
	pool         *pgxpool.Pool
	store        Storage
	historyLimit int
}

// Storage is the interface the document service uses for file object storage.
type Storage interface {
	PutObject(ctx context.Context, key string, r io.Reader, size int64, mimeType string) error
	GetObject(ctx context.Context, key string) (body io.ReadCloser, size int64, mimeType string, err error)
	DeleteObject(ctx context.Context, key string) error
}

// ByteCounter is satisfied by reader wrappers that track bytes consumed.
type ByteCounter interface {
	BytesRead() int64
}

func NewService(pool *pgxpool.Pool, store Storage) *Service {
	return &Service{
		pool:         pool,
		store:        store,
		historyLimit: defaultDocumentHistoryLimit,
	}
}

func (s *Service) SetHistoryLimit(limit int) {
	if limit <= 0 {
		limit = defaultDocumentHistoryLimit
	}
	s.historyLimit = limit
}

type TeamspaceMemberPreview struct {
	ID           uuid.UUID        `json:"id"`
	DisplayName  string           `json:"display_name"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

type TeamspaceRow struct {
	ID          uuid.UUID                `json:"id"`
	Name        string                   `json:"name"`
	OwnerUserID uuid.UUID                `json:"owner_user_id"`
	IsPrivate   bool                     `json:"is_private"`
	IsMember    bool                     `json:"is_member"`
	IsOwner     bool                     `json:"is_owner"`
	CanManage   bool                     `json:"can_manage"`
	MemberCount int                      `json:"member_count"`
	Members     []TeamspaceMemberPreview `json:"members"`
	CreatedAt   time.Time                `json:"created_at"`
	UpdatedAt   time.Time                `json:"updated_at"`
}

type SidebarDocumentNode struct {
	ID               uuid.UUID             `json:"id"`
	TeamspaceID      uuid.UUID             `json:"teamspace_id"`
	ParentDocumentID *uuid.UUID            `json:"parent_document_id,omitempty"`
	Title            string                `json:"title"`
	IsFavorite       bool                  `json:"is_favorite"`
	FavoritedAt      *time.Time            `json:"favorited_at,omitempty"`
	Children         []SidebarDocumentNode `json:"children"`
}

type SidebarTeamspace struct {
	ID        uuid.UUID             `json:"id"`
	Name      string                `json:"name"`
	Documents []SidebarDocumentNode `json:"documents"`
}

type sidebarTempNode struct {
	node     SidebarDocumentNode
	children []*sidebarTempNode
}

type DocumentResponse struct {
	ID               uuid.UUID  `json:"id"`
	TeamspaceID      uuid.UUID  `json:"teamspace_id"`
	TeamspaceName    string     `json:"teamspace_name"`
	ParentDocumentID *uuid.UUID `json:"parent_document_id,omitempty"`
	ParentTitle      *string    `json:"parent_title,omitempty"`
	Title            string     `json:"title"`
	ContentMarkdown  *string    `json:"content_markdown"`
	CreatedBy        uuid.UUID  `json:"created_by"`
	UpdatedBy        uuid.UUID  `json:"updated_by"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type DocumentSearchResult struct {
	ID            uuid.UUID `json:"id"`
	TeamspaceID   uuid.UUID `json:"teamspace_id"`
	TeamspaceName string    `json:"teamspace_name"`
	Title         string    `json:"title"`
	Snippet       string    `json:"snippet"`
}

type DocumentFavoriteResponse struct {
	DocumentID  uuid.UUID  `json:"document_id"`
	IsFavorite  bool       `json:"is_favorite"`
	FavoritedAt *time.Time `json:"favorited_at,omitempty"`
}

type DocumentHistoryEditor struct {
	ID           uuid.UUID        `json:"id"`
	DisplayName  string           `json:"display_name"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

type DocumentHistoryItem struct {
	Title           string                `json:"title"`
	ContentMarkdown *string               `json:"content_markdown"`
	EditedBy        uuid.UUID             `json:"edited_by"`
	CreatedAt       time.Time             `json:"created_at"`
	Editor          DocumentHistoryEditor `json:"editor"`
}

type DocumentAttachmentRow struct {
	ID         uuid.UUID `json:"id"`
	DocumentID uuid.UUID `json:"document_id"`
	FileName   string    `json:"file_name"`
	FileSize   int64     `json:"file_size"`
	MimeType   string    `json:"mime_type"`
	StorageKey string    `json:"-"`
	UploadedBy uuid.UUID `json:"uploaded_by"`
	CreatedAt  time.Time `json:"created_at"`
}

type CreateTeamspaceParams struct {
	Name      string
	IsPrivate bool
	MemberIDs []uuid.UUID
	ActorID   uuid.UUID
}

type UpdateTeamspaceParams struct {
	Name      string
	IsPrivate bool
	MemberIDs []uuid.UUID
	ActorID   uuid.UUID
	ActorRole string
}

type CreateDocumentParams struct {
	TeamspaceID      uuid.UUID
	ParentDocumentID *uuid.UUID
	Title            string
	ContentMarkdown  *string
	ActorID          uuid.UUID
}

type UpdateDocumentParams struct {
	Title           *string
	ContentMarkdown *string
	ActorID         uuid.UUID
}

type UpdateDocumentContentParams struct {
	ContentMarkdown *string
	ActorID         uuid.UUID
	ForceSnapshot   bool
}

type UploadAttachmentParams struct {
	DocumentID uuid.UUID
	ActorID    uuid.UUID
	FileName   string
	MimeType   string
	Size       int64
	Body       io.Reader
}

func (s *Service) ListTeamspaces(ctx context.Context, userID uuid.UUID, actorRole string) ([]TeamspaceRow, error) {
	return s.listVisibleTeamspaces(ctx, s.pool, userID, actorRole, nil)
}

func (s *Service) CreateTeamspace(ctx context.Context, params CreateTeamspaceParams, actorRole string) (TeamspaceRow, error) {
	name := strings.TrimSpace(params.Name)
	if name == "" {
		return TeamspaceRow{}, fmt.Errorf("%w: teamspace name is required", ErrBadRequest)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TeamspaceRow{}, fmt.Errorf("documents: begin create teamspace tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var teamspaceID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO teamspace (name, owner_user_id, is_private)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		name, params.ActorID, params.IsPrivate,
	).Scan(&teamspaceID); err != nil {
		return TeamspaceRow{}, classifyMutationError("create teamspace", err)
	}

	memberIDs := uniqueUserIDs(append(params.MemberIDs, params.ActorID))
	for _, memberID := range memberIDs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO teamspace_member (teamspace_id, user_id)
			 VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			teamspaceID, memberID,
		); err != nil {
			return TeamspaceRow{}, classifyMutationError("insert teamspace member", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return TeamspaceRow{}, fmt.Errorf("documents: commit create teamspace tx: %w", err)
	}

	return s.getVisibleTeamspace(ctx, teamspaceID, params.ActorID, actorRole)
}

func (s *Service) UpdateTeamspace(ctx context.Context, teamspaceID uuid.UUID, params UpdateTeamspaceParams) (TeamspaceRow, error) {
	name := strings.TrimSpace(params.Name)
	if name == "" {
		return TeamspaceRow{}, fmt.Errorf("%w: teamspace name is required", ErrBadRequest)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TeamspaceRow{}, fmt.Errorf("documents: begin update teamspace tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var ownerUserID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT owner_user_id
		   FROM teamspace
		  WHERE id = $1
		    AND deleted_at IS NULL
		  FOR UPDATE`,
		teamspaceID,
	).Scan(&ownerUserID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TeamspaceRow{}, fmt.Errorf("%w: teamspace", ErrNotFound)
		}
		return TeamspaceRow{}, fmt.Errorf("documents: load teamspace owner: %w", err)
	}

	if !canManageTeamspace(ownerUserID, params.ActorID, params.ActorRole) {
		return TeamspaceRow{}, fmt.Errorf("%w: teamspace", ErrForbidden)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE teamspace
		    SET name = $2,
		        is_private = $3
		  WHERE id = $1`,
		teamspaceID, name, params.IsPrivate,
	); err != nil {
		return TeamspaceRow{}, classifyMutationError("update teamspace", err)
	}

	targetMembers := uniqueUserIDs(append(params.MemberIDs, ownerUserID))
	currentMembers, err := listTeamspaceMemberIDs(ctx, tx, teamspaceID)
	if err != nil {
		return TeamspaceRow{}, err
	}
	for _, currentMemberID := range currentMembers {
		if currentMemberID == ownerUserID || slices.Contains(targetMembers, currentMemberID) {
			continue
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM teamspace_member
			  WHERE teamspace_id = $1
			    AND user_id = $2`,
			teamspaceID, currentMemberID,
		); err != nil {
			return TeamspaceRow{}, fmt.Errorf("documents: delete teamspace member: %w", err)
		}
	}
	for _, memberID := range targetMembers {
		if _, err := tx.Exec(ctx,
			`INSERT INTO teamspace_member (teamspace_id, user_id)
			 VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			teamspaceID, memberID,
		); err != nil {
			return TeamspaceRow{}, classifyMutationError("upsert teamspace member", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return TeamspaceRow{}, fmt.Errorf("documents: commit update teamspace tx: %w", err)
	}

	return s.getVisibleTeamspace(ctx, teamspaceID, params.ActorID, params.ActorRole)
}

func (s *Service) DeleteTeamspace(ctx context.Context, teamspaceID, actorID uuid.UUID, actorRole string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("documents: begin delete teamspace tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var (
		ownerUserID uuid.UUID
		deletedAt   sql.NullTime
	)
	if err := tx.QueryRow(ctx,
		`SELECT owner_user_id, deleted_at
		   FROM teamspace
		  WHERE id = $1
		  FOR UPDATE`,
		teamspaceID,
	).Scan(&ownerUserID, &deletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: teamspace", ErrNotFound)
		}
		return fmt.Errorf("documents: load teamspace for delete: %w", err)
	}
	if deletedAt.Valid {
		return fmt.Errorf("%w: teamspace", ErrNotFound)
	}
	if !canManageTeamspace(ownerUserID, actorID, actorRole) {
		return fmt.Errorf("%w: teamspace", ErrForbidden)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE teamspace
		    SET deleted_at = now()
		  WHERE id = $1`,
		teamspaceID,
	); err != nil {
		return classifyMutationError("delete teamspace", err)
	}

	// All documents in a teamspace share the same teamspace_id, so a flat
	// update is the correct delete shape here.
	if _, err := tx.Exec(ctx,
		`UPDATE document
		    SET archived_at = now(),
		        updated_by = $2,
		        updated_at = now()
		  WHERE teamspace_id = $1
		    AND archived_at IS NULL`,
		teamspaceID, actorID,
	); err != nil {
		return classifyMutationError("archive teamspace documents", err)
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM document_favorite df
		  USING document d
		  WHERE d.id = df.document_id
		    AND d.teamspace_id = $1`,
		teamspaceID,
	); err != nil {
		return classifyMutationError("delete teamspace document favorites", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("documents: commit delete teamspace tx: %w", err)
	}
	return nil
}

func (s *Service) JoinTeamspace(ctx context.Context, teamspaceID, userID uuid.UUID, actorRole string) (TeamspaceRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TeamspaceRow{}, fmt.Errorf("documents: begin join teamspace tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var isPrivate bool
	if err := tx.QueryRow(ctx,
		`SELECT is_private
		   FROM teamspace
		  WHERE id = $1
		    AND deleted_at IS NULL
		  FOR UPDATE`,
		teamspaceID,
	).Scan(&isPrivate); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TeamspaceRow{}, fmt.Errorf("%w: teamspace", ErrNotFound)
		}
		return TeamspaceRow{}, fmt.Errorf("documents: load teamspace privacy: %w", err)
	}
	if isPrivate {
		return TeamspaceRow{}, fmt.Errorf("%w: teamspace", ErrForbidden)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO teamspace_member (teamspace_id, user_id)
		 VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`,
		teamspaceID, userID,
	); err != nil {
		return TeamspaceRow{}, classifyMutationError("join teamspace", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return TeamspaceRow{}, fmt.Errorf("documents: commit join teamspace tx: %w", err)
	}

	return s.getVisibleTeamspace(ctx, teamspaceID, userID, actorRole)
}

func (s *Service) ListSidebar(ctx context.Context, userID uuid.UUID) ([]SidebarTeamspace, error) {
	teamspaceRows, err := s.pool.Query(ctx,
		`SELECT t.id, t.name
		   FROM teamspace t
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = t.id
		    AND tm.user_id = $1
		  WHERE t.deleted_at IS NULL
		  ORDER BY lower(t.name), t.created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list sidebar teamspaces: %w", err)
	}
	defer teamspaceRows.Close()

	teamspaces := make([]SidebarTeamspace, 0)
	teamspaceIndexByID := make(map[uuid.UUID]int)
	for teamspaceRows.Next() {
		var item SidebarTeamspace
		if err := teamspaceRows.Scan(&item.ID, &item.Name); err != nil {
			return nil, fmt.Errorf("documents: scan sidebar teamspace: %w", err)
		}
		teamspaces = append(teamspaces, item)
		teamspaceIndexByID[item.ID] = len(teamspaces) - 1
	}
	if err := teamspaceRows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate sidebar teamspaces: %w", err)
	}
	if len(teamspaces) == 0 {
		return teamspaces, nil
	}

	docRows, err := s.pool.Query(ctx,
		`SELECT d.id, d.teamspace_id, d.parent_document_id, d.title, df.favorited_at
		   FROM document d
		   JOIN teamspace t
		     ON t.id = d.teamspace_id
		    AND t.deleted_at IS NULL
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = d.teamspace_id
		    AND tm.user_id = $1
		   LEFT JOIN document_favorite df
		     ON df.document_id = d.id
		    AND df.user_id = $1
		  WHERE d.archived_at IS NULL
		  ORDER BY d.teamspace_id ASC,
		           COALESCE(d.parent_document_id::text, '') ASC,
		           d.created_at ASC,
		           lower(d.title) ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list sidebar documents: %w", err)
	}
	defer docRows.Close()

	nodeByID := make(map[uuid.UUID]*sidebarTempNode)
	orderedNodes := make([]*sidebarTempNode, 0)
	rootNodesByTeamspace := make(map[uuid.UUID][]*sidebarTempNode)
	for docRows.Next() {
		var (
			id               uuid.UUID
			teamspaceID      uuid.UUID
			parentDocumentID uuid.NullUUID
			title            string
			favoritedAt      sql.NullTime
		)
		if err := docRows.Scan(&id, &teamspaceID, &parentDocumentID, &title, &favoritedAt); err != nil {
			return nil, fmt.Errorf("documents: scan sidebar document: %w", err)
		}
		item := &sidebarTempNode{
			node: SidebarDocumentNode{
				ID:          id,
				TeamspaceID: teamspaceID,
				Title:       title,
			},
		}
		if parentDocumentID.Valid {
			parentID := parentDocumentID.UUID
			item.node.ParentDocumentID = &parentID
		}
		if favoritedAt.Valid {
			favoritedAtValue := favoritedAt.Time
			item.node.IsFavorite = true
			item.node.FavoritedAt = &favoritedAtValue
		}
		nodeByID[id] = item
		orderedNodes = append(orderedNodes, item)
	}
	if err := docRows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate sidebar documents: %w", err)
	}

	for _, node := range orderedNodes {
		if node.node.ParentDocumentID != nil {
			parent := nodeByID[*node.node.ParentDocumentID]
			if parent != nil {
				parent.children = append(parent.children, node)
				continue
			}
		}
		rootNodesByTeamspace[node.node.TeamspaceID] = append(rootNodesByTeamspace[node.node.TeamspaceID], node)
	}

	for teamspaceID, roots := range rootNodesByTeamspace {
		index, ok := teamspaceIndexByID[teamspaceID]
		if !ok {
			continue
		}
		teamspaces[index].Documents = make([]SidebarDocumentNode, 0, len(roots))
		for _, root := range roots {
			teamspaces[index].Documents = append(teamspaces[index].Documents, cloneSidebarNode(root))
		}
	}

	return teamspaces, nil
}

func (s *Service) CreateDocument(ctx context.Context, params CreateDocumentParams) (DocumentResponse, error) {
	title := strings.TrimSpace(params.Title)
	if title == "" {
		return DocumentResponse{}, fmt.Errorf("%w: document title is required", ErrBadRequest)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DocumentResponse{}, fmt.Errorf("documents: begin create document tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := ensureTeamspaceMember(ctx, tx, params.TeamspaceID, params.ActorID); err != nil {
		return DocumentResponse{}, err
	}

	if params.ParentDocumentID != nil {
		var parentTeamspaceID uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT d.teamspace_id
			   FROM document d
			   JOIN teamspace t
			     ON t.id = d.teamspace_id
			    AND t.deleted_at IS NULL
			  WHERE d.id = $1
			    AND archived_at IS NULL`,
			*params.ParentDocumentID,
		).Scan(&parentTeamspaceID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return DocumentResponse{}, fmt.Errorf("%w: parent document", ErrNotFound)
			}
			return DocumentResponse{}, fmt.Errorf("documents: load parent document: %w", err)
		}
		if parentTeamspaceID != params.TeamspaceID {
			return DocumentResponse{}, fmt.Errorf("%w: parent document belongs to another teamspace", ErrBadRequest)
		}
	}

	var documentID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO document (teamspace_id, parent_document_id, title, content_markdown, created_by, updated_by)
		 VALUES ($1, $2, $3, $4, $5, $5)
		 RETURNING id`,
		params.TeamspaceID, params.ParentDocumentID, title, nullString(params.ContentMarkdown), params.ActorID,
	).Scan(&documentID); err != nil {
		return DocumentResponse{}, classifyMutationError("create document", err)
	}

	if err := s.maybeCreateDocumentSnapshotInTx(ctx, tx, documentID, title, params.ContentMarkdown, params.ActorID); err != nil {
		return DocumentResponse{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return DocumentResponse{}, fmt.Errorf("documents: commit create document tx: %w", err)
	}

	return s.GetDocument(ctx, documentID, params.ActorID)
}

func (s *Service) GetDocument(ctx context.Context, documentID, userID uuid.UUID) (DocumentResponse, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT d.id,
		        d.teamspace_id,
		        t.name,
		        d.parent_document_id,
		        parent.title,
		        d.title,
		        d.content_markdown,
		        d.created_by,
		        d.updated_by,
		        d.created_at,
		        d.updated_at
		   FROM document d
		   JOIN teamspace t
		     ON t.id = d.teamspace_id
		    AND t.deleted_at IS NULL
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = d.teamspace_id
		    AND tm.user_id = $2
		   LEFT JOIN document parent
		     ON parent.id = d.parent_document_id
		  WHERE d.id = $1
		    AND d.archived_at IS NULL`,
		documentID, userID,
	)

	var (
		resp             DocumentResponse
		parentDocumentID uuid.NullUUID
		parentTitle      sql.NullString
		content          sql.NullString
	)
	if err := row.Scan(
		&resp.ID,
		&resp.TeamspaceID,
		&resp.TeamspaceName,
		&parentDocumentID,
		&parentTitle,
		&resp.Title,
		&content,
		&resp.CreatedBy,
		&resp.UpdatedBy,
		&resp.CreatedAt,
		&resp.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocumentResponse{}, s.documentAccessError(ctx, documentID, userID)
		}
		return DocumentResponse{}, fmt.Errorf("documents: get document: %w", err)
	}
	if parentDocumentID.Valid {
		parentID := parentDocumentID.UUID
		resp.ParentDocumentID = &parentID
	}
	if parentTitle.Valid {
		value := parentTitle.String
		resp.ParentTitle = &value
	}
	if content.Valid {
		value := content.String
		resp.ContentMarkdown = &value
	}
	return resp, nil
}

func (s *Service) GetDocumentContent(ctx context.Context, documentID, userID uuid.UUID) (*string, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT d.content_markdown
		   FROM document d
		   JOIN teamspace t
		     ON t.id = d.teamspace_id
		    AND t.deleted_at IS NULL
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = d.teamspace_id
		    AND tm.user_id = $2
		  WHERE d.id = $1
		    AND d.archived_at IS NULL`,
		documentID, userID,
	)

	var content sql.NullString
	if err := row.Scan(&content); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, s.documentAccessError(ctx, documentID, userID)
		}
		return nil, fmt.Errorf("documents: get document content: %w", err)
	}
	if !content.Valid {
		return nil, nil
	}
	value := content.String
	return &value, nil
}

func (s *Service) SearchDocuments(ctx context.Context, userID uuid.UUID, query string) ([]DocumentSearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("%w: search query is required", ErrBadRequest)
	}

	pattern := "%" + query + "%"
	rows, err := s.pool.Query(ctx,
		`SELECT d.id,
		        d.teamspace_id,
		        t.name,
		        d.title,
		        d.content_markdown
		   FROM document d
		   JOIN teamspace t
		     ON t.id = d.teamspace_id
		    AND t.deleted_at IS NULL
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = d.teamspace_id
		    AND tm.user_id = $1
		  WHERE d.archived_at IS NULL
		    AND (d.title ILIKE $2 OR d.content_markdown ILIKE $2)
		  ORDER BY CASE WHEN d.title ILIKE $2 THEN 0 ELSE 1 END,
		           d.updated_at DESC
		  LIMIT $3`,
		userID, pattern, defaultDocumentSearchLimit,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: search documents: %w", err)
	}
	defer rows.Close()

	results := make([]DocumentSearchResult, 0)
	for rows.Next() {
		var (
			item    DocumentSearchResult
			content sql.NullString
		)
		if err := rows.Scan(
			&item.ID,
			&item.TeamspaceID,
			&item.TeamspaceName,
			&item.Title,
			&content,
		); err != nil {
			return nil, fmt.Errorf("documents: scan searched document: %w", err)
		}
		item.Snippet = buildDocumentSearchSnippet(query, content)
		results = append(results, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate searched documents: %w", err)
	}
	return results, nil
}

func (s *Service) UpdateDocument(ctx context.Context, documentID uuid.UUID, params UpdateDocumentParams) (DocumentResponse, error) {
	if params.Title == nil && params.ContentMarkdown == nil {
		return DocumentResponse{}, fmt.Errorf("%w: no document fields provided", ErrBadRequest)
	}

	var (
		currentTitle   string
		currentContent sql.NullString
	)
	if err := s.pool.QueryRow(ctx,
		`SELECT d.title, d.content_markdown
		   FROM document d
		   JOIN teamspace t
		     ON t.id = d.teamspace_id
		    AND t.deleted_at IS NULL
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = d.teamspace_id
		    AND tm.user_id = $2
		  WHERE d.id = $1
		    AND d.archived_at IS NULL`,
		documentID, params.ActorID,
	).Scan(&currentTitle, &currentContent); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocumentResponse{}, s.documentAccessError(ctx, documentID, params.ActorID)
		}
		return DocumentResponse{}, fmt.Errorf("documents: load document for update: %w", err)
	}

	nextTitle := currentTitle
	if params.Title != nil {
		nextTitle = strings.TrimSpace(*params.Title)
		if nextTitle == "" {
			return DocumentResponse{}, fmt.Errorf("%w: document title is required", ErrBadRequest)
		}
	}

	var nextContent *string
	if currentContent.Valid {
		current := currentContent.String
		nextContent = &current
	}
	if params.ContentMarkdown != nil {
		nextContent = params.ContentMarkdown
	}

	if nextTitle == currentTitle && nullStringEqual(nextContent, currentContent) {
		return s.GetDocument(ctx, documentID, params.ActorID)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DocumentResponse{}, fmt.Errorf("documents: begin update document tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`UPDATE document
		    SET title = $2,
		        content_markdown = $3,
		        updated_by = $4
		  WHERE id = $1`,
		documentID, nextTitle, nullString(nextContent), params.ActorID,
	); err != nil {
		return DocumentResponse{}, classifyMutationError("update document", err)
	}

	if err := s.maybeCreateDocumentSnapshotInTx(ctx, tx, documentID, nextTitle, nextContent, params.ActorID); err != nil {
		return DocumentResponse{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return DocumentResponse{}, fmt.Errorf("documents: commit update document tx: %w", err)
	}

	return s.GetDocument(ctx, documentID, params.ActorID)
}

func (s *Service) UpdateDocumentContent(ctx context.Context, documentID uuid.UUID, params UpdateDocumentContentParams) (DocumentResponse, error) {
	var (
		currentTitle   string
		currentContent sql.NullString
	)
	if err := s.pool.QueryRow(ctx,
		`SELECT d.title, d.content_markdown
		   FROM document d
		   JOIN teamspace t
		     ON t.id = d.teamspace_id
		    AND t.deleted_at IS NULL
		   JOIN teamspace_member tm
		     ON tm.teamspace_id = d.teamspace_id
		    AND tm.user_id = $2
		  WHERE d.id = $1
		    AND d.archived_at IS NULL`,
		documentID, params.ActorID,
	).Scan(&currentTitle, &currentContent); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocumentResponse{}, s.documentAccessError(ctx, documentID, params.ActorID)
		}
		return DocumentResponse{}, fmt.Errorf("documents: load document content for update: %w", err)
	}

	if nullStringEqual(params.ContentMarkdown, currentContent) {
		return s.GetDocument(ctx, documentID, params.ActorID)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DocumentResponse{}, fmt.Errorf("documents: begin update document content tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`UPDATE document
		    SET content_markdown = $2,
		        updated_by = $3,
		        updated_at = now()
		  WHERE id = $1`,
		documentID, nullString(params.ContentMarkdown), params.ActorID,
	); err != nil {
		return DocumentResponse{}, classifyMutationError("update document content", err)
	}

	if err := s.maybeCreateDocumentSnapshotInTx(ctx, tx, documentID, currentTitle, params.ContentMarkdown, params.ActorID); err != nil {
		return DocumentResponse{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return DocumentResponse{}, fmt.Errorf("documents: commit update document content tx: %w", err)
	}

	return s.GetDocument(ctx, documentID, params.ActorID)
}

func (s *Service) DeleteDocument(ctx context.Context, documentID, actorID uuid.UUID) error {
	if err := s.ensureDocumentReadable(ctx, documentID, actorID); err != nil {
		return err
	}

	var archivedCount int
	err := s.pool.QueryRow(ctx,
		`WITH RECURSIVE subtree AS (
		     SELECT d.id
		       FROM document d
		      WHERE d.id = $1
		     UNION ALL
		     SELECT child.id
		       FROM document child
		       JOIN subtree parent
		         ON child.parent_document_id = parent.id
		 ),
		 archived AS (
		 UPDATE document d
		    SET archived_at = now(),
		        updated_by = $2,
		        updated_at = now()
		   FROM subtree
		  WHERE d.id = subtree.id
		    AND d.archived_at IS NULL
		  RETURNING d.id
		 ),
		 deleted_favorites AS (
		 DELETE FROM document_favorite df
		  USING subtree
		  WHERE df.document_id = subtree.id
		  RETURNING df.document_id
		 )
		 SELECT count(*) FROM archived`,
		documentID, actorID,
	).Scan(&archivedCount)
	if err != nil {
		return classifyMutationError("delete document", err)
	}
	if archivedCount == 0 {
		return s.documentAccessError(ctx, documentID, actorID)
	}
	return nil
}

func (s *Service) FavoriteDocument(ctx context.Context, documentID, userID uuid.UUID) (DocumentFavoriteResponse, error) {
	if err := s.ensureDocumentReadable(ctx, documentID, userID); err != nil {
		return DocumentFavoriteResponse{}, err
	}

	var favoritedAt time.Time
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO document_favorite (user_id, document_id)
		 VALUES ($1, $2)
		 ON CONFLICT (user_id, document_id) DO UPDATE
		       SET favorited_at = document_favorite.favorited_at
		 RETURNING favorited_at`,
		userID, documentID,
	).Scan(&favoritedAt); err != nil {
		return DocumentFavoriteResponse{}, classifyMutationError("favorite document", err)
	}

	return DocumentFavoriteResponse{
		DocumentID:  documentID,
		IsFavorite:  true,
		FavoritedAt: &favoritedAt,
	}, nil
}

func (s *Service) UnfavoriteDocument(ctx context.Context, documentID, userID uuid.UUID) (DocumentFavoriteResponse, error) {
	if _, err := s.pool.Exec(ctx,
		`DELETE FROM document_favorite
		  WHERE user_id = $1
		    AND document_id = $2`,
		userID, documentID,
	); err != nil {
		return DocumentFavoriteResponse{}, classifyMutationError("unfavorite document", err)
	}

	return DocumentFavoriteResponse{
		DocumentID: documentID,
		IsFavorite: false,
	}, nil
}

func (s *Service) ListDocumentHistory(ctx context.Context, documentID, userID uuid.UUID) ([]DocumentHistoryItem, error) {
	if err := s.ensureDocumentReadable(ctx, documentID, userID); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT h.title,
		        h.content_markdown,
		        h.edited_by,
		        h.created_at,
		        u.id,
		        COALESCE(NULLIF(u.display_name, ''), u.email),
		        u.avatar_url,
		        u.custom_status_text,
		        u.custom_status_emoji,
		        u.custom_status_expires_at
		   FROM document_history h
		   JOIN users u
		     ON u.id = h.edited_by
		  WHERE h.document_id = $1
		  ORDER BY h.created_at DESC, h.id DESC
		  LIMIT $2`,
		documentID, s.historyLimit,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list document history: %w", err)
	}
	defer rows.Close()

	out := make([]DocumentHistoryItem, 0)
	for rows.Next() {
		var (
			item          DocumentHistoryItem
			content       sql.NullString
			statusText    string
			statusEmoji   string
			statusExpires sql.NullTime
		)
		if err := rows.Scan(
			&item.Title,
			&content,
			&item.EditedBy,
			&item.CreatedAt,
			&item.Editor.ID,
			&item.Editor.DisplayName,
			&item.Editor.AvatarURL,
			&statusText,
			&statusEmoji,
			&statusExpires,
		); err != nil {
			return nil, fmt.Errorf("documents: scan document history: %w", err)
		}
		item.Editor.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(statusText, statusEmoji, statusExpires, time.Now().UTC()))
		if content.Valid {
			value := content.String
			item.ContentMarkdown = &value
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate document history: %w", err)
	}
	return out, nil
}

func (s *Service) UploadAttachment(
	ctx context.Context,
	params UploadAttachmentParams,
	maxSizeMB int,
	counter ByteCounter,
) (*DocumentAttachmentRow, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(params.FileName) == "" {
		return nil, fmt.Errorf("%w: file_name is required", ErrBadRequest)
	}
	if err := s.ensureDocumentReadable(ctx, params.DocumentID, params.ActorID); err != nil {
		return nil, err
	}

	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if params.Size >= 0 && params.Size > maxBytes {
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}

	attachmentID := uuid.New()
	safeFileName := sanitiseFileName(params.FileName)
	storageKey := fmt.Sprintf("documents/%s/%s/%s", params.DocumentID, attachmentID, safeFileName)
	if err := store.PutObject(ctx, storageKey, params.Body, params.Size, params.MimeType); err != nil {
		if errors.Is(err, errAttachmentTooLarge) {
			return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
		}
		return nil, fmt.Errorf("documents: upload attachment: %w", err)
	}

	actualSize := params.Size
	if counter != nil {
		actualSize = counter.BytesRead()
	}
	if actualSize > maxBytes {
		s.deleteObjectBestEffort(ctx, store, storageKey)
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}

	var row DocumentAttachmentRow
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO document_attachment (id, document_id, file_name, file_size, mime_type, storage_key, uploaded_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, document_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at`,
		attachmentID, params.DocumentID, params.FileName, actualSize, params.MimeType, storageKey, params.ActorID,
	).Scan(
		&row.ID,
		&row.DocumentID,
		&row.FileName,
		&row.FileSize,
		&row.MimeType,
		&row.StorageKey,
		&row.UploadedBy,
		&row.CreatedAt,
	); err != nil {
		s.deleteObjectBestEffort(ctx, store, storageKey)
		return nil, fmt.Errorf("documents: create attachment record: %w", err)
	}
	return &row, nil
}

func (s *Service) ListAttachments(ctx context.Context, documentID, userID uuid.UUID) ([]DocumentAttachmentRow, error) {
	if err := s.ensureDocumentReadable(ctx, documentID, userID); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, document_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
		   FROM document_attachment
		  WHERE document_id = $1
		  ORDER BY created_at ASC, id ASC`,
		documentID,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list attachments: %w", err)
	}
	defer rows.Close()

	out := make([]DocumentAttachmentRow, 0)
	for rows.Next() {
		var item DocumentAttachmentRow
		if err := rows.Scan(
			&item.ID,
			&item.DocumentID,
			&item.FileName,
			&item.FileSize,
			&item.MimeType,
			&item.StorageKey,
			&item.UploadedBy,
			&item.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("documents: scan attachment: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate attachments: %w", err)
	}
	return out, nil
}

func (s *Service) DownloadAttachment(
	ctx context.Context,
	documentID, userID, attachmentID uuid.UUID,
) (io.ReadCloser, int64, string, string, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, 0, "", "", err
	}
	if err := s.ensureDocumentReadable(ctx, documentID, userID); err != nil {
		return nil, 0, "", "", err
	}

	row, err := s.getAttachmentForDocument(ctx, documentID, attachmentID)
	if err != nil {
		return nil, 0, "", "", err
	}

	body, size, mimeType, err := store.GetObject(ctx, row.StorageKey)
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("documents: download attachment: %w", err)
	}
	return body, size, mimeType, row.FileName, nil
}

func (s *Service) DeleteAttachment(ctx context.Context, documentID, userID, attachmentID uuid.UUID) error {
	store, err := s.requireStore()
	if err != nil {
		return err
	}
	if err := s.ensureDocumentReadable(ctx, documentID, userID); err != nil {
		return err
	}

	var storageKey string
	if err := s.pool.QueryRow(ctx,
		`DELETE FROM document_attachment
		  WHERE id = $1
		    AND document_id = $2
		 RETURNING storage_key`,
		attachmentID, documentID,
	).Scan(&storageKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: attachment", ErrNotFound)
		}
		return fmt.Errorf("documents: delete attachment record: %w", err)
	}

	s.deleteObjectBestEffort(ctx, store, storageKey)
	return nil
}

func (s *Service) getVisibleTeamspace(ctx context.Context, teamspaceID, userID uuid.UUID, actorRole string) (TeamspaceRow, error) {
	rows, err := s.listVisibleTeamspaces(ctx, s.pool, userID, actorRole, &teamspaceID)
	if err != nil {
		return TeamspaceRow{}, err
	}
	if len(rows) == 0 {
		return TeamspaceRow{}, fmt.Errorf("%w: teamspace", ErrNotFound)
	}
	return rows[0], nil
}

func (s *Service) listVisibleTeamspaces(ctx context.Context, q queryer, userID uuid.UUID, actorRole string, teamspaceID *uuid.UUID) ([]TeamspaceRow, error) {
	args := []any{userID}
	filter := ""
	if teamspaceID != nil {
		args = append(args, *teamspaceID)
		filter = " AND t.id = $2"
	}

	rows, err := q.Query(ctx,
		`SELECT t.id,
		        t.name,
		        t.owner_user_id,
		        t.is_private,
		        t.created_at,
		        t.updated_at,
		        membership.is_member,
		        t.owner_user_id = $1 AS is_owner,
		        counts.member_count::int AS member_count
		   FROM teamspace t
		   CROSS JOIN LATERAL (
		        SELECT EXISTS (
		            SELECT 1
		              FROM teamspace_member tm
		             WHERE tm.teamspace_id = t.id
		               AND tm.user_id = $1
		        ) AS is_member
		   ) membership
		   CROSS JOIN LATERAL (
		        SELECT COUNT(*) AS member_count
		          FROM teamspace_member tm2
		         WHERE tm2.teamspace_id = t.id
		   ) counts
		  WHERE (
		            t.is_private = false
		         OR membership.is_member
		        )
		    AND t.deleted_at IS NULL`+filter+`
		  ORDER BY CASE
		               WHEN t.owner_user_id = $1 THEN 0
		               WHEN membership.is_member THEN 1
		               ELSE 2
		           END,
		           lower(t.name),
		           t.created_at ASC`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list teamspaces: %w", err)
	}
	defer rows.Close()

	teamspaces := make([]TeamspaceRow, 0)
	teamspaceIDs := make([]uuid.UUID, 0)
	byID := make(map[uuid.UUID]int)
	for rows.Next() {
		var item TeamspaceRow
		if err := rows.Scan(
			&item.ID,
			&item.Name,
			&item.OwnerUserID,
			&item.IsPrivate,
			&item.CreatedAt,
			&item.UpdatedAt,
			&item.IsMember,
			&item.IsOwner,
			&item.MemberCount,
		); err != nil {
			return nil, fmt.Errorf("documents: scan teamspace: %w", err)
		}
		item.CanManage = canManageTeamspace(item.OwnerUserID, userID, actorRole)
		teamspaces = append(teamspaces, item)
		teamspaceIDs = append(teamspaceIDs, item.ID)
		byID[item.ID] = len(teamspaces) - 1
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate teamspaces: %w", err)
	}
	if len(teamspaces) == 0 {
		return teamspaces, nil
	}

	memberRows, err := q.Query(ctx,
		`SELECT tm.teamspace_id,
		        u.id,
		        COALESCE(NULLIF(u.display_name, ''), u.email),
		        u.avatar_url,
		        u.custom_status_text,
		        u.custom_status_emoji,
		        u.custom_status_expires_at
		   FROM teamspace_member tm
		   JOIN users u
		     ON u.id = tm.user_id
		  WHERE tm.teamspace_id = ANY($1::uuid[])
		  ORDER BY tm.teamspace_id ASC,
		           lower(COALESCE(NULLIF(u.display_name, ''), u.email)) ASC`,
		teamspaceIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list teamspace members: %w", err)
	}
	defer memberRows.Close()

	for memberRows.Next() {
		var (
			teamspaceID   uuid.UUID
			member        TeamspaceMemberPreview
			statusText    string
			statusEmoji   string
			statusExpires sql.NullTime
		)
		if err := memberRows.Scan(
			&teamspaceID,
			&member.ID,
			&member.DisplayName,
			&member.AvatarURL,
			&statusText,
			&statusEmoji,
			&statusExpires,
		); err != nil {
			return nil, fmt.Errorf("documents: scan teamspace member: %w", err)
		}
		member.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(statusText, statusEmoji, statusExpires, time.Now().UTC()))
		if index, ok := byID[teamspaceID]; ok {
			teamspaces[index].Members = append(teamspaces[index].Members, member)
		}
	}
	if err := memberRows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate teamspace members: %w", err)
	}

	return teamspaces, nil
}

func (s *Service) maybeCreateDocumentSnapshotInTx(
	ctx context.Context,
	tx pgx.Tx,
	documentID uuid.UUID,
	title string,
	contentMarkdown *string,
	actorID uuid.UUID,
) error {
	var (
		latestTitle   string
		latestContent sql.NullString
	)
	err := tx.QueryRow(ctx,
		`SELECT title, content_markdown
		   FROM document_history
		  WHERE document_id = $1
		  ORDER BY created_at DESC, id DESC
		  LIMIT 1`,
		documentID,
	).Scan(&latestTitle, &latestContent)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("documents: load latest document snapshot: %w", err)
	}
	if err == nil && latestTitle == title && nullStringEqual(contentMarkdown, latestContent) {
		return nil
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO document_history (document_id, title, content_markdown, edited_by)
		 VALUES ($1, $2, $3, $4)`,
		documentID, title, nullString(contentMarkdown), actorID,
	); err != nil {
		return fmt.Errorf("documents: insert document snapshot: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`WITH ranked AS (
		     SELECT id,
		            row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn
		       FROM document_history
		      WHERE document_id = $1
		  )
		  DELETE FROM document_history h
		   USING ranked r
		  WHERE h.id = r.id
		    AND r.rn > $2`,
		documentID, s.historyLimit,
	); err != nil {
		return fmt.Errorf("documents: prune document snapshots: %w", err)
	}
	return nil
}

func (s *Service) getAttachmentForDocument(ctx context.Context, documentID, attachmentID uuid.UUID) (DocumentAttachmentRow, error) {
	var item DocumentAttachmentRow
	if err := s.pool.QueryRow(ctx,
		`SELECT id, document_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
		   FROM document_attachment
		  WHERE document_id = $1
		    AND id = $2`,
		documentID, attachmentID,
	).Scan(
		&item.ID,
		&item.DocumentID,
		&item.FileName,
		&item.FileSize,
		&item.MimeType,
		&item.StorageKey,
		&item.UploadedBy,
		&item.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocumentAttachmentRow{}, fmt.Errorf("%w: attachment", ErrNotFound)
		}
		return DocumentAttachmentRow{}, fmt.Errorf("documents: get attachment for document: %w", err)
	}
	return item, nil
}

func (s *Service) ensureDocumentReadable(ctx context.Context, documentID, userID uuid.UUID) error {
	var allowed bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (
		     SELECT 1
		       FROM document d
		       JOIN teamspace t
		         ON t.id = d.teamspace_id
		        AND t.deleted_at IS NULL
		       JOIN teamspace_member tm
		         ON tm.teamspace_id = d.teamspace_id
		        AND tm.user_id = $2
		      WHERE d.id = $1
		        AND d.archived_at IS NULL
		 )`,
		documentID, userID,
	).Scan(&allowed); err != nil {
		return fmt.Errorf("documents: check document access: %w", err)
	}
	if !allowed {
		return s.documentAccessError(ctx, documentID, userID)
	}
	return nil
}

func (s *Service) documentAccessError(ctx context.Context, documentID, userID uuid.UUID) error {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (
		     SELECT 1
		       FROM document d
		       JOIN teamspace t
		         ON t.id = d.teamspace_id
		        AND t.deleted_at IS NULL
		      WHERE d.id = $1
		        AND d.archived_at IS NULL
		 )`,
		documentID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("documents: check document existence: %w", err)
	}
	if exists {
		return fmt.Errorf("%w: document", ErrForbidden)
	}
	return fmt.Errorf("%w: document", ErrNotFound)
}

func ensureTeamspaceMember(ctx context.Context, q queryer, teamspaceID, userID uuid.UUID) error {
	var existsMarker int
	if err := q.QueryRow(ctx,
		`SELECT 1
		   FROM teamspace
		  WHERE id = $1
		    AND deleted_at IS NULL
		  FOR UPDATE`,
		teamspaceID,
	).Scan(&existsMarker); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: teamspace", ErrNotFound)
		}
		return fmt.Errorf("documents: check teamspace access: %w", err)
	}
	var isMember bool
	if err := q.QueryRow(ctx,
		`SELECT EXISTS (
		     SELECT 1
		       FROM teamspace_member
		      WHERE teamspace_id = $1
		        AND user_id = $2
		 )`,
		teamspaceID, userID,
	).Scan(&isMember); err != nil {
		return fmt.Errorf("documents: check teamspace membership: %w", err)
	}
	if !isMember {
		return fmt.Errorf("%w: teamspace", ErrForbidden)
	}
	return nil
}

func (s *Service) requireStore() (Storage, error) {
	if s.store == nil {
		return nil, fmt.Errorf("%w: attachment storage unavailable", ErrUnavailable)
	}
	return s.store, nil
}

func (s *Service) deleteObjectBestEffort(ctx context.Context, store Storage, storageKey string) {
	if store == nil {
		return
	}
	if err := store.DeleteObject(ctx, storageKey); err != nil {
		zap.L().Warn("documents: failed to delete attachment object", zap.String("storage_key", storageKey), zap.Error(err))
	}
}

func listTeamspaceMemberIDs(ctx context.Context, q queryer, teamspaceID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx,
		`SELECT user_id
		   FROM teamspace_member
		  WHERE teamspace_id = $1`,
		teamspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("documents: list teamspace member ids: %w", err)
	}
	defer rows.Close()

	out := make([]uuid.UUID, 0)
	for rows.Next() {
		var userID uuid.UUID
		if err := rows.Scan(&userID); err != nil {
			return nil, fmt.Errorf("documents: scan teamspace member id: %w", err)
		}
		out = append(out, userID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("documents: iterate teamspace member ids: %w", err)
	}
	return out, nil
}

func classifyMutationError(action string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case pgErrUniqueViolation:
			return fmt.Errorf("%w: %s", ErrConflict, action)
		case pgErrForeignKeyViolation, pgErrCheckViolation:
			return fmt.Errorf("%w: %s", ErrBadRequest, action)
		}
	}
	return fmt.Errorf("documents: %s: %w", action, err)
}

func canManageTeamspace(ownerUserID, actorID uuid.UUID, actorRole string) bool {
	return ownerUserID == actorID || actorRole == "admin" || actorRole == "owner"
}

func uniqueUserIDs(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func sanitiseFileName(name string) string {
	name = strings.NewReplacer("/", "_", "\\", "_").Replace(name)
	var b strings.Builder
	for _, r := range name {
		if r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	result := b.String()
	if result == "" {
		return "file"
	}
	return result
}

func nullString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullStringEqual(value *string, candidate sql.NullString) bool {
	if value == nil {
		return !candidate.Valid
	}
	return candidate.Valid && candidate.String == *value
}

func buildDocumentSearchSnippet(query string, content sql.NullString) string {
	if !content.Valid {
		return ""
	}

	normalized := normaliseDocumentSearchText(content.String)
	if normalized == "" {
		return ""
	}

	query = strings.TrimSpace(query)
	if query == "" {
		return truncateDocumentSearchSnippet(normalized)
	}

	normalizedRunes := []rune(normalized)
	queryRunes := []rune(query)
	matchIndex := -1
	for index := 0; index+len(queryRunes) <= len(normalizedRunes); index++ {
		if strings.EqualFold(string(normalizedRunes[index:index+len(queryRunes)]), query) {
			matchIndex = index
			break
		}
	}
	if matchIndex < 0 {
		return truncateDocumentSearchSnippet(normalized)
	}

	start := matchIndex - 48
	if start < 0 {
		start = 0
	}
	end := matchIndex + len(queryRunes) + 96
	if end > len(normalizedRunes) {
		end = len(normalizedRunes)
	}

	snippet := strings.TrimSpace(string(normalizedRunes[start:end]))
	if start > 0 {
		snippet = "..." + strings.TrimLeft(snippet, ". ")
	}
	if end < len(normalizedRunes) {
		snippet = strings.TrimRight(snippet, ". ") + "..."
	}
	return truncateDocumentSearchSnippet(snippet)
}

func normaliseDocumentSearchText(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func truncateDocumentSearchSnippet(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= documentSearchSnippetLimit {
		return value
	}
	return strings.TrimSpace(value[:documentSearchSnippetLimit-3]) + "..."
}

func cloneSidebarNode(node *sidebarTempNode) SidebarDocumentNode {
	out := node.node
	out.Children = make([]SidebarDocumentNode, 0, len(node.children))
	for _, child := range node.children {
		out.Children = append(out.Children, cloneSidebarNode(child))
	}
	return out
}
