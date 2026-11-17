/* Muse provider: Kugou Music 酷狗音乐 — keyless, called straight from the page.
 *  - search:  songsearch.kugou.com/song_search_v2 (JSONP; the API sends no CORS headers but honours a callback)
 *  - stream:  m.kugou.com/app/i/getSongInfo.php?cmd=playInfo (JSONP) -> https://sharefs.kugou.com/… mp3
 *             The audio CDN answers with Access-Control-Allow-Origin: * and supports Range, so the mixer can
 *             analyse and route it through Web Audio like any other source.
 *  - only what Kugou serves for free to an anonymous listener: paid songs (music-pack flag in search, or
 *    no URL / pay_type / privilege 10 in play info) are skipped, no login, no paid quality tiers. Standard 128 kbps only.
 *  - no BPM / key metadata: the app's in-browser analysis fills tempo and beat phase ('simple' crate). */
(function () {
  'use strict';
  const P = window.NEONDJ.providers, { jsonp } = P.net, CN = P.cn;
  const cache = new Map();
  const URL_TTL = 15 * 60 * 1000;   // playInfo URLs carry a timestamp; refresh before a deck loads if older than this

  const Kugou = {
    id: 'kugou', name: 'Kugou', label: 'Kugou 酷狗', hint: 'Free full tracks · no account', fallback: 'audius',
    capabilities: { fullTrack: true, hasBpmKey: false, rangeRequests: true, filters: false, trending: false, crate: 'simple', resolveConcurrency: 2, searchConcurrency: 1, rateLimited: true },   // parallel searches come back empty,
    keywords: CN.KEYWORDS,
    stats: { free: 0, paid: 0, noAnswer: 0 }, _lastSearch: 0,   // resolve outcomes (debugging / tests)
    async search(term, { limit = 30 } = {}) {
      const u = 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(term) + `&page=1&pagesize=${limit}&platform=WebFilter&format=jsonp`;
      // the search API answers empty pages when hit in bursts: keep searches ~0.5 s apart, retry an empty page once
      const gap = 500 - (Date.now() - this._lastSearch); if (gap > 0) await P.net.sleep(gap);
      this._lastSearch = Date.now();
      let r = await jsonp(u, { timeout: 10000 }).catch(() => null);
      if (!(r && r.data && r.data.lists && r.data.lists.length)) { await P.net.sleep(1200 + Math.random() * 600); this._lastSearch = Date.now(); r = await jsonp(u, { timeout: 10000 }).catch(() => r); }
      return ((r && r.data && r.data.lists) || []).filter(s => s && s.FileHash).map(s => this.toTrack(s, term));
    },
    getStreamUrl(track) { return track.url || ''; },
    /* fetch (or refresh) the free stream URL right before analysis / deck load */
    async resolveStream(track) {
      if (track.url && Date.now() - (track._resolvedAt || 0) < URL_TTL) return track;
      const c = cache.get(track.hash);   // shared across digs: rebuilding a set doesn't re-ask for the same songs
      if (c && Date.now() - c.at < URL_TTL) { if (c.bad) { track.playable = false; throw new Error('Kugou: not free to stream'); } Object.assign(track, { url: c.url, alt: c.alt, _resolvedAt: c.at }); if (c.dur) track.dur = c.dur; return track; }
      const ask = () => jsonp('https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + encodeURIComponent(track.hash) + '&format=jsonp', { timeout: 10000 }).catch(() => null);
      let r = await ask();
      // no answer / no URL without a "paid" flag = usually throttling after a burst: back off once and ask again
      if (!(r && r.url) && !(r && (r.pay_type || (r.privilege | 0) >= 10))) { await P.net.sleep(900 + Math.random() * 900); r = await ask(); }
      const url = r && r.url ? CN.https(r.url) : '';
      this.stats[r && r.url && !r.pay_type && (r.privilege | 0) < 10 ? 'free' : r && (r.pay_type || (r.privilege | 0) >= 10) ? 'paid' : 'noAnswer']++;
      if (!url || r.pay_type || (r.privilege | 0) >= 10) { if (r && (r.url || r.pay_type || (r.privilege | 0) >= 10)) cache.set(track.hash, { bad: true, at: Date.now() }); track.playable = false; track.url = ''; throw new Error('Kugou: not free to stream'); }
      track.url = url; track.alt = (r.backup_url && r.backup_url[0]) ? CN.https(r.backup_url[0]) : null; track._resolvedAt = Date.now();
      if (r.timeLength) track.dur = +r.timeLength;
      cache.set(track.hash, { url: track.url, alt: track.alt, dur: track.dur, at: track._resolvedAt });
      return track;
    },
    /* raw search hit -> normalized Track (url is filled lazily by resolveStream) */
    toTrack(s, term) {
      const img = CN.https(s.Image || (s.trans_param && s.trans_param.union_cover) || '');
      const singer = (s.Singers && s.Singers[0]) || {};
      const title = CN.stripTags(s.SongName) + (s.Suffix && !/\(|（/.test(s.SongName) ? ' ' + s.Suffix : '');
      return P.normalize({ src: 'kugou', id: 'kg' + String(s.FileHash).toLowerCase(), hash: s.FileHash, title, artist: CN.stripTags(s.SingerName) || 'Unknown',
        artistId: singer.id || CN.stripTags(s.SingerName), art: img.replace('{size}', '400'), artSmall: img.replace('{size}', '150'),
        dur: +s.Duration || 0, preview: false, bpm: null, key: null, genre: '', mood: '', tags: [term, s.trans_param && s.trans_param.language].filter(Boolean).join(', '),
        url: '', link: 'https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyWord=' + encodeURIComponent(title), plays: +s.OwnerCount || 0, prior: CN.prior(term), year: +(String(s.PublishDate || '').slice(0, 4)) || null,
        // musicpack_advance = 1: needs Kugou's music pack (paid); Privilege 5 is almost always unavailable too.
        // Filtering here saves a play-info request per paid song; resolveStream() still has the final say.
        playable: !(s.trans_param && s.trans_param.musicpack_advance === 1) && (s.Privilege | 0) !== 5, signals: { tags: term || '' } });
    },
  };
  P.register(Kugou);
})();
