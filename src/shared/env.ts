import "dotenv/config";
import { z } from "zod";

const optionalString = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const optionalUrl = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

const schema = z.object({
  DATABASE_URL: z.string().url(),
  DISCORD_TOKEN: optionalString(),
  DISCORD_CLIENT_ID: optionalString(),
  DISCORD_CLIENT_SECRET: optionalString(),
  DISCORD_GUILD_IDS: optionalString(),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  WEB_BASE_URL: optionalUrl(),
  COOKIE_SECRET: z.string().min(8).default("dev-cookie-secret-change-me"),
  GOOGLE_BOOKS_API_KEY: optionalString(),
  UPLOADS_DIR: z.string().default("./data/uploads"),
  BACKUPS_DIR: z.string().default("./data/backups"),
  GIT_SHA: z.string().default("dev"),
  IMAGE_TAG: z.string().default("dev"),
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

export interface OAuthEnv {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  allowedGuildIds: string[];
}

export function getOAuthEnv(): OAuthEnv | null {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.WEB_BASE_URL) {
    return null;
  }
  return {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    baseUrl: env.WEB_BASE_URL.replace(/\/$/, ""),
    allowedGuildIds: (env.DISCORD_GUILD_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
