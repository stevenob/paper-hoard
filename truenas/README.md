# Paper Hoard on TrueNAS SCALE

These compose files target **TrueNAS SCALE 24.10 (Electric Eel) or newer**, which
uses Docker. Older SCALE releases (Cobia / Dragonfish) use k3s and won't work
with these files — upgrade first.

Two variants:

| File                    | Use when                                                                      |
| ----------------------- | ----------------------------------------------------------------------------- |
| `compose.build.yml`     | The repo is cloned onto TrueNAS and you want to build the image on the host. |
| `compose.published.yml` | You build/publish the image elsewhere (CI, laptop) and just pull it here.    |

Both expect Postgres data to live on a real dataset so it can be snapshotted.

---

## One-time TrueNAS prep

In the TrueNAS UI → **Datasets**, create:

```
POOL/apps/paperhoard
POOL/apps/paperhoard/code      (only needed for compose.build.yml)
POOL/apps/paperhoard/pgdata
```

Replace `POOL` with your real pool name in **both** the dataset paths and inside
whichever compose file you use (search/replace `POOL`).

Set ownership so the container users can write:

```bash
# From the TrueNAS shell:
chown -R 999:999 /mnt/POOL/apps/paperhoard/pgdata   # postgres uid in the alpine image
```

---

## Variant A — build on TrueNAS (`compose.build.yml`)

```bash
# 1. Clone the repo onto the dataset
cd /mnt/POOL/apps/paperhoard/code
git clone https://github.com/<your-user>/paper-hoard.git .

# 2. Configure env
cp .env.example .env
# Edit .env: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_IDS,
#           COOKIE_SECRET (use: openssl rand -hex 32)

# 3. Bring it up (uses .env automatically because it's in the project dir)
cd truenas
docker compose -f compose.build.yml --env-file ../.env up -d --build

# 4. Tail logs
docker compose -f compose.build.yml logs -f web bot
```

To update later:
```bash
cd /mnt/POOL/apps/paperhoard/code
git pull
cd truenas
docker compose -f compose.build.yml --env-file ../.env up -d --build
```

---

## Variant B — pull published image (`compose.published.yml`)

Build & publish from your dev machine once:
```bash
docker build -t ghcr.io/<you>/paperhoard:latest .
docker push ghcr.io/<you>/paperhoard:latest
```

Then on TrueNAS, pick **either** of:

### B.1 — From the TrueNAS shell

```bash
mkdir -p /mnt/POOL/apps/paperhoard/deploy && cd /mnt/POOL/apps/paperhoard/deploy
# Copy compose.published.yml + a .env file into this directory.
# Edit compose.published.yml: replace POOL and set PAPERHOARD_IMAGE in .env.
docker compose -f compose.published.yml --env-file .env up -d
```

### B.2 — From the TrueNAS Apps UI ("Install via YAML")

1. **Apps → Discover Apps → ⋮ → Install via YAML**.
2. Paste the contents of `compose.published.yml` (after replacing `POOL`).
3. Provide the env vars in the form (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `DISCORD_GUILD_IDS`, `COOKIE_SECRET`, `PAPERHOARD_IMAGE`, optionally
   `GOOGLE_BOOKS_API_KEY` and `WEB_PORT`).
4. Save. The UI will manage start/stop/logs from then on.

> If your image is in a private registry, run `docker login <registry>` from the
> TrueNAS shell first so the pull succeeds.

---

## After first start

Register Smaug's slash commands (only needed once, plus after any command change):

```bash
# Variant A:
cd /mnt/POOL/apps/paperhoard/code/truenas
docker compose -f compose.build.yml run --rm bot node dist/bot/register-commands.js

# Variant B:
docker compose -f compose.published.yml run --rm bot node dist/bot/register-commands.js
```

Then visit `http://<truenas-ip>:3000` and create users + log a completion.

---

## Common operations

```bash
# Status
docker compose -f compose.build.yml ps

# Tail logs
docker compose -f compose.build.yml logs -f bot

# Update (Variant B — re-pull published image)
docker compose -f compose.published.yml pull && \
  docker compose -f compose.published.yml up -d

# Backup the database
docker compose -f compose.build.yml exec -T postgres \
  pg_dump -U paperhoard paperhoard | gzip > paperhoard-$(date +%F).sql.gz

# Restore
gunzip -c paperhoard-2026-04-27.sql.gz | \
  docker compose -f compose.build.yml exec -T postgres psql -U paperhoard paperhoard
```

---

## Add HTTPS with Caddy (optional but required for phone camera scanning)

The web UI's barcode scanner needs HTTPS on iOS Safari and most modern Android
browsers. The bundled Caddy service in `compose.local-image.yml` gives you a
self-signed HTTPS endpoint on your LAN with zero domain or port-forwarding setup.

### One-time setup

1. **Create the Caddy data datasets** (so its CA cert + auto-renewals persist):
   ```
   POOL/apps/paperhoard/caddy-data
   POOL/apps/paperhoard/caddy-config
   ```
   `chown -R 1000:1000` them (the user the Caddy container runs as).

2. **Make sure the repo is cloned at**
   `/mnt/POOL/apps/paperhoard/code` — the compose file bind-mounts the Caddyfile
   from `code/truenas/Caddyfile`. (You already did this for the build step.)

3. **Set `PAPERHOARD_HOSTS`** in the TrueNAS Apps UI environment variables
   section. SPACE-separated list of every name/IP you'll type in the URL bar
   (Caddy uses spaces, not commas):
   ```
   obrienserver.local 192.168.1.50
   ```
   (Replace with your real hostname + LAN IP.)

4. **Reinstall or edit** the `paperhoard` Custom App to pick up the new YAML.

After the app starts, Caddy auto-generates a self-signed cert covering every
name in `PAPERHOARD_HOSTS`, and you can browse to `https://obrienserver.local`
(or whatever hostname you set).

### Silence the browser cert warning (one-time per device)

Caddy publishes its local-CA root cert at:
```
/mnt/POOL/apps/paperhoard/caddy-data/caddy/pki/authorities/local/root.crt
```

Copy that file to each device and trust it once:

- **macOS:** double-click the `.crt` → Keychain Access → set "Always Trust" for SSL.
- **Windows:** double-click → Install Certificate → Local Machine → Place all in "Trusted Root Certification Authorities".
- **iOS:** AirDrop the file to the iPhone → Settings → General → VPN & Device Management → install the profile → then Settings → General → About → Certificate Trust Settings → enable it.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate.

Without this step you'll just get a "Not secure" warning every time and have to
click through; the camera will still work.

### Why both `local_certs` and `tls internal` in the Caddyfile

`local_certs` is a safety global that forces Caddy to never reach out to Let's
Encrypt. `tls internal` on the site block does the same per-site. Belt and
suspenders so a typo in `PAPERHOARD_HOSTS` (e.g. accidentally listing a real
public domain) can't trigger a public ACME order.



Because Postgres data is on `POOL/apps/paperhoard/pgdata`, set a TrueNAS
**Periodic Snapshot Task** on that dataset (e.g. daily, retain 14). For
crash-consistent snapshots that's fine; for an application-consistent backup,
prefer the `pg_dump` approach above.
