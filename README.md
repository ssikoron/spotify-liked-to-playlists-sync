# Spotify New Likes -> Playlists

A simple script to automatically add newly liked spotify tracks into playlists based on the playlist genre profiles.

## Why

Spotify app in my car (Android Automotive) doesn't provide any way to automatically add new tracks to playlists. It does
have a button to like a track. This script then makes sure every new liked track gets put in one of my current
playlists.

## Setup

### Prerequisites

- Node.js 18+ and npm/pnpm
- A Spotify account
- Spotify Developer credentials (Client ID and Client Secret)
- If you want to automate it - some sort of a server + setting it up as a CRON job

### Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/spotify-liked-to-playlists-sync.git
   cd spotify-liked-to-playlists-sync
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Create a `config.json` file in the project root with your Spotify credentials and playlists. You can put bare playlist IDs, full URLs, or Spotify URIs; they will be normalized automatically:
   ```json
   {
     "spotify": {
       "clientId": "your_client_id",
       "clientSecret": "your_client_secret",
       "redirectUri": "http://localhost:3000/callback"
     },
     "targetPlaylists": [
       "37i9dQZF1DXcBWIGoYBM5M",
       "https://open.spotify.com/playlist/6UeSakyzhiEt4NB3UAd6NQ",
       "spotify:playlist:3AGOiaoRXMSjswCLtuNqv5"
     ]
   }
   ```

   Optionally, you can control how often genre profiles are rebuilt via an environment variable:
   ```
   REBUILD_GENRE_PROFILE_INTERVAL=24
   ```

4. Get your Spotify refresh token and have it saved into `config.json` automatically:
   ```bash
   pnpm auth
   ```
   Follow the instructions in the terminal to authorize the application. When completed, the `refreshToken` will be written under `spotify.refreshToken` in your `config.json`.

### Spotify Developer Setup

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
2. Create a new application
3. Add `http://localhost:3000/callback` as a Redirect URI in your app settings
4. Copy your Client ID and Client Secret to your `.env` file

## Usage

### Running the Application

```bash
pnpm dev

# or

pnpm build
pnpm start
```

(Docker usage has been removed; run directly with Node as shown above.)

## How to Find Playlist IDs

You can find a playlist's ID in several ways:

1. From the Spotify web player, the ID is in the URL: `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`
2. Right-click a playlist and select "Share" > "Copy Spotify URI". The ID is the part after `spotify:playlist:`

## Behavior

- On the first run, the application sets a watermark to the current time and will only process tracks liked after this
  point
- For each target playlist, a genre profile is built by analyzing all tracks and their artists
- When it encounters a new liked track, the script determines which playlist has the most similar genre profile
- The track is then added to that playlist (if it's not already there)
- Genre profiles are rebuilt periodically based on the `REBUILD_GENRE_PROFILE_INTERVAL` setting

## License

MIT
