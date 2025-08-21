/**
 * Helper for retrieving access and refresh tokens from Spotify
 */
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";
import SpotifyWebApi from "spotify-web-api-node";
import { getSpotifyConfigForAuth, saveSpotifyRefreshToken } from "./config";

const scopes = [
  "user-library-read",
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
];

const { clientId, clientSecret, redirectUri } = await getSpotifyConfigForAuth();

const spotify = new SpotifyWebApi({
  clientId,
  clientSecret,
  redirectUri,
});

const state = crypto.randomBytes(16).toString("hex");
const authUrl = spotify.createAuthorizeURL(scopes, state);

console.log("\nOpen this URL in your browser to authorize:\n");
console.log(authUrl, "\n");

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) return;
    const url = new URL(req.url, redirectUri);

    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) throw new Error(`Spotify error: ${error}`);
    if (!code) throw new Error("Missing code param");
    if (returnedState !== state) throw new Error("State mismatch");

    const data = await spotify.authorizationCodeGrant(code);

    const accessToken = data.body.access_token;
    const refreshToken = data.body.refresh_token;
    const expiresIn = data.body.expires_in;

    // Persist refresh token to config.json
    if (refreshToken) {
      await saveSpotifyRefreshToken(refreshToken);
    }

    console.log("\n=== AUTH SUCCESS ===");
    console.log("Access token (expires in seconds):", expiresIn);
    if (!refreshToken) {
      console.log(
        "No refresh token returned. If you re-authorized too quickly, try revoking the app in Spotify and retry.",
      );
    } else {
      console.log("Refresh token saved to config.json.");
    }
    console.log("====================\n");

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("Auth OK. You can close this tab and return to the terminal.");

    server.close();
  } catch (e: any) {
    console.error("Auth error:", e?.message ?? e);
    res.statusCode = 500;
    res.end("Auth failed. See terminal for details.");
    server.close();
  }
});

server.listen(3000, () => {
  console.log("Listening on http://localhost:3000/callback");
});
