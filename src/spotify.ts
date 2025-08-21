import SpotifyWebApi from "spotify-web-api-node";
import { setTimeout as sleep } from "node:timers/promises";
import { getSpotifyConfig } from "./config";

let _spotifyInstance: SpotifyWebApi | null = null;

function getSpotify(): SpotifyWebApi {
  if (_spotifyInstance) return _spotifyInstance;
  throw new Error("Spotify API not initialized. Call initSpotify() first.");
}

export async function initSpotify() {
  const { clientId, clientSecret, refreshToken, redirectUri } =
    await getSpotifyConfig();
  _spotifyInstance = new SpotifyWebApi({
    clientId,
    clientSecret,
    redirectUri,
  });
  _spotifyInstance.setRefreshToken(refreshToken);
}

const spotify = {
  getAccessToken: () => getSpotify().getAccessToken(),
  setAccessToken: (t: string) => getSpotify().setAccessToken(t),
  refreshAccessToken: () => getSpotify().refreshAccessToken(),
  getMySavedTracks: (opts: any) => getSpotify().getMySavedTracks(opts),
  getPlaylistTracks: (id: string, opts: any) => getSpotify().getPlaylistTracks(id, opts),
  getArtists: (ids: string[]) => getSpotify().getArtists(ids),
  addTracksToPlaylist: (id: string, uris: string[]) => getSpotify().addTracksToPlaylist(id, uris),
  getPlaylist: (id: string, opts: any) => getSpotify().getPlaylist(id, opts),
};

async function ensureAccessToken() {
  const token = spotify.getAccessToken();
  if (token) return;
  const data = await spotify.refreshAccessToken();
  spotify.setAccessToken(data.body.access_token);
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  { tries = 5 }: { tries?: number } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await ensureAccessToken();
      return await fn();
    } catch (err: any) {
      const status = err?.statusCode ?? err?.status ?? 0;
      const headers = err?.headers ?? {};

      if (status === 401 && attempt < tries) {
        const data = await spotify.refreshAccessToken();
        spotify.setAccessToken(data.body.access_token);
        continue;
      }

      if (status === 429 && attempt < tries) {
        const retryAfterSec = Number(
          headers["retry-after"] ?? headers["Retry-After"] ?? 1,
        );
        await sleep(Math.max(1, retryAfterSec) * 1000);
        continue;
      }

      if (attempt < tries) {
        await sleep(500 * attempt);
        continue;
      }

      throw err;
    }
  }
}

export type SavedTrackItem = {
  added_at: string;
  track: SpotifyApi.TrackObjectFull;
};

export async function getSavedTracksPaginated(limit = 50, offset = 0) {
  return callWithRetry(
    () => spotify.getMySavedTracks({ limit, offset }),
  );
}


export async function* iterateSavedTracks() {
  const limit = 50;
  let offset = 0;
  while (true) {
    const res = await getSavedTracksPaginated(limit, offset);
    const items = res.body.items as SavedTrackItem[];
    if (!items.length) break;
    for (const it of items) yield it;
    offset += items.length;
    if (!res.body.next) break;
  }
}

export async function getPlaylistItemsPaginated(
  playlistId: string,
  limit = 50,
  offset = 0,
) {
  return callWithRetry(() =>
    spotify.getPlaylistTracks(playlistId, { limit, offset }),
  );
}

export async function* iteratePlaylistTracks(playlistId: string) {
  const limit = 50;
  let offset = 0;
  while (true) {
    const res = await getPlaylistItemsPaginated(playlistId, limit, offset);
    const items = res.body.items ?? [];
    if (!items.length) break;
    for (const it of items) {
      const track = (it as SpotifyApi.PlaylistTrackObject).track; // because it can also be a podcast?
      if (track && track.type === "track")
        yield track as SpotifyApi.TrackObjectFull;
    }
    offset += items.length;
    if (!res.body.next) break;
  }
}

export async function getSeveralArtists(ids: string[]) {
  return callWithRetry(() => spotify.getArtists(ids));
}

export function toTrackUri(id: string) {
  return `spotify:track:${id}`;
}

export async function getPlaylistTrackIdsSet(
  playlistId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const track of iteratePlaylistTracks(playlistId)) {
    if (track.id) ids.add(track.id);
  }
  return ids;
}

export async function addTracksToPlaylistIfMissing(
  playlistId: string,
  trackIds: string[],
) {
  const existing = await getPlaylistTrackIdsSet(playlistId);
  const toAdd = trackIds.filter((id) => !existing.has(id));

  if (toAdd.length === 0) {
    return { added: 0, skipped: trackIds.length };
  }

  for (let i = 0; i < toAdd.length; i += 100) {
    const slice = toAdd.slice(i, i + 100).map(toTrackUri);
    await callWithRetry(() => spotify.addTracksToPlaylist(playlistId, slice));
  }

  return {
    added: toAdd.length,
    skipped: trackIds.length - toAdd.length
  };
}

export async function getPlaylistSnapshot(playlistId: string) {
  const res = await callWithRetry(() =>
    spotify.getPlaylist(playlistId, { fields: "snapshot_id,tracks.total" }),
  );

  return {
    snapshotId: (res.body as any).snapshot_id as string,
    tracksTotal: (res.body as any).tracks?.total as number,
  };
}
