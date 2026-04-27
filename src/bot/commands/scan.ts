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

const NAME = "scan";

function bookEmbed(opts: {
  title: string;
  authors: string[];
  thumbnailUrl?: string | null;
  isbn13?: string | null;
  source: string;
  libraryName: string;
  trophy?: boolean;
}): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(opts.title)
    .setDescription(opts.authors.join(", ") || "Unknown author")
    .setFooter({ text: `${opts.libraryName} • source: ${opts.source}` });
  if (opts.thumbnailUrl) e.setThumbnail(opts.thumbnailUrl);
  if (opts.isbn13) e.addFields({ name: "ISBN", value: opts.isbn13, inline: true });
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

export const scanCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName(NAME)
    .setDescription("Add a physical book to the shared family library")
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

    const trophy = await prisma.trophy.findUnique({
      where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
      include: { requestedBy: true },
    });

    const embed = bookEmbed({
      title: meta.title,
      authors: meta.authors,
      thumbnailUrl: meta.thumbnailUrl,
      isbn13: meta.isbn13,
      source: meta.source,
      libraryName: library.name,
      trophy: Boolean(trophy),
    });

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

    // Dedupe check: if the library already has a copy of this book, surface
    // it in the embed so the user knows before adding another.
    const existing = await prisma.physicalCopy.findMany({
      where: { libraryId: library.id, bookId: book.id },
      include: { addedBy: true },
      orderBy: { addedAt: "asc" },
      take: 5,
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

    // No trophy — commit immediately and offer the detail editor.
    const copy = await createPhysicalCopy({
      libraryId: library.id,
      userId: user.id,
      bookId: book.id,
    });
    await interaction.editReply({
      content: "Added to the family library.",
      embeds: [embed],
      components: [detailButton(copy.id)],
    });
  },

  async handleButton(interaction: ButtonInteraction) {
    if (!interaction.guild) return;
    const [, action, id] = interaction.customId.split(":");

    if (action === "detail") {
      const copyId = id;
      const copy = await prisma.physicalCopy.findUnique({ where: { id: copyId } });
      if (!copy) {
        await interaction.reply({ content: "That copy is gone.", flags: MessageFlags.Ephemeral });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`${NAME}:detail-modal:${copyId}`)
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
              .setCustomId("location")
              .setLabel("Location (e.g. Living room shelf)")
              .setRequired(false)
              .setStyle(TextInputStyle.Short)
              .setMaxLength(200)
              .setValue(copy.location ?? "")
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

    if (action === "trophy-acquire" || action === "trophy-keep" || action === "trophy-cancel") {
      const bookId = id;
      const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);
      const user = await upsertUser(
        interaction.user.id,
        interaction.user.globalName ?? interaction.user.username
      );
      await ensureMembership(user.id, library.id);

      if (action === "trophy-cancel") {
        await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
        return;
      }

      const copy = await createPhysicalCopy({
        libraryId: library.id,
        userId: user.id,
        bookId,
      });
      let note = "Added to the family library.";
      if (action === "trophy-acquire") {
        await deleteTrophyIfExists(library.id, bookId);
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
    const location = interaction.fields.getTextInputValue("location")?.trim() || null;
    const notes = interaction.fields.getTextInputValue("notes")?.trim() || null;
    await prisma.physicalCopy.update({
      where: { id: copyId },
      data: { condition, edition, location, notes },
    });
    await interaction.reply({
      content: "Saved.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
