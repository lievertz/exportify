
> **This is a personal fork** of [pavelkomarov/exportify](https://github.com/pavelkomarov/exportify) — Pavel's project is the canonical one, hosted at [exportify.net](https://exportify.net), and that's where general improvements and discussion belong. This fork exists because Spotify deprecated some endpoints I cared about and I wanted my exports to keep including that data. Pavel's app was grandfathered into the old API; a freshly registered Spotify app (which this fork uses by default for local dev) is not.

### What changed in this fork

In November 2024, Spotify deprecated `audio-features`, `audio-analysis`, recommendations, related-artists, and a few other endpoints for any client app that didn't already have extended-quota access. For a new app you register today, those endpoints return 403. That wipes out most of the musically interesting columns this project used to produce: Danceability, Energy, Key, Loudness, Mode, Speechiness, Acousticness, Instrumentalness, Liveness, Valence, Tempo, Time Signature.

This fork backfills as much of that data as possible from third-party services, keyed off each track's ISRC code (which Spotify still hands out). Three sources, each in its own paced queue with a circuit breaker that aborts that service after five consecutive non-miss failures while letting the others continue:

- **Deezer** — BPM and gain, via JSONP (their public API doesn't send CORS headers). ~150ms cadence.
- **MusicBrainz** — recording MBID and user-submitted tags, via the `/isrc/` endpoint. 1.1s cadence to honor their rate-limit guidance.
- **AcousticBrainz** — full Essentia low-level + high-level feature set: BPM, key, loudness, dynamic complexity, plus classifier outputs for danceability, mood (happy / sad / aggressive / relaxed / party), voice vs. instrumental, tonal vs. atonal, timbre, gender, and two genre taxonomies (Dortmund, Rosamerica). Bulk-of-25 MBID lookups, two endpoints (`low-level` and `high-level`) per chunk. **Note:** AcousticBrainz stopped accepting new submissions in 2022, so coverage falls off sharply for newer releases.

Single-track failures retry with backoff and then get logged as blank columns. The circuit breaker only trips on five consecutive *real* failures (CORS rejection, repeated 5xx, network errors) — clean 404s and Deezer's in-body "no data" responses are misses, not failures, and don't count.

### Export format

Playlist data is exported as [CSV](http://en.wikipedia.org/wiki/Comma-separated_values) with the following fields. The first block comes from Spotify directly; the second block is the new enrichment.

**From Spotify:**

- [Track URI](https://developer.spotify.com/documentation/web-api/concepts/spotify-uris-ids)
- Track Name
- Album Name
- Artist Name(s)
- Release Date
- Duration (ms)
- Popularity
- Explicit
- Added By
- Added At
- Genres (from the artist object — Spotify has been thinning this field out over time)
- Record Label

**From enrichment:**

- ISRC
- Deezer BPM, Deezer Gain
- MB Recording ID, MB Tags
- AB BPM, AB Key, AB Average Loudness, AB Dynamic Complexity
- AB Danceability, AB Mood Happy, AB Mood Sad, AB Mood Aggressive, AB Mood Relaxed, AB Mood Party
- AB Voice/Instrumental, AB Tonal/Atonal, AB Timbre
- AB Genre (Dortmund), AB Genre (Rosamerica), AB Gender

AcousticBrainz classifier columns are formatted as `value (probability)`, e.g. `happy (0.87)`. Numeric columns (BPMs, loudness, etc.) are plain floats.

### Analysis notebook

I haven't touched [`taste_analysis.ipynb`](taste_analysis.ipynb). It was written against the old Spotify column layout and almost certainly needs updating to work with the enriched CSV format above. If you want to use it, expect to fix column references yourself, or use the upstream version with an upstream export.

### Development

Most of the logic lives in `exportify.js`. The page is plain static HTML/JS — no build step.

To run locally:

```bash
python3 -m http.server 8765
```

Then open <http://[::1]:8765>. Any open local port works; the example uses 8765 because the more common 8000 is often taken by Docker.

To use your own Spotify Developer Dashboard app (recommended for local development, so you're not depending on Pavel's grandfathered credentials):

1. Register an app at <https://developer.spotify.com/dashboard>.
2. Whitelist whatever origin you're serving from as a redirect URI (e.g. `http://[::1]:8765`).
3. Copy `config.local.example.js` to `config.local.js` (which is gitignored) and paste your client ID into it.

If `config.local.js` is absent, the page falls back to the production exportify.net client ID baked into `exportify.js`.

### Contributing

For improvements that would benefit everyone, please go to the [upstream project](https://github.com/pavelkomarov/exportify) — that's where the real users and discussion are. This fork is a personal scratchpad and I'm not actively reviewing PRs against it.
