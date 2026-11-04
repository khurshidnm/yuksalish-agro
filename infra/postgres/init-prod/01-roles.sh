#!/bin/sh
# Runs once, when the data volume is first created. Production counterpart of init/01-roles.sql,
# whose passwords are development values.
#   yap_app  API runtime role. Not an owner and no BYPASSRLS, so row-level security always applies.
#   yap_ai   read-only role for the AI layer (spec 4.1 p.8, 15.2).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$YAP_APP_PASSWORD" -v ai_password="$YAP_AI_PASSWORD" <<'SQL'
CREATE ROLE yap_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE yap_ai LOGIN PASSWORD :'ai_password' NOSUPERUSER NOBYPASSRLS;
SQL
