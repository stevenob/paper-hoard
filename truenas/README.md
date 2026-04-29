# Paper Hoard on TrueNAS SCALE

These compose files target **TrueNAS SCALE 24.10 (Electric Eel) or newer**, which
uses Docker. Older SCALE releases (Cobia / Dragonfish) use k3s and won't work
with these files — upgrade first.

Two variants:

| File                                | Use when                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `compose.build.yml`                 | The repo is cloned onto TrueNAS and you want to build the image on the host. |
| `compose.published.yml`             | You build/publish the image elsewhere (CI, laptop) and just pull it here.    |
| `compose.local-image.yml`           | Locally-built image + bundled Caddy HTTPS proxy. Quick start without GHCR.   |
| `compose.published-with-caddy.yml`  | **Recommended.** Pulls from GHCR + bundled Caddy. Pairs with the GitHub Actions workflow for push-button updates. |

Both expect Postgres data to live on a real dataset so it can be snapshotted.

## ⚠️ TrueNAS Apps UI YAML pitfalls

The TrueNAS Apps UI re-serializes YAML on save, which causes three subtle issues
the bundled compose files are written to avoid. If you hand-edit YAML in the
form, watch for these:

1. **No YAML anchors / aliases.** The UI alphabetizes keys and demotes
   top-level `x-` keys into `services:`, silently breaking aliases like
   `<<: *paperhoard-image`. Repeat `image:` and `pull_policy:` on every
   service instead.

2. **Quote every Discord ID.** Snowflake IDs are 64-bit, larger than YAML/JSON
   can represent precisely. Unquoted, `1489048099606364212` becomes
   `1489048099606364200` — the trailing digits get rounded to the nearest 100
   and Discord then returns "Unknown Application" / can't find the guild.
   Always write `DISCORD_CLIENT_ID: "1489..."` with the quotes.

3. **Watch for duplicate keys after editing.** TrueNAS sometimes *appends* a
   re-serialized copy of an env var instead of replacing the original. YAML
   duplicate-key semantics mean the **last** one wins, so your correction
   gets overwritten by the stale value. After saving, verify with:
   ```
   sudo docker exec $(sudo docker ps -qf name=paperhoard-web) \
     printenv DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_GUILD_IDS WEB_BASE_URL
   ```
   All four should print the values you just set, not stale ones.

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

## Continuous deployment via GHCR (recommended)

A GitHub Actions workflow (`.github/workflows/publish.yml`) builds and publishes
a new image to GitHub Container Registry **only when you push a `vX.Y.Z` git
tag** (or click "Run workflow" manually in the Actions tab). Pushes to `main`
do not trigger builds — bump a tag when you're ready to ship.

### One-time setup

1. **Push to GitHub** — initial setup of the repo and workflow file.

2. **Make the package public** so TrueNAS can pull without authentication:
   - GitHub → your profile → **Packages** → click `paper-hoard` → **Package
     settings** → **Change visibility** → Public.
   - (Alternative if you want to keep it private: `docker login ghcr.io` on
     TrueNAS once with a personal access token that has `read:packages`.)

3. **Switch the TrueNAS Custom App from `compose.local-image.yml` to
   `compose.published-with-caddy.yml`:**
   - Edit the app, replace the YAML with the contents of
     `truenas/compose.published-with-caddy.yml` (with `POOL` patched to your
     pool path, and the `CHANGE_ME_*` placeholders filled in).
   - Save.

### Cutting a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers the workflow, which publishes:
- `ghcr.io/stevenob/paper-hoard:0.1.0`
- `ghcr.io/stevenob/paper-hoard:0.1`
- `ghcr.io/stevenob/paper-hoard:latest`
- `ghcr.io/stevenob/paper-hoard:sha-<short>`

Wait ~1 min for the green check, then in the TrueNAS UI click **paperhoard →
Restart**. `pull_policy: always` makes the restart pull the new `latest`.

### Pinning to a specific version

For reproducible deploys, use the version-tagged image instead of `latest`:

```
PAPERHOARD_IMAGE=ghcr.io/stevenob/paper-hoard:0.1.0
```

### Rolling back

GHCR keeps every published image. To roll back:
```
PAPERHOARD_IMAGE=ghcr.io/stevenob/paper-hoard:0.0.9
```
Save → Restart.

### One-off / experimental builds

The workflow also has a manual trigger. **Actions → Publish image → Run
workflow** publishes a `sha-<short>`-tagged image without bumping a real
version. Useful for testing on TrueNAS before cutting an actual `vX.Y.Z` tag.

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


## Remote access via Tailscale (no port forward, real Let's Encrypt cert)

For access away from home, use Tailscale instead of port-forwarding 8443.
This avoids any public exposure and gives you a real LE cert.

### One-time setup

1. Install the **Tailscale** iX app from the TrueNAS Apps catalog.
   - Hostname: `obrienserver` (becomes the tailnet URL)
   - Auth key: leave blank, authenticate via the URL printed in Logs
   - State volume: bind a dataset (e.g. `apps/tailscale/state`) at owner
     `apps:apps` (UID/GID **568**), mode `0700` — it stores the node private key.
2. Sign in via the URL in the Tailscale app's logs.
3. In the Tailscale admin (https://login.tailscale.com/admin/dns):
   - Toggle **MagicDNS** ON
   - Toggle **HTTPS Certificates** ON
4. Provision the cert + start the reverse proxy on TrueNAS:
   ```bash
   sudo docker exec ix-tailscale-tailscale-1 tailscale cert obrienserver.<tailnet>.ts.net
   sudo docker exec ix-tailscale-tailscale-1 tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```
   `--bg` persists the config across container restarts.
5. Add the new OAuth callback to the Discord developer portal:
   `https://obrienserver.<tailnet>.ts.net/auth/discord/callback`
6. In the TrueNAS Apps UI, set the web service env var
   `WEB_BASE_URL=https://obrienserver.<tailnet>.ts.net` (additionally — keep Caddy
   running for LAN access; the env var only controls the OAuth round-trip URL).
7. Install Tailscale on every device that needs remote access.

After setup you have two access paths simultaneously:

| From | URL | Path |
|---|---|---|
| LAN (home) | `https://obrienserver.local:8443` | Caddy (self-signed) |
| Anywhere on tailnet | `https://obrienserver.<tailnet>.ts.net` | `tailscale serve` (Let's Encrypt) |

Both Discord callback URLs can be registered simultaneously in the developer
portal — they don't conflict.

### Postgres backups

Because Postgres data is on `POOL/apps/paperhoard/pgdata`, set a TrueNAS
**Periodic Snapshot Task** on that dataset (e.g. daily, retain 14). For
crash-consistent snapshots that's fine; for an application-consistent backup,
prefer the `pg_dump` approach above.
