import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import type { BotCommand } from "./index.js";
import { prisma } from "../../shared/db.js";
import { upsertLibrary } from "../../shared/repo.js";

const NAME = "trophies";

export const trophiesCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName(NAME)
    .setDescription("List shared Trophy items and remove them"),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Smaug only works inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const library = await upsertLibrary(interaction.guild.id, interaction.guild.name);
    const trophies = await prisma.trophy.findMany({
      where: { libraryId: library.id },
      include: { book: true, requestedBy: true },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: 5,
    });

    if (trophies.length === 0) {
      await interaction.reply({
        content: `No Trophy items in ${library.name}. Add some from the web UI.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Trophy List — ${library.name}`)
      .setDescription(
        trophies
          .map((t, i) => {
            const authors = t.book.authors.join(", ") || "Unknown";
            return `**${i + 1}. ${t.book.title}** — ${authors}\n  requested by ${t.requestedBy.displayName} • priority ${t.priority}`;
          })
          .join("\n")
      );

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let row = new ActionRowBuilder<ButtonBuilder>();
    trophies.forEach((t, i) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${NAME}:remove:${t.id}`)
          .setLabel(`Remove #${i + 1}`)
          .setStyle(ButtonStyle.Danger)
      );
      if (row.components.length === 5) {
        rows.push(row);
        row = new ActionRowBuilder<ButtonBuilder>();
      }
    });
    if (row.components.length > 0) rows.push(row);

    await interaction.reply({ embeds: [embed], components: rows });
  },

  async handleButton(interaction: ButtonInteraction) {
    const [, action, id] = interaction.customId.split(":");
    if (action !== "remove" || !id) return;

    const trophy = await prisma.trophy.findUnique({
      where: { id },
      include: { book: true },
    });
    if (!trophy) {
      await interaction.reply({
        content: "That Trophy item is already gone.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await prisma.trophy.delete({ where: { id } });
    await interaction.reply({
      content: `Removed **${trophy.book.title}** from the Trophy List.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
