/* Muse provider: QQ Music QQ音乐 — keyless, called straight from the page (JSONP, no proxy).
 *  - search:  c.y.qq.com/soso/fcgi-bin/client_search_cp (JSONP, param jsonpCallback)
 *  - stream:  u.y.qq.com/cgi-bin/musicu.fcg vkey.GetVkeyServer (JSONP) -> https://ws.stream.qqmusic.qq.com/C400….m4a
 *             The audio CDN sends Access-Control-Allow-Origin: *, so the mixer can analyse it.
 *  - QQ Music only hands out stream keys for free songs to listeners in mainland China. Elsewhere every
 *    song comes back without a URL; the dig then finds nothing and the app falls back to Audius.
 *  - free songs only: paid / VIP songs (pay.payplay = 1, or no URL) are skipped. No login, no cookies.
 *  - m4a files: analysed whole (no Range slicing), like the iTunes path. */
(function () {
  'use strict';
  const P = window.NEONDJ.providers, { jsonp } = P.net, CN = P.cn;
  const URL_TTL = 15 * 60 * 1000;
  const guid = String(Math.floor(Math.random() * 9e9) + 1e9);

  const QQ = {
    id: 'qqmusic', name: 'QQ Music', label: 'QQ Music QQ音乐', hint: 'Free tracks · plays in mainland China only', fallback: 'audius',
    capabilities: { fullTrack: true, hasBpmKey: false, rangeRequests: false, filters: false, trending: false, crate: 'simple' },
    keywords: CN.KEYWORDS,
    async search(term, { limit = 30 } = {}) {
      const u = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(term) + `&p=1&n=${limit}&format=jsonp&inCharset=utf8&outCharset=utf-8`;
      const r = await jsonp(u, { param: 'jsonpCallback', timeout: 10000 });
      return ((r && r.data && r.data.song && r.data.song.list) || []).filter(s => s && s.songmid).map(s => this.toTrack(s, term));
    },
    getStreamUrl(track) { return track.url || ''; },
    async resolveStream(track) {
      if (track.url && Date.now() - (track._resolvedAt || 0) < URL_TTL) return track;
      const data = { req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, songmid: [track.mid], songtype: [0], uin: '0', loginflag: 1, platform: '20' } },
        comm: { uin: 0, format: 'json', ct: 24, cv: 0 } };
      const r = await jsonp('https://u.y.qq.com/cgi-bin/musicu.fcg?format=jsonp&data=' + encodeURIComponent(JSON.stringify(data)), { timeout: 10000 });
      const d = r && r.req_0 && r.req_0.data, info = d && d.midurlinfo && d.midurlinfo[0];
      const host = (d && d.sip && d.sip.find(h => /^https?:/.test(h))) || 'https://ws.stream.qqmusic.qq.com/';
      if (!info || !info.purl) { track.playable = false; track.url = ''; throw new Error('QQ Music: no free stream here (paid song or outside mainland China)'); }
      track.url = CN.https(host) + info.purl; track._resolvedAt = Date.now();
      return track;
    },
    toTrack(s, term) {
      const art = s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '';
      const singer = (s.singer && s.singer[0]) || {};
      return P.normalize({ src: 'qqmusic', id: 'qq' + s.songmid, mid: s.songmid, title: CN.stripTags(s.songname) || 'Untitled', artist: (s.singer || []).map(x => x.name).join(', ') || 'Unknown',
        artistId: singer.mid || singer.id || singer.name, art, artSmall: art.replace('300x300', '150x150'), dur: +s.interval || 0, preview: false, bpm: null, key: null,
        genre: '', mood: '', tags: term || '', url: '', link: 'https://y.qq.com/n/ryqq/songDetail/' + s.songmid, plays: 0, prior: CN.prior(term), year: s.pubtime ? new Date(s.pubtime * 1000).getFullYear() : null,
        playable: !(s.pay && +s.pay.payplay === 1), signals: { tags: term || '' } });
    },
  };
  P.register(QQ);
})();
