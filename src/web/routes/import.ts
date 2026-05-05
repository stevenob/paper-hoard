import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { lookupByIsbn, searchByTitle } from "../../shared/metadata.js";
import { upsertBookFromMetadata } from "../../shared/repo.js";
import { scheduleKindleAsinEnrichment } from "../../shared/kindle-enrichment.js";
import { parseCsv, type CsvFormat, type ImportType } from "../../shared/csv-import.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

interface ImportSummary {
  total: number;
  imported: number;
  skipped: number;
  errors: { row: number; reason: string; title?: string }[];
  warnings: string[];
}

const SLEEP_MS = 200; // be polite to Google Books / Open Library

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function importRoutes(app: FastifyInstance) {
  app.get("/import", async (req, reply) => {
    return reply.view(
      "import.ejs",
      await withChrome(req, { summary: null as ImportSummary | null, error: null as string | null })
    );
  });

  app.post("/import", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library) {
      return reply.view(
        "import.ejs",
        await withChrome(req, {
          summary: null,
          error: "No family library exists yet. Run /library in Discord first.",
        })
      );
    }

    let format: CsvFormat = "generic";
    let type: ImportType = "physical";
    let csvText: string | null = null;

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "csv") {
        const chunks: Buffer[] = [];
        for await (const c of part.file) chunks.push(c);
        csvText = Buffer.concat(chunks).toString("utf8");
      } else if (part.type === "field") {
        if (part.fieldname === "format") format = part.value as CsvFormat;
        if (part.fieldname === "type") type = part.value as ImportType;
      }
    }

    if (!csvText) {
      return reply.view(
        "import.ejs",
        await withChrome(req, { summary: null, error: "No CSV file uploaded." })
      );
    }

    const { rows, warnings } = parseCsv(csvText, format, type);
    const summary: ImportSummary = {
      total: rows.length,
      imported: 0,
      skipped: 0,
      errors: [],
      warnings,
    };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        let meta = r.isbn ? await lookupByIsbn(r.isbn) : null;
        if (!meta && r.title) {
          const results = await searchByTitle([r.title, r.author].filter(Boolean).join(" "));
          meta = results[0] ?? null;
        }
        if (!meta) {
          summary.errors.push({ row: i + 2, reason: "no metadata match", title: r.title });
          summary.skipped++;
        } else {
          const book = await upsertBookFromMetadata(meta);
          // Schedule Kindle ASIN enrichment for the just-identified
          // book. The reply argument is the import-route reply, so
          // the OL fetch fires after the import response finishes,
          // which means it runs at the end of the loop AFTER all
          // rows have been processed. The atomic claim + cooldown
          // serialise multiple bookIds and short-circuit recently-
          // attempted ones.
          scheduleKindleAsinEnrichment(reply, book.id);
          if (type === "physical") {
            const copy = await prisma.physicalCopy.create({
              data: {
                bookId: book.id,
                libraryId: library.id,
                addedByUserId: user.id,
                condition: r.condition ?? null,
                edition: r.edition ?? null,
                notes: r.notes ?? null,
              },
            });
            void audit({
              userId: user.id,
              action: "create",
              entity: "physicalCopy",
              entityId: copy.id,
              details: { source: "csv-import", format, row: i + 2 },
            });
          } else if (type === "trophy") {
            // Idempotent: skip if a trophy already exists for this book.
            const existing = await prisma.trophy.findUnique({
              where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
            });
            if (existing) {
              summary.skipped++;
              summary.imported--;
              summary.errors.push({
                row: i + 2,
                reason: "already on trophy list",
                title: r.title,
              });
              // Don't double-count as imported below.
              continue;
            }
            const trophy = await prisma.trophy.create({
              data: {
                libraryId: library.id,
                bookId: book.id,
                requestedByUserId: user.id,
                priority: 3,
              },
            });
            void audit({
              userId: user.id,
              action: "create",
              entity: "trophy",
              entityId: trophy.id,
              details: { source: "csv-import", format, row: i + 2 },
            });
          } else {
            const completion = await prisma.completion.create({
              data: {
                userId: user.id,
                libraryId: library.id,
                bookId: book.id,
                mediaType: r.mediaType ?? "ebook",
                source: r.source ?? null,
                completedOn: r.completedOn ?? null,
                rating: r.rating ?? null,
                notes: r.notes ?? null,
              },
            });
            void audit({
              userId: user.id,
              action: "create",
              entity: "completion",
              entityId: completion.id,
              details: { source: "csv-import", format, row: i + 2 },
            });
          }
          summary.imported++;
        }
      } catch (err) {
        summary.errors.push({
          row: i + 2,
          reason: err instanceof Error ? err.message : String(err),
          title: r.title,
        });
        summary.skipped++;
      }
      // Throttle metadata lookups to avoid rate limits.
      if (r.isbn || r.title) await sleep(SLEEP_MS);
    }

    return reply.view("import.ejs", await withChrome(req, { summary, error: null }));
  });
}
