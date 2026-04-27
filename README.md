# Paper Hoard

A self-hosted physical book library + Discord bot for households.

> Track your physical library and the digital reads worth adding to your hoard.

## What it does

- **Physical Library** — every book you own physically, scanned by ISBN, organized into series and tags
- **Trophy List** — digital books you finished and now want to buy physically
- **Digital Completions** — ebooks/audiobooks you read elsewhere (Kindle, Audible, Libby…)
- **Smaug** — a Discord bot for the household: `/scan`, `/library`, `/trophies`
- **Web UI** — Plex-style cover grid, per-book detail with reviews from Goodreads/StoryGraph/LibraryThing/Open Library, mobile camera scanning, dark mode, optional public read-only share link

Discord identity is the source of truth: log in with Discord OAuth, the bot sees the same users, scope is one library per Discord guild (one household).

## Features

| Area | What you get |
| --- | --- |
| **Scanning** | Phone camera (ZXing) with barcode confirmation card, photo upload from camera roll, manual ISBN/title/author entry, Smaug `/scan isbn:` or `/scan title: author:` |
| **Metadata** | Google Books primary, Open Library fallback, manual override per book, auto-detected binding (HC/PB/mass-market) and series |
| **Browse** | Cover grid, list view, search, sort/filter, per-book detail page, per-tag, per-series, paginated 60/page |
| **Trophy** | Detected on scan with confirm-buttons in Discord, Smaug DMs the requester when their trophy is acquired |
| **Imports** | Goodreads CSV, StoryGraph CSV, generic CSV (physical or completions) |
| **Operations** | Audit log, /about page with version + DB counts, automated `pg_dump` backup script, public share link with regenerable slug |
| **Quality of life** | PWA install (Add to Home Screen), dark mode (auto + manual toggle), service worker for snappy reloads, accessibility (focus rings, ARIA, Esc closes camera) |

## Quick start (local dev)

Requires Node 22+ and Docker.

```bash
cp .env.example .env                # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_IDS, COOKIE_SECRET
npm install
npm run build

# Postgres
docker run -d --name paperhoard-pg \
  -e POSTGRES_USER=paperhoard -e POSTGRES_PASSWORD=paperhoard -e POSTGRES_DB=paperhoard \
  -p 5432:5432 postgres:16-alpine
npx prisma migrate deploy

# Web (separate terminal)
npm run dev:web                     # http://localhost:3000

# Bot (only if you have a Discord token)
npm run register-commands           # one-time per command change
npm run dev:bot
```

## Self-hosting on TrueNAS SCALE

See [`truenas/README.md`](truenas/README.md). Recommended path:

1. Run the GitHub Actions workflow once (push a `vX.Y.Z` tag).
2. Make the GHCR package public.
3. Install the **`compose.published-with-caddy.yml`** as a Custom App on TrueNAS — pulls the image from GHCR, runs the web + bot + Postgres + a self-signed-HTTPS Caddy proxy in one shot.
4. After that, every new tag → `Restart` in the TrueNAS Apps UI, no SSH.

The TrueNAS guide also covers:

- Mounting Postgres + uploads + Caddy data on snapshot-able datasets
- Trusting Caddy's local CA on iPhone so the camera scanner works in Safari
- Backup cron job + restore
- Discord OAuth setup for web login

## Architecture

- **Node.js 22 + TypeScript**, single repo, two entrypoints (`bot`, `web`) sharing a `shared/` module
- **Fastify + EJS** for the web UI (server-rendered HTML, minimal JS)
- **discord.js v14** for Smaug (slash commands + buttons + modals)
- **Prisma + Postgres 16** for persistence
- **ZXing-js** vendored for in-browser barcode decoding
- **Caddy** in front for HTTPS termination on LAN
- **GitHub Actions → GHCR** for image publishing on tag

Single household = single library. Multi-library is in the parking lot but not implemented.

## Project layout

```
prisma/schema.prisma     Data model
src/shared/              DB, env, logger, metadata providers, audit, notifications, picklists, tags
src/bot/                 Smaug entrypoint + slash command handlers + notification poller
src/web/                 Fastify routes + EJS views + public assets (incl. service worker)
src/scripts/             One-off maintenance scripts (e.g. backfill-editions)
truenas/                 Compose files + Caddyfile + deployment guide
scripts/                 Host-side helpers (e.g. backup.sh)
.github/workflows/       CI — image publish on tag
```

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check, compile, copy views/static into `dist/` |
| `npm run dev:web` | Web with watch (tsx) |
| `npm run dev:bot` | Bot with watch |
| `npm run register-commands` | Push slash command definitions to Discord |
| `npm run prisma:migrate` | Create + apply a new migration |
| `npm run prisma:deploy` | Apply existing migrations (used in containers) |
| `npm run lint` | Type-check only |
| `npm run test` | Vitest |
| `git tag vX.Y.Z && git push origin vX.Y.Z` | Cut a release; GitHub Actions publishes to GHCR |

## License

This is a personal project — no license declared yet. Don't redistribute without asking.
