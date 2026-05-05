# Product Spec

## Product Name

**Paper Hoard**

## Discord Bot Name

**Smaug**

## Tagline

Track your physical library and the digital reads worth adding to your hoard.

## Summary

Paper Hoard is a self-hosted physical book library for tracking owned physical books and completed digital books that may be worth buying physically.

The core idea is simple:

- The **Physical Library** contains books already owned in print.
- **Digital Completions** record completed ebooks and audiobooks from services like Kindle, Audible, Libby, Kobo, Apple Books, Spotify, Libro.fm, or other sources.
- The **Trophy List** contains completed digital books that the user wants to own physically.

Smaug, the Discord bot, provides quick Discord-based access for adding physical books, searching the library, and listing/removing Trophy items.

## Goals

- Make it easy to catalog a physical book collection.
- Allow physical books to be added by ISBN or title search.
- Track completed ebooks and audiobooks without requiring Kindle, Audible, or DRM integrations.
- Maintain a Trophy List of digital books that deserve a physical copy.
- Keep v1 focused and self-hostable.
- Avoid native mobile app requirements for v1.

## Non-goals for V1

- Native iOS app.
- Apple Developer Program dependency.
- Kindle account sync.
- Audible account sync.
- Audiobook playback.
- Ebook reading.
- Ebook hosting (Amazon-purchased Kindle files are DRM-locked, and paper-hoard is a physical-first catalog rather than a Calibre-Web/Kavita replacement).
- DRM handling.
- Public social network features.
- Marketplace scraping or automatic value tracking.
- Complex multi-tenant SaaS hosting.

## Core Concepts

### Physical Library

The physical library represents books the user owns in print.

Examples:

- Hardcover
- Paperback
- Special edition
- Signed edition
- Box set

### Digital Completions

Digital completions represent ebooks or audiobooks the user has completed elsewhere.

Examples:

- Kindle ebook
- Audible audiobook
- Libby ebook
- Libby audiobook
- Kobo ebook
- Apple Books ebook/audiobook
- Spotify audiobook
- Libro.fm audiobook
- Other

### Trophy List

The Trophy List is a wishlist of completed digital books the user wants to buy physically.

Rule:

```text
Trophy List = books I want to buy physically.
Physical Library = books I own physically.
```

When a Trophy item is acquired:

```text
Add to Physical Library
Remove from Trophy List
```

There is no separate acquired trophy state in v1.

## Primary User Flows

### Add a physical book through Discord

```text
/scan isbn:9780593135204
  -> Smaug looks up the ISBN
  -> user confirms the book
  -> user selects condition/location
  -> Smaug checks for a Trophy match
  -> book is added to Physical Library
```

### Add a physical book by title through Discord

```text
/scan title:"Dune" author:"Frank Herbert"
  -> Smaug searches metadata providers
  -> user selects the best match
  -> user selects condition/location
  -> Smaug checks for a Trophy match
  -> book is added to Physical Library
```

### Add a completed digital book through server UI

```text
Open server UI
  -> add completed ebook or audiobook
  -> enter source, completed date, rating, notes
  -> choose whether to add to Trophy List
```

### Acquire a Trophy item

```text
User adds/scans a physical book
  -> Smaug finds matching Trophy item
  -> asks whether to add to library and remove from trophies
  -> if confirmed, physical copy is saved and Trophy item is deleted
```

## V1 Interfaces

### Discord Bot: Smaug

Smaug handles fast interactions:

- `/scan`
- `/library`
- `/trophies`

### Server-side UI

The web UI handles slower management tasks:

- Add completed ebooks.
- Add completed audiobooks.
- Add completions to Trophy List.
- Edit library metadata.
- Edit Trophy items.
- Browse data more comfortably than Discord.

## Metadata Providers

Initial metadata lookup sources:

1. Google Books API
2. Open Library API fallback

Future possible additions:
- ISBNdb
- LibraryThing
- Manual metadata enrichment

## Kindle link-out

Each `Book` row carries an optional `kindleAsin` field. When set on a
book that the family library owns (any non-deleted PhysicalCopy) or
that any user has logged a Completion for, the web UI shows a
"📖 Read on Kindle" button that opens Amazon's Cloud Reader. The
button is suppressed on Trophy items (the wishlist context doesn't
benefit from a reader link).

ASIN sources, in priority order:

1. **Open Library auto-enrichment** — runs after each durable Book
   write (scan-confirm, completion-create, manual-add, edit-refetch,
   CSV-import row). Hits OL's `search.json?q=<isbn>&fields=id_amazon`
   endpoint, verifies the queried ISBN appears in the returned doc,
   filters to `B0…`-prefixed values, and stamps
   `kindleAsinSource = "open_library"` on the Book.
2. **Manual entry** on the Book edit form (`/books/:id/edit`) and on
   the New Completion form (`/completions/new`). Manual entries are
   stamped `kindleAsinSource = "manual"` and are never overwritten by
   the auto-enrichment.

A 7-day cooldown column (`kindleAsinAttemptedAt`) prevents repeat OL
fetches for books the search couldn't enrich. The Book edit page has
a "🔁 Try Open Library lookup again" action that explicitly clears
the cooldown for users who want an immediate re-attempt.

This is link-out only. Paper Hoard does not host ebook files —
Amazon-purchased Kindle files are DRM-locked and paper-hoard's
identity is *physical-first catalog*, not a Calibre-Web/Kavita
replacement.
