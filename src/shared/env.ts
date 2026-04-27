import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_IDS: z.string().optional(),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  COOKIE_SECRET: z.string().min(8).default("dev-cookie-secret-change-me"),
  GOOGLE_BOOKS_API_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);

export function requireDiscordEnv(): { token: string; clientId: string; guildIds: string[] } {
  if (!env.DISCORD_TOKEN || !env.DISCORD_CLIENT_ID) {
    throw new Error(
      "DISCORD_TOKEN and DISCORD_CLIENT_ID must be set. Copy .env.example to .env and fill them in."
    );
  }
  return {
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildIds: (env.DISCORD_GUILD_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
