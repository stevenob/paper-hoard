import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import type { BotCommand } from "./index.js";
import { prisma } from "../../shared/db.js";
import { CONDITIONS, EDITIONS } from "../../shared/picklists.js";
import {
  createPhysicalCopy,
  deleteTrophyIfExists,
  ensureMembership,
  lookupBook,
  upsertBookFromMetadata,
  upsertLibrary,
  upsertUser,
} from "../../shared/repo.js";
import { isStale, refreshOpenLibraryRatings } from "../../shared/openlibrary-ratings.js";

const NAME = "scan";

function bookEmbed(opts: {
  title: string;
  authors: string[];
  thumbnailUrl?: string | null;
  isbn13?: string | null;
  edition?: string | null;
  ratingAvg?: number | null;
  ratingCount?: number | null;
  source: string;
  libraryName: string;
}): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(opts.title)
    .setDescription(opts.authors.join(", ") || "Unknown author")
    .setFooter({ text: `${opts.libraryName} • source: ${opts.source}` });
  if (opts.thumbnailUrl) e.setThumbnail(opts.thumbnailUrl);
  if (opts.isbn13) e.addFields({ name: "ISBN", value: opts.isbn13, inline: true });
  if (opts.edition) e.addFields({ name: "Binding", value: opts.edition, inline: true });
  if (opts.ratingAvg != null && (opts.ratingCount ?? 0) > 0) {
    e.addFields({
      name: "Rating",
      value: `⭐ ${opts.ratingAvg.toFixed(2)} (${opts.ratingCount} on Open Library)`,
      inline: true,
    });
  }
  return e;
}

function detailButton(copyId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NAME}:detail:${copyId}`)
      .setLabel("Set condition / edition / location")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✏️")
  );
}

function trophyConfirmButtons(bookId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NAME}:trophy-acquire:${bookId}`)
      .setLabel("Acquire — add copy & remove trophy")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${NAME}:trophy-keep:${bookId}`)
      .setLabel("Add copy, keep trophy")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${NAME}:trophy-cancel:${bookId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  );
}

function chooseButtons(bookId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NAME}:add-library:${bookId}`)
      .setLabel("Add to library")
      .setStyle(ButtonStyle.Success)
      .setEmoji("📚"),
    new ButtonBuilder()
      .setCustomId(`${NAME}:add-trophy:${bookId}`)
      .setLabel("Add to trophy list")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🏆"),
    new ButtonBuilder()
      .setCustomId(`${NAME}:cancel:${bookId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

export const scanCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName(NAME)
    .setDescription("Look up a book and add it to the family library or trophy list")
    .addStringOption((o) =>
      o.setName("isbn").setDescription("ISBN-10 or ISBN-13").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("title").setDescription("Book title (used if ISBN not provided)").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("author").setDescription("Author (optional, narrows title search)").setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Smaug only works inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isbn = interaction.options.getString("isbn") ?? undefined;
    const title = interaction.options.getString("title") ?? undefined;
    const author = interaction.options.getString("author") ?? undefined;

    if (!isbn && !title) {
      await interaction.reply({
        content: "Provide either an ISBN or a title.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    const meta = await lookupBook({ isbn, title, author });
    if (!meta) {
      await interaction.editReply("No matching book found.");
      return;
    }

    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);
    const user = await upsertUser(
      interaction.user.id,
      interaction.user.globalName ?? interaction.user.username
    );
    await ensureMembership(user.id, library.id);
    const book = await upsertBookFromMetadata(meta);

    const [trophy, existing] = await Promise.all([
      prisma.trophy.findUnique({
        where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
        include: { requestedBy: true },
      }),
      prisma.physicalCopy.findMany({
        where: { libraryId: library.id, bookId: book.id, deletedAt: null },
        include: { addedBy: true },
        orderBy: { addedAt: "asc" },
        take: 5,
      }),
    ]);

    if (book.isbn13 && isStale(book.olFetchedAt)) {
      void refreshOpenLibraryRatings(book.id);
    }

    const embed = bookEmbed({
      title: meta.title,
      authors: meta.authors,
      thumbnailUrl: meta.thumbnailUrl,
      isbn13: meta.isbn13,
      edition: meta.edition ?? null,
      ratingAvg: book.olRatingAvg,
      ratingCount: book.olRatingCount,
      source: meta.source,
      libraryName: library.name,
    });

    if (existing.length > 0) {
      const lines = existing.map(
        (c) =>
          `• ${c.edition || "edition?"} · added by ${c.addedBy.displayName} on ${c.addedAt.toISOString().slice(0, 10)}`
      );
      embed.addFields({
        name: `⚠️ Already in your library (${existing.length})`,
        value: lines.join("\n"),
      });
    }

    if (trophy) {
      embed.addFields({
        name: "🏆 Trophy match",
        value: `Requested by **${trophy.requestedBy.displayName}**${trophy.reason ? ` — ${trophy.reason}` : ""}`,
      });
      await interaction.editReply({
        content: "This book is on the family Trophy List. What would you like to do?",
        embeds: [embed],
        components: [trophyConfirmButtons(book.id)],
      });
      return;
    }

    await interaction.editReply({
      content: "Add this to the family library, or save it to the trophy list to buy later?",
      embeds: [embed],
      components: [chooseButtons(book.id)],
    });
  },

  async handleButton(interaction: ButtonInteraction) {
    if (!interaction.guild) return;
    const [, action, id] = interaction.customId.split(":");

    if (action === "detail") {
      const copy = await prisma.physicalCopy.findUnique({ where: { id } });
      if (!copy) {
        await interaction.reply({ content: "That copy is gone.", flags: MessageFlags.Ephemeral });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`${NAME}:detail-modal:${id}`)
        .setTitle("Copy details")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("condition")
              .setLabel(`Condition (${CONDITIONS.join(", ")})`)
              .setRequired(false)
              .setStyle(TextInputStyle.Short)
              .setValue(copy.condition ?? "")
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("edition")
              .setLabel(`Edition (${EDITIONS.join(", ")})`)
              .setRequired(false)
              .setStyle(TextInputStyle.Short)
              .setValue(copy.edition ?? "")
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("notes")
              .setLabel("Notes")
              .setRequired(false)
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(2000)
              .setValue(copy.notes ?? "")
          )
        );
      await interaction.showModal(modal);
      return;
    }

    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);
    const user = await upsertUser(
      interaction.user.id,
      interaction.user.globalName ?? interaction.user.username
    );
    await ensureMembership(user.id, library.id);

    if (action === "cancel") {
      await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
      return;
    }

    if (action === "add-library") {
      const book = await prisma.book.findUnique({ where: { id } });
      if (!book) {
        await interaction.reply({ content: "Book is gone.", flags: MessageFlags.Ephemeral });
        return;
      }
      const copy = await createPhysicalCopy({
        libraryId: library.id,
        userId: user.id,
        bookId: book.id,
      });
      await interaction.update({
        content: "Added to the family library.",
        components: [detailButton(copy.id)],
      });
      return;
    }

    if (action === "add-trophy") {
      const book = await prisma.book.findUnique({ where: { id } });
      if (!book) {
        await interaction.reply({ content: "Book is gone.", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        await prisma.trophy.create({
          data: {
            libraryId: library.id,
            bookId: book.id,
            requestedByUserId: user.id,
            priority: 3,
          },
        });
      } catch {
        await interaction.update({
          content: "🏆 Already on the trophy list.",
          components: [],
        });
        return;
      }
      await interaction.update({
        content: "🏆 Added to the family trophy list. Edit details on the web UI.",
        components: [],
      });
      return;
    }

    if (action === "trophy-acquire" || action === "trophy-keep" || action === "trophy-cancel") {
      if (action === "trophy-cancel") {
        await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
        return;
      }
      const copy = await createPhysicalCopy({
        libraryId: library.id,
        userId: user.id,
        bookId: id,
      });
      let note = "Added to the family library.";
      if (action === "trophy-acquire") {
        await deleteTrophyIfExists(library.id, id);
        note = "🏆 Acquired! Added to the library and removed from the Trophy List.";
      }
      await interaction.update({
        content: note,
        components: [detailButton(copy.id)],
      });
      return;
    }
  },

  async handleModal(interaction: ModalSubmitInteraction) {
    const [, kind, copyId] = interaction.customId.split(":");
    if (kind !== "detail-modal" || !copyId) return;
    const condition = interaction.fields.getTextInputValue("condition")?.trim() || null;
    const edition = interaction.fields.getTextInputValue("edition")?.trim() || null;
    const notes = interaction.fields.getTextInputValue("notes")?.trim() || null;
    await prisma.physicalCopy.update({
      where: { id: copyId },
      data: { condition, edition, notes },
    });
    await interaction.reply({
      content: "Saved.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
