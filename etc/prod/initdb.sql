\set ON_ERROR_STOP on
\getenv app_db_password APP_DB_PASSWORD
\getenv workspace_name WORKSPACE_NAME
\getenv owner_email INITIAL_OWNER_EMAIL
\getenv owner_name INITIAL_OWNER_NAME
\getenv owner_password INITIAL_OWNER_PASSWORD

SELECT octet_length(:'owner_password') BETWEEN 12 AND 72 AS valid_owner_password \gset
\if :valid_owner_password
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'INITIAL_OWNER_PASSWORD must contain 12 to 72 bytes';
  END $$;
\endif

BEGIN;
-- The messenger owns its database, but has no PostgreSQL superuser privileges.
CREATE ROLE msgnr LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_db_password';
ALTER DATABASE msgnr OWNER TO msgnr;
SET ROLE msgnr;
\ir /opt/msgnr/schema.sql

INSERT INTO workspace (name) VALUES (:'workspace_name');
INSERT INTO users (email, password_hash, display_name, role, status, need_change_password)
VALUES (:'owner_email', crypt(:'owner_password', gen_salt('bf', 10)), :'owner_name', 'owner', 'active', true)
RETURNING id AS owner_id \gset

INSERT INTO channels (kind, visibility, name, created_by)
VALUES ('channel', 'public', 'general', :'owner_id')
RETURNING id AS channel_id \gset
INSERT INTO channel_members (channel_id, user_id) VALUES (:'channel_id', :'owner_id');
COMMIT;
\echo 'Msgnr workspace, owner and general channel initialized'
