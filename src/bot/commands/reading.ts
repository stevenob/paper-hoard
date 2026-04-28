import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type { BotCommand } from "./index.js";
import { prisma } from "../../shared/db.js";
import { upsertLibrary } from "../../shared/repo.js";

export const readingCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("reading")
    .setDescription("Show what the household is currently reading"),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Smaug only works inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);
    const active = await prisma.reading.findMany({
      where: { libraryId: library.id, finishedAt: null },
      include: { user: true, copy: { include: { book: true } } },
      orderBy: { startedAt: "desc" },
      take: 25,
    });

    if (active.length === 0) {
      await interaction.reply({
        content: `Nobody in ${library.name} is mid-book right now.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📖 Currently reading in ${library.name}`)
      .setDescription(
        active
          .map((r) => {
            const authors = r.copy.book.authors.join(", ") || "Unknown";
            const days = Math.max(
              1,
              Math.round((Date.now() - r.startedAt.getTime()) / (24 * 60 * 60 * 1000))
            );
            return `**${r.user.displayName}** — *${r.copy.book.title}* by ${authors} _(day ${days})_`;
          })
          .join("\n")
      );
    await interaction.reply({ embeds: [embed] });
  },
};
