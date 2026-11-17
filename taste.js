/* Muse — likes ("♥") + taste profile. Deterministic scripts only: no AI calls.
 * Provider-agnostic: works on the normalized Track (providers/registry.js), so it carries over to any source.
 * Loaded after providers/*.js and before app.js; exposes window.NEONDJ.taste.
 *
 *  Likes     localStorage 'neondj.likes' = [LikeRecord]; export / import as JSON (with dislikes).
 *  Dislikes  localStorage 'neondj.dislikes' = [same records]; avoid() / blocked() / penalty(): never again + negative signal.
 *  profile() liked tracks -> { artists, genres, moods, tags, BPM range, Camelot keys, play-count depth }.
 *  similarity(track, profile) -> 0 … ~3.2 points: how much a candidate looks like what you liked.
 *  The app (digCrates in app.js) uses these to add search seeds, boost candidates and mix liked tracks in.
 */
(function () {
  'use strict';
  const NS = window.NEONDJ = window.NEONDJ || {};
  const KEY = 'neondj.likes';
  // fields kept per like: enough to show it, re-find it, score against it and re-stream it
  const FIELDS = ['src', 'id', 'title', 'artist', 'artistId', 'genre', 'mood', 'bpm', 'key', 'tags', 'link', 'art', 'artSmall', 'artMirrors',
    'url', 'hash', 'mid', 'nid', 'dur', 'fullDur', 'preview', 'plays', 'prior'];
  const keyOf = t => t.src + ':' + t.id;
  const valid = r => r && typeof r === 'object' && typeof r.src === 'string' && r.id != null && r.id !== '' && typeof r.title === 'string';
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  /* ---------- likes / dislikes stores (same record shape; a track is never in both) ---------- */
  const DKEY = 'neondj.dislikes';
  function makeStore(KEYN, stamp) {
    let list = null; const subs = [];
    const load = () => { if (list) return list; try { const v = JSON.parse(localStorage.getItem(KEYN) || '[]'); list = Array.isArray(v) ? v.filter(valid) : []; } catch (e) { list = []; } return list; };
    const save = () => { try { localStorage.setItem(KEYN, JSON.stringify(list)); } catch (e) { console.warn(KEYN + ' not saved', e); } subs.forEach(f => { try { f(); } catch (e) { } }); };
    const record = t => { const r = {}; FIELDS.forEach(f => { if (t[f] !== undefined && t[f] !== null && t[f] !== '') r[f] = t[f]; });
      if (r.tags == null && t.signals && t.signals.tags) r.tags = t.signals.tags; r.id = String(r.id); r[stamp] = Date.now(); return r; };
    const St = {
      key: keyOf,
      all() { return load(); },
      count() { return load().length; },
      has(t) { if (!t) return false; const k = keyOf(t); return load().some(r => keyOf(r) === k); },
      add(t) { if (!t || St.has(t)) return false; St.other && St.other.remove(t); load().unshift(record(t)); save(); return true; },   // liking clears a dislike and vice versa
      remove(t) { const k = typeof t === 'string' ? t : keyOf(t); const n = load().length; list = load().filter(r => keyOf(r) !== k); if (list.length !== n) save(); },
      toggle(t) { if (St.has(t)) { St.remove(t); return false; } St.add(t); return true; },
      onChange(f) { subs.push(f); },
      /* merge records (array); returns { added, skipped } */
      merge(arr, isBlocked) {
        const have = new Set(load().map(keyOf)); let added = 0, skipped = 0;
        for (const r of arr) { if (!valid(r)) { skipped++; continue; } const c = {}; FIELDS.concat(stamp).forEach(f => { if (r[f] !== undefined) c[f] = r[f]; }); c.id = String(c.id);
          if (have.has(keyOf(c)) || (isBlocked && isBlocked(c))) { skipped++; continue; } have.add(keyOf(c)); list.push(c); added++; }
        if (added) save(); return { added, skipped };
      },
      _reload() { list = null; return load(); },
    };
    return St;
  }
  const Likes = makeStore(KEY, 'likedAt'), Dislikes = makeStore(DKEY, 'dislikedAt');
  Likes.other = Dislikes; Dislikes.other = Likes;
  /* export: { likes as before, + dislikes } — older files without `dislikes` still import */
  Likes.exportData = () => ({ app: 'Muse', kind: 'likes', v: 1, exportedAt: new Date().toISOString(), tracks: Likes.all(), dislikes: Dislikes.all() });
  /* merge an exported file (or a bare array of likes); returns { added, total, skipped, disliked } */
  Likes.importData = obj => {
    const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.tracks) ? obj.tracks : null;
    if (!arr) throw new Error('not a Muse likes file');
    const r = Likes.merge(arr, c => Dislikes.has(c));                         // your existing dislikes win over imported likes
    const d = obj && Array.isArray(obj.dislikes) ? Dislikes.merge(obj.dislikes, c => Likes.has(c)) : { added: 0, skipped: 0 };
    return { added: r.added, total: Likes.count(), skipped: r.skipped + d.skipped, disliked: d.added };
  };

  /* ---------- dislikes as a negative signal ----------
   * hard (always): a disliked track never comes back (same id, or same title + artist on another upload); an artist with 2+
   * dislikes is excluded.  soft = negative taste profile, scaled by the Taste setting in app.js (Off 0 · Some · Strong): same artist −1,
   * shared disliked tags ≤ −0.6, genre ≤ −0.4 / mood ≤ −0.2 / tempo band −0.2 (only where dislikes outweigh likes). */
  const splitArtists = s => String(s || '').split(/\s*(?:[、，,;；]|\s(?:feat\.?|ft\.?|with)\s)\s*/i).map(norm).filter(a => a && a !== 'unknown' && a !== 'various artists');
  const songKey = t => norm(t.title).replace(/\s+/g, '') + '|' + norm(t.artist).replace(/\s+/g, '');
  function avoid(dis) {
    dis = dis || Dislikes.all(); if (!dis.length) return null;
    const A = { n: dis.length, ids: new Set(dis.map(keyOf)), songs: new Set(dis.map(songKey)), artists: new Map(), artistIds: new Map(), tags: new Map(), banned: new Set(), bannedIds: new Set(), topTags: [] };
    for (const t of dis) {
      new Set(splitArtists(t.artist)).forEach(a => bump(A.artists, a));
      if (t.artistId != null && t.artistId !== '') bump(A.artistIds, t.src + ':' + t.artistId);
      new Set(tagList(t.tags)).forEach(x => bump(A.tags, x));
    }
    A.artists.forEach((c, a) => { A.tags.delete(a); if (c >= 2) A.banned.add(a); });
    A.artistIds.forEach((c, k) => { if (c >= 2) A.bannedIds.add(k); });
    const liked = profile(Likes.all());                                         // styles you also like aren't held against a track
    A.topTags = [...A.tags.entries()].filter(x => !(liked && liked.tags.has(x[0]))).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(x => x[0]);
    const NP = profile(dis); A.genres = NP.genres; A.moods = NP.moods; A.bpm = NP.bpm;     // negative taste profile (same features likes use)
    A.likedBpm = liked && liked.bpm; A.likedGenres = liked ? liked.genres : new Map(); A.likedMoods = liked ? liked.moods : new Map();
    return A;
  }
  function blocked(t, A) {
    if (!A || !t) return false;
    return A.ids.has(keyOf(t)) || A.songs.has(songKey(t)) || A.bannedIds.has(t.src + ':' + t.artistId) || splitArtists(t.artist).some(a => A.banned.has(a));
  }
  function penalty(t, A) {
    if (!A || !t) return 0;
    let s = splitArtists(t.artist).some(a => A.artists.has(a)) || (t.artistId != null && A.artistIds.has(t.src + ':' + t.artistId)) ? 1 : 0;
    if (A.topTags.length) { const own = new Set(tagList(t.tags != null ? t.tags : t.signals && t.signals.tags)); let h = 0; for (const x of A.topTags) if (own.has(x)) h++; s += Math.min(0.6, h * 0.2); }
    // genre / mood / tempo features: only the part your dislikes outweigh your likes for
    const g = String(t.genre || '').toLowerCase(), net = (M, L, k) => Math.max(0, (M.get(k) || 0) / A.n - (L.get(k) || 0) / Math.max(1, Likes.count()));
    if (g && A.genres.has(g)) s += 0.4 * Math.min(1, 2 * net(A.genres, A.likedGenres, g));
    const m = String(t.mood || '').toLowerCase(); if (m && A.moods.has(m)) s += 0.2 * Math.min(1, 2 * net(A.moods, A.likedMoods, m));
    const inB = (B, b) => B && b && [b, b * 2, b / 2].some(x => x >= B.lo && x <= B.hi);
    if (A.n >= 3 && inB(A.bpm, t.bpm) && !inB(A.likedBpm, t.bpm)) s += 0.2;
    return s;
  }

  /* ---------- taste profile ---------- */
  const TAG_STOP = new Set(['music', 'new', 'remix', 'original', 'original mix', 'mix', 'edit', 'free', 'free download', 'beat', 'beats', 'song', 'track', 'audius', 'dj', 'producer', 'electronic', 'official', 'single']);
  const tagList = s => String(s || '').toLowerCase().split(/[,#;|]+/).map(x => x.trim()).filter(x => x.length >= 3 && x.length <= 30 && !TAG_STOP.has(x) && !/^\d+$/.test(x));
  const bump = (m, k, w = 1) => { if (k) m.set(k, (m.get(k) || 0) + w); };
  const quant = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];

  function profile(likes) {
    if (!likes || !likes.length) return null;
    const P = { n: likes.length, artists: new Map(), artistNames: new Map(), artistIds: new Set(), genres: new Map(), moods: new Map(), tags: new Map(),
      topTags: [], bpm: null, cams: [], depth: null, ids: new Set(likes.map(keyOf)) };
    const bpms = [], lps = [];
    for (const t of likes) {
      const an = norm(t.artist); if (an && an !== 'unknown') { bump(P.artists, an); if (!P.artistNames.has(an)) P.artistNames.set(an, t.artist); }
      if (t.artistId != null) P.artistIds.add(t.src + ':' + t.artistId);
      bump(P.genres, String(t.genre || '').toLowerCase()); bump(P.moods, String(t.mood || '').toLowerCase());
      new Set(tagList(t.tags)).forEach(x => bump(P.tags, x));
      if (t.bpm > 50 && t.bpm < 200) bpms.push(+t.bpm);
      const c = typeof camelot === 'function' ? camelot(t.key) : null; if (c && !P.cams.some(x => x.s === c.s)) P.cams.push(c);
      if (t.plays > 0) lps.push(Math.log10(t.plays + 1));
    }
    P.artists.forEach((_, a) => P.tags.delete(a));            // artist names in tags aren't a style
    P.topTags = [...P.tags.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 14).map(x => x[0]);
    if (bpms.length) { bpms.sort((a, b) => a - b); P.bpm = { lo: quant(bpms, 0.1) - 4, hi: quant(bpms, 0.9) + 4, mid: quant(bpms, 0.5) }; }
    if (lps.length) { lps.sort((a, b) => a - b); P.depth = { lo: lps[0] - 0.35, hi: lps[lps.length - 1] + 0.35 }; }
    return P;
  }

  /* points for "sounds like what you liked": artist 1, genre ≤0.6, mood 0.3, tags ≤0.8, tempo 0.35, key 0.2, depth 0.25, via similar() 0.3 */
  function similarity(t, P) {
    if (!P || !t) return 0;
    let s = 0;
    const an = norm(t.artist);
    if (P.artistIds.has(t.src + ':' + t.artistId) || (an && P.artists.has(an))) s += 1;
    const g = String(t.genre || '').toLowerCase(); if (g && P.genres.has(g)) s += 0.25 + 0.35 * Math.min(1, 2 * P.genres.get(g) / P.n);
    const m = String(t.mood || '').toLowerCase(); if (m && P.moods.has(m)) s += 0.3;
    if (P.topTags.length) {
      const own = new Set(tagList(t.tags != null ? t.tags : t.signals && t.signals.tags)); const blob = (String(t.title || '') + ' ' + g).toLowerCase();
      let hits = 0; for (const x of P.topTags) if (own.has(x) || blob.includes(x)) hits++;
      s += Math.min(0.8, hits * 0.25);
    }
    if (t.bpm && P.bpm && [t.bpm, t.bpm * 2, t.bpm / 2].some(b => b >= P.bpm.lo && b <= P.bpm.hi)) s += 0.35;
    if (P.cams.length && typeof camelot === 'function') { const c = t.cam || camelot(t.key); if (c && P.cams.some(x => keyDist(c, x) <= 0.6)) s += 0.2; }
    const p = (t.signals && t.signals.plays) || t.plays || 0;
    if (P.depth && p > 0) { const lp = Math.log10(p + 1); if (lp >= P.depth.lo && lp <= P.depth.hi) s += 0.25; }
    if (t.viaSimilar) s += 0.3;
    return s;
  }

  /* how strongly taste steers a set */
  const MODES = { off: { w: 0, artists: 0, tags: 0, similar: 0, likeShare: 0, likeMax: 0 },
    some: { w: 0.55, artists: 2, tags: 2, similar: 1, likeShare: 0.1, likeMax: 2 },
    strong: { w: 1.1, artists: 3, tags: 3, similar: 2, likeShare: 0.25, likeMax: 5 } };
  const mode = m => MODES[m] || MODES.some;      // default "Some" (only matters when likes exist)

  /* extra search terms from the profile: liked artists (most-liked first) + recurring tags */
  function seedQueries(P, m, shuffle) {
    const M = mode(m); if (!P || !M.w) return [];
    const arts = shuffle([...P.artists.keys()]).sort((a, b) => P.artists.get(b) - P.artists.get(a)).slice(0, M.artists).map(a => P.artistNames.get(a));
    const tags = P.topTags.filter(x => !arts.some(a => norm(a) === x)).slice(0, M.tags + 2);
    return arts.concat(shuffle(tags).slice(0, M.tags));
  }
  /* app genre ids whose provider genre filters match the most-liked genres (used when nothing is selected) */
  function genresFor(prov, P) {
    if (!P || !prov || !prov.genreFilters) return [];
    const sc = Object.entries(prov.genreFilters).map(([id, vals]) => [id, vals.reduce((s, v) => s + (P.genres.get(String(v).toLowerCase()) || 0) / (vals.length > 1 ? 1.5 : 1), 0)]).filter(x => x[1] > 0);
    return sc.sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
  }

  NS.taste = { Likes, Dislikes, avoid, blocked, penalty, DKEY, profile, similarity, seedQueries, genresFor, mode, MODES, KEY, FIELDS, tagList };
})();
