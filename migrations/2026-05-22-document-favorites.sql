CREATE TABLE IF NOT EXISTS document_favorite (
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id  uuid        NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    favorited_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pk_document_favorite PRIMARY KEY (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_favorite_user_favorited_at
    ON document_favorite (user_id, favorited_at DESC, document_id);

CREATE INDEX IF NOT EXISTS idx_document_favorite_document_id
    ON document_favorite (document_id);
