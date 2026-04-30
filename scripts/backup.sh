#!/usr/bin/env bash
# Daily Postgres backup. Streams a compressed pg_dump straight to S3.
#
# Required env:
#   DATABASE_URL      postgres connection string
#   S3_BACKUP_BUCKET  e.g. sakay-backups-prod
# Optional:
#   AWS_REGION        defaults to ap-southeast-1
#
# Wired to a daily cron in cloud-init/user-data.sh.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${S3_BACKUP_BUCKET:?S3_BACKUP_BUCKET is required}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
key="sakay-api/${ts}/dump.sql.gz"
tmp="$(mktemp -t sakay-dump.XXXXXX.sql.gz)"

echo "[backup] dumping to ${tmp}"
pg_dump \
  --no-owner \
  --no-privileges \
  --format=plain \
  --serializable-deferrable \
  "${DATABASE_URL}" \
  | gzip -9 > "${tmp}"

size=$(wc -c < "${tmp}")
echo "[backup] dump size: ${size} bytes"

if [[ "${size}" -lt 1024 ]]; then
  echo "[backup] dump suspiciously small, aborting" >&2
  rm -f "${tmp}"
  exit 1
fi

echo "[backup] uploading to s3://${S3_BACKUP_BUCKET}/${key}"
aws s3 cp \
  --region "${AWS_REGION}" \
  --storage-class STANDARD_IA \
  "${tmp}" "s3://${S3_BACKUP_BUCKET}/${key}"

rm -f "${tmp}"
echo "[backup] ok"
