/* Muse provider: NetEase Cloud Music 网易云音乐 — needs a small CORS proxy (see providers/proxy/).
 * music.163.com sends no CORS headers and has no JSONP, so a page on github.io cannot read its answers directly.
 * Hidden from the Source menu until a proxy URL is saved under Advanced → NetEase proxy.
 *  - search:  <proxy>/netease/api/cloudsearch/pc       (plain JSON API, no weapi/eapi encryption needed)
 *  - stream:  <proxy>/netease/api/song/enhance/player/url?ids=[id]&br=128000  -> https://m*.music.126.net/… mp3
 *             (URLs expire after ~20 min; the audio CDN sends Access-Control-Allow-Origin: *, so the
 *             browser fetches audio directly — the proxy only carries two small JSON calls.)
 *  - free songs only: VIP / paid songs (fee 1 or 4), region-blocked songs (privilege.st < 0) and 30 s trial
 *    clips are skipped. No login, no cookies, no region spoofing.
 *  - NetEase decides availability by the requesting IP — i.e. the proxy's. A proxy outside mainland China
 *    (Cloudflare Workers usually are) sees most of the catalogue as unavailable; only part of it plays. */
(function () {
  'use strict';
  const P = window.NEONDJ.providers, { fetchJSON } = P.net, CN = P.cn;
  const URL_TTL = 15 * 60 * 1000;
  const base = () => P.settings.get('neteaseProxy').replace(/\/+$/, '');

  const NetEase = {
    id: 'netease', name: 'NetEase Cloud Music', label: 'NetEase 网易云', hint: 'Free tracks via your proxy', fallback: 'audius',
    capabilities: { fullTrack: true, hasBpmKey: false, rangeRequests: true, filters: false, trending: false, crate: 'simple' },
    keywords: CN.KEYWORDS,
    available() { return /^https:\/\//.test(base()) || /^http:\/\/(localhost|127\.)/.test(base()); },
    async search(term, { limit = 30 } = {}) {
      if (!this.available()) throw new Error('NetEase proxy not configured');
      const r = await fetchJSON(`${base()}/netease/api/cloudsearch/pc?type=1&offset=0&limit=${limit}&s=` + encodeURIComponent(term), 12000);
      return ((r && r.result && r.result.songs) || []).filter(Boolean).map(s => this.toTrack(s, term));
    },
    getStreamUrl(track) { return track.url || ''; },
    async resolveStream(track) {
      if (track.url && Date.now() - (track._resolvedAt || 0) < URL_TTL) return track;
      const r = await fetchJSON(`${base()}/netease/api/song/enhance/player/url?br=128000&ids=` + encodeURIComponent(`[${track.nid}]`), 12000);
      const d = r && r.data && r.data[0];
      if (!d || !d.url || d.freeTrialInfo) { track.playable = false; track.url = ''; throw new Error('NetEase: no free full stream for this song'); }
      track.url = CN.https(d.url); track._resolvedAt = Date.now();
      return track;
    },
    toTrack(s, term) {
      const al = s.al || {}, ar = s.ar || [], pv = s.privilege || {};
      const art = al.picUrl ? CN.https(al.picUrl) : '';
      return P.normalize({ src: 'netease', id: 'ne' + s.id, nid: s.id, title: s.name || 'Untitled', artist: ar.map(a => a.name).join(', ') || 'Unknown', artistId: (ar[0] && ar[0].id) || s.id,
        art: art ? art + '?param=400y400' : '', artSmall: art ? art + '?param=150y150' : '', dur: (s.dt || 0) / 1000, preview: false, bpm: null, key: null,
        genre: '', mood: '', tags: term || '', url: '', link: 'https://music.163.com/#/song?id=' + s.id, plays: 0, prior: CN.prior(term),
        playable: s.fee !== 1 && s.fee !== 4 && (pv.st == null || pv.st >= 0) && (pv.pl == null || pv.pl > 0), signals: { tags: term || '' } });
    },
  };
  P.register(NetEase);
})();
