# V1 Scope

Paper Hoard v1.0 is a self-hosted family book library where Smaug manages the shared physical hoard in Discord, while individual users track personal ebook and audiobook completions that can become shared Trophy List requests.

## Core Model

Paper Hoard v1 uses this ownership model:

- One shared family library per Discord server.
- Physical books belong to the shared family library.
- Trophy items belong to the shared family library.
- Users belong to a library through membership records.
- Digital completions belong to individual users.
- Trophy items remember which user requested them.

## In Scope

### Shared Family Library

- Create or resolve a library from a Discord server.
- Store physical copies under the shared library.
- Search/list the shared physical collection.
- Track who added a physical copy.

### Users

- Create or resolve users from Discord user identity.
- Track display name and Discord user ID.
- Associate users with libraries through memberships.
- Use users for personal digital completion tracking.

### Digital Completions

- Add completed ebooks.
- Add completed audiobooks.
- Store completion source, media type, completion date, rating, and notes.
- Scope completions to both a library and a user.

### Trophy List

- Add a completed digital book to the shared family Trophy List.
- Store requested-by user.
- Store desired format, priority, and reason.
- List Trophy items from Discord.
- Remove Trophy items from Discord with confirmation buttons.
- Detect Trophy matches when scanning physical books.

### Smaug Discord Bot

V1 commands:

```text
/scan      Add a physical book to the shared family library
/library   Search or list the shared family library
/trophies  List shared Trophy items and remove them
```

### Web UI

V1 web UI pages:

```text
/
/library
/trophies
/completions
/completions/new
/users
```

For v1, the web UI may use a simple local user selector instead of full authentication.

## Out of Scope for V1

- Native iOS app.
- Kindle account sync.
- Audible account sync.
- Ebook reading.
- Ebook hosting / Calibre-Web-style file storage.
- Audiobook playback.
- DRM handling.
- Public social network features.
- Marketplace scraping.
- Automatic book value tracking.
- Complex roles and permissions.
- Multi-tenant SaaS hosting.

## In Scope additions (post-v1)

- **Kindle link-out**: a `kindleAsin` column on `Book` powers a
  "📖 Read on Kindle" Cloud Reader button on owned and completed
  books. ASINs are auto-enriched from Open Library after each
  durable Book write (with 7-day cooldown + manual-edit guard) and
  can be set/cleared manually. No file hosting, no DRM handling, no
  Kindle account sync — those remain non-goals.

## V1 Acceptance Checklist

### Identity

- [ ] Discord guild creates/fetches a library.
- [ ] Discord user creates/fetches a user.
- [ ] Discord user gets membership in the current library.
- [ ] Commands never leak data across libraries.

### Physical Library

- [ ] `/scan isbn:` adds a physical book to the current family library.
- [ ] `/scan title:` adds a physical book to the current family library.
- [ ] `/library` lists only current family library books.
- [ ] Physical copy records `added_by_user_id`.

### Digital Completions

- [ ] Web UI can create/list users.
- [ ] Web UI can select an active user.
- [ ] Web UI can add ebook completion for selected user.
- [ ] Web UI can add audiobook completion for selected user.
- [ ] Completion records user and library.

### Trophy List

- [ ] Completion can create Trophy item.
- [ ] Trophy item belongs to shared family library.
- [ ] Trophy item records requested user.
- [ ] `/trophies` lists shared Trophy items.
- [ ] `/trophies` shows requested-by user.
- [ ] Remove button deletes/removes Trophy item after confirmation.
- [ ] `/scan` detects Trophy match.
- [ ] Acquired Trophy is removed after physical copy is added.

### Deployment

- [ ] App runs locally with Docker Compose.
- [ ] PostgreSQL data persists after restart.
- [ ] `.env.example` documents required variables.
- [ ] README has setup steps.
- [ ] TrueNAS deployment notes exist.