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
    const counts = new Map<string, number>(Object.entries(cached.genres));
    return counts;
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
