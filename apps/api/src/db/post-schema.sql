-- Applied after the Drizzle schema. Idempotent: safe to run after every schema change.
-- Everything here is generic over the catalog, so a new table with tenant_id automatically
-- gets row-level security, audit and grants without anyone having to remember.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Session context ───────────────────────────────────────────────────────
-- NULLIF because a custom GUC reverts to '' (not NULL) after SET LOCAL ends.
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(current_setting('app.platform', true), '') = 'on' $$;

-- ─── PostGIS columns derived from GeoJSON in `boundary` ────────────────────
ALTER TABLE fields ADD COLUMN IF NOT EXISTS geom geometry(Geometry, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_GeomFromGeoJSON(boundary), 4326)) STORED;
CREATE INDEX IF NOT EXISTS fields_geom_idx ON fields USING gist (geom);

ALTER TABLE facilities ADD COLUMN IF NOT EXISTS geom geometry(Geometry, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_GeomFromGeoJSON(boundary), 4326)) STORED;
CREATE INDEX IF NOT EXISTS facilities_geom_idx ON facilities USING gist (geom);

-- ─── Fast text search ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS animals_tag_trgm_idx ON animals USING gin (tag gin_trgm_ops);
CREATE INDEX IF NOT EXISTS counterparties_name_trgm_idx ON counterparties USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_name_trgm_idx ON items USING gin (name gin_trgm_ops);

-- ─── Audit: who, when, what, before and after (spec 20.1) ──────────────────
-- SECURITY DEFINER so the API role can stay read-only on audit_logs and cannot forge rows.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  -- Machines keep these current, some of them every minute, and nobody edits them.
  not_a_change text[] := ARRAY['updated_at', 'last_used_at', 'last_seen_at', 'cursor'];
BEGIN
  IF COALESCE(current_setting('app.skip_audit', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND (old_row - not_a_change) = (new_row - not_a_change) THEN
    RETURN NEW;
  END IF;
  INSERT INTO audit_logs (tenant_id, user_id, entity, entity_id, action, before, after, ip, device)
  VALUES (
    COALESCE(new_row->>'tenant_id', old_row->>'tenant_id')::uuid,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    TG_TABLE_NAME,
    COALESCE(new_row->>'id', old_row->>'id'),
    lower(TG_OP),
    old_row,
    new_row,
    NULLIF(current_setting('app.ip', true), ''),
    NULLIF(current_setting('app.device', true), '')
  );
  RETURN COALESCE(NEW, OLD);
END $$;

-- ─── RLS, grants and audit triggers for every table ────────────────────────
DO $$
DECLARE
  t record;
  -- Identity tables must be readable before a tenant is known (login, API key lookup).
  identity_tables text[] := ARRAY['roles', 'farms', 'memberships', 'api_keys', 'invitations'];
  -- High volume or derived; change history adds noise, not accountability.
  no_audit text[] := ARRAY['audit_logs', 'events', 'idempotency_keys', 'notifications',
                           'notification_prefs', 'ai_messages', 'weather_daily', 'import_jobs',
                           'webhook_deliveries', 'job_runs'];
  -- Secrets the AI role must never read.
  no_ai_read text[] := ARRAY['api_keys', 'idempotency_keys', 'audit_logs', 'telegram_link_codes', 'invitations'];
  policy_expr text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    policy_expr := CASE WHEN t.table_name = ANY (identity_tables)
      THEN 'tenant_id = app_tenant() OR app_is_platform()'
      ELSE 'tenant_id = app_tenant()' END;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
                   t.table_name, policy_expr, policy_expr);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO yap_app', t.table_name);
    IF NOT t.table_name = ANY (no_ai_read) THEN
      EXECUTE format('GRANT SELECT ON %I TO yap_ai', t.table_name);
    END IF;

    IF NOT t.table_name = ANY (no_audit) THEN
      EXECUTE format('CREATE OR REPLACE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON %I
                      FOR EACH ROW EXECUTE FUNCTION audit_row()', t.table_name);
    END IF;
  END LOOP;
END $$;

-- The tenant row itself is keyed by id, not tenant_id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_tenant() OR app_is_platform())
  WITH CHECK (id = app_tenant() OR app_is_platform());
GRANT SELECT, INSERT, UPDATE ON tenants TO yap_app;
GRANT SELECT ON tenants TO yap_ai;

-- Global identity tables have no tenant_id and no RLS.
GRANT SELECT, INSERT, UPDATE ON users TO yap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens, telegram_link_codes, recovery_codes, sign_in_failures TO yap_app;
-- Append-only: an API that is broken into cannot erase what a platform admin did.
GRANT SELECT, INSERT ON platform_audit TO yap_app;
GRANT SELECT ON plans TO yap_app, yap_ai;
-- Not to yap_ai: the assistant has no business reading a prospect's phone number.
GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO yap_app;
GRANT INSERT, UPDATE ON plans TO yap_app;
-- AI may resolve names, but never sees credentials.
GRANT SELECT (id, full_name, locale, status) ON users TO yap_ai;

-- Append-only: the journal cannot be rewritten, the audit log cannot be touched at all.
REVOKE UPDATE, DELETE ON events FROM yap_app;
REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM yap_app;

-- The only tables AI writes to (spec 4.1 p.8, 15.2).
GRANT INSERT, UPDATE ON ai_insights TO yap_ai;
GRANT SELECT, INSERT ON ai_messages, ai_conversations TO yap_ai;
GRANT SELECT, INSERT, UPDATE ON ai_proposals TO yap_ai;

-- ─── Cross-tenant references ───────────────────────────────────────────────
-- Foreign key checks run as the table owner and ignore RLS, so a plain FK accepts another
-- tenant's id: a request could attach someone else's account or herd to its own record.
-- Every FK between two tenant tables therefore also gets a composite twin on (tenant_id, id),
-- which makes such a row impossible, whichever code path writes it.
DO $$
DECLARE
  fk record;
  child_name text;
  parent_name text;
  constraint_name text;
  on_delete text;
BEGIN
  FOR fk IN
    SELECT c.conrelid, c.confrelid, a.attname AS column_name, c.confdeltype
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f'
      AND c.connamespace = 'public'::regnamespace
      AND cardinality(c.conkey) = 1
      AND pa.attname = 'id'
      AND a.attname <> 'tenant_id'
      AND EXISTS (SELECT 1 FROM pg_attribute x
                  WHERE x.attrelid = c.conrelid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute x
                  WHERE x.attrelid = c.confrelid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
  LOOP
    child_name := fk.conrelid::regclass::text;
    parent_name := fk.confrelid::regclass::text;
    constraint_name := 'tfk_' || left(md5(child_name || '.' || fk.column_name), 24);

    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (tenant_id, id)',
                   'tid_' || left(md5(parent_name), 24), parent_name);

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = constraint_name AND conrelid = fk.conrelid) THEN
      on_delete := CASE fk.confdeltype
        WHEN 'c' THEN 'ON DELETE CASCADE'
        WHEN 'n' THEN format('ON DELETE SET NULL (%I)', fk.column_name)
        ELSE '' END;
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %I (tenant_id, id) %s',
                     child_name, constraint_name, fk.column_name, parent_name, on_delete);
    END IF;
  END LOOP;
END $$;
