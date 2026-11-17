# Muse — detailed notes (English)

Pick a genre/mood (or type a vibe like `深夜 暗黑 hypnotic techno`), press **Generate & Play**.
The app digs free tracks from the Audius network, listens to them, builds a set that warms up,
builds, peaks and cools down, and mixes it on two decks with beat-synced transitions and FX.

## Run
- Easiest: double-click `index.html` (Chrome / Edge / Safari / Firefox, internet needed).
- Or serve the folder: `cd ai-dj && python3 -m http.server 8000` and open http://localhost:8000

No build step, no accounts, no API keys. Files: `index.html`, `style.css`, `app.js`, `taste.js` (likes + taste profile), `providers/`.

## Music sources (providers)
Pick one in **Source**. Sources are pluggable (`providers/`, see `../providers/README.md`); `app.js` only sees a normalized `Track`.

| Source | What plays | Needs |
|---|---|---|
| **Audius** (default) | Full tracks by independent artists, BPM + key | nothing |
| **iTunes previews** | 30 s previews (Audius's fallback) | nothing |
| **Kugou 酷狗** | Full songs Kugou streams for free (standard quality); VIP-only songs skipped | nothing — called straight from the page |
| **QQ Music QQ音乐** | Free songs only, **in mainland China only** (QQ hands out no stream keys elsewhere) | nothing; outside China it falls back to Audius |
| **NetEase 网易云** | Free full songs; VIP/paid, region-blocked and 30 s trial clips skipped | your own small proxy (Cloudflare Worker, `providers/proxy/`) — hidden from Source until saved under Advanced |

Chinese platforms have no BPM/key data, so Muse measures tempo and energy itself (like the iTunes path).
If a source finds nothing playable, the set comes from Audius instead. No logins, no VIP/region workarounds.

## What happens when you press Generate
1. **Crate digging** – curated seed keywords per genre/mood (sub-genres, scene terms, textures)
   go to the Audius search API with genre/mood filters. Trending is only a last-resort top-up.
2. **Taste filter** – rejects type-beats, nightcore/sped-up, DJ mixes/hour-long uploads, very short
   tracks, playlist spam; penalises viral/chart-level play counts, pop re-rubs, genre-named SEO titles,
   channel-style uploaders; rewards mid-range "deeper cut" play counts, high like/repost ratio,
   matching tags, label-style titles. Max one track per artist.
3. **Listening** – fetches ~20 s from the start (tempo + beat phase via onset autocorrelation) and a slice
   from the body (loudness/energy) of each track. Audius also supplies BPM + key for most tracks.
4. **Sequencing** – energy arc (warm-up → build → peak → cool-down) or build-up, while minimising tempo
   jumps, clashing keys (Camelot wheel) and same-artist adjacency. Tempo outliers become spares.
5. **Mixing** – two decks, loudness-matched, tempo-synced (±8 %, half/double aware), transitions land on
   bars/phrases. Auto FX picks a scripted transition per pair: EQ bass swap, filter sweep, phaser blend,
   flange out, reverb wash, echo out, loop-roll drop with riser + impact, stutter cut, tape stop.
   Between transitions it occasionally adds phrase-end flourishes (loop roll, echo throw, filter dip,
   stutter, riser→drop). Intensity: Subtle / Normal / Wild.

## ♥ Likes & taste (红心 → 按你的品味挖歌)
- Tap **♡** on the now-playing card (or press **L**) or on any row in the tracklist to like a track; tap again to un-like.
  Likes are stored in this browser (`localStorage['neondj.likes']`). The **♥ Liked** tab (or the *Liked* button in Set
  Builder) lists them, shows a one-line taste summary, lets you un-heart, and **Export / Import** them as JSON
  (import merges, duplicates skipped) — keep a copy so clearing browser data doesn't lose your taste.
- **Taste** (Off / Some / Strong, default Some) sets how much likes steer the next set. With no likes, or Off, digging is
  exactly as before. Otherwise, per build:
  1. a *taste profile* is made from your likes: favourite artists, genres, moods, recurring tags, BPM range (10th–90th
     percentile), Camelot keys and how "deep" (play counts) your likes are;
  2. extra searches go out for your most-liked artists and recurring tags (Some: 2 + 2, Strong: 3 + 3), plus the source's
     "more like this" for 1–2 liked tracks when it has one (Audius: tracks by artists related to the liked artist);
  3. every candidate still goes through the same anti-chart taste filter, then gets bonus points for looking like your
     likes (same/liked artist, genre, mood, shared tags, tempo in your range, compatible key, similar depth) — weight
     ×0.55 for Some, ×1.1 for Strong;
  4. a few liked tracks that fit the current genres/tempo are mixed back in (Some ≈10 % max 2, Strong ≈25 % max 5).
  One track per artist still applies. If no genre/mood/prompt is picked, the set starts from your most-liked genres.
- All scripted and deterministic. Works through the provider interface, so it carries over to new sources.

## 华语 / C-Pop
One genre chip for Chinese-language pop hits; the mood picks the flavour (chill → ballads/folk, groovy → R&B, deep → Cantonese classics,
dreamy → 国风, dark/energetic → rap/rock, happy → pop). Hits are wanted here, so the anti-chart penalties are off for it. With a
non-Chinese source selected, the dig goes to Kugou (QQ first if QQ is the source); originals only (no DJ edits, karaoke, covers,
re-uploads). Kugou's paid songs (music-pack flag) are skipped before any request. If Kugou finds nothing, Audius is searched
with Chinese terms.

## Steering a playing set (换风格不用重来)
Change the Genre / Mood chips while a set is playing — no need to press Generate. After ~1.5 s Muse digs the
new selection in the background ("Shifting to Tech House…"), keeps the playing track and the already-cued next
one, then queues **bridge** tracks (one from the old crate leaning toward the new tempo, then the new track
closest to it in tempo/key, tagged BRIDGE in the list), followed by the new style as a build-up. Endless mode
keeps digging the latest selection.

## Live decks (what you see)
- Every deck control is drawn from the real audio-node values each frame: 3-band EQ, filter (LP/HP with
  frequency), echo, reverb and gain knobs (arc + pointer + value), a level meter with peak hold, the
  channel volume (crossfader gain), pitch/tempo offset and BPM, plus FX lamps (LOOP, STUT, ECHO, FILT,
  FLNG, PHSR, VERB, STOP) that light while that effect is actually running. A knob glows lime with a dot
  while automation is moving it away from your setting.
- With Auto FX on, Muse rides the mix like a DJ between transitions — at most one tasteful move per
  16-beat phrase, timed to the beat grid and finished before the phrase ends: high-shelf or low cuts, a mid
  lift, low-pass "breaths", high-pass sweeps into a phrase end, small gain rides, echo taps, reverb tails.
  Transitions add bass swaps, filter sweeps, echo-outs, loop rolls, tape stops, risers and impacts.
- Every effect shows a chip in the visualizer with its deck and a progress bar; the matching pad lights up and
  pulses on the beat while it runs. FX intensity (Subtle / Normal / Wild) scales how often this happens.
- Manual control: drag a knob up/down (Shift = fine), mouse wheel, or arrow keys when focused; double-click
  (or Home/Delete) resets. Grabbing a knob cancels the automation on that parameter and your value wins; the
  next scripted move starts from your setting. Reduced-motion settings turn off easing and glows.

## Interface
- Quiet by design: short labels, help lives in tooltips (hover a control).
- First visit shows a short tour (pick a genre → mood → Generate & Play → ♥). **?** in the header replays it; Esc or Skip ends it.
  Shown once per browser (`localStorage['neondj.tour']`).

## Live control
- Pads (hold or tap, keys 1–0, N): loop roll (1/4–4 beats), stutter, echo throw, filter sweep, flanger,
  phaser, reverb wash, tape stop → next track, riser, impact, mix next. Space = play/pause, L = like.
- Click any track in the list to mix into it now. Generate again while playing to queue a new set after
  the current track. Endless mode digs more tracks before the set runs out.

## Advanced
- **Keyword expansion** (optional): turns your vibe into a few extra search keywords with your own OpenAI API key
  (one short request per set, cached; the key stays in this browser). Off by default.
- **NetEase proxy**: paste your Worker URL (see `providers/proxy/README.md`) and Save — Muse checks it and adds
  NetEase to Source. Clear + Save removes it. Stored in `localStorage['neondj.provsettings']`.

## Storage
Settings and likes keep their original keys (`neondj.opts`, `neondj.sel`, `neondj.likes`, …) so nothing is
lost after the rename (new: `neondj.tour`, `neondj.provsettings`); likes export as `muse-likes-YYYY-MM-DD.json` (older exports import fine).

## Honest limits
- Music = whatever independent artists uploaded to Audius; quality varies and the catalogue is not the
  commercial charts. Audius can rate-limit (HTTP 429) if you rebuild many times in a row.
- Beat grids are estimates: tempo is usually right (Audius BPM + our check), but bar/phrase alignment
  (which beat is "1") is a best guess, so some blends drift or land off-phrase.
- Loops are delay-line "slip loops" (the track keeps running underneath), the standard approach for
  streamed audio.
- iTunes fallback = 30 s previews only, tempo estimated in-browser, short crossfades.
- Chinese platforms: unofficial web endpoints that can change or rate-limit without notice; search relevance is
  looser (pop remixes tagged "DJ" turn up), and no BPM/key metadata. Use is subject to each platform's terms —
  Muse only plays what they stream for free to anonymous listeners.
