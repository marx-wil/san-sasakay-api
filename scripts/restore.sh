#!/usr/bin/env bash
# Restore a Sakay API Postgres dump from S3.
#
# Usage:
#   ./scripts/restore.sh s3://sakay-backups-prod/sakay-api/20260501T020000Z/dump.sql.gz
#
# This script is destructive on the target DATABASE_URL. It will:
#   1. Drop and recreate the public schema (extensions remain).
#   2. Pipe the gzipped dump into psql.
#
# Required env:
#   DATABASE_URL      target connection string

set -euo pipefail

s3_uri="${1:-}"
if [[ -z "${s3_uri}" ]]; then
  echo "Usage: $0 s3://bucket/path/dump.sql.gz" >&2
  exit 1
fi
: "${DATABASE_URL:?DATABASE_URL is required}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"

read -r -p "This will overwrite the target database. Type 'restore' to continue: " confirm
[[ "${confirm}" == "restore" ]] || { echo "aborted"; exit 1; }

echo "[restore] dropping public schema"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 <<SQL
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
SQL

echo "[restore] re-asserting extensions"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../src/db/extensions.sql"

echo "[restore] streaming dump from ${s3_uri}"
aws s3 cp --region "${AWS_REGION}" "${s3_uri}" - \
  | gunzip \
  | psql "${DATABASE_URL}" -v ON_ERROR_STOP=1

echo "[restore] ok"
