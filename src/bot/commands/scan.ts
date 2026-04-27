import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type { BotCommand } from "./index.js";
import { prisma } from "../../shared/db.js";
import { lookupByIsbn, searchByTitle } from "../../shared/metadata.js";
import {
  ensureMembership,
  upsertBookFromMetadata,
  upsertLibrary,
  upsertUser,
} from "../../shared/repo.js";

export const scanCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("scan")
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

    const isbn = interaction.options.getString("isbn");
    const title = interaction.options.getString("title");
    const author = interaction.options.getString("author");

    if (!isbn && !title) {
      await interaction.reply({
        content: "Provide either an ISBN or a title.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    const meta = isbn
      ? await lookupByIsbn(isbn)
      : (await searchByTitle([title, author].filter(Boolean).join(" ")))[0];

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

    // Trophy match check before creating the copy.
    const trophy = await prisma.trophy.findUnique({
      where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
    });

    await prisma.physicalCopy.create({
      data: {
        bookId: book.id,
        libraryId: library.id,
        addedByUserId: user.id,
      },
    });

    if (trophy) {
      await prisma.trophy.delete({ where: { id: trophy.id } });
    }

    const embed = new EmbedBuilder()
      .setTitle(meta.title)
      .setDescription(meta.authors.join(", ") || "Unknown author")
      .setFooter({ text: `Added to ${library.name} • source: ${meta.source}` });
    if (meta.thumbnailUrl) embed.setThumbnail(meta.thumbnailUrl);
    if (meta.isbn13) embed.addFields({ name: "ISBN", value: meta.isbn13, inline: true });

    const note = trophy
      ? "🏆 Trophy match! Removed from the family Trophy List."
      : "Added to the family library.";

    await interaction.editReply({ content: note, embeds: [embed] });
  },
};
