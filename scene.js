/* Muse — shared "scene" scorer: one generic ranking used by every provider / genre (no artist black- or white-lists).
 *   score(track) = proximity to the genre's seed artists   (co-occurrence: features / collabs, same album, same results)
 *                − mainstream penalty                       (play counts relative to the dug pool, per track and per artist)
 *                − variety-show / talent-show penalty       (title / album patterns: (Live), 现场, 综艺, Ep.3, 第3期, 《…说唱…》 …)
 * Likes / dislikes (taste.js) are added on top by app.js. Loaded after taste.js, before app.js; exposes window.NEONDJ.scene.
 */
(function () {
  'use strict';
  const NS = window.NEONDJ = window.NEONDJ || {};
  const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s.·•_\-']+/g, '').trim();
  /* one track's artists ("A、B", "A, B", "A feat. B", "A x B") — latin + CJK aliases kept whole */
  const splitRaw = t => String(t.artist || '').replace(/\s*[(（]\s*(explicit|clean)\s*[)）]/gi, '').split(/\s*(?:[、，,;；&/]|\s(?:feat\.?|ft\.?|with|x|×)\s)\s*/i).map(x => x.trim()).filter(Boolean);
  const artistsOf = t => splitRaw(t).map(norm).filter(a => a && a !== 'unknown');
  /* featured artists / producers named in the title: "Song (feat. X)", "ft.X", "(Prod.Y)" */
  const featOf = t => { const m = String(t.title || '').match(/(?:feat\.?|ft\.?|with|prod\.?(?:\s*by)?\s*[:：]?)\s*([^)）\]]+)/i); return m ? m[1].split(/\s*[、,&/]\s*/).map(norm).filter(x => x.length >= 2) : []; };

  /* variety-show / talent-show / live-stage markers (generic patterns, no names) */
  const VARIETY = [
    /[(（\[【]\s*live\s*[)）\]】]|\blive\s*(版|ver\.?|version)\b|现场|舞台版|演唱会/i,                                   // live-stage cuts
    /综艺|节目|选秀|海选|公演|淘汰|晋级|battle\s*(版|round)|cypher\s*(版|现场)|第\s*[0-9一二三四五六七八九十]+\s*期|\bep\.?\s*\d+|\bepisode\b/i,   // show episodes / rounds
    /《[^》]*(说唱|嘻哈|rap|hip-?hop|新世代|听我的|有嘻哈|好声音|歌手|街舞|乐队|偶像|创造|青春有你|少年)[^》]*》/i,          // 《…show…》 tags
    /中国有嘻哈|中国新说唱|说唱新世代|说唱听我的|少年说唱企划|rap\s*of\s*china|the\s*rap\s*of|说唱梦工厂/i,
  ];
  const variety = t => { const s = `${t.title || ''} ${t.album || ''}`; let v = 0; VARIETY.forEach((re, i) => { if (re.test(s)) v += i === 0 ? 1 : 1.5; }); return Math.min(2, v); };

  /* co-occurrence graph from everything the dig saw (playable or not): seed = 1, collaborator of a seed ≈ 0.6–0.9,
   * collaborator of a collaborator ≈ 0.3, same album as a seed track 0.4, merely in a seed's search results 0.1 each (≤ 0.3) */
  function graph(tracks, seeds, seedHits) {
    const S = new Set((seeds || []).map(norm)), w = new Map(), edges = new Map();
    if (!S.size) return { w, S, empty: true };
    const link = (a, b) => { if (a === b) return; if (!edges.has(a)) edges.set(a, new Map()); const m = edges.get(a); m.set(b, (m.get(b) || 0) + 1); };
    const albumsOfSeeds = new Set();
    for (const t of tracks) {
      const as = [...new Set(artistsOf(t).concat(featOf(t)))];
      as.forEach(a => as.forEach(b => link(a, b)));
      if (t.album && as.some(a => S.has(a) || [...S].some(s => a.includes(s)))) albumsOfSeeds.add(norm(t.album));
    }
    const isSeed = a => S.has(a) || [...S].some(s => s.length >= 3 && a.includes(s));   // "艾志恒asen" ∋ "asen"
    const all = new Set([...edges.keys()]); tracks.forEach(t => artistsOf(t).forEach(a => all.add(a)));
    all.forEach(a => { if (isSeed(a)) w.set(a, 1); });
    const hop = (base, k, cap) => { const nw = new Map(); edges.forEach((m, a) => { if (w.get(a) >= 1) return; let s = 0; m.forEach((c, b) => { const wb = base.get(b) || 0; if (wb) s += k * wb * Math.min(2, c); }); if (s) nw.set(a, Math.min(cap, s)); }); return nw; };
    const h1 = hop(w, 0.6, 0.9); h1.forEach((v, a) => w.set(a, Math.max(w.get(a) || 0, v)));
    const h2 = hop(new Map([...h1]), 0.35, 0.4); h2.forEach((v, a) => { if (!w.has(a)) w.set(a, v); });
    for (const t of tracks) if (t.album && albumsOfSeeds.has(norm(t.album))) artistsOf(t).forEach(a => w.set(a, Math.max(w.get(a) || 0, 0.4)));
    if (seedHits) seedHits.forEach(t => artistsOf(t).forEach(a => { if (!w.has(a) || w.get(a) < 0.3) w.set(a, Math.min(0.3, (w.get(a) || 0) + 0.1)); }));
    const names = new Map(); tracks.forEach(t => splitRaw(t).forEach(r => { const k = norm(r); if (!names.has(k)) names.set(k, r); }));
    return { w, S, names };
  }
  const proximity = (t, G) => { if (!G || G.empty) return 0; let p = 0; artistsOf(t).concat(featOf(t)).forEach(a => { p = Math.max(p, G.w.get(a) || 0); }); return p; };
  /* collaborators worth a second-hop search (not seeds, strongest links first) */
  const expand = (G, k) => G && !G.empty ? [...G.w.entries()].filter(x => x[1] < 1 && x[1] >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, k).map(x => G.names.get(x[0]) || x[0]) : [];

  /* mainstream penalty relative to the pool: 0 up to the median, rising to ~1.5 for the pool's chart-toppers;
   * an artist's biggest track counts too (a mass-market act's quieter songs still lean mainstream) */
  function popularity(pool) {
    const lp = t => Math.log10(((t.signals && t.signals.plays) || t.plays || 0) + 1);
    const xs = pool.map(lp).filter(x => x > 0).sort((a, b) => a - b);
    if (xs.length < 5) return () => 0;
    const q = f => xs[Math.min(xs.length - 1, Math.round(f * (xs.length - 1)))], med = q(0.5), hi = Math.max(q(0.9), med + 0.3);
    const byArtist = new Map(); pool.forEach(t => artistsOf(t).forEach(a => byArtist.set(a, Math.max(byArtist.get(a) || 0, lp(t)))));
    const f = x => Math.max(0, Math.min(1.5, (x - med) / (hi - med)));
    return t => { const a = Math.max(0, ...artistsOf(t).map(x => byArtist.get(x) || 0)); return 0.6 * f(lp(t)) + 0.6 * f(a); };
  }

  /* the one scorer: weights can be tuned per call; returns { s, parts } */
  function score(t, ctx) {
    const prox = proximity(t, ctx.G), pop = ctx.pop ? ctx.pop(t) : 0, vs = variety(t);
    const s = (ctx.wProx ?? 2) * prox - (ctx.wPop ?? 1) * pop - (ctx.wVar ?? 2) * vs;
    return { s, prox, pop, vs };
  }

  NS.scene = { artistsOf, variety, graph, proximity, expand, popularity, score, VARIETY, norm };
})();
