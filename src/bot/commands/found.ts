import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type { BotCommand } from "./index.js";
import { prisma } from "../../shared/db.js";
import { upsertLibrary } from "../../shared/repo.js";

/**
 * /found <isbn> — quick "do we own this?" check from inside Discord without
 * opening the web UI. Useful when you're chatting in Discord, see a book
 * recommendation, and want to verify in two seconds whether you already
 * own it (or have it on the trophy list).
 */
export const foundCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("found")
    .setDescription("Quick check: do we own this ISBN?")
    .addStringOption((o) =>
      o
        .setName("isbn")
        .setDescription("ISBN-10 or ISBN-13 (digits only or with dashes)")
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Smaug only works inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const raw = interaction.options.getString("isbn", true);
    const isbn = raw.replace(/[^0-9Xx]/g, "");
    if (isbn.length !== 10 && isbn.length !== 13) {
      await interaction.reply({
        content: `\`${raw}\` doesn't look like an ISBN-10 or ISBN-13 (got ${isbn.length} digits).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);
    const book = await prisma.book.findUnique({
      where: { isbn13: isbn },
      include: {
        physicalCopies: {
          where: { libraryId: library.id, deletedAt: null },
          include: {
            addedBy: { select: { displayName: true } },
            shelves: { include: { shelf: { select: { name: true } } } },
          },
        },
        trophies: {
          where: { libraryId: library.id },
          include: { requestedBy: { select: { displayName: true } } },
        },
      },
    });

    if (!book) {
      await interaction.reply({
        content: `❓ ISBN \`${isbn}\` not in ${library.name}. Use \`/scan\` if you want to add it.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Library-scoped owned-or-completed gating: show the Read on
    // Kindle link only when the family library has a non-deleted
    // PhysicalCopy of this book. Trophy-only books get nothing.
    // Completion check is implicit here — /found is a "do we own
    // this print?" lookup, so showing a Kindle link on a known-
    // owned book is exactly the right behaviour.
    const ownedOrRead = book.physicalCopies.length > 0;
    const description =
      `by ${book.authors.join(", ") || "Unknown"}` +
      (ownedOrRead && book.kindleAsin
        ? `\n📖 [Read on Kindle](https://read.amazon.com/kp/kshare?asin=${encodeURIComponent(book.kindleAsin)})`
        : "");
    const embed = new EmbedBuilder()
      .setTitle(book.title)
      .setDescription(description);
    if (book.thumbnailUrl) embed.setThumbnail(book.thumbnailUrl);

    if (book.physicalCopies.length > 0) {
      const lines = book.physicalCopies.map((c) => {
        const shelves = c.shelves.map((s) => s.shelf.name).join(", ");
        const where = shelves ? ` · 📍 ${shelves}` : "";
        return `• ${c.edition || "edition?"} · added by ${c.addedBy.displayName}${where}`;
      });
      embed.addFields({
        name: `✅ Owned (${book.physicalCopies.length} copy)`,
        value: lines.join("\n").slice(0, 1024),
      });
    }

    if (book.trophies.length > 0) {
      const t = book.trophies[0];
      embed.addFields({
        name: "🏆 On the trophy list",
        value: `Requested by **${t.requestedBy.displayName}**${t.reason ? ` — ${t.reason}` : ""}`,
      });
    }

    if (book.physicalCopies.length === 0 && book.trophies.length === 0) {
      embed.addFields({
        name: "Status",
        value: "Known to the catalog but no physical copy or trophy entry.",
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
