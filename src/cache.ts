import { promises as fs } from "node:fs";
import path from "node:path";

// Allow overriding data directory via env var DATA_DIR
const DATA_DIR = path.resolve(process.env.DATA_DIR || ".data");
const CACHE_PATH = path.join(DATA_DIR, "playlistProfiles.json");

export type CachedProfile = {
  playlistId: string;
  snapshotId: string;
  tracksTotal: number;
  updatedAt: string;
  genres: Record<string, number>;
};

type CacheFile = { profiles: CachedProfile[] };

async function readFile(): Promise<CacheFile> {
  try {
    const buf = await fs.readFile(CACHE_PATH, "utf8");
    return JSON.parse(buf) as CacheFile;
  } catch {
    return { profiles: [] };
  }
}

async function writeFile(data: CacheFile) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(data, null, 2));
}

export async function getCachedProfile(playlistId: string, snapshotId: string) {
  const cache = await readFile();
  return (
    cache.profiles.find(
      (p) => p.playlistId === playlistId && p.snapshotId === snapshotId,
    ) ?? null
  );
}

export async function putCachedProfile(entry: CachedProfile) {
  const cache = await readFile();
  const idx = cache.profiles.findIndex(
    (p) =>
      p.playlistId === entry.playlistId && p.snapshotId === entry.snapshotId,
  );
  if (idx >= 0) cache.profiles[idx] = entry;
  else cache.profiles.push(entry);
  await writeFile(cache);
}
