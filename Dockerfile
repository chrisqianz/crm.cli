# crm.cli enterprise server (spec/enterprise.md, P1)
#
# Deployed, the server sits in front of Postgres. The image needs no changes
# for that — one environment variable carries the connection string and
# states the backend — so bring the database up with it rather than running
# this image against a file:
#
#   docker compose up -d --build      # postgres:16 + this image, see docker-compose.yml
#
# or by hand, with CRM_DATABASE_URL pointing at a reachable Postgres 16+:
#
#   docker build -t crm .
#   docker run -d --name crm -p 8443:8443 -p 127.0.0.1:8580:8580 \
#     -e CRM_DATABASE_URL='postgres://crm:crm@db.internal:5432/crm' \
#     -e CRM_CONFIG=/data/crm.toml crm
#
# Without CRM_DATABASE_URL the container runs on SQLite in /data (local,
# offline, evaluation). That is a supported shape, not the deployed one.
#
# The first boot prints a BOOTSTRAP-CODE to the container logs for creating
# the owner account:
#
#   docker logs crm            # or: docker compose logs crm
#   crm admin bootstrap --server <host>:8443 --code <code> \
#     --username admin --password '...'
#
# Production: mount CA-signed TLS material and pass it via the [serve]
# cert/key config, e.g. with an additional volume at /etc/crm/certs and:
#
#   crm.toml:  [serve] cert = "/etc/crm/certs/server.crt" key = "/etc/crm/certs/server.key"

FROM oven/bun:1

# openssl is used once at first boot to mint the self-signed dev certificate
# (~/.crm/certs). Provide your own cert/key for anything real.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

ENV CRM_DB=/data/crm.db
# SQLite fallback only. CRM_DATABASE_URL wins and makes CRM_DB dead config —
# validateDatabaseConfig accepts both being present, so this line never has to
# be removed to run on Postgres; it simply stops meaning anything.
#
# Config: `crm serve` refuses [auth]/[ldap] from a crm.toml it discovers by
# walking up from the cwd (that file can arrive with a clone), so give the
# server an explicit one:
#   docker run -e CRM_CONFIG=/data/crm.toml -v ./crm.toml:/data/crm.toml:ro \
#              -e CRM_LDAP_BIND_PASSWORD=... -p 8443:8443 -v crm-data:/data crm
# Unset, the global ~/.crm/config.toml inside the container is used (also
# trusted), or defaults + the env vars above.
VOLUME /data
# 8443 is the TLS RPC port; 8580 is the admin console (plain HTTP), which is
# also where /health and /ready live. Publish 8580 on loopback only.
EXPOSE 8443

CMD ["bun", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8443"]
