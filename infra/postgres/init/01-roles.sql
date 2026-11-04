-- Runs once, when the data volume is first created.
--   yap       owner: schema changes and seed.
--   yap_app   API runtime role. Not an owner and no BYPASSRLS, so RLS always applies.
--   yap_ai    read-only role for the AI layer (spec 4.1 p.8, 15.2).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'yap_app') THEN
    CREATE ROLE yap_app LOGIN PASSWORD 'yap_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'yap_ai') THEN
    CREATE ROLE yap_ai LOGIN PASSWORD 'yap_ai_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
