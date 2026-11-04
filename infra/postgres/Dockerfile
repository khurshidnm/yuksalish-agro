# Official Postgres + Debian's PostGIS package. Builds natively on arm64 and amd64
# (the postgis/postgis image is amd64-only).
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
