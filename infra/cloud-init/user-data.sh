#!/bin/bash
# cloud-init user-data for Sakay API EC2.
# Bootstraps a single t4g.micro into a self-healing API host:
#   - Installs Docker + Compose + AWS CLI + CloudWatch agent
#   - Runs Caddy + Postgres + API + Worker via systemd-managed compose
#   - Pulls the API image from GHCR (best-effort: missing image does NOT
#     kill the bootstrap, so curl http://<eip>/ still answers with 502)
#   - Daily backup cron to S3
#
# Variables interpolated by Terraform's templatefile():
#   ${domain_name}        e.g. "sansasakay.example" or ""
#   ${api_subdomain}      e.g. "api"
#   ${ghcr_image}         e.g. "ghcr.io/org/sakay-api:latest"
#   ${letsencrypt_email}  email for Let's Encrypt notifications
#   ${s3_backup_bucket}   bucket name (Terraform-created)
#   ${aws_region}         e.g. "ap-southeast-1"
#   ${public_api_url}     "https://api.sansasakay.example" or ""
#   ${public_web_url}     "https://sansasakay.example" or ""

set -euxo pipefail

exec > >(tee /var/log/sakay-bootstrap.log | logger -t sakay-bootstrap -s 2>/dev/console) 2>&1

# ─── 1. base packages ───────────────────────────────────────────────────────
dnf update -y
dnf install -y docker amazon-cloudwatch-agent jq cronie

systemctl enable --now docker
systemctl enable --now crond

# Docker Compose v2 plugin (Amazon Linux 2023 doesn't ship it).
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-aarch64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# ─── 2. application directory ───────────────────────────────────────────────
# postgres-data is NOT a bind-mount; we use a named Docker volume instead
# (see docker-compose.yml). The timescale/timescaledb-ha image runs as
# UID 1000 inside the container and needs to chown the data dir on first
# init, which Operation-not-permitteds on bind-mounts owned by root.
install -d -m 0755 /opt/sakay
install -d -m 0755 /opt/sakay/caddy-data
install -d -m 0755 /opt/sakay/caddy-config
install -d -m 0755 /var/log/caddy

# When no domain is configured, derive PUBLIC_API_URL from the instance's
# public IPv4 (via IMDSv2) so the API's Zod env validator (which requires a
# valid URL) doesn't reject an empty string. Magic-link emails will use the
# IP-based URL — fine for IP-only / dev deployments.
if [ -z "${public_api_url}" ]; then
  IMDS_TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  PUBLIC_IPV4=$(curl -fsS -H "X-aws-ec2-metadata-token: $${IMDS_TOKEN}" \
    "http://169.254.169.254/latest/meta-data/public-ipv4")
  RESOLVED_API_URL="http://$${PUBLIC_IPV4}"
else
  RESOLVED_API_URL="${public_api_url}"
fi

# PUBLIC_WEB_URL is the landing site (sansasakay.com) — distinct from the
# API host. The magic-link email CTA points here, and the API's CORS
# allow-list in production reads from this var (see src/server.ts). When
# unset (IP-only deploy), fall back to the API URL so Zod's URL validator
# is satisfied; the web flow simply isn't usable in that mode.
if [ -z "${public_web_url}" ]; then
  RESOLVED_WEB_URL="$${RESOLVED_API_URL}"
else
  RESOLVED_WEB_URL="${public_web_url}"
fi

cat > /opt/sakay/.env <<EOF
NODE_ENV=production
LOG_LEVEL=info
PORT=3000
HOST=0.0.0.0
PUBLIC_API_URL=$${RESOLVED_API_URL}
PUBLIC_WEB_URL=$${RESOLVED_WEB_URL}
DATABASE_URL=postgres://sakay:$(openssl rand -hex 16)@postgres:5432/sakay
JWT_SECRET=$(openssl rand -base64 48)
JWT_ISSUER=sakay-api
JWT_TTL_SECONDS=2592000
MAGIC_LINK_TTL_SECONDS=600
EMAIL_PROVIDER=resend
RESEND_API_KEY="${resend_api_key}"
EMAIL_FROM="San Sasakay <no-reply@${domain_name}>"
AWS_REGION=${aws_region}
S3_BACKUP_BUCKET=${s3_backup_bucket}
AGGREGATOR_TICK_SECONDS=10
REPORT_DECAY_START_MINUTES=30
REPORT_EXPIRY_MINUTES=45
EOF
chmod 0640 /opt/sakay/.env

# Extract the Postgres password we just generated for the postgres container.
PG_PASS=$(grep -oP '(?<=postgres://sakay:)[^@]+' /opt/sakay/.env)

# ─── 3. Caddyfile (rendered to /opt/sakay so the caddy container mounts it) ─
if [ -n "${domain_name}" ]; then
  cat > /opt/sakay/Caddyfile <<EOF
{
  email ${letsencrypt_email}
}

${api_subdomain}.${domain_name} {
  encode gzip
  reverse_proxy api:3000
  log {
    output file /var/log/caddy/access.log
    format console
  }
}
EOF
else
  # No domain configured. Serve plain HTTP on port 80 for testing.
  cat > /opt/sakay/Caddyfile <<EOF
:80 {
  encode gzip
  reverse_proxy api:3000
  log {
    output file /var/log/caddy/access.log
    format console
  }
}
EOF
fi

# ─── 4. docker-compose.yml ──────────────────────────────────────────────────
# `app` profile is the API + worker. They are started best-effort so that if
# the GHCR image isn't published yet (first deploy), Caddy + Postgres still
# come up and the public IP responds.
cat > /opt/sakay/docker-compose.yml <<EOF
name: sakay
services:
  postgres:
    image: timescale/timescaledb-ha:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: sakay
      POSTGRES_PASSWORD: $${PG_PASS}
      POSTGRES_DB: sakay
      TIMESCALEDB_TELEMETRY: "off"
    volumes:
      - postgres_data:/home/postgres/pgdata/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sakay -d sakay"]
      interval: 10s
      timeout: 5s
      retries: 10
      # HA image does Patroni + initdb + PostGIS setup on first boot; on a
      # t4g.micro that can take 60-90s. start_period gives that grace window
      # before a failure starts counting against retries.
      start_period: 90s
    networks: [sakaynet]

  caddy:
    image: caddy:2.8-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - /opt/sakay/Caddyfile:/etc/caddy/Caddyfile:ro
      - /opt/sakay/caddy-data:/data
      - /opt/sakay/caddy-config:/config
      - /var/log/caddy:/var/log/caddy
    networks: [sakaynet]

  api:
    image: ${ghcr_image}
    profiles: [app]
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file: /opt/sakay/.env
    networks: [sakaynet]

  worker:
    image: ${ghcr_image}
    profiles: [app]
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file: /opt/sakay/.env
    command: ["node", "dist/workers/index.js"]
    networks: [sakaynet]

volumes:
  postgres_data:

networks:
  sakaynet:
    driver: bridge
EOF

# ─── 5. systemd unit for compose ────────────────────────────────────────────
# Two-phase boot:
#   1. Always bring up postgres + caddy (their images are public, this never
#      fails on a healthy network).
#   2. Best-effort pull + up of the `app` profile. If the GHCR image is the
#      placeholder or hasn't been pushed yet, this just leaves Caddy answering
#      502s until the next `deploy.yml` run replaces the image.
cat > /etc/systemd/system/sakay.service <<'EOF'
[Unit]
Description=Sakay API stack (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/sakay
# First boot of the HA postgres image can take 60-90s to init, and the app
# profile's compose up waits for postgres healthy before starting api/worker.
# Bump the systemd timeout so ExecStartPost doesn't get SIGTERM'd mid-init.
TimeoutStartSec=600
ExecStart=/usr/bin/docker compose up -d --remove-orphans postgres caddy
ExecStartPost=-/bin/bash -c '/usr/bin/docker compose --profile app pull --ignore-pull-failures || true'
ExecStartPost=-/bin/bash -c '/usr/bin/docker compose --profile app up -d --remove-orphans || true'
ExecStop=/usr/bin/docker compose --profile app down

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sakay.service

# ─── 6. daily backup cron ───────────────────────────────────────────────────
cat > /etc/cron.daily/sakay-backup <<EOF
#!/bin/bash
set -e
docker exec sakay-postgres-1 sh -c \
  "pg_dump --no-owner --no-privileges \"\$${DATABASE_URL:-postgres://sakay:$${PG_PASS}@localhost:5432/sakay}\" | gzip -9" \
  > /tmp/sakay-dump.sql.gz
aws s3 cp --region ${aws_region} \
  --storage-class STANDARD_IA \
  /tmp/sakay-dump.sql.gz \
  s3://${s3_backup_bucket}/sakay-api/\$$(date -u +%Y%m%dT%H%M%SZ)/dump.sql.gz
rm -f /tmp/sakay-dump.sql.gz
EOF
chmod +x /etc/cron.daily/sakay-backup

# ─── 7. CloudWatch agent (free 5GB logs/mo) ─────────────────────────────────
cat > /opt/aws/amazon-cloudwatch-agent/etc/sakay.json <<'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/sakay-bootstrap.log",
            "log_group_name": "/sakay/bootstrap",
            "log_stream_name": "{instance_id}",
            "retention_in_days": 7
          },
          {
            "file_path": "/var/log/caddy/access.log",
            "log_group_name": "/sakay/caddy",
            "log_stream_name": "{instance_id}",
            "retention_in_days": 7
          }
        ]
      }
    }
  }
}
EOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/sakay.json \
  -s

echo "[sakay-bootstrap] complete"
