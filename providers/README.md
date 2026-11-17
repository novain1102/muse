# Music providers

Every track Muse plays comes from a **provider**. The crate digging, taste filter, sequencing, analysis,
decks and mixer only ever see the normalized `Track` shape, so adding a source (e.g. NetEase Cloud Music /
网易云音乐, QQ Music) means adding one file here — no changes to `app.js`.

| File | What it is |
|---|---|
| `registry.js` | Interface docs, normalized `Track` fields, capabilities, the registry (`window.NEONDJ.providers`) and the shared `fetchJSON` (timeout + one retry on 429/5xx). |
| `audius.js` | Audius — default source: full tracks, BPM + key, genre/mood filters, trending, `similar()` via related artists, popularity signals (`crate: 'scored'`). Falls back to iTunes. |
| `itunes.js` | iTunes Search — 30 s previews (`fullTrack: false`, `crate: 'simple'`). Used as Audius's fallback and selectable in the menu. |
| `cn-common.js` | Shared Chinese-platform helpers: genre/mood → search keywords (中文 + English), tag stripping, https upgrade. |
| `kugou.js` | Kugou 酷狗 — keyless, JSONP search + play info straight from the page; free full songs (128 kbps); CDN has CORS. |
| `qqmusic.js` | QQ Music QQ音乐 — keyless JSONP search + stream key; free songs, mainland China only (elsewhere no keys → falls back). |
| `netease.js` | NetEase 网易云 — via your own CORS proxy (`proxy/worker.js`); hidden from Source until a proxy URL is saved. |
| `proxy/` | `worker.js` Cloudflare Worker (2 whitelisted read-only routes) + deploy steps. |
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

## Chinese platforms — what works from a static page (checked Nov 2026)
| Platform | Search from github.io | Stream URL | Audio CDN CORS (needed for analysis/mixing) | Result |
|---|---|---|---|---|
| Kugou 酷狗 | JSONP (`songsearch.kugou.com`) | JSONP (`m.kugou.com … cmd=playInfo`), free songs only | `sharefs.kugou.com`: `Access-Control-Allow-Origin: *`, Range | **works, no proxy** |
| QQ Music | JSONP (`c.y.qq.com … client_search_cp`) | JSONP (`u.y.qq.com/cgi-bin/musicu.fcg` vkey); empty outside mainland China | `*.stream.qqmusic.qq.com`: ACAO `*` | **works in mainland China only**, else falls back |
| NetEase 网易云 | no CORS headers, no JSONP | plain `api/song/enhance/player/url` (no weapi/eapi needed) | `m*.music.126.net` (https): ACAO `*` | **needs a proxy** (`proxy/`) |
| Kuwo 酷我 | no CORS (JS-variable "JSONP", not JSON) | `antiserver.kuwo.cn` no CORS | no ACAO → Web Audio would be silent | not implemented |
| Migu 咪咕 | no ACAO for other origins | signed app headers | — | not implemented |

Rules every CN provider follows: only what the platform streams for free to an anonymous listener; skip VIP /
paid / trial-only songs; no login, cookies, region spoofing or third-party "unlock" mirrors.
Lazy stream URLs: these providers implement `resolveStream()`; the 'simple' crate resolves picks until it has
enough free ones (and throws if none → fallback). New optional provider hooks: `keywords`, `available()`, `hint`;
`NEONDJ.providers.net.jsonp()` and `NEONDJ.providers.settings` are shared helpers.
