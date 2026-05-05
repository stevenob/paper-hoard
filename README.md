# Paper Hoard

> Self-hosted physical book library for households — scan a barcode in a bookstore to instantly check whether you already own the book or have it on your wishlist.

[![Tag](https://img.shields.io/github/v/tag/stevenob/paper-hoard?label=release)](https://github.com/stevenob/paper-hoard/tags)
[![License](https://img.shields.io/badge/license-personal-lightgrey)](#license)

Paper Hoard is a single-household app for tracking the physical books on your shelves. It's built around a simple use case:

> You're standing in a bookstore aisle. You see a book you might already own. You'd rather not buy *Project Hail Mary* twice. Open the app on your phone, point the camera at the barcode, and within a second you know.

## ✨ Features

### 📷 Field scanning
- **Phone-camera barcode reader** with a big landscape reticle, scan-line animation, and an instant "🟢 already owned / 🟡 already on wishlist / ⚪ new" status pill — even offline, served from a local ISBN cache
- **Bulk mode** for shelf-inventory sweeps: every successful scan auto-adds, with a horizontal cover filmstrip showing what was just captured and an "↶ undo last" button
- **Photo upload** path for awkward scanning conditions; ZXing decodes from the static image
- **Manual entry** for ISBN-less editions (vintage, self-published, regional reprints)
- **iOS Shortcut friendly** — `?isbn=…` URL parameter triggers the same flow

### 📚 Library management
- **Cover-grid + list views** with sort, filter, and Postgres `pg_trgm` fuzzy search
- **Bulk edit** — tick rows to add/remove from shelves, set edition/condition, mark as part of a series with auto-numbering, or trash
- **Multi-photo per copy** — dust jacket, signed page, damage closeups
- **Per-copy provenance**: `acquiredFrom`, `acquiredOn`, `priceCents`, condition, edition
- **Soft delete** with a 30-day trash sweeper, undo toast, and restore action

### 🏆 Trophy list (wishlist)
- **Smart-search add modal** — type a title or paste an ISBN, pick from live Google Books / Open Library results, set max price + edition notes + reason
- **Auto-detect on scan** — when you scan a book that's on your wishlist, the confirm sheet shows a 🏆 badge and offers a "Mark FOUND" action
- **Public share page** at `/share/<slug>/wishlist` (regenerable slug) — perfect for sharing your wishlist with family before holidays
- **Aged badge** on items >180 days old so they don't quietly rot at the bottom of the list
- **Goodreads "Want to Read" CSV import**

### 📐 Catalog quality
- **Cover backfill** with a cascading lookup: Google Books → Open Library `-L` → Open Library `-M` → LibraryThing sister-edition cover (free dev key) → manual upload prompt
- **Activity log** during repair runs — shows each book's outcome (kept / repaired / nulled) live, with `📷 add cover` quick-link on failures
- **Author backfill** — a phase-1 cheap pass copies `authors[0]` into `primaryAuthor`, then a phase-2 ISBN lookup fills empty entries
- **Duplicate book merge** at `/library/dupes`
- **Author dupe merge** at `/authors/dupes`
- **📖 Read on Kindle deep-links** — books with a Kindle ASIN show a "Read on Kindle" button that opens Amazon's Cloud Reader. ASINs are auto-fetched from Open Library after each scan/import (with a 7-day cooldown and a manual-edit guard) and can be set or cleared on the book edit page. The link is owned-only; trophy items stay link-free. A bulk **`📖 Backfill Kindle ASINs`** button on `/about` walks owned books that don't have one yet — same activity-log UI as the cover backfill.

### 📚 Series + shelves
- **Series detail page** at `/series?name=<name>` — merges your owned books with what Open Library knows about the series, sorted by volume number; missing books get a `MISSING` pill and a one-click `+ trophy` quick-add
- **Netflix-style shelf rails** — `/shelves` shows one horizontal poster row per shelf, with auto-generated rails for every series you own books from
- **Ordered shelves** preserve volume position per shelf membership
- **QR spine stickers** at `/library/labels` — print-ready, scanning a sticker deep-links to the copy detail

### 🤖 Smaug (Discord bot)
- Slash commands: `/scan <isbn>`, `/library`, `/trophies`, `/found <isbn>`, `/random [shelf]`
- DMs the requester when their trophy gets fulfilled
- Notifies the configured channel on new acquisitions

### 📊 Operations
- `/about` — combined dashboard with KPIs (active copies, completeness %, top authors, oldest/newest, most-expensive, lending tracker), backup/share/Discord widgets, and live cover-repair tools
- `/audit` — append-only log of every change, color-coded by verb (`create` / `update` / `delete`)
- **Daily auto-backup** with 30-day retention; manual "Run backup now" button
- **CSV + JSON export** endpoints
- **Lending tracker** at `/lending` — record who borrowed what; due-date warnings + overdue badges
- **Healthz endpoint** for uptime monitoring

### 📱 Mobile
- **PWA** — "Add to Home Screen" works on iOS and Android
- **Hamburger drawer** for the nav at narrow widths
- **Touch-target floor** of 44px on all buttons
- **Sticky form-action bar** on long forms so submit is always one tap away
- **Service-worker offline shell** keeps the camera UI usable on dead cellular signal

### 🎨 Visual identity
- Inky Paper palette: warm-white / terracotta-accent in light mode, deep-charcoal / coral in dark mode
- Fraunces (display) + Inter (body) + JetBrains Mono (numerics)
- Auto theme toggle that persists across sessions

## 🚀 Quick start (local dev)

Requires **Node.js 22+** and **Docker**.

```bash
git clone https://github.com/stevenob/paper-hoard.git
cd paper-hoard
cp .env.example .env             # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, etc.
npm install
npm run build

# spin up Postgres
docker run -d --name paperhoard-pg \
  -e POSTGRES_USER=paperhoard -e POSTGRES_PASSWORD=paperhoard -e POSTGRES_DB=paperhoard \
  -p 5432:5432 postgres:16-alpine

npx prisma migrate deploy
npm run dev:web                  # http://localhost:3000
npm run register-commands        # one-time, when slash command set changes
npm run dev:bot                  # only needed if testing the Discord bot
```

Required env vars:

| Var | What it's for |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `DISCORD_TOKEN` | Smaug bot token from the Developer Portal |
| `DISCORD_CLIENT_ID` | Smaug application ID |
| `DISCORD_GUILD_IDS` | Comma-separated guild IDs to register slash commands in |
| `COOKIE_SECRET` | Random 32+ char string for session cookies |

Optional but recommended:

| Var | What it's for |
| --- | --- |
| `DISCORD_CLIENT_SECRET` | Required for Discord OAuth web login |
| `GOOGLE_BOOKS_API_KEY` | Higher rate limits than the anonymous tier |
| `LIBRARYTHING_DEVKEY` | Enables sister-edition cover-repair fallback |
| `WEB_BASE_URL` | Public URL — used for Discord links, share pages, OAuth redirects |
| `UPLOADS_DIR` | Where cover photos are stored — bind-mount to a snapshot-able path |
| `BACKUPS_DIR` | Where daily backups land — bind-mount too |

## 🏠 Self-hosting on TrueNAS SCALE

The `truenas/` directory has everything you need:

- **`compose.published.yml`** — pulls the prebuilt image from GHCR (`ghcr.io/stevenob/paper-hoard:latest`)
- **`compose.published-with-caddy.yml`** — same plus a Caddy reverse proxy with self-signed local CA
- **`compose.local-image.yml`** — for testing local builds before pushing
- **`compose.build.yml`** — builds from source inside the container (slowest, useful when iterating without GHCR)
- **`Caddyfile`** — sample reverse-proxy config for `obrienserver.local` style hostnames

Highlights of what the truenas guide covers:

- Mounting Postgres + uploads + backups + Caddy data on snapshot-able TrueNAS datasets
- Trusting Caddy's local CA on iOS for LAN access
- **Tailscale + `tailscale serve`** for off-LAN access with real Let's Encrypt certs and zero public exposure (no port-forwarding required)
- Discord OAuth setup for web login
- The TrueNAS Apps UI YAML quirks to watch out for (no anchors, quote Discord IDs, etc.)

After initial setup, every new `vX.Y.Z` git tag triggers GitHub Actions to publish a new GHCR image. Bump the image tag in your TrueNAS app config (or leave it on `latest`) and click **Restart** — no SSH required.

## 🏗 Architecture

- **Node.js 22 + TypeScript** — single repo, two entrypoints (`web`, `bot`) sharing a `shared/` module
- **Fastify + EJS** for the web UI — server-rendered HTML, vanilla JS islands for interactivity, single hand-written `style.css`
- **discord.js v14** for Smaug
- **Prisma + Postgres 16** with `pg_trgm` for fuzzy search
- **ZXing-js** vendored for in-browser barcode + QR decoding
- **`qrcode`** for server-rendered SVG spine labels
- **Caddy or Tailscale Serve** in front for HTTPS termination
- **GitHub Actions → GHCR** for image publishing on tag

Single household = single library. Multi-library is in the parking lot but not implemented.

## 📂 Project layout

```
prisma/schema.prisma          Data model
prisma/migrations/            Hand-written SQL migrations (prisma migrate deploy)
src/shared/                   DB, env, logger, metadata providers, audit, notifications
src/bot/                      Smaug entrypoint + slash command handlers
src/web/                      Fastify routes + EJS views + public assets (sw.js, ui.js, style.css)
src/scripts/                  One-off maintenance scripts
tests/                        Vitest smoke tests (boots the app via fastify.inject)
truenas/                      Compose files + Caddyfile + deployment guide
.github/workflows/            CI — image publish on tag
```

## 🧰 Useful commands

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

## 🤝 Contributing

This is a personal project I built for my household, but PRs are welcome if you spot a bug or have an enhancement that fits the scope. Open an issue first if it's a big change.

A few opinionated ground rules:

- **No SPA framework.** The whole client is server-rendered EJS + vanilla JS. PRs that pull in React/Vue/Svelte will be politely declined.
- **Hand-written SQL migrations.** `prisma migrate dev` hangs in containerised environments — write the SQL by hand under `prisma/migrations/<timestamp>_<name>/migration.sql`, then `prisma migrate deploy` applies it.
- **Smoke tests stay green.** `npm test` boots the whole app via `fastify.inject` and hits every GET route plus the auth-required POSTs. Don't break it.
- **Inky Paper palette.** New UI uses the existing CSS tokens (`--accent`, `--gold`, `--success`, etc.) — no inline `style="color:#…"` strings.

## 📜 License

This is a personal project — no license declared. Don't redistribute without asking.

## 🙏 Credits

- **Cover art:** Google Books, Open Library
- **Edition coverage:** [LibraryThing thingISBN](https://www.librarything.com/services/) for sister-edition cover rescue
- **Barcode decoding:** [@zxing/browser](https://github.com/zxing-js/library)
- **Fonts:** [Fraunces](https://fonts.google.com/specimen/Fraunces), [Inter](https://fonts.google.com/specimen/Inter), [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono)
