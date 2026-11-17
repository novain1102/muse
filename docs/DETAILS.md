# Muse — detailed notes (English)

Pick a genre/mood (or type a vibe like `深夜 暗黑 hypnotic techno`), press **Generate & Play**.
The app digs free tracks from the Audius network, listens to them, builds a set that warms up,
builds, peaks and cools down, and mixes it on two decks with beat-synced transitions and FX.

## Run
- Easiest: double-click `index.html` (Chrome / Edge / Safari / Firefox, internet needed).
- Or serve the folder: `cd ai-dj && python3 -m http.server 8000` and open http://localhost:8000

No build step, no accounts, no API keys. Files: `index.html`, `style.css`, `app.js`, `taste.js` (likes, dislikes + taste profile), `scene.js` (shared scene scorer), `providers/`.

## Music sources (providers)
Pick one in **Source**. Sources are pluggable (`providers/`, see `../providers/README.md`); `app.js` only sees a normalized `Track`.

| Source | What plays | Needs |
|---|---|---|
| **Audius** (default) | Full tracks by independent artists, BPM + key | nothing |
| **iTunes previews** | 30 s previews (Audius's fallback) | nothing |
| **Kugou 酷狗** | Full songs Kugou streams for free (standard quality); VIP-only songs skipped | nothing — called straight from the page |
| **QQ Music QQ音乐** | Free songs only, **in mainland China only** (QQ hands out no stream keys elsewhere) | nothing; outside China it falls back to Audius |
| **NetEase 网易云** | Free full songs; VIP/paid, region-blocked and 30 s trial clips skipped | a small proxy (Cloudflare Worker, `providers/proxy/`): a built-in one on the hosted site (`muse-proxy…workers.dev`, only answers novain1102.github.io and localhost:8000); your own URL under Advanced overrides it |

Chinese platforms have no BPM/key data, so Muse measures tempo and energy itself (like the iTunes path).
If a source finds nothing playable, the set comes from Audius instead. No logins, no VIP/region workarounds.

## What happens when you press Generate
1. **Crate digging** – curated seed keywords per genre/mood (sub-genres, scene terms, textures)
   go to the Audius search API with genre/mood filters. Trending is only a last-resort top-up.
2. **Taste filter** – rejects type-beats, nightcore/sped-up, DJ mixes/hour-long uploads, very short
   tracks, playlist spam; penalises viral/chart-level play counts, pop re-rubs, genre-named SEO titles,
   channel-style uploaders; rewards mid-range "deeper cut" play counts, high like/repost ratio,
   matching tags, label-style titles. Max one track per artist.
3. **Listening** – full tracks (up to 8 min) are decoded whole once: tempo + beat phase from the first ~25 s (onset
   autocorrelation), loudness from the body, and a 0.1 s energy profile of the whole song (level, <150 Hz low end, onset
   flux). Per bar on the beat grid that gives a robust score against the song's own median; 4-bar phrases in the loudest
   third, the phrase re-entering after a break, and single bars far above the rest are marked **high-energy** (hooks,
   drops). Longer tracks / previews fall back to a head + body slice. Audius also supplies BPM + key for most tracks.
4. **Sequencing** – energy arc (warm-up → build → peak → cool-down) or build-up, while minimising tempo
   jumps, clashing keys (Camelot wheel) and same-artist adjacency. Tempo outliers become spares.
5. **Mixing** – two decks, loudness-matched, tempo-synced (±8 %, half/double aware), transitions land on
   bars/phrases. Auto FX picks a scripted transition per pair: EQ bass swap, filter sweep, phaser blend,
   flange out, reverb wash, echo out, loop-roll drop with riser + impact, stutter cut, tape stop.
   Between transitions it occasionally adds phrase-end flourishes (loop roll, echo throw, filter dip,
   stutter, riser→drop). Intensity: Subtle / Normal / Wild.
   **Mix-out point**: the best 4-bar phrase boundary whose overlap window holds no high-energy bar — preferring the boundary
   right after a hook / drop ends, then a calmer stretch, then earlier; past the window it holds to the next clean boundary,
   and a song that ends on its hook plays it out. Without an energy map, the live section detector holds a mix that would land
   in a drop (up to 2 phrases).
   **Hip-Hop / Trap and 华语 (rhythm-dense, vocal-led)**: each track plays most of the song (≥ 65 % and ≥ 2:30, about
   80 % in tests; short tracks play out). Blends are short: when both grids are trustworthy (metadata agrees or onset
   confidence ≥ 1.3) and tempos are within ±10 %, a 1-bar **bass swap** — the next track (cued one bar early) runs with its
   lows cut, kick / 808 hand over on the 1 of its phrase, the old track is gone 2 beats later (≈ 3–6 s overlap, one low end
   at a time), with a start-latency correction + jog nudges. Otherwise an **echo out**: the old bar filters up and throws an
   echo, the new track starts clean on its own downbeat (no rhythmic overlap). No long mashups in these sets. House /
   techno keep the long blends and Hype mashups.

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
- **Dislike** (thumbs-down next to the heart, or **X**): on the playing track it quick-mixes to the next one; on a queued
  row it drops that track from the set; on a played row it just records it. Dislikes live in `localStorage['neondj.dislikes']`
  (same record shape as likes) and are listed in the thumbs-down tab, where each can be undone. Liking a disliked track clears
  the dislike and vice versa. Export / Import carry both (`dislikes` array in the same JSON; older files still import).
  - hard, always on: a disliked track is never picked again (same id, or same title + artist on another upload), and an
    artist with 2 dislikes is excluded — queued tracks by them leave the set at once;
  - soft, scaled by Taste (Off none, Some ×0.5, Strong ×1): a negative taste profile takes points off candidates —
    same artist −1, shared disliked tags ≤ −0.6, genre ≤ −0.4 / mood ≤ −0.2 / tempo band −0.2 (only where dislikes
    outweigh likes; tags you also like aren't counted).
- All scripted and deterministic. Works through the provider interface, so it carries over to new sources.

## Hip-Hop / Trap
Modern trap / rap rather than boom-bap. Same generic knobs any genre can use (in `GENRES`):
- `scene` seed artists — Travis Scott, Drake, Future, 21 Savage, Metro Boomin, Playboi Carti, Don Toliver, Lil Uzi Vert, Gunna,
  Young Thug, Kendrick Lamar — ranked through `scene.js` (closeness via features / producers / albums);
- `popTol: 0.6` — popularity tolerance: the anti-chart penalties (play counts, follower counts, the mainstream-name list) are
  scaled by 1 − popTol, so popular tracks are allowed here;
- `recent: 2015` — older releases (where the source gives a date) lose 0.4–1.2 points;
- `vocals: true` — beat / instrumental / "type" uploads lose points, songs with `prod.` / `feat.` gain a little.
- `minYear: 2010` — anything dated earlier is dropped;
- `fullOnly: true` — no 30-second previews when full tracks can be found: picking iTunes swaps in Audius for this genre
  (previews only if no full source answers);
- `covers: true` — other artists' versions / re-uploads of the seeds' songs are welcome: `scene.js` learns the seeds' own
  song titles from the dig, searches them, and counts a free version of one as close to the scene (0.6). Altered edits
  are still skipped (DJ / remix / instrumental / sped-up / slowed / "type beat" / mashups / 伴奏 / 氛围版 …), and one version per song;
- `alsoCn: true` — besides the picked source (Audius by default), Kugou, QQ Music and NetEase are dug in parallel and the
  results interleaved (one version per song). Each extra source gets a ~45 s budget; a source that finds nothing is skipped.
What actually plays free (tested Nov 2026 from outside mainland China): Audius — full tracks by independent artists
(modern trap / rage / plugg, 2020+); Kugou and NetEase — the seeds' own songs are almost all paid, but covers / re-uploads
of them and some features play in full; QQ Music — streams only for listeners in mainland China (elsewhere it finds
nothing and drops out); iTunes — the real seed songs, 30 s previews only (used only if nothing full is found).

## 华语 / C-Pop
Underground / new-wave Chinese rap and trap (dug from Kugou, QQ Music and NetEase together, `alsoCn`). The genre's config is only a handful of **scene seed artists**
(`GENRES.cpop.scene`: Asen, ThomBoyDontkill, Mac Ova Seas, Sasioverlxrd (SASI on Kugou), 华一龙, APMozart) — no keyword
lists, no artist black- or white-lists. Muse searches the seeds, then their strongest collaborators / producers (second hop),
and ranks everything with the shared scene scorer (`scene.js`, used by every provider and genre):
- **scene proximity** from co-occurrence in what the dig saw: seed = 1, featured with / produced for a seed ≈ 0.6–0.9,
  one more hop ≈ 0.3, same album as a seed track 0.4, showing up in a seed's search results 0.1 each; only tracks at
  ≥ 0.3 are eligible;
- **mainstream penalty** from the source's play counts, relative to the pool — per track and per artist (an act's biggest
  song counts), so scene-acclaimed but not mass-market wins;
- **variety-show / talent-show penalty** from generic title / album patterns: `(Live)`, 现场, 舞台版, 综艺 / 节目 / 公演,
  `Ep.3`, 第3期, `《…说唱… / …嘻哈…》` tags and show names (for 华语, `(Live)` cuts are dropped outright);
- then likes / dislikes (taste.js) on top, as for every genre. Endless mode and steering use the same dig.
Kugou first, QQ Music next (QQ first if it is the source), Audius with Chinese terms last; originals only, releases before
2016 dropped where a date is given; Kugou's paid songs are skipped, so what plays is the free part of each catalogue.

## Steering a playing set (换风格不用重来)
Change the Genre / Mood chips while a set is playing — no need to press Generate. After ~1.5 s Muse digs the
new selection in the background ("Shifting to Tech House…"), keeps the playing track and the already-cued next
one, then queues **bridge** tracks (one from the old crate leaning toward the new tempo, then the new track
closest to it in tempo/key, tagged BRIDGE in the list), followed by the new style as a build-up. Endless mode
keeps digging the latest selection.

## Hype (Smooth / Club / Wild)
The select next to the toggles (was "Auto FX intensity"; old settings map Subtle → Smooth, Normal → Club). The default is to
do **nothing** — no quota of moves per minute. A move happens only when the music gives a reason, decided ~1 beat before a
bar and landed on the phrase grid (when inside a phrase varies with the reason, plus randomness):
- **a drop is coming** (build, or a breakdown that has run 4+ bars): a high-pass build-up over the last 2–4 bars (Club sets add
  a riser), then the bass pulled on the last beat and slammed back in on the 1. Only here, and rarely, a cut — a short loop
  roll, a ⅛ stutter or a tape stop: at most one per ~3 min in Club (~75 s in Wild), only in club / hip-hop sets, never in
  chill or vocal-led (华语) sets;
- **into a breakdown**: a reverb swell or a slow low-pass sweep down;
- **a long plateau** (4+ untouched phrases in Club, 2+ in Wild): one slow HP or LP sweep over 8 or 16 bars, or a bass swap
  that comes back on the 1; Wild may use a ⅛ trance gate here;
- **a 32-beat phrase change** after a quiet stretch: an echo throw on the last beat;
- flanger / phaser only under build-ups (Wild).
Moves follow the style of the set: club (house / techno / bass …), trap (hip-hop), song (vocal-led), chill. After each move
the track is left alone (Club ≥ 2 phrases, Wild ≥ 1). Smooth uses only filter dips into drops, reverb into breakdowns and
echo throws after long quiet stretches — no cuts; the subtle EQ "rides" only come after 3+ untouched phrases.
Transition scripts follow the same idea: loop-roll / tape-stop mixes only into a clear energy lift, in club / hip-hop sets,
within the same cut cooldown. Measured on the box (4–6 min runs, moves per mid-track minute, before → after): Club tech-house 6.4 → 1.4 (of which
1.0 subtle EQ rides), Wild tech-house 14.7 → 1.4–1.7, Club hip-hop 3.4 → 0.2; glitch cuts (roll / stutter / gate / chop)
mid-track 3.2 / 7.5 / 2.8 → 0 per minute — they now come only right before a detected drop, behind a long cooldown.
Transitions: when the next track is
tempo-synced, Club plans a long mashup about 45 % of the time (Wild 65 %) and starts the mix early enough for it —
*drums under* (next track's kick / bass under this one's mids / highs, then hand-over), *loop under* (the next track's first
bar looped for 3 bars under this one, bass swap on the phrase), and with compatible keys *double drop* or *vocal over beat*.
Everything is AudioParam automation, so knobs, pads and the FX lamps show it; the master has a glue compressor + limiter
(peaks stayed ≤ 0.89 in tests, no clipping).

## Live decks (what you see)
- Every deck control is drawn from the real audio-node values each frame: 3-band EQ, filter (LP/HP with
  frequency), echo, reverb and gain knobs (arc + pointer + value), a level meter with peak hold, the
  channel volume (crossfader gain), pitch/tempo offset and BPM, plus FX lamps (LOOP, STUT, ECHO, FILT,
  FLNG, PHSR, VERB, STOP) that light while that effect is actually running. A knob glows lime with a dot
  while automation is moving it away from your setting.
- With Auto FX on, Muse occasionally rides the mix like a DJ between transitions — only after 3+ untouched
  phrases, one move, timed to the beat grid and finished before the phrase ends: high-shelf or low cuts, a mid
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
- **NetEase proxy**: the hosted site uses a built-in proxy; paste your own Worker URL (see `providers/proxy/README.md`) and
  Save to override it — Muse checks it. Clear + Save goes back to the built-in one (opened from file:// there is none). Stored in `localStorage['neondj.provsettings']`.

## Storage
Settings and likes keep their original keys (`neondj.opts`, `neondj.sel`, `neondj.likes`, …) so nothing is
lost after the rename (new: `neondj.tour`, `neondj.provsettings`, `neondj.dislikes`); likes export as `muse-likes-YYYY-MM-DD.json` (older exports import fine).

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
