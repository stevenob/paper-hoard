# Paper Hoard

Paper Hoard is a self-hosted physical book library for tracking the books you own and the completed digital reads worth adding to your shelf.

It includes **Smaug**, a Discord bot for quickly adding physical books by ISBN or title, searching your library, and viewing your Trophy List.

## Tagline

Track your physical library and the digital reads worth adding to your hoard.

## V1 Focus

Paper Hoard v1 is intentionally focused:

- Physical book library tracking
- Discord-based book intake through Smaug
- Add books by ISBN or title search
- Search/list your physical library from Discord
- Track completed ebooks and audiobooks through a server-side UI
- Add completed digital books to a Trophy List when you want to buy the physical copy
- List Trophy items from Discord
- Remove Trophy items with Discord buttons

## What V1 Does Not Do

To keep the first version achievable, v1 does not include:

- Native iOS app
- Kindle login or sync
- Audible login or sync
- Audiobook playback
- Ebook reading
- Public social features
- Automatic marketplace value tracking
- App Store distribution

## Core Concept

Paper Hoard has three main concepts:

1. **Physical Library** — books you own physically.
2. **Digital Completions** — ebooks or audiobooks you completed elsewhere.
3. **Trophy List** — completed digital books you want to own physically.

A typical flow:

```
Complete a Kindle ebook or Audible audiobook
  -> log it in Paper Hoard
  -> decide if it is worthy of the Trophy List
  -> later scan/add the physical book with Smaug
  -> add it to the Physical Library
  -> remove it from the Trophy List
```

## Smaug Discord Bot

Smaug handles fast Discord interactions:

```
/scan      Add a physical book by ISBN or title
/library   Search or list your physical library
/trophies  List Trophy items with Remove buttons
```

## Server-side UI

The server-side UI handles slower management tasks:

- Add completed ebooks
- Add completed audiobooks
- Decide whether a completion should be added to the Trophy List
- Manage/edit library data
- Manage/edit Trophy items

## Planned Stack

Initial planned stack:

- PostgreSQL
- Discord bot named Smaug
- Server-side web UI
- Google Books API lookup
- Open Library API fallback
- Docker deployment for TrueNAS SCALE

## Repository Status

This repository currently contains the product/spec template for Paper Hoard. Implementation details may change as the project evolves.

## Getting Started

Paper Hoard is a Node.js + TypeScript app with a Discord bot (Smaug) and a Fastify web UI, backed by Postgres via Prisma.

### Prerequisites

- Node.js 22+
- Docker (for Postgres). Compose v2 is also nice to have, but not required for local dev.
- A Discord application + bot token if you want to run Smaug — see https://discord.com/developers/applications

### One-time setup

```bash
cp .env.example .env       # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_IDS
npm install
npm run build
```

### Run the database

If you have Docker Compose:
```bash
docker compose up -d postgres
```

Or with plain Docker:
```bash
docker run -d --name paperhoard-pg \
  -e POSTGRES_USER=paperhoard -e POSTGRES_PASSWORD=paperhoard -e POSTGRES_DB=paperhoard \
  -p 5432:5432 postgres:16-alpine
```

### Apply migrations

```bash
npx prisma migrate deploy   # production / first run
# or, while iterating on schema.prisma:
npm run prisma:migrate -- --name <change-name>
```

### Run the web UI

```bash
npm run dev:web    # tsx watch, http://localhost:3000
# or
npm run start:web  # uses dist/
```

Visit http://localhost:3000 — pick or create an active user from the top bar.

### Run Smaug (the Discord bot)

1. Register slash commands once (and every time you change them):
   ```bash
   npm run register-commands
   ```
2. Start the bot:
   ```bash
   npm run dev:bot
   # or
   npm run start:bot
   ```

In your Discord server, try `/library`, `/scan isbn:9780593135204`, `/trophies`.

### Full stack via Docker Compose

```bash
docker compose up --build
```

This brings up Postgres, the web UI on `http://localhost:3000`, and the bot (which will only stay up if `DISCORD_TOKEN` is set).

### TrueNAS SCALE deployment notes

See [`truenas/README.md`](truenas/README.md) for the full guide. Two ready-to-use compose files are provided:

- `truenas/compose.build.yml` — clone the repo onto TrueNAS and build the image there.
- `truenas/compose.published.yml` — pull a pre-built image from a registry (also what to paste into the TrueNAS Apps UI's "Install via YAML" flow).

Both use a bind-mounted dataset for Postgres so it can be snapshotted by TrueNAS.

### Project layout

```
prisma/schema.prisma     Data model (Library, User, Membership, Book, PhysicalCopy, Completion, Trophy)
src/shared/              DB client, env, logger, metadata providers (Google Books + Open Library)
src/bot/                 Smaug entrypoint + slash command handlers
src/web/                 Fastify app, EJS views, public assets
```

### Useful commands

| Command                       | What it does                                        |
| ----------------------------- | --------------------------------------------------- |
| `npm run build`               | Type-check, compile, copy views/static into `dist/` |
| `npm run dev:web`             | Run the web UI with watch                           |
| `npm run dev:bot`             | Run the bot with watch                              |
| `npm run register-commands`   | Push slash command definitions to Discord          |
| `npm run prisma:migrate`      | Create + apply a new migration                      |
| `npm run prisma:deploy`       | Apply existing migrations (use in containers)       |
| `npm run lint`                | TypeScript type-check only                          |
| `npm run test`                | Run Vitest                                          |
