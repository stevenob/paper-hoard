import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export interface BotCommand {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  handleButton?(interaction: ButtonInteraction): Promise<void>;
  handleModal?(interaction: ModalSubmitInteraction): Promise<void>;
}

import { scanCommand } from "./scan.js";
import { libraryCommand } from "./library.js";
import { trophiesCommand } from "./trophies.js";

export const commandList: BotCommand[] = [scanCommand, libraryCommand, trophiesCommand];

export const commands = new Map<string, BotCommand>(
  commandList.map((c) => [c.data.name, c])
);
