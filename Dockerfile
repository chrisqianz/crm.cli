# crm.cli enterprise server (spec/enterprise.md, P1)
#
#   docker build -t crm .
#   docker run -d --name crm -p 8443:8443 -v crm-data:/data crm
#
# Data (SQLite + WAL) lives in /data. The first boot prints a
# BOOTSTRAP-CODE to the container logs for creating the owner account:
#
#   docker logs crm
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
# Config: `crm serve` refuses [auth]/[ldap] from a crm.toml it discovers by
# walking up from the cwd (that file can arrive with a clone), so give the
# server an explicit one:
#   docker run -e CRM_CONFIG=/data/crm.toml -v ./crm.toml:/data/crm.toml:ro \
#              -e CRM_LDAP_BIND_PASSWORD=... -p 8443:8443 -v crm-data:/data crm
# Unset, the global ~/.crm/config.toml inside the container is used (also
# trusted), or defaults + the env vars above.
VOLUME /data
EXPOSE 8443

CMD ["bun", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8443"]
