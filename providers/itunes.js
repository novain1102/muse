/* Muse provider: iTunes Search API — 30 s previews only, no BPM/key. Used as Audius's fallback
 * and selectable as "iTunes (30s previews)". See registry.js for the interface. */
(function () {
  'use strict';
  const P = window.NEONDJ.providers, { fetchJSON } = P.net;

  const ITunes = {
    id: 'itunes', name: 'iTunes', label: 'iTunes previews', hint: '30-second previews',
    capabilities: { fullTrack: false, previewSeconds: 30, hasBpmKey: false, rangeRequests: false, filters: false, trending: false, crate: 'simple' },
    async search(term, { limit = 50 } = {}) {
      const u = `https://itunes.apple.com/search?media=music&entity=song&limit=${limit}&term=${encodeURIComponent(term)}`;
      const r = await fetchJSON(u, 12000); return ((r && r.results) || []).filter(Boolean).map(t => this.toTrack(t));
    },
    getStreamUrl(track) { return track.url; },   // previewUrl is already a direct, unsigned m4a link
    /* raw iTunes result -> normalized Track */
    toTrack(t) {
      return P.normalize({ src: 'itunes', id: 'it' + t.trackId, title: t.trackName, artist: t.artistName, artistId: t.artistId, art: (t.artworkUrl100 || '').replace('100x100', '400x400'),
        artSmall: t.artworkUrl100 || '', dur: 30, fullDur: (t.trackTimeMillis || 0) / 1000, preview: true, bpm: null, key: null, genre: t.primaryGenreName || '', mood: '', tags: '',
        url: t.previewUrl, link: t.trackViewUrl || '', plays: 0, prior: 0.5, playable: !!t.previewUrl });
    },
  };
  P.register(ITunes);
})();
