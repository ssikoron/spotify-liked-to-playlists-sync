import "dotenv/config";
import { promises as fs } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import {
  iterateSavedTracks,
  getSeveralArtists,
  addTracksToPlaylistIfMissing,
  initSpotify,
} from "./spotify";
import { readState, writeState } from "./state";
import {
  buildPlaylistGenreProfile,
  pickPlaylistsWithinDelta,
  scoreTrackAgainstProfile,
} from "./genreRouter";

// Rebluild genre profiles every 24 hours by default
const REBUILD_GENRE_PROFILE_INTERVAL = process.env
  .REBUILD_GENRE_PROFILE_INTERVAL
  ? parseInt(process.env.REBUILD_GENRE_PROFILE_INTERVAL)
  : 24;

// MATCH_SCORE_DELTA will be read from config.json (key: matchScoreDelta) by
// getTargetPlaylistIdsFromConfig(). If missing, default to 0.
// (We intentionally do not read MATCH_SCORE_DELTA from env anymore.)

const CONFIG_PATH = process.env.SPOTIFY_CONFIG_PATH
  || process.env.CONFIG_PATH
  || "/etc/spotify-liked-to-playlists-sync/config.json";

const CONFIG_DIR = path.dirname(CONFIG_PATH);
const DATA_DIR = process.env.DATA_DIR || path.join(CONFIG_DIR, ".data");

const SPOTIFY_LOG_PATH = process.env.SPOTIFY_LOG_PATH
  || path.join(DATA_DIR, "spotify-liked-to-playlists-sync.jsonl");

await fs.mkdir(DATA_DIR, { recursive: true });

function extractPlaylistId(raw: string): string | null {
  const s = raw.trim();

  // Case 1: spotify:playlist:<id>
  const colon = s.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (colon) return colon[1];

  // Case 2: https://open.spotify.com/playlist/<id>?...
  const url = s.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (url) return url[1];

  // Case 3: bare id (possibly with ?something)
  const bare = s.split("?")[0];
  if (/^[a-zA-Z0-9]+$/.test(bare)) return bare;

  return null;
}

async function getTargetPlaylistIdsFromConfig(): Promise<{playlistIds: string[]; matchScoreDelta?: number}> {
  const configPath = path.resolve(CONFIG_PATH);
  try {
    const buf = await fs.readFile(configPath, "utf8");
    const cfg = JSON.parse(buf);

    const rawList: unknown = cfg?.targetPlaylists ?? cfg?.playlists;
    if (!Array.isArray(rawList)) {
      throw new Error(
        `config.json must contain array property targetPlaylists (or playlists)`,
      );
    }
    const out: string[] = [];
    for (const v of rawList) {
      if (typeof v !== "string") continue;
      const id = extractPlaylistId(v);
      if (id) out.push(id);
      else console.warn("Skipping unrecognized playlist value:", v);
    }

    // Read matchScoreDelta from config.json if provided. Supported formats:
    //  - number (e.g. 0.05 for 5% as fraction, or 5 for 5%)
    //  - string (e.g. "0.05", "5", or "5%")
    // Interpretation in pickPlaylistsWithinDelta:
    //  - value in (0,1] is treated as fraction (0.05 -> 5%)
    //  - value > 1 is treated as percentage (5 -> 5%)
    let matchScoreDelta: number | undefined = undefined;
    if (cfg && typeof cfg.matchScoreDelta !== 'undefined') {
      const raw = cfg.matchScoreDelta;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        matchScoreDelta = Math.max(0, raw);
      } else if (typeof raw === 'string') {
        const s = raw.trim();
        if (s.endsWith('%')) {
          const num = parseFloat(s.slice(0, -1));
          if (!Number.isNaN(num)) matchScoreDelta = Math.max(0, num);
        } else if (s !== '') {
          const num = parseFloat(s);
          if (!Number.isNaN(num)) matchScoreDelta = Math.max(0, num);
        }
      }
    }

    return { playlistIds: Array.from(new Set(out)), matchScoreDelta };
  } catch (e: any) {
    throw new Error(
      `Failed to read playlists from config.json at ${configPath}: ${e?.message ?? e}`,
    );
  }
}

/**
 * Check if a playlist's genre profile should be rebuilt based on the last rebuild time
 * and the configured rebuild interval
 */
function shouldRebuildProfile(lastRebuildTime: string | undefined): boolean {
  if (!lastRebuildTime) return true;

  const now = new Date();
  const lastRebuild = new Date(lastRebuildTime);
  const hoursSinceLastRebuild =
    (now.getTime() - lastRebuild.getTime()) / (1000 * 60 * 60);

  return hoursSinceLastRebuild >= REBUILD_GENRE_PROFILE_INTERVAL;
}

async function main() {
  await initSpotify();
  const state = await readState();
  if (!state.lastProfileRebuildTime) {
    state.lastProfileRebuildTime = {};
  }

  // First run: set watermark to now and exit without modifying playlists
  if (!state.lastProcessedAddedAt) {
    const nowIso = new Date().toISOString();
    await writeState({
      lastProcessedAddedAt: nowIso,
      lastProfileRebuildTime: state.lastProfileRebuildTime,
    });
    console.log(
      `Initialized watermark to ${nowIso}. No existing likes will be processed.`,
    );
    return;
  }

  const { playlistIds: targetPlaylists, matchScoreDelta } = await getTargetPlaylistIdsFromConfig();
  const MATCH_SCORE_DELTA = typeof matchScoreDelta === 'number' ? matchScoreDelta : 0;

  if (targetPlaylists.length === 0) {
    throw new Error(
      "Provide at least one playlist in config.json under targetPlaylists.",
    );
  }

  console.log("Target playlists:", targetPlaylists.join(", "));

  // Build genre profiles for each target playlist only if needed
  const profiles: Record<string, Map<string, number>> = {};
  const updatedLastProfileRebuildTime = { ...state.lastProfileRebuildTime };

  for (const pid of targetPlaylists) {
    const lastRebuildTime = state.lastProfileRebuildTime?.[pid];
    const needsRebuild = shouldRebuildProfile(lastRebuildTime);

    if (needsRebuild) {
      console.log(
        `Building genre profile for ${pid} (last rebuilt: ${lastRebuildTime || "never"}) ...`,
      );
      profiles[pid] = await buildPlaylistGenreProfile(pid);
      console.log("Profile genres count:", profiles[pid].size);

      updatedLastProfileRebuildTime[pid] = new Date().toISOString();
    } else {
      console.log(
        `Using cached genre profile for ${pid} (last rebuilt: ${lastRebuildTime}, interval: ${REBUILD_GENRE_PROFILE_INTERVAL}h)`,
      );
      profiles[pid] = await buildPlaylistGenreProfile(pid);
    }
  }

  const newTrackIdsByPlaylist: Record<string, string[]> = {};
  const trackMeta = new Map<string, { name: string; artists: string[] }>();
  let newestAddedAt: string | undefined = state.lastProcessedAddedAt;

  for await (const item of iterateSavedTracks()) {
    const addedAt = item.added_at;

    if (!newestAddedAt || addedAt > newestAddedAt) newestAddedAt = addedAt;

    if (state.lastProcessedAddedAt && addedAt <= state.lastProcessedAddedAt)
      break;

    const track = item.track;
    trackMeta.set(track.id, {
      name: track.name,
      artists: track.artists.map(a => a.name).filter(Boolean),
    });
    const artistIds = track.artists.map((a) => a.id).filter(Boolean);
    const genres = new Set<string>();
    for (let i = 0; i < artistIds.length; i += 50) {
      const res = await getSeveralArtists(artistIds.slice(i, i + 50));
      for (const artist of res.body.artists ?? []) {
        for (const g of artist.genres ?? []) genres.add(g);
      }
    }
    const trackGenres = [...genres];

    // Debugging stuff
    const scores = Object.entries(profiles)
      .map(([pid, prof]) => {
        return [pid, scoreTrackAgainstProfile(trackGenres, prof)] as const;
      })
      .sort((a, b) => b[1] - a[1]);

    const bestPid = scores[0]?.[0] ?? targetPlaylists[0];
    const bestScore = scores[0]?.[1] ?? 0;

    // If the best score is 0, there's no meaningful match — do not add the track
    // to any playlist regardless of matchScoreDelta.
    if (bestScore === 0) {
      console.log(`Skipping "${track.name}" - no profile match (bestScore=0).`);
      await appendFile(
        SPOTIFY_LOG_PATH,
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "route",
          trackId: track.id,
          trackName: track.name,
          artists: trackMeta.get(track.id)?.artists || [],
          playlistIds: [],
          genres: trackGenres,
          reason: "no_profile_match",
        }) + "\n",
      );
      continue;
    }

    // Debugging: Log top 5 genres and per-playlist scores
    const topGenres = trackGenres.slice(0, 5).join(", ") || "n/a";
    console.log(
      `Scores => ${scores.map(([pid, s]) => `${pid}:${s}`).join(" | ")}`,
    );
    console.log(`Top genres: ${topGenres}`);

    const matched = pickPlaylistsWithinDelta(trackGenres, profiles, MATCH_SCORE_DELTA);
    const matchedPids = matched.length > 0 ? matched : [bestPid];

    for (const pid of matchedPids) {
      (newTrackIdsByPlaylist[pid] ??= []).push(track.id);
    }

    await appendFile(
      SPOTIFY_LOG_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "route",
        trackId: track.id,
        trackName: track.name,
        artists: trackMeta.get(track.id)?.artists || [],
        playlistIds: matchedPids,
        genres: trackGenres,
      }) + "\n",
    );

    console.log(
      `Route "${track.name}" -> ${matchedPids.join(",")} (genres: ${trackGenres.join(", ") || "n/a"})`,
    );
  }

  for (const [pid, ids] of Object.entries(newTrackIdsByPlaylist)) {
    if (!ids.length) continue;
    console.log(`Considering ${ids.length} tracks for ${pid} …`);
    const res = await addTracksToPlaylistIfMissing(pid, ids);

    await appendFile(
      SPOTIFY_LOG_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "add_batch",
        playlistId: pid,
        attempted: ids.length,
        added: res?.added ?? null,
        skipped: res?.skipped ?? null,
        ids,
      }) + "\n",
    );

    for (const id of res.addedIds || []) {
      const meta = trackMeta.get(id);
      await appendFile(
        SPOTIFY_LOG_PATH,
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "added",
          playlistId: pid,
          trackId: id,
          trackName: meta?.name || null,
          artists: meta?.artists || [],
        }) + "\n",
      );
    }
  }

  const updatedState = { ...state };

  if (newestAddedAt && newestAddedAt > state.lastProcessedAddedAt) {
    updatedState.lastProcessedAddedAt = newestAddedAt;
    console.log("Updated lastProcessedAddedAt ->", newestAddedAt);
  }

  updatedState.lastProfileRebuildTime = updatedLastProfileRebuildTime;

  await writeState(updatedState);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
