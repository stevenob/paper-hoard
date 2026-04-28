import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type { BotCommand } from "./index.js";
import { prisma } from "../../shared/db.js";
import { upsertLibrary } from "../../shared/repo.js";

export const libraryCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("library")
    .setDescription("Search or list the shared family library")
    .addStringOption((o) =>
      o.setName("query").setDescription("Optional title/author search").setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Smaug only works inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString("query")?.trim();
    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);

    const copies = await prisma.physicalCopy.findMany({
      where: {
        libraryId: library.id,
        deletedAt: null,
        ...(query
          ? {
              book: {
                OR: [
                  { title: { contains: query, mode: "insensitive" } },
                  { authors: { has: query } },
                ],
              },
            }
          : {}),
      },
      include: { book: true, addedBy: true },
      orderBy: { addedAt: "desc" },
      take: 20,
    });

    if (copies.length === 0) {
      await interaction.reply({
        content: query
          ? `No matches for "${query}" in ${library.name}.`
          : `${library.name} is empty. Add books with /scan.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(query ? `Library results for "${query}"` : `${library.name} — recent additions`)
      .setDescription(
        copies
          .map((c, i) => {
            const authors = c.book.authors.join(", ") || "Unknown";
            return `**${i + 1}. ${c.book.title}** — ${authors}\n  added by ${c.addedBy.displayName}`;
          })
          .join("\n")
      )
      .setFooter({ text: `Showing ${copies.length} of ${copies.length} (max 20)` });

    await interaction.reply({ embeds: [embed] });
  },
};
