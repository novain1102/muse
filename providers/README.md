# Music providers

Every track Muse plays comes from a **provider**. The crate digging, taste filter, sequencing, analysis,
decks and mixer only ever see the normalized `Track` shape, so adding a source (e.g. NetEase Cloud Music /
网易云音乐, QQ Music) means adding one file here — no changes to `app.js`.

| File | What it is |
|---|---|
| `registry.js` | Interface docs, normalized `Track` fields, capabilities, the registry (`window.NEONDJ.providers`) and the shared `fetchJSON` (timeout + one retry on 429/5xx). |
| `audius.js` | Audius — default source: full tracks, BPM + key, genre/mood filters, trending, `similar()` via related artists, popularity signals (`crate: 'scored'`). Falls back to iTunes. |
| `itunes.js` | iTunes Search — 30 s previews (`fullTrack: false`, `crate: 'simple'`). Used as Audius's fallback and selectable in the menu. |
| `_template.js` | Commented skeleton to copy. Not loaded. |

## Add a provider
1. `cp _template.js mysource.js`, set `id` / `name` / `label`, implement `search()` + `getStreamUrl()` and
   map the raw JSON to a `Track` in `toTrack()` (see the field list in `registry.js`).
2. Set `capabilities` honestly — they decide app behaviour:
   - `fullTrack:false` → previews: short blends, no phrase-aligned exits/flourishes, set length uses `previewSeconds`.
   - `crate:'scored'` (needs `signals`: plays/likes/reposts/followers…) → full taste filter + optional trending top-up;
     `crate:'simple'` → basic reject rules, shuffle, one track per artist.
   - `filters:true` + `genreFilters`/`moodFilters` → app genre/mood ids are translated to your source's vocabulary.
   - `rangeRequests:true` → analysis reads a head + body byte range instead of the whole file.
3. Optional `similar(track)` ("more like this", set `capabilities.similar: true`) feeds the ♥ taste digs; fill
   `Track.tags` when the source has tags — taste matching uses them. Likes store `src`+`id`, so ids must stay stable.
4. Signed / expiring stream URLs: implement `resolveStream(track)`; it's called before a deck loads a track,
   before analysis fetches it, and when a playing deck errors.
5. Optional `fallback: '<id>'` = provider used when yours throws or returns nothing.
6. Add `<script src="providers/mysource.js"></script>` to `index.html` after `registry.js`, before `taste.js` / `app.js`.
   It appears in the **Source** menu automatically (registration order). No ES modules, so `file://` keeps working.

## Switch provider
- In the UI: **Source** menu (saved in `localStorage['neondj.opts'].source`, as before).
- Default for new users: the first registered provider, or the one with `isDefault: true`.
- Console: `NEONDJ.providers.list()`, `NEONDJ.providers.get('audius')`.

## Caveats for Chinese platforms
NetEase / QQ Music have no official public browser API: their web endpoints need signing/cookies and generally
don't send CORS headers, and many songs are VIP/region-locked. Expect to run a small proxy (and set `playable:false`
for locked songs). Without CORS on the audio, tracks can still play but BPM/energy analysis is skipped.
