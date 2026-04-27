import {
  Client,
  GatewayIntentBits,
  Events,
  Interaction,
  MessageFlags,
  type InteractionReplyOptions,
} from "discord.js";
import { env, requireDiscordEnv } from "../shared/env.js";
import { logger } from "../shared/logger.js";
import { commands } from "./commands/index.js";

async function main() {
  const { token } = requireDiscordEnv();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag }, "Smaug is awake");
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (!cmd) return;
      try {
        await cmd.execute(interaction);
      } catch (err) {
        logger.error({ err, cmd: interaction.commandName }, "command failed");
        const payload: InteractionReplyOptions = {
          content: "Something went wrong handling that command.",
          flags: MessageFlags.Ephemeral,
        };
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload).catch(() => undefined);
        } else {
          await interaction.reply(payload).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isButton()) {
      const handler = commands.get(interaction.customId.split(":")[0]);
      if (handler?.handleButton) {
        try {
          await handler.handleButton(interaction);
        } catch (err) {
          logger.error({ err }, "button handler failed");
        }
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      const handler = commands.get(interaction.customId.split(":")[0]);
      if (handler?.handleModal) {
        try {
          await handler.handleModal(interaction);
        } catch (err) {
          logger.error({ err }, "modal handler failed");
        }
      }
    }
  });

  await client.login(token);
}

main().catch((err) => {
  logger.error({ err }, "Smaug failed to start");
  process.exit(1);
});

// Silence unused export warnings in production
void env;
