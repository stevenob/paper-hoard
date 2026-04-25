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
