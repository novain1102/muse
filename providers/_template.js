/* Muse provider TEMPLATE — copy to providers/<id>.js, fill in, and add a <script> tag for it in
 * index.html AFTER providers/registry.js and BEFORE app.js. Not loaded by default; it registers nothing
 * until you uncomment the P.register(...) line at the bottom.
 *
 * Full interface + normalized Track field list: providers/registry.js (top comment).
 * Rules of thumb:
 *   - Only this file may know the source's URLs, auth, raw JSON field names and genre/mood vocabulary.
 *   - search() must return normalized Tracks (use P.normalize on what you build). Return [] rather than
 *     throwing for "no results"; throw for network/auth errors (the app then tries `fallback`).
 *   - Track ids must be unique across providers: prefix them (e.g. 'ne' + songId, 'qq' + songmid).
 *   - The browser must be allowed to fetch your API and stream URLs (CORS for fetch(); the <audio>
 *     element itself needs no CORS, but the in-browser BPM/energy analysis does — without it tracks
 *     still play, they just skip analysis). Sources without browser-friendly endpoints need a small proxy.
 */
(function () {
  'use strict';
  const P = window.NEONDJ.providers, { fetchJSON } = P.net;   // fetchJSON: timeout + one retry on 429/5xx

  const MyProvider = {
    id: 'example',                       // stable id; saved in localStorage as the selected Source
    name: 'Example',                     // used in status lines: "Connecting to Example…"
    label: 'Example (full tracks)',      // text in the Source menu
    fallback: 'itunes',                  // optional: provider tried when this one fails / returns nothing
    capabilities: {
      fullTrack: true,                   // false if only previews are playable (then set previewSeconds)
      previewSeconds: 30,
      hasBpmKey: false,                  // true if Track.bpm / Track.key come from the source
      rangeRequests: false,              // true if stream URLs honour HTTP Range (cheaper analysis)
      filters: false,                    // true if search() uses opts.genres / opts.moods
      trending: false,                   // true if trending() is implemented
      similar: false,                    // true if similar() is implemented
      crate: 'simple',                   // 'scored' only if you can fill Track.signals (plays, likes, …)
      rateLimited: false,
    },
    // app genre / mood ids -> this source's filter values (only used when capabilities.filters is true).
    // App ids: house deep-house tech-house techno progressive electro disco dnb bass hiphop lofi downtempo
    //          chill groovy deep dreamy dark happy energetic
    genreFilters: { /* 'house': ['House'], 'techno': ['Techno'], … */ },
    moodFilters: { /* 'chill': ['Relaxed'], … */ },

    async init() { /* optional: discover a host, refresh a token, … (called before every dig) */ },

    async search(query, { genres = [], moods = [], limit = 50 } = {}) {
      // const r = await fetchJSON(`https://api.example.com/search?q=${encodeURIComponent(query)}&limit=${limit}`, 12000);
      // return (r.items || []).map(x => this.toTrack(x));
      return [];
    },

    // async trending(sourceGenre) { return (await …).map(x => this.toTrack(x, true)); },

    // "More like this" for a liked track of this provider (e.g. a song radio / related-songs endpoint).
    // async similar(track, { limit = 24 } = {}) { return (await …).map(x => this.toTrack(x)); },

    getStreamUrl(track) {
      // return `https://api.example.com/stream/${encodeURIComponent(track.id.slice(2))}`;
      return track.url;
    },

    // Optional, for signed / short-lived URLs: called right before a deck loads the track, before analysis
    // fetches it, and when a playing deck errors. Set track.url (and optionally track.alt).
    // async resolveStream(track) { const r = await fetchJSON(`https://api.example.com/url?id=${…}`); track.url = r.url; },

    toTrack(x, trending = false) {
      return P.normalize({
        src: this.id, id: 'ex' + x.id, title: x.title || 'Untitled', artist: x.artist || 'Unknown', artistId: x.artistId || x.artist,
        art: x.coverLarge || '', artSmall: x.coverSmall || x.coverLarge || '', artMirrors: [],
        dur: (x.durationMs || 0) / 1000,          // for previews: the clip length; put the song length in fullDur
        preview: false,
        bpm: x.bpm > 50 && x.bpm < 200 ? +x.bpm : null, key: x.key || null,   // key text, e.g. 'A minor' / 'F#m'
        genre: x.genre || '', mood: x.mood || '', tags: (x.tags || []).join(','), prior: 0.5,                 // prior: 0..1 energy guess
        url: x.streamUrl || '', alt: null, link: x.pageUrl || '', plays: x.plays || 0,
        playable: x.playable !== false, listed: true,
        signals: { plays: x.plays, likes: x.likes, reposts: x.shares, followers: x.artistFollowers, hasArt: !!x.coverLarge, trending, tags: '', description: '' },
      });
    },
  };

  // P.register(MyProvider);
})();
