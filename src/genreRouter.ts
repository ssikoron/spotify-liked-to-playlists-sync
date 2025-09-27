/**
 * Creates playlist profiles and assigns a track to a particular playlist
 */
import {
  iteratePlaylistTracks,
  getSeveralArtists,
  getPlaylistSnapshot,
} from "./spotify";
import { getCachedProfile, putCachedProfile } from "./cache";

export type GenreProfile = Map<string, number>;

export async function buildPlaylistGenreProfile(
  playlistId: string,
): Promise<GenreProfile> {
  const { snapshotId, tracksTotal } = await getPlaylistSnapshot(playlistId);
  const cached = await getCachedProfile(playlistId, snapshotId);
  if (cached) {
    return new Map<string, number>(Object.entries(cached.genres));
  }
  const counts: GenreProfile = new Map();

  const artistIds = new Set<string>();
  for await (const track of iteratePlaylistTracks(playlistId)) {
    for (const a of track.artists) artistIds.add(a.id);
  }
  const ids = [...artistIds].filter(Boolean);

  for (let i = 0; i < ids.length; i += 50) {
    const res = await getSeveralArtists(ids.slice(i, i + 50));
    for (const artist of res.body.artists ?? []) {
      for (const g of artist.genres ?? []) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
  }

  await putCachedProfile({
    playlistId,
    snapshotId,
    tracksTotal: tracksTotal ?? ids.length,
    updatedAt: new Date().toISOString(),
    genres: Object.fromEntries(counts.entries()),
  });

  return counts;
}

export function scoreTrackAgainstProfile(
  trackGenres: string[],
  profile: GenreProfile,
): number {
  let score = 0;
  for (const g of trackGenres) {
    score += profile.get(g) ?? 0;
  }
  return score;
}

export function pickBestPlaylist(
  trackGenres: string[],
  profiles: Record<string, GenreProfile>,
): string | null {
  let bestId: string | null = null;
  let bestScore = -1;

  for (const [pid, prof] of Object.entries(profiles)) {
    const s = scoreTrackAgainstProfile(trackGenres, prof);
    if (s > bestScore) {
      bestScore = s;
      bestId = pid;
    }
  }

  return bestId;
}

/**
 * Pick all playlists whose score is within `delta` (inclusive) of the best score.
 *
 * - trackGenres: array of genres for the track
 * - profiles: map of playlistId -> GenreProfile
 * - delta: non-negative integer. If 0 behaves like pickBestPlaylist (single best).
 *
 * Returns an array of playlist ids (may be empty if profiles is empty).
 */
export function pickPlaylistsWithinDelta(
  trackGenres: string[],
  profiles: Record<string, GenreProfile>,
  delta = 0,
): string[] {
  const scores: Array<[string, number]> = [];

  for (const [pid, prof] of Object.entries(profiles)) {
    const s = scoreTrackAgainstProfile(trackGenres, prof);
    scores.push([pid, s]);
  }

  if (scores.length === 0) return [];

  scores.sort((a, b) => b[1] - a[1]);
  const bestScore = scores[0][1];

  // Interpret `delta` as a relative value. Two forms are supported:
  //  - If delta is in (0, 1], treat it as a fraction (e.g. 0.1 => 10%).
  //  - If delta is > 1, treat it as percentage (e.g. 10 => 10%).
  // If delta is 0, only the best playlist is returned.
  const rel = delta <= 0 ? 0 : (delta <= 1 ? delta : delta / 100);

  if (rel === 0) {
    // only the top playlist
    return [scores[0][0]];
  }

  const threshold = bestScore * (1 - rel);

  // Include any playlist with score >= threshold (inclusive)
  return scores.filter(([, s]) => s >= threshold).map(([pid]) => pid);
}
