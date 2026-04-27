import { REST, Routes } from "discord.js";
import { requireDiscordEnv } from "../shared/env.js";
import { logger } from "../shared/logger.js";
import { commandList } from "./commands/index.js";

async function main() {
  const { token, clientId, guildIds } = requireDiscordEnv();
  const rest = new REST({ version: "10" }).setToken(token);
  const body = commandList.map((c) => c.data.toJSON());

  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      logger.info({ guildId, count: body.length }, "Registered guild commands");
    }
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    logger.info({ count: body.length }, "Registered global commands (may take ~1h to propagate)");
  }
}

main().catch((err) => {
  logger.error({ err }, "Failed to register commands");
  process.exit(1);
});
