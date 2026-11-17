/* Muse — music provider layer: interface, normalized Track shape, registry, shared net helpers.
 * Classic script (no ES modules) so index.html still works from file://. Load order in index.html:
 *   providers/registry.js -> providers/<each provider>.js -> app.js
 * Everything lives under one global: window.NEONDJ.providers (app.js later adds debug handles to window.NEONDJ).
 *
 * ───────────────────────── Provider interface ─────────────────────────
 * A provider is a plain object passed to NEONDJ.providers.register({...}):
 *
 *   id            string   unique, stable; stored in localStorage ('neondj.opts'.source) and in Track.src
 *   name          string   short display name used in status lines ("Connecting to <name>…")
 *   label         string   text of its option in the Source <select> ("Audius (full tracks)")
 *   capabilities  object   see CAPS_DEFAULT below
 *   fallback      string?  id of the provider to try when this one fails or returns nothing
 *   genreFilters  object?  app genre id ('house', 'techno', …) -> [source genre values] used as search filters
 *   moodFilters   object?  app mood id ('chill', 'dark', …)    -> [source mood values]
 *   async init()                        optional; pick a host, warm up, etc. Called before every dig.
 *   async search(query, opts)           REQUIRED. opts = { genres: [source genre values], moods: [source mood values], limit }
 *                                       -> Track[] (normalized, see below). Unknown filters may be ignored.
 *   async trending(sourceGenre)         optional; -> Track[] with signals.trending = true (last-resort top-up)
 *   async similar(track, {limit})       optional; "more like this" for a (liked) Track of this provider -> Track[]
 *                                       (related tracks / related artists / radio). Used by taste-driven digs.
 *   getStreamUrl(track)                 REQUIRED. -> URL the <audio> element / analyser can fetch.
 *                                       Normally called inside your normalizer to fill Track.url.
 *   async resolveStream(track)          optional; for sources whose URLs are signed/expiring: fill or refresh
 *                                       track.url / track.alt right before a deck loads or analysis fetches it.
 *
 * Rate limits: use NEONDJ.providers.net.fetchJSON — it retries once with jittered back-off on
 * HTTP 429 / 5xx / aborts / network errors. Throwing from search() is fine: the dig pool swallows
 * single failed queries, and a dig that ends with zero tracks triggers the provider's fallback.
 *
 * ───────────────────────── Normalized Track ─────────────────────────
 * Everything after the dig (taste filter, sequencing, analysis, decks, mixer, UI) only reads these fields:
 *   src        provider id                     id        unique across providers (prefix it, e.g. 'it123')
 *   title      display title                   artist    display artist
 *   artistId   used for "max one per artist"   link      public page of the track ('' if none)
 *   art        large cover URL ('' if none)    artSmall  small cover URL for the list
 *   artMirrors [origin, …] alternate hosts tried (same path) when a cover fails to load
 *   dur        playable length in seconds (preview length for clips; decks overwrite it with the real one)
 *   fullDur    optional: length of the full song when only a preview is playable
 *   preview    true = short clip (no phrase-aligned exits, no flourishes, short blends)
 *   bpm        source BPM or null (50–200 only; the app folds half/double time and may fill it by analysis)
 *   key        musical key text ('A minor', 'F#m', …) or null — the app derives the Camelot code (cam)
 *   genre      source genre text (shown in the list, compared with genreFilters)
 *   mood       source mood text ('' if none)
 *   tags       optional free-text tags, comma separated ('' if none) — used by likes / taste matching
 *   prior      0..1 energy guess before audio analysis (0.5 if unknown)
 *   url        primary stream URL (getStreamUrl)  alt  optional second URL tried if url fails
 *   plays      play count (0 if unknown)
 *   playable   false = don't use (blocked / gated); default true
 *   listed     false = unlisted / access-restricted; skipped by the strict first pass; default true
 *   signals    taste inputs for 'scored' crates — { plays, likes, reposts, followers, bpm (as reported,
 *              unvalidated), hasArt, trending, tags, description } plus optional raw overrides
 *              { rawTitle, artistName, artistKey } when they differ from the display fields; missing = unknown
 * The app adds runtime fields itself (cam, an, energy, bad, anFail, …); providers must not set them.
 *
 * ───────────────────────── Capabilities ─────────────────────────
 */
(function () {
  'use strict';
  const NS = window.NEONDJ = window.NEONDJ || {};
  const CAPS_DEFAULT = {
    fullTrack: true,        // false = only previews; set length math uses previewSeconds per track
    previewSeconds: 30,     // length of a preview clip (also shown as "30s preview")
    hasBpmKey: false,       // source supplies BPM / musical key metadata
    rangeRequests: false,   // stream URL honours HTTP Range: analyse a head + body slice instead of the whole file
    filters: false,         // search() understands genre / mood filters (genreFilters / moodFilters)
    trending: false,        // trending() available for top-ups
    similar: false,         // similar(track) available ("more like this" for taste-driven digs)
    crate: 'simple',        // 'scored' = rich popularity signals -> full taste filter + trending top-up;
                            // 'simple' = shuffle + one-per-artist dig with basic reject rules (preview catalogues)
    rateLimited: false,     // informational: source is known to answer HTTP 429 under bursts
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchJSON1(url, timeout, opts) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeout);
    try { const r = await fetch(url, { ...opts, signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(to); }
  }
  /* JSON fetch with timeout + one jittered retry on 429 / 5xx / abort / network failure */
  async function fetchJSON(url, timeout = 10000, opts = {}, retry = 1) {
    try { return await fetchJSON1(url, timeout, opts); }
    catch (e) { if (retry > 0 && /HTTP (429|5\d\d)|abort|Failed to fetch/i.test(String(e.message || e))) { await sleep(1200 + Math.random() * 1200); return fetchJSON(url, timeout, opts, retry - 1); } throw e; }
  }

  const list = [], byId = new Map();
  let defaultId = null;

  const Providers = {
    net: { fetchJSON, sleep },
    CAPS_DEFAULT,
    /* register a provider; the first one registered (or one with isDefault) becomes the default */
    register(p) {
      if (!p || !p.id || typeof p.search !== 'function' || typeof p.getStreamUrl !== 'function') throw new Error('provider needs id, search(), getStreamUrl()');
      if (byId.has(p.id)) throw new Error('duplicate provider id ' + p.id);
      p.name = p.name || p.id; p.label = p.label || p.name;
      p.capabilities = Object.assign({}, CAPS_DEFAULT, p.capabilities || {});
      p.genreFilters = p.genreFilters || {}; p.moodFilters = p.moodFilters || {};
      list.push(p); byId.set(p.id, p);
      if (!defaultId || p.isDefault) defaultId = p.id;
      return p;
    },
    get(id) { return byId.get(id) || null; },
    /* provider for an id, or the default when the id is unknown (e.g. stale localStorage value) */
    resolve(id) { return byId.get(id) || byId.get(defaultId) || null; },
    list() { return list.slice(); },
    get defaultId() { return defaultId; },
    fallbackFor(id) { const p = byId.get(id); return p && p.fallback && p.fallback !== id ? byId.get(p.fallback) || null : null; },
    caps(trackOrId) { const id = typeof trackOrId === 'string' ? trackOrId : trackOrId && trackOrId.src; const p = byId.get(id); return p ? p.capabilities : CAPS_DEFAULT; },
    /* app genre / mood ids -> this provider's filter values (deduped, order kept) */
    mapGenres(p, ids) { return [...new Set(ids.flatMap(g => p.genreFilters[g] || []))]; },
    mapMoods(p, ids) { return [...new Set(ids.flatMap(m => p.moodFilters[m] || []))]; },
    /* true when a track's provider wants to (re)resolve its stream URL before use */
    needsResolve(track) { const p = track && byId.get(track.src); return !!(p && typeof p.resolveStream === 'function'); },
    async prepare(track) { const p = track && byId.get(track.src); if (p && typeof p.resolveStream === 'function') await p.resolveStream(track); return track; },
    /* fill defaults so consumers can rely on the Track shape */
    normalize(t) {
      if (t.playable == null) t.playable = true;
      if (t.listed == null) t.listed = true;
      if (t.preview == null) t.preview = false;
      if (t.prior == null) t.prior = 0.5;
      if (t.plays == null) t.plays = 0;
      if (!t.signals) t.signals = {};
      if (!t.artMirrors) t.artMirrors = [];
      return t;
    },
  };
  NS.providers = Providers;
})();
