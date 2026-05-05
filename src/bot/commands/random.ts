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
 * /random — pick a random book from the library. Useful when you can't
 * decide what to read tonight, or for the household to surface things
 * that have been on the shelf a while without being touched.
 */
export const randomCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("random")
    .setDescription("Pick a random book from the household library")
    .addStringOption((o) =>
      o
        .setName("shelf")
        .setDescription("Optional shelf slug to narrow the random pick")
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Smaug only works inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const shelfSlug = interaction.options.getString("shelf")?.trim().toLowerCase();
    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);

    // Sample-by-id: count first, pick a random offset, fetch one row.
    // Cheap on Postgres up to ~10k rows; we'll never approach that.
    const where: Record<string, unknown> = {
      libraryId: library.id,
      deletedAt: null,
    };
    if (shelfSlug) {
      where.shelves = { some: { shelf: { slug: shelfSlug } } };
    }
    const total = await prisma.physicalCopy.count({ where });
    if (total === 0) {
      await interaction.reply({
        content: shelfSlug
          ? `No books on shelf \`${shelfSlug}\`.`
          : `${library.name} is empty. Add some with /scan first.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const skip = Math.floor(Math.random() * total);
    const copy = await prisma.physicalCopy.findFirst({
      where,
      include: { book: true, shelves: { include: { shelf: true } } },
      skip,
    });
    if (!copy) {
      await interaction.reply({ content: "Couldn't pick — try again.", flags: MessageFlags.Ephemeral });
      return;
    }

    // /random is by definition operating on a PhysicalCopy — every
    // result is library-owned, so no separate ownership gate is
    // needed. Just append the Kindle link when the underlying Book
    // has an ASIN.
    const description =
      `by ${copy.book.authors.join(", ") || "Unknown"}` +
      (copy.book.kindleAsin
        ? `\n📖 [Read on Kindle](https://read.amazon.com/kp/kshare?asin=${encodeURIComponent(copy.book.kindleAsin)})`
        : "");
    const embed = new EmbedBuilder()
      .setTitle(copy.book.title)
      .setDescription(description);
    if (copy.book.thumbnailUrl) embed.setThumbnail(copy.book.thumbnailUrl);
    if (copy.book.seriesName) {
      embed.addFields({
        name: "Series",
        value: `${copy.book.seriesName}${
          copy.book.seriesPosition ? `, vol. ${copy.book.seriesPosition}` : ""
        }`,
      });
    }
    if (copy.shelves.length > 0) {
      embed.addFields({
        name: "Shelves",
        value: copy.shelves.map((s) => s.shelf.name).join(", "),
      });
    }
    embed.setFooter({
      text: shelfSlug ? `Random pick from /${shelfSlug}` : `1 of ${total}`,
    });

    await interaction.reply({ embeds: [embed] });
  },
};
