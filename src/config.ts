import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";

export type AppConfig = {
  targetPlaylists?: unknown;
  playlists?: unknown; // legacy alias supported in index.ts
  spotify?: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    redirectUri?: string; // optional, default provided
  };
};

// Allow overriding config.json location via env var CONFIG_PATH
const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || "config.json");
const DOTENV_PATH = path.resolve(".env");

async function migrateFromDotEnvIfPossible(): Promise<AppConfig | null> {
  try {
    const rawEnv = await fs.readFile(DOTENV_PATH, "utf8");
    const env = parseDotenv(rawEnv);

    const spotify: AppConfig["spotify"] = {};
    if (env.SPOTIFY_CLIENT_ID) spotify.clientId = env.SPOTIFY_CLIENT_ID;
    if (env.SPOTIFY_CLIENT_SECRET) spotify.clientSecret = env.SPOTIFY_CLIENT_SECRET;
    if (env.SPOTIFY_REFRESH_TOKEN) spotify.refreshToken = env.SPOTIFY_REFRESH_TOKEN;
    if (env.SPOTIFY_REDIRECT_URI) spotify.redirectUri = env.SPOTIFY_REDIRECT_URI;

    const playlists: string[] = [];
    if (env.TARGET_PLAYLIST_IDS) {
      for (const part of env.TARGET_PLAYLIST_IDS.split(",")) {
        const v = part.trim();
        if (v) playlists.push(v);
      }
    }
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("TARGET_PLAYLIST_ID_")) {
        const s = (v ?? "").toString().trim();
        if (s) playlists.push(s);
      }
    }

    const cfg: AppConfig = {};
    if (Object.keys(spotify).length > 0) cfg.spotify = spotify;
    if (playlists.length > 0) cfg.targetPlaylists = playlists;

    // If nothing meaningful found, do not create config.json
    if (!cfg.spotify && !cfg.targetPlaylists) return null;

    // Ensure parent directory exists before writing custom path
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`Created ${CONFIG_PATH} from existing .env values.`);
    return cfg;
  } catch (e: any) {
    // .env missing or unreadable; ignore
    return null;
  }
}

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return cfg ?? {};
  } catch (e: any) {
    if (e && (e.code === "ENOENT" || e.message?.includes("ENOENT"))) {
      const migrated = await migrateFromDotEnvIfPossible();
      if (migrated) return migrated;
    }
    throw new Error(
      `Failed to read config.json at ${CONFIG_PATH}: ${e?.message ?? e}`,
    );
  }
}

export type SpotifyConfig = Required<
  Required<AppConfig>["spotify"]
>;

export async function getSpotifyConfig(): Promise<SpotifyConfig> {
  const cfg = await readConfig();
  const s = cfg.spotify ?? {};
  const clientId = s.clientId?.trim();
  const clientSecret = s.clientSecret?.trim();
  const refreshToken = s.refreshToken?.trim();
  const redirectUri = (s.redirectUri?.trim() || "http://localhost:3000/callback");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing spotify.clientId or spotify.clientSecret in config.json",
    );
  }
  if (!refreshToken) {
    // For flows that need a refresh token (main app), we require it
    // The auth script will guide to obtain it and will write it back
    throw new Error(
      "Missing spotify.refreshToken in config.json. Run `pnpm auth` to obtain and save it.",
    );
  }

  return { clientId, clientSecret, refreshToken, redirectUri };
}

export async function getSpotifyConfigForAuth(): Promise<
  Omit<SpotifyConfig, "refreshToken">
> {
  const cfg = await readConfig();
  const s = cfg.spotify ?? {};
  const clientId = s.clientId?.trim();
  const clientSecret = s.clientSecret?.trim();
  const redirectUri = (s.redirectUri?.trim() || "http://localhost:3000/callback");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing spotify.clientId or spotify.clientSecret in config.json",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

export async function saveSpotifyRefreshToken(refreshToken: string): Promise<void> {
  const cfg = await readConfig().catch(() => ({} as AppConfig));
  const existing = cfg.spotify ?? {};
  const updated: AppConfig = {
    ...cfg,
    spotify: {
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
      redirectUri: existing.redirectUri ?? "http://localhost:3000/callback",
      refreshToken,
    },
  };
  // Ensure parent directory exists before writing
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2));
  console.log(`Saved refresh token to ${CONFIG_PATH} under spotify.refreshToken`);
}
