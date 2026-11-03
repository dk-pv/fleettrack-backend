#!/usr/bin/env bash
# First start only: the official postgres image runs /docker-entrypoint-initdb.d solely when
# the data directory is EMPTY, never against an existing database.
#
# Creates the role the API connects as: NOT a superuser, but owner of its database, which is
# all `prisma migrate deploy` needs (no migration creates an extension, and on PG 15+ the
# database owner controls the public schema). A compromised API therefore cannot reach
# superuser-only features such as COPY ... PROGRAM, server file access or ALTER SYSTEM.
#
# No credential lives here. FLEETTRACK_DB_PASSWORD comes from the container environment
# (/srv/fleettrack/secrets/postgres.env) and must equal the password in the API's
# DATABASE_URL. psql reads it with \getenv, so it never appears in a process list. There is
# deliberately no `set -u`: if this file ever loses its executable bit, the entrypoint
# SOURCES it into its own shell, so the missing/empty check is the `:?` guard below.

: "${FLEETTRACK_DB_PASSWORD:?FLEETTRACK_DB_PASSWORD is empty or unset (see /srv/fleettrack/secrets/postgres.env)}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv app_pw FLEETTRACK_DB_PASSWORD
CREATE ROLE fleettrack LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
CREATE DATABASE fleettrack OWNER fleettrack;
SQL
