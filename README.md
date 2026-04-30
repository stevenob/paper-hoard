# Paper Hoard

A self-hosted physical book library + Discord bot for households.

> Track the books you own, scan a barcode in a bookstore to instantly check whether you already have it, and never accidentally buy *Project Hail Mary* twice again.

## What it does

- **Physical Library** — every book you own physically, scanned by ISBN or photo, organized into shelves.
- **Trophy List** — books you'd like to own ("wishlist"). Smaug DMs you when someone in the household acquires one.
- **Field lookup** — open the scanner on your phone in a bookstore aisle, scan the barcode, get an instant **"already owned"** or **"on trophy list"** chip from a local cache. Works offline.
- **Smaug** — Discord bot: `/scan`, `/library`, `/trophies`, `/found <isbn>` for quick checks from chat.
- **Web UI** — cover grid, fuzzy search, bulk edit, book merge, catalog stats, JSON+CSV export, automated backups, QR spine labels, multi-photo per copy.

Discord identity is the source of truth. Scope is one library per Discord guild (one household).

## Features at a glance

| Area | What you get |
| --- | --- |
| **Scanning** | Phone camera (ZXing), two-frame confirmation, speculative server lookup, bulk mode for shelf inventory, photo upload, manual ISBN/title/author entry, iOS Shortcut friendly (`?isbn=` URL param), QR spine-sticker scan |
| **Field lookup** | Instant "already owned / on trophy list" chip from a local ISBN cache (works offline), confirmation card with cover + rating + edition + dedupe |
| **Match repair** | Inline edit on confirm card (title/authors/publisher/edition), missing-author rescue prompt, refetch metadata button on book detail, manual book entry for ISBN-less editions |
| **Metadata** | Google Books primary, Open Library fallback, DB-cached on re-scan, manual override per book, OL ratings cached with stale-after-7-days refresh |
| **Browse** | Cover grid, list view with checkbox bulk-edit, fuzzy search via Postgres pg_trgm, sort/filter, per-book detail, per-author page (`/authors/<slug>`), per-shelf page, paginated 60/page |
| **Catalog quality** | `/library/dupes` book merge tool, `/stats` completeness dashboard, one-click cover backfill, bulk shelf/edition/condition assignment |
| **Provenance** | Per-copy `acquiredFrom`, `acquiredOn`, `priceCents`, multi-photo gallery (dust jacket, signed page, damage), catalog value rollup |
| **Trophy** | Auto-detected on scan with one-tap acquisition; Smaug DMs the requester when fulfilled. Optional reason capture in field. Goodreads "Want to Read" CSV import |
| **Backup** | Daily automatic JSON dump per library (30-day retention), CSV + JSON export endpoints, "Run backup now" button on /about |
| **Operations** | Audit log, /about page with counts, soft-delete + 30-day trash sweeper + undo toast, public share link with regenerable slug, healthz endpoint |
| **Physical tools** | `/library/labels` generates print-ready QR spine stickers; scanning a sticker deep-links to the copy detail |
| **Quality of life** | PWA install, dark mode (auto + manual), service worker for offline scanning, accessibility (focus rings, ARIA, Esc closes camera), Tailscale-friendly |

## Quick start (local dev)

Requires Node 22+ and Docker.

```bash
cp .env.example .env                # set DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_IDS, COOKIE_SECRET
npm install
npm run build

docker run -d --name paperhoard-pg \
  -e POSTGRES_USER=paperhoard -e POSTGRES_PASSWORD=paperhoard -e POSTGRES_DB=paperhoard \
  -p 5432:5432 postgres:16-alpine
npx prisma migrate deploy

npm run dev:web                     # http://localhost:3000
npm run register-commands           # one-time, when slash command set changes
npm run dev:bot                     # only if you have a Discord token
```

## Self-hosting on TrueNAS SCALE

See [`truenas/README.md`](truenas/README.md). Recommended path: **GHCR-published image + Caddy or Tailscale-served HTTPS**.

1. Run the GitHub Actions workflow once (push a `vX.Y.Z` tag).
2. Make the GHCR package public.
3. Install **`compose.published-with-caddy.yml`** as a Custom App in TrueNAS.
4. After that, every new tag → `Restart` in the TrueNAS Apps UI, no SSH.

The TrueNAS guide also covers:

- Mounting Postgres + uploads + backups + Caddy data on snapshot-able datasets
- Trusting Caddy's local CA on iPhone for LAN access
- **Tailscale + `tailscale serve`** for off-LAN access with real Let's Encrypt certs and zero public exposure
- Discord OAuth setup for web login
- The TrueNAS Apps UI YAML quirks to watch out for

## Architecture

- **Node.js 22 + TypeScript**, single repo, two entrypoints (`bot`, `web`) sharing a `shared/` module
- **Fastify + EJS** for the web UI (server-rendered HTML, minimal JS, vanilla service worker)
- **discord.js v14** for Smaug (slash commands + buttons + modals)
- **Prisma + Postgres 16** with `pg_trgm` for fuzzy search
- **ZXing-js** vendored for in-browser barcode + QR decoding
- **`qrcode`** for server-rendered SVG spine labels
- **Caddy or Tailscale Serve** in front for HTTPS termination
- **GitHub Actions → GHCR** for image publishing on tag

Single household = single library. Multi-library is in the parking lot but not implemented.

## Project layout

```
prisma/schema.prisma         Data model
prisma/migrations/           Hand-written SQL migrations (prisma migrate deploy)
src/shared/                  DB, env, logger, metadata providers, audit, notifications, search, exports
src/bot/                     Smaug entrypoint + slash command handlers + notification poller
src/web/                     Fastify routes + EJS views + public assets (sw.js, ui.js, style.css)
src/scripts/                 One-off maintenance scripts (e.g. backfill-editions, backfill-ratings)
tests/                       Vitest smoke tests (boots the app via fastify.inject)
truenas/                     Compose files + Caddyfile + deployment guide
.github/workflows/           CI — image publish on tag
```

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check, compile, copy views/static into `dist/` |
| `npm run dev:web` | Web with watch (tsx) |
| `npm run dev:bot` | Bot with watch |
| `npm run register-commands` | Push slash command definitions to Discord |
| `npm run prisma:deploy` | Apply existing migrations (used in containers) |
| `npm run lint` | Type-check only |
| `npm test` | Vitest smoke tests (requires running Postgres at `localhost:5432`) |
| `git tag vX.Y.Z && git push origin vX.Y.Z` | Cut a release; GitHub Actions publishes to GHCR |

## License

This is a personal project — no license declared yet. Don't redistribute without asking.
