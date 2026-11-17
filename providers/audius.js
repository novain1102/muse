/* Muse provider: Audius (free, artist-uploaded, full tracks, BPM + key metadata).
 * Everything Audius-specific lives here: API host discovery, query params, genre/mood vocabulary,
 * raw field names, stream URLs, artwork mirrors and the mood -> energy prior. See registry.js for the interface. */
(function () {
  'use strict';
  const P = window.NEONDJ.providers, { fetchJSON } = P.net;
  const APP_NAME = 'NEON_DJ_browser';
  const API = 'https://api.audius.co';

  // app genre id -> Audius genre filter values
  const GENRE_FILTERS = {
    'house': ['House', 'Deep House'], 'deep-house': ['Deep House'], 'tech-house': ['Tech House'], 'techno': ['Techno'],
    'progressive': ['Progressive House', 'Trance'], 'electro': ['Electro', 'Electronic'], 'disco': ['Disco', 'Funk'],
    'dnb': ['Drum & Bass', 'Jungle'], 'bass': ['Dubstep', 'Trap'], 'hiphop': ['Hip-Hop/Rap'], 'lofi': ['Lo-Fi'], 'downtempo': ['Downtempo', 'Ambient'],
  };
  // app mood id -> Audius mood filter values
  const MOOD_FILTERS = {
    'chill': ['Peaceful', 'Easygoing', 'Cool', 'Tender'], 'groovy': ['Cool', 'Upbeat', 'Sensual', 'Easygoing'],
    'deep': ['Sophisticated', 'Yearning', 'Brooding', 'Cool'], 'dreamy': ['Yearning', 'Sentimental', 'Sophisticated', 'Tender'],
    'dark': ['Brooding', 'Gritty', 'Serious', 'Melancholy'], 'happy': ['Upbeat', 'Excited', 'Empowering', 'Romantic'],
    'energetic': ['Energizing', 'Excited', 'Rowdy', 'Fiery', 'Aggressive'],
  };
  // energy prior for every Audius mood tag
  const MOOD_E = { Peaceful: .15, Tender: .2, Romantic: .3, Sentimental: .3, Easygoing: .35, Melancholy: .35, Yearning: .4, Sophisticated: .45, Cool: .45, Sensual: .45,
    Brooding: .55, Serious: .55, Gritty: .65, Upbeat: .65, Stirring: .6, Empowering: .7, Defiant: .7, Excited: .78, Energizing: .82, Fiery: .85, Rowdy: .88, Aggressive: .9, Other: .5 };

  const Audius = {
    id: 'audius', name: 'Audius', label: 'Audius', hint: 'Independent artists · full tracks', isDefault: true, fallback: 'itunes',
    capabilities: { fullTrack: true, hasBpmKey: true, rangeRequests: true, filters: true, trending: true, similar: true, crate: 'scored', rateLimited: true },
    genreFilters: GENRE_FILTERS, moodFilters: MOOD_FILTERS,
    host: null,
    async init() {
      if (this.host) return this.host;
      try {
        const r = await fetchJSON(API, 8000);
        const hosts = (r && r.data) || [];
        this.host = hosts.length ? hosts[Math.floor(Math.random() * hosts.length)] : API;
      } catch (e) { this.host = API; }
      return this.host;
    },
    async search(query, { genres = [], moods = [], limit = 50 } = {}) {
      const u = new URL(this.host + '/v1/tracks/search');
      u.searchParams.set('query', query); u.searchParams.set('app_name', APP_NAME); u.searchParams.set('limit', limit);
      genres.forEach(g => u.searchParams.append('genre', g)); moods.forEach(m => u.searchParams.append('mood', m));
      const r = await fetchJSON(u.toString(), 12000); return ((r && r.data) || []).filter(Boolean).map(t => this.toTrack(t));
    },
    async trending(genre) {
      const u = new URL(this.host + '/v1/tracks/trending');
      u.searchParams.set('app_name', APP_NAME); u.searchParams.set('time', 'month'); if (genre) u.searchParams.set('genre', genre);
      const r = await fetchJSON(u.toString(), 12000); return ((r && r.data) || []).filter(Boolean).map(t => this.toTrack(t, true));
    },
    /* "more like this": Audius has no per-track related endpoint, but it has related artists
     * (/v1/users/{id}/related). Returns tracks by the first 3 artists related to the track's artist. */
    async similar(track, { limit = 24 } = {}) {
      if (!track || !track.artistId) return [];
      const rel = await fetchJSON(`${this.host}/v1/users/${encodeURIComponent(track.artistId)}/related?limit=6&app_name=${APP_NAME}`, 12000);
      const users = ((rel && rel.data) || []).filter(u => u && u.id).slice(0, 3);
      const lists = await Promise.all(users.map(u => fetchJSON(`${this.host}/v1/users/${encodeURIComponent(u.id)}/tracks?limit=10&app_name=${APP_NAME}`, 12000)
        .then(r => (r && r.data) || [], () => [])));
      return lists.flat().filter(Boolean).map(t => this.toTrack(t)).slice(0, limit);
    },
    streamUrl(id) { return `${this.host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${APP_NAME}`; },
    getStreamUrl(track) { return this.streamUrl(track.id); },
    /* raw Audius track -> normalized Track */
    toTrack(t, trending = false) {
      const art = t.artwork || {};
      return P.normalize({ src: 'audius', id: t.id, title: (t.title || 'Untitled').trim(), artist: (t.user && t.user.name) || 'Unknown', artistId: (t.user && t.user.id) || t.user_id || t.id,
        art: art['480x480'] || art['150x150'] || '', artMirrors: art.mirrors || [], artSmall: art['150x150'] || art['480x480'] || '', dur: t.duration || 0, preview: false,
        bpm: t.bpm && t.bpm > 50 && t.bpm < 200 ? +t.bpm : null, key: t.musical_key || null,
        genre: t.genre || '', mood: t.mood || '', tags: t.tags || '', url: this.streamUrl(t.id), alt: (t.stream && t.stream.url) || null, link: t.permalink ? 'https://audius.co' + t.permalink : '',
        plays: t.play_count || 0, prior: MOOD_E[t.mood] ?? 0.5, year: +String(t.release_date || t.created_at || '').slice(0, 4) || null,
        playable: t.is_streamable !== false && !t.is_stream_gated,
        listed: !t.is_unlisted && (!t.access || t.access.stream !== false),
        signals: { rawTitle: t.title || '', plays: t.play_count || 0, likes: t.favorite_count || 0, reposts: t.repost_count || 0,
          followers: (t.user && t.user.follower_count) || 0, artistName: (t.user && t.user.name) || '', artistKey: t.user ? t.user.id : t.user_id,
          bpm: t.bpm || null, hasArt: !!art['480x480'], trending, tags: t.tags || '', description: t.description || '' } });
    },
  };
  P.register(Audius);
})();
