/* Muse — browser DJ: builds a set from a vibe and mixes it live (no build step, no LLM by default)
 * Everything here is deterministic scripting + heuristics in the browser:
 *  - crate digging: curated seed keywords per genre/mood -> music provider search (providers/) -> taste scoring
 *  - music sources are pluggable: see providers/registry.js (interface + normalized Track) and providers/README.md
 *  - sequencing: energy arc + tempo/key continuity + artist variety (local search)
 *  - analysis: onset-envelope autocorrelation for tempo/beat-phase, RMS for energy/loudness
 *  - mixing: two decks, beat-quantized scripted transitions, Web Audio FX
 */
'use strict';

const Providers = window.NEONDJ.providers;   // provider registry (providers/registry.js, loaded before this file)
const { fetchJSON } = Providers.net;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* seeded PRNG so a given build is reproducible within the session */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rng = mulberry32(Date.now() & 0xffffffff);
const pick = arr => arr[Math.floor(rng() * arr.length)];
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------- curated crate: genres ---------- */
// seeds: sub-genre / scene / texture terms a selector would dig with (source-specific genre filters live in each provider's genreFilters)
const GENRES = {
  'house':      { label: 'House', zh: '浩室', bpm: [118, 128],
                  seeds: ['jackin house', 'chicago house', 'soulful house', 'garage house', 'dub house', 'raw house', 'lo-fi house', 'organic house', 'afro house', 'warehouse house', 'rhodes', 'classic house'] },
  'deep-house': { label: 'Deep House', zh: '深浩室', bpm: [114, 124],
                  seeds: ['deep house', 'late night', 'dub', 'jazzy', 'soulful deep', 'rhodes chords', 'balearic', 'organic deep', 'minimal deep', 'afterhours'] },
  'tech-house': { label: 'Tech House', zh: '科技浩室', bpm: [122, 130],
                  seeds: ['minimal tech', 'rolling', 'groovy tech', 'percussive', 'bassline', 'underground', 'tribal', 'microhouse', 'dub tech'] },
  'techno':     { label: 'Techno', zh: '科技', bpm: [124, 140],
                  seeds: ['hypnotic techno', 'dub techno', 'minimal techno', 'deep techno', 'raw techno', 'industrial', 'acid', 'detroit', 'warehouse', 'melodic techno', 'tribal techno', 'berlin'] },
  'progressive':{ label: 'Progressive / Melodic', zh: '渐进', bpm: [120, 132],
                  seeds: ['progressive', 'melodic', 'deep progressive', 'afterhours', 'atmospheric', 'organic progressive', 'emotive', 'sunrise'] },
  'electro':    { label: 'Electro / Breaks', zh: '电气/碎拍', bpm: [120, 135],
                  seeds: ['electro', 'breakbeat', 'breaks', 'uk garage', 'leftfield', 'idm', 'broken beat', 'electronica'] },
  'disco':      { label: 'Disco / Nu-Disco', zh: '迪斯科', bpm: [110, 124],
                  seeds: ['nu disco', 'disco edit', 'boogie', 'italo', 'cosmic disco', 'funky', 'balearic disco', 'french touch'] },
  'dnb':        { label: 'Drum & Bass', zh: '鼓打贝斯', bpm: [168, 176],
                  seeds: ['liquid', 'rollers', 'minimal dnb', 'atmospheric', 'jungle', 'deep dnb', 'autonomic', 'halftime'] },
  'bass':       { label: 'Dubstep / Bass', zh: '低音', bpm: [138, 150],
                  seeds: ['deep dubstep', 'dub', 'halftime', '140', 'garage', 'wave', 'future garage', 'sub bass'] },
  'hiphop':     { label: 'Hip-Hop / Beats', zh: '嘻哈', bpm: [80, 98],
                  seeds: ['boom bap', 'instrumental', 'jazz rap', 'underground hip hop', 'beat tape', 'abstract', 'soulful beats', 'sample'] },
  'lofi':       { label: 'Lo-Fi', zh: '低保真', bpm: [70, 92],
                  seeds: ['lofi beats', 'jazzhop', 'tape', 'dusty', 'chillhop', 'vinyl', 'rainy', 'mellow'] },
  'downtempo':  { label: 'Downtempo / Ambient', zh: '氛围', bpm: [80, 112],
                  seeds: ['downtempo', 'trip hop', 'organic', 'chillout', 'balearic', 'dub', 'ethereal', 'ambient'] },
  // Chinese-language pop: popular hits wanted (hits: anti-chart scoring relaxed), dug from Chinese sources first (cn: true)
  'cpop':       { label: '华语 C-Pop', zh: '华语流行 · R&B · 国风 · 粤语 · 说唱', bpm: [66, 132], hits: true, cn: true,
                  seeds: ['c-pop', 'mandopop', 'chinese pop', 'cantopop', 'chinese r&b', 'guofeng', 'chinese hip hop', '华语'] },
};
/* ---------- curated crate: moods ---------- */
const MOODS = {
  'chill':     { label: 'Chill', zh: '放松', words: ['chill', 'mellow', 'smooth', 'laid back'], e: 0.25 },
  'groovy':    { label: 'Groovy', zh: '律动', words: ['groovy', 'funky', 'bouncy', 'swing'], e: 0.55 },
  'deep':      { label: 'Deep', zh: '深邃', words: ['deep', 'hypnotic', 'late night', 'introspective'], e: 0.45 },
  'dreamy':    { label: 'Dreamy', zh: '梦幻', words: ['dreamy', 'atmospheric', 'ethereal', 'melodic'], e: 0.4 },
  'dark':      { label: 'Dark', zh: '暗黑', words: ['dark', 'hypnotic', 'underground', 'night'], e: 0.65 },
  'happy':     { label: 'Happy', zh: '快乐', words: ['sunny', 'uplifting', 'feel good', 'summer'], e: 0.6 },
  'energetic': { label: 'Energetic', zh: '燃', words: ['driving', 'peak time', 'rave', 'hard'], e: 0.88 },
};
const MOOD_FALLBACK_GENRES = { chill: ['lofi', 'deep-house', 'downtempo'], groovy: ['house', 'disco', 'tech-house'], deep: ['deep-house', 'techno'],
  dreamy: ['progressive', 'downtempo', 'deep-house'], dark: ['techno', 'bass'], happy: ['house', 'disco'], energetic: ['techno', 'tech-house', 'dnb'] };

/* free-text vibe prompt -> chips + extra keywords (deterministic keyword map, EN + 中文) */
const PROMPT_MAP = [
  [/deep ?house|深浩室|深house/i, 'g', 'deep-house'], [/tech ?house|科技浩室/i, 'g', 'tech-house'], [/\bhouse\b|浩室|豪斯/i, 'g', 'house'],
  [/techno|科技舞曲|铁克诺|泰克诺/i, 'g', 'techno'], [/progressive|melodic|trance|渐进|旋律|迷幻/i, 'g', 'progressive'], [/electro|breaks?|garage|碎拍/i, 'g', 'electro'],
  [/disco|funk|迪斯科|迪厅|放克/i, 'g', 'disco'], [/drum ?(and|&|n) ?bass|dnb|jungle|鼓打贝斯|丛林/i, 'g', 'dnb'], [/dubstep|bass music|低音/i, 'g', 'bass'],
  [/hip.?hop|rap|boom ?bap|嘻哈|说唱/i, 'g', 'hiphop'], [/lo.?fi|低保真|学习/i, 'g', 'lofi'], [/ambient|downtempo|trip.?hop|氛围|慢摇/i, 'g', 'downtempo'],
  [/chill|relax|mellow|放松|休闲|轻松|安静/i, 'm', 'chill'], [/groov|funky|律动|摇摆/i, 'm', 'groovy'], [/deep|late.?night|深夜|深邃|午夜/i, 'm', 'deep'],
  [/dream|ethereal|梦|空灵/i, 'm', 'dreamy'], [/dark|暗|黑暗|阴郁/i, 'm', 'dark'], [/happy|sunny|summer|uplift|快乐|开心|阳光|夏天/i, 'm', 'happy'],
  [/energ|hard|peak|rave|party|燃|嗨|派对|激烈|蹦迪/i, 'm', 'energetic'],
  [/华语|中文|国语|c-?pop|mandopop|cantopop|粤语|国风|古风|中国风|chinese/i, 'g', 'cpop'],
];

/* ---------- taste filter ---------- */
const HARD_REJECT = /type ?beat|nightcore|sped ?up|speed ?up|slowed|8d ?audio|tik ?tok|viral|karaoke|ringtone|full album|podcast|episode|\bep\.? ?\d{2,}|mixtape|dj ?set|live ?set|\bset\b ?(\||-|@)|\bmix\b ?(#|vol|\d|\|)|(\||#|vol\.?) ?\d+.*\bmix\b|\b\d ?h(ou)?r\b|hours?\b|compilation|top ?\d+|billboard|hits ?20\d\d|playlist|remix contest|for (studying|sleep)|study music|sleep music|meditation music|instrumental beat for|freestyle beat|\bprod\.? by\b.*beat|ai generated|suno|udio|loop kit|sample pack|drum kit|test upload|untitled/i;
const SOFT_PENALTY = /remix|bootleg|vip|cover|flip|mashup|rework|tribute/i;
const MAINSTREAM = /disney|encanto|frozen|taylor swift|drake|billie eilish|ed sheeran|dua lipa|weeknd|ariana|bad bunny|beyonc|rihanna|bieber|coldplay|\bbts\b|blackpink|harry styles|olivia rodrigo|doja cat|post malone|kanye|eminem|adele|bruno mars|lady gaga|katy perry|miley|sabrina carpenter|chainsmokers|avicii|calvin harris|david guetta|alan walker|marshmello/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/* scores a normalized Track (providers/registry.js); popularity/engagement inputs come from t.signals */
function tasteScore(t, ctx) {
  const sg = t.signals || {};
  const title = (sg.rawTitle ?? t.title ?? '');
  const blob = (title + ' ' + (sg.tags || '') + ' ' + (sg.description || '').slice(0, 200)).toLowerCase();
  if (HARD_REJECT.test(title) || HARD_REJECT.test(sg.tags || '')) return -99;
  const d = t.dur || 0;
  if (d < 105 || d > 900) return -99;
  let s = 0;
  if (d < 150) s -= 0.6; else if (d <= 480) s += 1; else if (d <= 660) s += 0.3; else s -= 0.8;
  const p = sg.plays || t.plays || 0, lp = Math.log10(p + 1);
  if (lp < 1.3) s -= 1.5;            // < ~20 plays: unknown quality
  else if (lp < 2) s -= 0.2;
  else if (lp <= 4.7) s += 1;        // ~100 .. 50k plays: the "deeper cuts" sweet spot
  else if (lp <= 5.6) s += 0.2;
  else if (!ctx.hits) s -= 1.4;      // > ~400k: viral / chart territory (wanted for hit genres like 华语)
  const love = ((sg.likes || 0) + 1.5 * (sg.reposts || 0)) / (p + 25);
  s += clamp(love * 18, 0, 1.3);     // engagement ratio = listeners actually liked it
  const f = sg.followers || 0;
  if (f > 400000) { if (!ctx.hits) s -= 0.7; } else if (f < 60000) s += 0.3;
  let hits = 0; for (const k of ctx.seedTerms) if (blob.includes(k)) hits++;
  s += Math.min(1.6, hits * 0.4);
  if (ctx.genreSet.has(t.genre)) s += 0.8; else if (ctx.genreSet.size) s -= 0.6;
  if (ctx.moodSet.size && t.mood) s += ctx.moodSet.has(t.mood) ? 0.7 : -0.15;
  const aname = sg.artistName ?? t.artist ?? '';
  if (!ctx.hits && (MAINSTREAM.test(title) || MAINSTREAM.test(aname))) s -= 1.3;   // chart bait / pop re-rubs
  const uname = aname.toLowerCase();
  if (ctx.genrePhrases.some(gp => uname.includes(gp)) || /music|records? ?label|beats|official/i.test(uname) && /\d{3,}/.test(uname)) s -= 0.8;   // channel-style uploaders
  if (SOFT_PENALTY.test(title) && !ctx.allowEdits) s -= 0.35;
  if (title.length > 14 && title === title.toUpperCase() && /[A-Z]/.test(title)) s -= 0.3;
  const em = (title.match(EMOJI) || []).length; if (em > 1) s -= 0.4 * em;
  if ((title.match(/#/g) || []).length > 1) s -= 0.6;
  if (title.length > 80) s -= 0.4;
  // SEO-style titles that just name the genre ("Deep House", "Lofi Beat 3") = low-effort uploads
  for (const gp of ctx.genrePhrases) if (title.toLowerCase().includes(gp)) { s -= 0.7; break; }
  if (/\b(vol(ume)?\.? ?\d+|part ?\d+|beat ?\d+|track ?\d+)\b/i.test(title)) s -= 0.4;
  if (sg.hasArt ?? !!t.art) s += 0.2; else s -= 0.3;
  if (sg.trending) s -= 0.6;
  const rb = sg.bpm ?? t.bpm;
  if (rb && ctx.bpmRanges && ctx.bpmRanges.length) {   // keep the tempo world coherent (half/double time allowed)
    const ok = ctx.bpmRanges.some(([lo, hi]) => [rb, rb * 2, rb / 2].some(b => b >= lo - 5 && b <= hi + 5));
    if (!ok) s -= 1.1;
  }         // trending is only a minor fallback
  s += rng() * 0.7;                  // crate-digging serendipity
  return s;
}

/* ---------- musical key -> Camelot ---------- */
const CAMELOT = { minor: { 'Ab': 1, 'G#': 1, 'Eb': 2, 'D#': 2, 'Bb': 3, 'A#': 3, 'F': 4, 'C': 5, 'G': 6, 'D': 7, 'A': 8, 'E': 9, 'B': 10, 'F#': 11, 'Gb': 11, 'C#': 12, 'Db': 12 },
  major: { 'B': 1, 'F#': 2, 'Gb': 2, 'Db': 3, 'C#': 3, 'Ab': 4, 'G#': 4, 'Eb': 5, 'D#': 5, 'Bb': 6, 'A#': 6, 'F': 7, 'C': 8, 'G': 9, 'D': 10, 'A': 11, 'E': 12 } };
function camelot(key) {
  if (!key) return null;
  const m = String(key).trim().match(/^([A-Ga-g])\s*(#|b|♯|♭|sharp|flat)?\s*(major|minor|maj|min|m)?/i);
  if (!m) return null;
  let n = m[1].toUpperCase(); const acc = (m[2] || '').toLowerCase();
  if (acc === '#' || acc === '♯' || acc === 'sharp') n += '#'; else if (acc === 'b' || acc === '♭' || acc === 'flat') n += 'b';
  const mode = /min|^m$/i.test(m[3] || '') ? 'minor' : 'major';
  const num = CAMELOT[mode][n]; if (!num) return null;
  return { n: num, l: mode === 'minor' ? 'A' : 'B', s: num + (mode === 'minor' ? 'A' : 'B') };
}
function keyDist(a, b) {
  if (!a || !b) return 1;
  const dn = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  if (a.l === b.l) return dn === 0 ? 0 : dn === 1 ? 0.5 : dn === 2 ? 1.5 : 3;
  return dn === 0 ? 0.6 : 3;
}
/* fold a BPM reading into the selected genres' home range (analysers often report half/double time) */
let BPM_HOME = [];
function foldBpm(b, ranges = BPM_HOME) {
  if (!b || !ranges || !ranges.length) return b;
  const dist = x => Math.min(...ranges.map(([lo, hi]) => x < lo ? lo - x : x > hi ? x - hi : 0));
  let best = b; for (const c of [b / 2, b * 2]) if (dist(c) < dist(best) - 3) best = c;
  return Math.round(best * 10) / 10;
}
/* tempo ratio allowing half/double time */
function tempoRatio(from, to) {
  if (!from || !to) return 1;
  let best = to / from;
  for (const m of [0.5, 2]) { const r = (to * m) / from; if (Math.abs(Math.log(r)) < Math.abs(Math.log(best))) best = r; }
  return best;
}
/* ---------- sources ----------
 * All music comes from providers registered in providers/*.js (window.NEONDJ.providers).
 * finalizeTrack: app-side fields derived from the normalized Track (Camelot code, BPM folded into the genre's range). */
function finalizeTrack(x) { x.cam = camelot(x.key); x.bpm = foldBpm(x.bpm); return x; }
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}

/* ---------- optional keyword expansion (user's own OpenAI key): at most one tiny call per build, cached ---------- */
async function aiExpand(genres, moods, prompt) {
  const on = $('#aiOn').checked, key = $('#aiKey').value.trim();
  if (!on || !key) return [];
  const model = ($('#aiModel').value || 'gpt-4o-mini').trim();
  const desc = [genres.map(g => GENRES[g].label).join('/'), moods.map(m => MOODS[m].label).join('/'), prompt].filter(Boolean).join(', ');
  const ck = 'neondj.ai.' + desc.toLowerCase();
  const cached = localStorage.getItem(ck); if (cached) { try { return JSON.parse(cached); } catch (e) { } }
  try {
    const r = await fetchJSON('https://api.openai.com/v1/chat/completions', 15000, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0.7, max_tokens: 90, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: `Vibe: ${desc}. Give 6 short (1-3 word) search keywords a crate-digging DJ would use to find underground, non-chart tracks: sub-genres, scene terms, textures. No artist names. JSON: {"k":[...]}` }] }) });
    const k = JSON.parse(r.choices[0].message.content).k.filter(x => typeof x === 'string').slice(0, 6).map(x => x.toLowerCase().slice(0, 40));
    localStorage.setItem(ck, JSON.stringify(k)); return k;
  } catch (e) { console.warn('keyword expansion failed (ignored):', e); return []; }
}

/* ---------- crate digging ---------- */
const CN_PREFERRED = 'kugou';   // Chinese source used for 华语 when the picked source isn't Chinese
function parsePrompt(text) {
  const g = new Set(), m = new Set(); let rest = text || '';
  for (const [re, kind, id] of PROMPT_MAP) if (re.test(rest)) { (kind === 'g' ? g : m).add(id); }
  // tech house / deep house shouldn't also select plain house
  if (g.has('deep-house') || g.has('tech-house')) { if (!/\bhouse\b(?! *(music)?$)/i.test(rest.replace(/(deep|tech) ?house/ig, ''))) g.delete('house'); }
  const words = rest.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(w => /^[a-z0-9-]{3,}$/i.test(w) && !/^(and|the|with|for|music|songs?|vibes?|some|set|mix)$/i.test(w));
  return { g: [...g], m: [...m], words: words.slice(0, 4).map(w => w.toLowerCase()) };
}

async function digCrates(args) {
  let { genres, moods, prompt, need, source, onStatus, taste } = args;
  const P = parsePrompt(prompt);
  const prov = Providers.resolve(source);
  if (!prov) throw new Error('no music provider registered');
  // taste (♥ likes, taste.js): TP stays null with zero likes or taste Off -> exactly the plain dig below
  const T = NEONDJ.taste, TM = T.mode(taste), likes = TM.w ? T.Likes.all() : [];
  const TP = likes.length ? T.profile(likes) : null;
  genres = [...new Set([...genres, ...P.g])]; moods = [...new Set([...moods, ...P.m])];
  if (TP && !genres.length && !moods.length && !String(prompt || '').trim()) genres = T.genresFor(prov, TP);   // nothing picked: start from what you liked
  if (!genres.length) { const s = new Set(); moods.forEach(m => (MOOD_FALLBACK_GENRES[m] || []).slice(0, 2).forEach(g => s.add(g))); genres = s.size ? [...s] : ['deep-house']; }
  if (!moods.length && !genres.length) moods = ['groovy'];
  // Chinese genres (华语) want a Chinese catalogue: try the picked source if it is one (e.g. QQ in mainland China), then
  // Kugou (plays worldwide); if both come back empty, carry on with the picked source (Audius: Chinese seed terms).
  if (genres.some(g => GENRES[g].cn) && !args._cn) {
    const tries = [prov.keywords ? prov.id : null, CN_PREFERRED].filter((x, i, a) => x && Providers.get(x) && a.indexOf(x) === i);
    let best = null;
    for (const id of tries) {
      try { const r = await digCrates({ ...args, genres, moods, source: id, _cn: true }); if (r.tracks.length >= Math.min(need, 4)) return r; if (r.tracks.length && (!best || r.tracks.length > best.tracks.length)) best = r; }
      catch (e) { console.warn(`${Providers.get(id).name}: no Chinese tracks`, e); }
    }
    if (best) return best;   // a short Chinese set beats none; endless mode keeps digging
  }
  const aiWords = await aiExpand(genres, moods, prompt);
  const srcGenres = Providers.mapGenres(prov, genres);   // provider's own genre / mood filter vocabulary
  const srcMoods = Providers.mapMoods(prov, moods);
  const moodWords = moods.flatMap(m => MOODS[m].words);
  const seedTerms = new Set([...genres.flatMap(g => GENRES[g].seeds), ...moodWords, ...P.words, ...aiWords].map(s => s.toLowerCase()));
  const bpmRanges = genres.map(g => GENRES[g].bpm); BPM_HOME = bpmRanges;
  const ctx = { hits: genres.some(g => GENRES[g].hits), seedTerms, bpmRanges, genreSet: new Set(srcGenres), moodSet: new Set(srcMoods), allowEdits: genres.includes('disco'),
    genrePhrases: [...new Set([...srcGenres, 'lofi', 'lo-fi', 'deep house', 'techno', 'house music', 'hip hop', 'drum and bass'].map(x => x.toLowerCase()))].filter(x => x.length > 3) };
  const info = { genres, moods };

  const tx = TP ? { T, TP, TM, likes, taste } : null;
  if (prov.capabilities.crate !== 'scored') {
    let tracks = await digSimple(prov, genres, moods, P.words.concat(aiWords), need, onStatus, tx);
    if (TP) tracks = mixInLikes(tracks, likes, prov, TM, need, ctx);
    return { tracks, info, source: prov.id, liked: tracks.filter(t => t.fromLikes).length };
  }

  onStatus(`Connecting to ${prov.name}…`);
  if (prov.init) await prov.init();
  // build query plan: seed terms per genre (x mood words), mood-filtered + open variants
  const plan = [];
  for (const g of genres) {
    const G = GENRES[g], gf = Providers.mapGenres(prov, [g]); const seeds = shuffle(G.seeds).slice(0, genres.length > 2 ? 2 : 3);
    for (const s of seeds) {
      plan.push({ q: s, genres: gf, moods: srcMoods });
      if (moodWords.length) plan.push({ q: s + ' ' + pick(moodWords), genres: gf, moods: [] });
    }
    plan.push({ q: pick(G.seeds), genres: gf, moods: [] });
  }
  for (const w of [...P.words, ...aiWords].slice(0, 4)) plan.push({ q: w, genres: srcGenres, moods: [] });
  if (TP) for (const q of T.seedQueries(TP, taste, shuffle)) plan.push({ q, genres: [], moods: [] });   // liked artists + tags, unfiltered
  onStatus('Finding tracks…');
  const res = await pool(plan, 3, p => prov.search(p.q, { genres: p.genres, moods: p.moods }));
  let raw = res.flat().filter(Boolean);
  if (TP) raw = raw.concat(await digSimilar(prov, likes, TM, onStatus));
  const uniq = () => { const m = new Map(); raw.forEach(t => { if (t && t.id && !m.has(t.id)) m.set(t.id, t); }); return [...m.values()]; };
  let cands = uniq().filter(t => t.playable !== false && t.listed !== false);
  // score = anti-chart taste filter + (with likes) weighted similarity to the ♥ profile; liked tracks themselves only come back via mixInLikes
  const scoreAll = list => (TP ? list.filter(t => !TP.ids.has(T.Likes.key(t))) : list)
    .map(t => { let s = tasteScore(t, ctx); if (TP && s > -50) s += TM.w * T.similarity(t, TP); return { t, s }; }).filter(x => x.s > -50);
  let scored = scoreAll(cands);
  if (scored.length < need * 2) {          // widen: open searches without filters
    onStatus('Finding more tracks…');
    const extra = await pool(genres.slice(0, 3).flatMap(g => [GENRES[g].label, pick(GENRES[g].seeds) + ' ' + (moodWords[0] || '')]), 3, q => prov.search(q.trim(), {}));
    raw = raw.concat(extra.flat().filter(Boolean)); cands = uniq().filter(t => t.playable !== false);
    scored = scoreAll(cands);
  }
  if (scored.length < need && prov.trending) {   // minor fallback only
    onStatus('Finding more tracks…');
    const tr = await pool(srcGenres.slice(0, 3), 3, g => prov.trending(g));
    raw = raw.concat(tr.flat().filter(Boolean)); cands = uniq().filter(t => t.playable !== false);
    scored = scoreAll(cands);
  }
  scored.sort((a, b) => b.s - a.s);
  // artist variety: max 1 per artist (2 if the crate is thin)
  const artistOf = t => (t.signals && 'artistKey' in t.signals) ? t.signals.artistKey : t.artistId;
  const pickN = (cap, minPlays) => { const per = new Map(), out = []; for (const x of scored) { if ((x.t.plays || 0) < minPlays) continue; const a = artistOf(x.t); const c = per.get(a) || 0; if (c >= cap) continue; per.set(a, c + 1); out.push(x.t); if (out.length >= need) break; } return out; };
  let chosen = pickN(1, 15); if (chosen.length < need) chosen = pickN(1, 0); if (chosen.length < need) chosen = pickN(2, 0);
  let tracks = chosen.map(finalizeTrack);
  if (TP) tracks = mixInLikes(tracks, likes, prov, TM, need, ctx);
  return { tracks, info, source: prov.id, poolSize: scored.length, liked: tracks.filter(t => t.fromLikes).length };
}

/* "more like this" via the provider's optional similar() for a few liked tracks of that provider */
async function digSimilar(prov, likes, TM, onStatus) {
  if (typeof prov.similar !== 'function' || !TM.similar) return [];
  const from = shuffle(likes.filter(l => l.src === prov.id)).slice(0, TM.similar);
  if (!from.length) return [];
  onStatus('Finding tracks like your ♥…');
  const res = await pool(from, 2, l => prov.similar(l, { limit: 24 }));
  return res.flat().filter(Boolean).map(t => (t.viaSimilar = true, t));
}

/* put a few liked tracks back into the set (Some ≈10 % ≤2, Strong ≈25 % ≤5) — only ones that fit the
 * current genres / tempo world; keeps one track per artist and the set length */
function mixInLikes(tracks, likes, prov, TM, need, ctx) {
  const k = Math.min(TM.likeMax, Math.round(need * TM.likeShare)); if (k < 1) return tracks;
  const have = new Set(tracks.map(t => t.id));
  const fitsBpm = b => !b || !ctx.bpmRanges.length || ctx.bpmRanges.some(([lo, hi]) => [b, b * 2, b / 2].some(x => x >= lo - 5 && x <= hi + 5));
  const pickd = likes.filter(l => l.src === prov.id && !have.has(l.id) && (!ctx.genreSet.size || ctx.genreSet.has(l.genre)) && fitsBpm(l.bpm))
    .map(l => ({ l, s: (ctx.moodSet.has(l.mood) ? 0.5 : 0) + rng() })).sort((a, b) => b.s - a.s).slice(0, k);
  if (!pickd.length) return tracks;
  const inj = pickd.map(({ l }) => { const t = Providers.normalize({ ...l, signals: {}, fromLikes: true }); delete t.likedAt; t.url = prov.getStreamUrl(t); return finalizeTrack(t); });
  const artistKey = t => String(t.artist || '').toLowerCase().trim() || String(t.artistId);
  const injA = new Set(inj.map(artistKey));
  const out = tracks.filter(t => !injA.has(artistKey(t))).slice(0, Math.max(0, Math.max(tracks.length, Math.min(need, tracks.length + inj.length)) - inj.length));
  inj.forEach((t, i) => out.splice(Math.min(out.length, Math.round((i + 1) * (out.length + 1) / (inj.length + 1))), 0, t));
  return out;
}

/* 'simple' crate for providers without popularity signals (e.g. preview catalogues): basic reject rules, shuffle, one per artist */
async function digSimple(prov, genres, moods, words, need, onStatus, tx = null) {
  const full = prov.capabilities.fullTrack;
  onStatus(`Searching ${prov.name}…`);
  if (prov.init) await prov.init();
  const qs = [], KW = prov.keywords, gOf = new Map();   // gOf: query -> app genre that asked for it
  const add = (q, g) => { q = q.trim(); if (!q || gOf.has(q)) return; gOf.set(q, g); qs.push(q); };
  if (KW && KW.genres) {   // provider vocabulary (e.g. Chinese + English terms for CN platforms)
    for (const g of genres) {
      const terms = shuffle(KW.genres[g] || [GENRES[g].label]), fl = KW.flavors && KW.flavors[g], artists = KW.artists && KW.artists[g];
      if (fl && moods.length) { moods.forEach(m => shuffle(fl[m] || []).slice(0, 2).forEach(q => add(q, g))); terms.slice(0, 2).forEach(q => add(q, g)); }
      else terms.slice(0, GENRES[g].hits ? 4 : 3).forEach((t, i) => add(t + (moods[0] && i === 1 && !GENRES[g].hits && KW.moods && KW.moods[moods[0]] ? ' ' + pick(KW.moods[moods[0]]) : ''), g));
      if (artists) shuffle(artists).slice(0, 6).forEach(q => add(q, g));   // hit genres: popular artists' catalogues
    }
  } else for (const g of genres) { const G = GENRES[g]; shuffle(G.seeds).slice(0, 3).forEach(s => add(s + (moods[0] ? ' ' + pick(MOODS[moods[0]].words) : ''), g)); }
  words.slice(0, 3).forEach(w => add(w, null));
  if (tx) tx.T.seedQueries(tx.TP, tx.taste, shuffle).forEach(q => add(q, null));
  const tag = (q, list) => { const g = gOf.get(q); if (g) list.forEach(t => { if (!t.genre) t.genre = GENRES[g].label; t._g = g; }); return list; };
  let res;
  if ((prov.capabilities.searchConcurrency || 3) === 1) {   // throttling source: one search at a time, stop once the crate is deep enough
    res = []; const enough = need * (genres.some(g => GENRES[g].hits) ? 6 : 4);
    for (const q of qs) { try { res.push(...tag(q, await prov.search(q))); } catch (e) { } if (res.filter(t => t.playable !== false).length >= enough) break; }
  } else res = (await pool(qs, 3, q => prov.search(q).then(list => tag(q, list)))).flat().filter(Boolean);
  if (tx) res = res.concat(await digSimilar(prov, tx.likes, tx.TM, onStatus)).filter(t => !tx.TP.ids.has(tx.T.Likes.key(t)));
  const beatsy = genres.some(g => g === 'hiphop' || g === 'lofi' || g === 'downtempo');
  const offGenre = /^(rock|pop|soundtrack|country|singer\/songwriter|alternative|christian.*|children.*|holiday|vocal|classical|latino|k-pop|j-pop|metal|easy listening)$/i;
  const lazy = typeof prov.resolveStream === 'function';   // stream URL fetched per track (signed / expiring / maybe not free)
  const NOT_ORIGINAL = /\bdj\b|dj版|remix|伴奏|纯音乐|钢琴版|八音盒|合唱版|群星|铃声|片段|抖音|翻唱|翻自|\bcover\b|加速|降调|0\.\d+x|\b(slowed|sped)\b|女版|男版|live版|串烧/i;   // hit genres: originals only
  const fanUpload = t => { const A = KW && KW.artists && KW.artists[t._g]; return /《.+》/.test(t.title) || !!(A && A.some(a => t.title.includes(a) && !(t.artist || '').includes(a))); };   // "<artist> (song)" re-uploads
  const m = new Map(); res.forEach(t => { if (t._g && GENRES[t._g].hits && (NOT_ORIGINAL.test(t.title + ' ' + (t.artist || '')) || fanUpload(t))) return; if (t.playable !== false && (t.url || lazy) && (t.fullDur ?? t.dur ?? 0) > 120 && !m.has(t.id) && !HARD_REJECT.test(t.title || '') && !MAINSTREAM.test((t.artist || '') + ' ' + t.title) && (beatsy || !offGenre.test(t.genre || ''))) m.set(t.id, t); });
  const per = new Map(), out = [];
  let order = shuffle([...m.values()]);
  if (genres.some(g => GENRES[g].hits)) order = order.map(t => ({ t, s: (t._g && GENRES[t._g].hits ? Math.log10((t.plays || 0) + 1) * 0.4 : 2) + rng() * 1.5 })).sort((a, b) => b.s - a.s).map(x => x.t);   // popular first, with variety
  if (tx) order = order.map(t => ({ t, s: tx.TM.w * tx.T.similarity(t, tx.TP) + rng() * 0.6 })).sort((a, b) => b.s - a.s).map(x => x.t);   // lean toward the ♥ profile
  const hitsWanted = genres.some(g => GENRES[g].hits);   // hit catalogues are partly paid: try more picks
  if (lazy) {   // confirm each pick actually has a free stream before it enters the set
    const picks = []; for (const t of order) { const c = per.get(t.artistId) || 0; if (c >= (hitsWanted ? 2 : 1)) continue; per.set(t.artistId, c + 1); picks.push(t); }   // hit genres: up to 2 per artist
    let i = 0, tried = 0;
    const worker = async () => { while (out.length < need && i < picks.length && tried < need * (hitsWanted ? 6 : 4)) { const t = picks[i++]; tried++;
      try { await prov.resolveStream(t); if (t.url && t.playable !== false && out.length < need) out.push(finalizeTrack(t)); } catch (e) { } } };
    await Promise.all(Array.from({ length: prov.capabilities.resolveConcurrency || 4 }, worker));
    if (!out.length && picks.length) throw new Error(prov.name + ': no free streams available here');
    return out;
  }
  for (const t of order) { const c = per.get(t.artistId) || 0; if (c) continue; per.set(t.artistId, 1); out.push(finalizeTrack(t)); if (out.length >= need) break; }
  return out;
}

/* ---------- in-browser analysis: tempo, beat phase, energy, loudness ---------- */
const BYTES_HEAD = 800000;   // ~20s at 320kbps from the start: tempo + beat phase
const BYTES_BODY = 480000;   // a slice from the body: loudness + energy (intros are often quiet)
async function fetchOnce(url, range, timeout) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeout);
  try { const r = await fetch(url, { headers: range ? { Range: range } : {}, signal: ac.signal }); if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return await r.arrayBuffer(); }
  finally { clearTimeout(to); }
}
/* analysis reads try the track's alternate URL first (e.g. a content node, spreading load off a rate-limited API), then the primary, with one backoff retry */
async function fetchBytes(tr, range, timeout = 20000) {
  if (Providers.needsResolve(tr)) await Providers.prepare(tr);
  const urls = [tr.alt, tr.url].filter(Boolean); let last;
  for (const u of urls) { try { return await fetchOnce(u, range, timeout); } catch (e) { last = e; } }
  await sleep(1500 + Math.random() * 1500);
  try { return await fetchOnce(tr.url, range, timeout); } catch (e) { throw last || e; }
}
const decode = buf => new OfflineAudioContext(1, 22050, 22050).decodeAudioData(buf);
async function analyzeTrack(tr) {
  if (!Providers.caps(tr).rangeRequests) { const a = analyzeBuffer(await decode(await fetchBytes(tr)), tr.bpm); return a; }
  const head = analyzeBuffer(await decode(await fetchBytes(tr, 'bytes=0-' + BYTES_HEAD)), tr.bpm);
  if (tr.dur > 90) {
    try {   // offset assumes >=128kbps: lands ~50% in at 128k, ~20% in at 320k — past most intros
      const off = Math.floor(tr.dur * 0.5 * 16000);
      const body = analyzeBuffer(await decode(await fetchBytes(tr, `bytes=${off}-${off + BYTES_BODY}`)), head.bpm, true);
      head.headDb = head.db; head.db = body.db; head.dens = body.dens; head.lowRatio = body.lowRatio; head.body = true;
    } catch (e) { head.db = Math.max(head.db, -18); }   // unknown body: don't over-boost a quiet intro
  }
  return head;
}
function analyzeBuffer(ab, knownBpm, levelsOnly = false) {
  const sr = ab.sampleRate, L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
  const hop = 512, fps = sr / hop;
  const n = Math.floor(ab.length / hop);
  if (n < fps * (levelsOnly ? 3 : 6)) throw new Error('too short');
  const E = new Float32Array(n), Lo = new Float32Array(n);
  const a = Math.exp(-2 * Math.PI * 150 / sr); let lp = 0, sumSq = 0, sumLo = 0;
  for (let i = 0; i < n; i++) {
    let e = 0, el = 0;
    for (let j = i * hop, J = j + hop; j < J; j++) { const x = (L[j] + R[j]) * 0.5; lp = (1 - a) * x + a * lp; e += x * x; el += lp * lp; }
    E[i] = Math.log(1e-9 + e / hop); Lo[i] = Math.log(1e-9 + el / hop); sumSq += e; sumLo += el;
  }
  if (levelsOnly) {
    const O = new Float32Array(n); let dens = 0; for (let i = 1; i < n; i++) { O[i] = Math.max(0, E[i] - E[i - 1]) + 1.5 * Math.max(0, Lo[i] - Lo[i - 1]); }
    const W = 16; let run = 0; for (let i = 0; i < n; i++) { run += O[i]; if (i >= W) run -= O[i - W]; dens += Math.max(0, O[i] - run / Math.min(i + 1, W)); }
    return { db: 20 * Math.log10(Math.sqrt(sumSq / (n * hop)) + 1e-9), dens: dens / n, lowRatio: sumLo / (sumSq + 1e-9) };
  }
  // onset envelope (full band + kick band flux), mean-removed
  const O = new Float32Array(n);
  for (let i = 1; i < n; i++) O[i] = Math.max(0, E[i] - E[i - 1]) + 1.5 * Math.max(0, Lo[i] - Lo[i - 1]);
  const W = 16, O2 = new Float32Array(n); let run = 0;
  for (let i = 0; i < n; i++) { run += O[i]; if (i >= W) run -= O[i - W]; O2[i] = Math.max(0, O[i] - run / Math.min(i + 1, W)); }
  // analyse the body (skip the first ~5s which is often an intro/fade)
  const s0 = Math.min(Math.floor(fps * 5), Math.floor(n / 3));
  const seg = O2.subarray(s0); const m = seg.length;
  const lagMin = Math.floor(fps * 60 / 185), lagMax = Math.ceil(fps * 60 / 68);
  const ac = new Float32Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax + 1; lag++) { let s = 0; for (let i = 0; i + lag < m; i++) s += seg[i] * seg[i + lag]; ac[lag] = s / (m - lag); }
  let best = lagMin, bestS = -1, mean = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = 60 * fps / lag; const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.75, 2));
    const half = lag * 2 <= lagMax + 1 ? ac[lag * 2] : 0;
    const sc = (ac[lag] + 0.4 * half) * w; mean += ac[lag];
    if (sc > bestS) { bestS = sc; best = lag; }
  }
  mean /= (lagMax - lagMin + 1);
  const y0 = ac[best - 1] || ac[best], y1 = ac[best], y2 = ac[best + 1] || ac[best];
  const den = (y0 - 2 * y1 + y2); const shift = den ? clamp(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0;
  let est = 60 * fps / (best + shift);
  const conf = mean > 0 ? ac[best] / mean : 0;
  est = foldBpm(est);
  let bpm = est, bpmSrc = 'est';
  if (knownBpm) { const r = tempoRatio(knownBpm, est); bpm = knownBpm; bpmSrc = Math.abs(r - 1) < 0.04 ? 'both' : 'meta'; }
  // beat phase: offset that maximises onset energy on the grid
  const P = 60 * fps / bpm; let bestO = 0, bestV = -1;
  for (let o = 0; o < P; o += 0.5) { let v = 0; for (let k = o + s0; k < n; k += P) { const i = Math.round(k); v += O2[i] + 0.5 * ((O2[i - 1] || 0) + (O2[i + 1] || 0)); } if (v > bestV) { bestV = v; bestO = o; } }
  const phase = ((bestO + s0) * hop / sr) % (60 / bpm);
  const rms = Math.sqrt(sumSq / (n * hop)); const db = 20 * Math.log10(rms + 1e-9);
  let dens = 0; for (let i = s0; i < n; i++) dens += O2[i]; dens /= (n - s0);
  return { bpm, est, bpmSrc, conf, phase, db, lowRatio: sumLo / (sumSq + 1e-9), dens };
}

/* ---------- sequencing: warm-up -> build -> peak -> cool-down ---------- */
function energyOf(t, norm) {
  const bpmN = t.bpm ? clamp((Math.min(t.bpm, 180) - 75) / 100, 0, 1) : 0.5;
  if (t.an) {
    const dbN = clamp((t.an.db + 24) / 16, 0, 1);
    const dN = norm ? clamp((t.an.dens - norm.dMin) / (norm.dMax - norm.dMin + 1e-9), 0, 1) : 0.5;
    return 0.3 * dbN + 0.25 * dN + 0.2 * bpmN + 0.25 * t.prior;
  }
  return 0.55 * t.prior + 0.45 * bpmN;
}
function targetCurve(x, mode) {
  if (mode === 'build') return 0.12 + 0.85 * Math.pow(x, 1.15);
  return x < 0.72 ? 0.12 + 0.88 * smooth(0, 0.72, x) : 1 - 0.42 * smooth(0.72, 1, x);  // arc
}
function sequence(tracks, mode, fixedHead = []) {
  // fixedHead: tracks that must stay at the front (already playing/preloaded)
  const list = tracks.slice(); if (!list.length) return fixedHead.slice();
  const an = list.concat(fixedHead).filter(t => t.an); const norm = an.length > 2 ? { dMin: Math.min(...an.map(t => t.an.dens)), dMax: Math.max(...an.map(t => t.an.dens)) } : null;
  list.concat(fixedHead).forEach(t => t.energy = energyOf(t, norm));
  if (mode === 'found') return fixedHead.concat(avoidArtistRepeats(list, fixedHead[fixedHead.length - 1]));
  // tempo outliers (>12% from the set's median, half/double aware) go to the back as spares instead of breaking the flow
  let spares = [];
  const bpms = list.concat(fixedHead).map(t => t.bpm).filter(Boolean).sort((a, b) => a - b);
  if (bpms.length >= 5) {
    const med = bpms[Math.floor(bpms.length / 2)];
    const out = list.filter(t => t.bpm && Math.abs(Math.log(tempoRatio(med, t.bpm))) > Math.log(1.12));
    if (out.length && out.length <= list.length * 0.3) { spares = out; for (const t of out) list.splice(list.indexOf(t), 1); }
  }
  if (!list.length) return fixedHead.concat(spares);
  const N = fixedHead.length + list.length; const off = fixedHead.length;
  const targets = list.map((_, i) => targetCurve(N > 1 ? (i + off) / (N - 1) : 0, mode));
  // initial assignment: rank-match energies to targets
  const byE = list.slice().sort((a, b) => a.energy - b.energy);
  const slots = targets.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const seq = new Array(list.length); slots.forEach((s, k) => seq[s.i] = byE[k]);
  const eMin = byE[0].energy, eMax = byE[byE.length - 1].energy, span = Math.max(0.05, eMax - eMin);
  const tnorm = v => eMin + (v - 0.12) / 0.88 * span;
  // no fixed head: anchor the opener to a low-tempo, low-energy virtual track so the set warms up from the bottom
  const lowB = bpms.length ? bpms[Math.floor(bpms.length * 0.2)] : null;
  const prev0 = fixedHead[fixedHead.length - 1] || (lowB ? { bpm: lowB, cam: null, artistId: null } : null);
  const pairCost = (a, b) => {
    if (!a || !b) return 0;
    let c = 0; const r = tempoRatio(a.bpm, b.bpm); c += Math.abs(Math.log(r)) * 28;   // ~1 per 3.6% jump
    if (Math.abs(r - 1) > 0.09) c += 1.2;
    c += keyDist(a.cam, b.cam) * 0.45; if (a.artistId === b.artistId) c += 6;
    return c;
  };
  const cost = s => { let c = 0; for (let i = 0; i < s.length; i++) { c += Math.pow((s[i].energy - tnorm(targets[i])) / span, 2) * 14; c += pairCost(i ? s[i - 1] : prev0, s[i]); } return c; };
  let cur = cost(seq);
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) {
      [seq[i], seq[j]] = [seq[j], seq[i]]; const c = cost(seq);
      if (c < cur - 1e-6) { cur = c; improved = true; } else[seq[i], seq[j]] = [seq[j], seq[i]];
    }
    if (!improved) break;
  }
  return fixedHead.concat(seq, spares);
}
function avoidArtistRepeats(list, prev) {
  const out = list.slice();
  for (let i = 0; i < out.length; i++) { const p = i ? out[i - 1] : prev; if (p && out[i].artistId === p.artistId) { const j = out.findIndex((t, k) => k > i && t.artistId !== p.artistId); if (j > 0) [out[i], out[j]] = [out[j], out[i]]; } }
  return out;
}
/* ---------- audio engine ---------- */
let ctx = null;
const hold = (p, t) => { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); } };
const setAt = (p, v, t) => p.setValueAtTime(v, t);
const lin = (p, v, t) => p.linearRampToValueAtTime(v, t);
const expo = (p, v, t) => p.exponentialRampToValueAtTime(Math.max(1e-4, v), t);
const glide = (p, v, t, tc = 0.004) => p.setTargetAtTime(v, t, tc);
function curve(p, from, to, t0, t1, shape = 'eqp', steps = 24) {
  p.setValueAtTime(from, t0);
  for (let k = 1; k <= steps; k++) {
    const x = k / steps; let y;
    if (shape === 'eqp') y = from < to ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2);
    else if (shape === 'exp') y = (Math.pow(10, x * 2) - 1) / 99; else y = x;
    const v = shape === 'eqp' ? (from < to ? from + (to - from) * y : to + (from - to) * y) : from + (to - from) * y;
    p.linearRampToValueAtTime(v, t0 + (t1 - t0) * x);
  }
}
function makeImpulse(seconds = 2.8, decay = 3.2) {
  const len = Math.floor(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let lp = 0; for (let i = 0; i < len; i++) { const x = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); lp = lp * 0.55 + x * 0.45; d[i] = i < ctx.sampleRate * 0.012 ? lp * (i / (ctx.sampleRate * 0.012)) : lp; } }
  return ir;
}
let noiseBuf = null;
function noise() { if (!noiseBuf) { const len = ctx.sampleRate * 2; noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; } return noiseBuf; }

const Master = {
  init() {
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.bus = g(0.9);
    this.glue = ctx.createDynamicsCompressor(); Object.assign(this.glue, {}); this.glue.threshold.value = -16; this.glue.ratio.value = 2.5; this.glue.knee.value = 8; this.glue.attack.value = 0.02; this.glue.release.value = 0.25;
    this.lim = ctx.createDynamicsCompressor(); this.lim.threshold.value = -2; this.lim.ratio.value = 20; this.lim.knee.value = 0; this.lim.attack.value = 0.002; this.lim.release.value = 0.12;
    this.out = g(0.85);
    this.an = ctx.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0.78;
    this.revIn = g(1); this.rev = ctx.createConvolver(); this.rev.buffer = makeImpulse(); this.revRet = g(0.9);
    this.revIn.connect(this.rev).connect(this.revRet).connect(this.bus);
    this.bus.connect(this.glue).connect(this.lim).connect(this.out).connect(this.an).connect(ctx.destination);
  },
  riser(t0, dur) {
    const src = ctx.createBufferSource(); src.buffer = noise(); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 5;
    const g = ctx.createGain(); const send = ctx.createGain(); send.gain.value = 0.6;
    bp.frequency.setValueAtTime(250, t0); bp.frequency.exponentialRampToValueAtTime(9500, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.22, t0 + dur * 0.95); g.gain.linearRampToValueAtTime(0, t0 + dur + 0.03);
    src.connect(bp).connect(g); g.connect(this.bus); g.connect(send).connect(this.revIn);
    src.start(t0); src.stop(t0 + dur + 0.2);
  },
  impact(t0, amt = 1) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(130, t0); o.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.75 * amt, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
    const n = ctx.createBufferSource(); n.buffer = noise(); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.25 * amt, t0); ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    const send = ctx.createGain(); send.gain.value = 0.5;
    o.connect(g); n.connect(hp).connect(ng);
    [g, ng].forEach(x => { x.connect(this.bus); x.connect(send); }); send.connect(this.revIn);
    o.start(t0); o.stop(t0 + 1.4); n.start(t0); n.stop(t0 + 0.4);
  },
};

const KNOB_DEFAULT = { low: 0, mid: 0, high: 0, filter: 0, delay: 0, reverb: 0, trim: 1 };
class Deck {
  constructor(name) {
    this.name = name; this.knob = { ...KNOB_DEFAULT }; this.grab = {}; this._rideUntil = 0; this._ridden = []; this.track = null; this.ready = false; this.auto = false; this.autoGain = 1;
    const el = this.el = new Audio(); el.crossOrigin = 'anonymous'; el.preload = 'auto';
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q, gain) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; if (gain != null) n.gain.value = gain; return n; };
    this.srcNode = ctx.createMediaElementSource(el);
    this.trim = g(1);
    this.low = bq('lowshelf', 220, null, 0); this.mid = bq('peaking', 1000, 0.7, 0); this.high = bq('highshelf', 3800, null, 0);
    this.hp = bq('highpass', 10, 0.9); this.lp = bq('lowpass', 22000, 0.9);
    // slip loop / roll (delay-line capture of the last N beats)
    this.loopDry = g(1); this.loopIn = g(1); this.loopDelay = ctx.createDelay(8); this.loopFb = g(0); this.loopWet = g(0); this.loopSum = g(1);
    // flanger
    this.flDelay = ctx.createDelay(0.05); this.flDelay.delayTime.value = 0.004; this.flFb = g(0); this.flWet = g(0);
    this.flLfo = ctx.createOscillator(); this.flLfo.frequency.value = 0.18; this.flDepth = g(0.0028); this.flLfo.connect(this.flDepth).connect(this.flDelay.delayTime); this.flLfo.start();
    // phaser (4 all-pass stages)
    this.aps = [0, 1, 2, 3].map(i => bq('allpass', 600 + i * 400, 0.6)); this.phWet = g(0);
    this.phLfo = ctx.createOscillator(); this.phLfo.frequency.value = 0.32; this.phDepth = g(500); this.phLfo.connect(this.phDepth); this.aps.forEach(a => this.phDepth.connect(a.frequency)); this.phLfo.start();
    this.modSum = g(1); this.gate = g(1); this.post = g(1);
    this.xf = g(0);
    // sends (post-gate, pre-crossfader, so tails ring out after the fader closes)
    this.dSend = g(0); this.dly = ctx.createDelay(4); this.dly.delayTime.value = 0.375; this.dFb = g(0.45); this.dHp = bq('highpass', 280, 0.7); this.dLp = bq('lowpass', 3800, 0.7); this.dOut = g(0.8);
    this.rSend = g(0);
    this.vu = ctx.createAnalyser(); this.vu.fftSize = 256; this.vuBuf = new Float32Array(256);

    this.srcNode.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp);
    this.lp.connect(this.loopDry).connect(this.loopSum);
    this.lp.connect(this.loopIn).connect(this.loopDelay).connect(this.loopWet).connect(this.loopSum); this.loopDelay.connect(this.loopFb).connect(this.loopDelay);
    this.loopSum.connect(this.modSum);
    this.loopSum.connect(this.flDelay).connect(this.flWet).connect(this.modSum); this.flDelay.connect(this.flFb).connect(this.flDelay);
    this.aps.reduce((prev, a) => (prev.connect(a), a), this.loopSum).connect(this.phWet).connect(this.modSum);
    this.modSum.connect(this.gate).connect(this.post);
    this.post.connect(this.xf).connect(Master.bus); this.xf.connect(this.vu);
    this.post.connect(this.dSend).connect(this.dly).connect(this.dHp).connect(this.dLp).connect(this.dOut).connect(Master.bus); this.dLp.connect(this.dFb).connect(this.dly);
    this.post.connect(this.rSend).connect(Master.revIn);
  }
  get beatSec() { const b = (this.track && this.track.bpm) || 120; return 60 / b / (this.el.playbackRate || 1); }   // real seconds per beat
  get phase() { return (this.track && this.track.an && this.track.an.phase) || 0; }
  beatPos() { const bpm = (this.track && this.track.bpm) || 120; return (this.el.currentTime - this.phase) / (60 / bpm); }
  /* real seconds until the next multiple of `mult` beats (>= minAhead) */
  untilBeat(mult = 1, minAhead = 0.03) {
    const b = this.beatPos(), bs = this.beatSec; let next = Math.ceil(b / mult - 1e-6) * mult; let dt = (next - b) * bs;
    while (dt < minAhead) { next += mult; dt = (next - b) * bs; }
    return dt;
  }
  load(track, startAt = 0, resolved = false) {
    if (!resolved && Providers.needsResolve(track)) return Providers.prepare(track).then(() => this.load(track, startAt, true));   // signed / expiring URLs
    this.track = track; this.ready = false; this.startAt = startAt;
    this.el.preservesPitch = true; this.el.playbackRate = 1;
    return new Promise((resolve, reject) => {
      const el = this.el; let done = false;
      const fin = (ok, err) => { if (done) return; done = true; clearTimeout(to); el.removeEventListener('canplay', onCan); el.removeEventListener('error', onErr); el.removeEventListener('loadedmetadata', onMeta); ok ? resolve() : reject(err); };
      const onMeta = () => { if (isFinite(el.duration) && el.duration > 1) track.dur = el.duration; if (startAt > 0 && startAt < track.dur - 5) el.currentTime = startAt; };
      const onCan = () => { if (startAt > 0 && Math.abs(el.currentTime - startAt) > 1 && startAt < track.dur - 5) { el.currentTime = startAt; return; } this.ready = true; fin(true); };
      const onErr = () => fin(false, new Error('media error ' + (el.error && el.error.code)));
      const to = setTimeout(() => fin(false, new Error('load timeout')), 20000);
      el.addEventListener('loadedmetadata', onMeta); el.addEventListener('canplay', onCan); el.addEventListener('error', onErr);
      el.src = track.url; el.load();
    }).catch(async e => {   // API hiccup / rate limit: retry once via the track's alternate URL
      if (this._altTried === track || !track.alt) throw e;
      this._altTried = track; await sleep(800); const u = track.url; track.url = track.alt; track.alt = u; return this.load(track, startAt, true);
    });
  }
  /* knob -> params (manual control; cancels automation on that param) */
  setKnob(p, v, t = ctx.currentTime) {
    this.knob[p] = v; const tc = 0.02;
    const apply = (param, val) => { hold(param, t); glide(param, val, t, tc); };
    if (p === 'low') apply(this.low.gain, v); else if (p === 'mid') apply(this.mid.gain, v); else if (p === 'high') apply(this.high.gain, v);
    else if (p === 'filter') { const f = filterFreqs(v); apply(this.hp.frequency, f.hp); apply(this.lp.frequency, f.lp); }
    else if (p === 'delay') { apply(this.dSend.gain, v * 0.8); this.dly.delayTime.setValueAtTime(clamp(this.beatSec * 0.75, 0.05, 3.9), t); apply(this.dFb.gain, 0.3 + v * 0.3); }
    else if (p === 'reverb') apply(this.rSend.gain, v * 0.9);
    else if (p === 'trim') apply(this.trim.gain, v * this.autoGain);
  }
  /* snap every param back to knob state at time t (end of an automated script) */
  restore(t, tc = 0.06) {
    const k = this.knob, f = filterFreqs(k.filter);
    const set = (param, v) => { hold(param, t); glide(param, v, t, tc); };
    set(this.low.gain, k.low); set(this.mid.gain, k.mid); set(this.high.gain, k.high); set(this.hp.frequency, f.hp); set(this.lp.frequency, f.lp);
    set(this.dSend.gain, k.delay * 0.8); set(this.dFb.gain, 0.3 + k.delay * 0.3); set(this.rSend.gain, k.reverb * 0.9);
    set(this.loopDry.gain, 1); set(this.loopIn.gain, 1); set(this.loopWet.gain, 0); set(this.loopFb.gain, 0);
    set(this.flWet.gain, 0); set(this.flFb.gain, 0); set(this.phWet.gain, 0); set(this.gate.gain, 1);
    this.hp.Q.setValueAtTime(0.9, t); this.lp.Q.setValueAtTime(0.9, t);
  }
  /* cancel a running "ride" (see ride()) and glide its params back to the knob settings */
  unride(t = ctx.currentTime) {
    if (!(this._rideUntil > t)) return;
    const k = this.knob, f = filterFreqs(k.filter);
    const base = { low: k.low, mid: k.mid, high: k.high, lp: f.lp, hp: f.hp, trim: k.trim * this.autoGain, dSend: k.delay * 0.8, rSend: k.reverb * 0.9 };
    this._ridden.forEach(([p, key]) => { hold(p, t); glide(p, base[key], t, 0.05); }); this._rideUntil = 0; this._ridden = [];
  }
  /* ---- FX primitives (all scheduled on the AudioContext clock) ---- */
  loopOn(t, len) { hold(this.loopDelay.delayTime, t); setAt(this.loopDelay.delayTime, clamp(len, 0.02, 7.9), t); [[this.loopIn, 0], [this.loopFb, 1], [this.loopWet, 1], [this.loopDry, 0]].forEach(([n, v]) => { hold(n.gain, t); glide(n.gain, v, t, 0.003); }); }
  loopLen(t, len) { setAt(this.loopDelay.delayTime, clamp(len, 0.02, 7.9), t); }
  loopOff(t) { [[this.loopIn, 1], [this.loopFb, 0], [this.loopWet, 0], [this.loopDry, 1]].forEach(([n, v]) => { hold(n.gain, t); glide(n.gain, v, t, 0.004); }); }
  stutter(t0, t1, div) { const p = this.gate.gain; hold(p, t0); for (let t = t0; t < t1 - 1e-4; t += div) { glide(p, 1, t, 0.002); glide(p, 0, t + div * 0.5, 0.003); } glide(p, 1, t1, 0.003); }
  echo(t, amount, fb = 0.5, beats = 0.75) { const p = this.dSend.gain; setAt(this.dly.delayTime, clamp(this.beatSec * beats, 0.05, 3.9), t); hold(this.dFb.gain, t); glide(this.dFb.gain, fb, t, 0.01); hold(p, t); glide(p, amount, t, 0.01); }
  flanger(t, on) { hold(this.flWet.gain, t); hold(this.flFb.gain, t); glide(this.flWet.gain, on ? 0.75 : 0, t, 0.05); glide(this.flFb.gain, on ? 0.6 : 0, t, 0.05); }
  phaser(t, on) { hold(this.phWet.gain, t); glide(this.phWet.gain, on ? 0.9 : 0, t, 0.05); }
  /* tape stop: ramps playbackRate (pitch drops) — timer driven, media element can't be AudioParam-automated */
  brake(t, dur) {
    const startIn = Math.max(0, (t - ctx.currentTime) * 1000);
    setTimeout(() => {
      const el = this.el, r0 = el.playbackRate || 1, t0 = performance.now();
      el.preservesPitch = false; el.mozPreservesPitch = false; el.webkitPreservesPitch = false;
      const step = () => { const x = (performance.now() - t0) / (dur * 1000); if (x >= 1 || el.paused) { el.pause(); return; } el.playbackRate = Math.max(0.07, r0 * Math.pow(1 - x, 1.6)); requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }, startIn);
    hold(this.lp.frequency, t); expo(this.lp.frequency, 900, t + dur);
  }
  vuLevel() { this.vu.getFloatTimeDomainData(this.vuBuf); let s = 0; for (const x of this.vuBuf) s += x * x; return Math.sqrt(s / this.vuBuf.length); }
}
function filterFreqs(x) {
  // x<0: low-pass closes 20k -> 150 Hz ; x>0: high-pass opens 10 -> 6k Hz
  if (x < -0.01) return { hp: 10, lp: 20000 * Math.pow(150 / 20000, -x) };
  if (x > 0.01) return { hp: 20 * Math.pow(300, x), lp: 22000 };
  return { hp: 10, lp: 22000 };
}
function freqsToFilter(hp, lp) {
  if (hp > 18) return clamp(Math.log(hp / 20) / Math.log(300), 0, 1);
  if (lp < 19000) return -clamp(Math.log(20000 / lp) / Math.log(20000 / 150), 0, 1);
  return 0;
}
/* ---------- mixing engine ---------- */
const S = { set: [], idx: -1, decks: [], live: null, playing: false, paused: false, inTrans: false, transAt: Infinity, segStart: 0,
  lastScript: '', lastFlourish: -1, lastRiser: -1, buildId: 0, params: null, extending: false, braking: false, preloading: null };
const opt = id => $('#' + id);
const xfLen = () => +opt('xfLen').value;
const perTrack = () => +opt('perTrack').value;
const fxAmt = () => ({ subtle: 0.1, normal: 0.22, wild: 0.42 })[opt('fxAmt').value] || 0.22;
const isChillSet = () => { const p = S.params || {}; return (p.moods || []).some(m => m === 'chill' || m === 'dreamy') || (p.genres || []).some(g => g === 'lofi' || g === 'downtempo' || g === 'hiphop'); };

function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended' && !S.paused) ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  Master.init(); Master.out.gain.value = +opt('masterVol').value;
  S.decks = [new Deck('A'), new Deck('B')];
  S.decks.forEach((d, i) => { d.ui = $(i ? '#deckB' : '#deckA'); d.el.addEventListener('error', () => onDeckError(d)); });
  bindDeckUI();
  setInterval(tick, 100);
}
const other = d => S.decks[0] === d ? S.decks[1] : S.decks[0];

function startPosFor(tr, isFirst) {
  if (tr.preview) return 0;
  const bs = 60 / (tr.bpm || 120), ph = (tr.an && tr.an.phase) || 0;
  let target = 0;
  if (!isFirst && opt('skipIntro').checked) target = Math.min(tr.dur * 0.1, 32);
  const need = (perTrack() || 180) + xfLen() + 4;
  target = Math.max(0, Math.min(target, tr.dur - need));
  const k = Math.max(0, Math.round((target - ph) / bs / 16) * 16);
  return Math.max(0, ph + k * bs);
}
function computeTransAt() {
  const d = S.live; if (!d || !d.track) return;
  const tr = d.track, bs = 60 / (tr.bpm || 120), ph = d.phase, start = S.segStart;
  const dur = tr.dur || d.el.duration || 180;
  let end = perTrack() > 0 && !tr.preview ? Math.min(dur - 1, start + perTrack()) : dur - 0.6;
  const xft = Math.min(xfLen() * (d.el.playbackRate || 1), (end - start) * 0.4);
  let at = end - xft;
  if (!tr.preview) {   // land the mix on a phrase boundary when possible
    const b = (at - ph) / bs; const p16 = ph + Math.floor(b / 16) * 16 * bs, p4 = ph + Math.floor(b / 4) * 4 * bs;
    at = p16 > start + 40 ? p16 : p4 > start + 20 ? p4 : at;
  }
  S.transAt = Math.max(start + 8, at);
}
function nextIdx(from) { for (let i = from; i < S.set.length; i++) if (!S.set[i].bad) return i; return -1; }

async function preloadNext() {
  const i = nextIdx(S.idx + 1); if (i < 0 || !S.live) return;
  const d = other(S.live), tr = S.set[i];
  if (d.track === tr && (d.ready || S.preloading === tr)) return;
  S.preloading = tr;
  try { await d.load(tr, startPosFor(tr, false)); applyAutoGain(d); renderDecks(); }
  catch (e) { console.warn('preload failed', tr.title, e); if (S.preloading === tr) { tr.bad = true; renderList(); S.preloading = null; return preloadNext(); } }
  if (S.preloading === tr) S.preloading = null;
  maybeExtend();
}
function applyAutoGain(d) {
  const tr = d.track; d.autoGain = tr && tr.an ? clamp(Math.pow(10, (-13 - tr.an.db) / 20), 0.55, 2.1) : 1;
  d.trim.gain.setTargetAtTime(d.knob.trim * d.autoGain, ctx.currentTime, 0.05);
}

async function playFrom(i) {
  ensureAudio();
  const d = S.live || S.decks[0]; const o = other(d);
  [d, o].forEach(x => { x.el.pause(); hold(x.xf.gain, ctx.currentTime); x.xf.gain.setValueAtTime(0, ctx.currentTime); x.restore(ctx.currentTime); });
  S.inTrans = false; S.idx = i; const tr = S.set[i];
  setStatus(`Loading “${tr.title}”…`, 'busy');
  try { await d.load(tr, startPosFor(tr, true)); }
  catch (e) { tr.bad = true; renderList(); const n = nextIdx(i + 1); if (n >= 0) return playFrom(n); setStatus('Could not load any track', 'err'); return; }
  S.live = d; applyAutoGain(d);
  const t = ctx.currentTime + 0.05;
  await d.el.play().catch(e => console.warn(e));
  S.playing = true; S.paused = false; document.body.classList.add('playing');
  const B = d.beatSec, fadeEnd = t + Math.max(3, B * 8);
  curve(d.xf.gain, 0, 1, t, fadeEnd, 'eqp');
  if (opt('autoFx').checked) { const f = filterFreqs(d.knob.filter); d.lp.frequency.setValueAtTime(400, t); expo(d.lp.frequency, f.lp, fadeEnd); showFx('INTRO FILTER', t, false, fadeEnd - t, d.name); }
  S.segStart = d.el.currentTime; computeTransAt(); S.lastFlourish = -1;
  setStatus('Live', 'ok'); renderAll(); preloadNext();
}

function chooseScript(D, I, synced) {
  if (!opt('autoFx').checked) return 'fade';
  const dE = (I.track.energy ?? .5) - (D.track.energy ?? .5);
  const pos = S.set.length > 1 ? S.idx / (S.set.length - 1) : 0;
  const chill = isChillSet(); let c;
  if (!synced) c = chill ? ['wash', 'echo', 'wash'] : ['echo', 'brake', 'roll', 'echo'];
  else if (chill) c = ['wash', 'filter', 'blend', 'phase', 'blend'];
  else if (dE > 0.12 || (pos > 0.45 && pos < 0.85 && fxAmt() > 0.3)) c = ['roll', 'stutter', 'filter', 'echo', 'blend'];
  else if (dE < -0.15) c = ['wash', 'echo', 'filter', 'flange'];
  else c = ['blend', 'filter', 'phase', 'blend', 'flange', 'echo'];
  if (fxAmt() < 0.15) c = c.filter(x => !['roll', 'stutter', 'brake', 'flange'].includes(x)).concat(['blend']);
  const opts = c.filter(x => x !== S.lastScript); return opts.length ? pick(opts) : c[0];
}

/* scripted transitions: (D)eck out, (I)ncoming, T start, B beat seconds, n beats -> {inAt, end} */
const SCRIPTS = {
  fade: { label: 'CROSSFADE', n: 'x', fn(D, I, T, B, n) { const T1 = T + n * B; curve(I.xf.gain, 0, 1, T, T1); D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, T, T1); return { inAt: T, end: T1 }; } },
  blend: { label: 'EQ BASS SWAP', n: 'x', fn(D, I, T, B, n, phase) {
    const T1 = T + n * B, mid = T + Math.round(n / 2) * B;
    curve(I.xf.gain, 0, 1, T, mid); D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, mid, T1);
    I.low.gain.setValueAtTime(-26, T); I.low.gain.setValueAtTime(-26, mid - B * 0.25); lin(I.low.gain, I.knob.low, mid);
    D.low.gain.setValueAtTime(D.knob.low, T); D.low.gain.setValueAtTime(D.knob.low, mid - B * 0.25); lin(D.low.gain, -26, mid);
    const q = T1 - Math.max(2, n / 4) * B; D.hp.frequency.setValueAtTime(filterFreqs(D.knob.filter).hp, q); expo(D.hp.frequency, 380, T1);
    if (phase) { D.phaser(T + B, true); showFx('PHASER', T + B, false, T1 - T - B, D.name); }
    showFx('BASS SWAP', mid - B, false, 2 * B, D.name + '→' + I.name); return { inAt: T, end: T1 }; } },
  phase: { label: 'PHASER BLEND', n: 'x', fn(D, I, T, B, n) { return SCRIPTS.blend.fn(D, I, T, B, n, true); } },
  filter: { label: 'FILTER SWEEP', n: 'x', fn(D, I, T, B, n) {
    const T1 = T + n * B, fD = filterFreqs(D.knob.filter), fI = filterFreqs(I.knob.filter);
    curve(I.xf.gain, 0, 1, T, T + n * B * 0.6); D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, T + n * B * 0.4, T1);
    D.hp.frequency.setValueAtTime(Math.max(10, fD.hp), T); expo(D.hp.frequency, 1700, T1); D.hp.Q.setValueAtTime(0.9, T); lin(D.hp.Q, 5, T1);
    I.lp.frequency.setValueAtTime(260, T); expo(I.lp.frequency, fI.lp, T1); I.lp.Q.setValueAtTime(3.5, T); lin(I.lp.Q, 0.9, T1);
    D.rSend.gain.setValueAtTime(D.knob.reverb * 0.9, T1 - 2 * B); lin(D.rSend.gain, 0.45, T1);
    return { inAt: T, end: T1 }; } },
  flange: { label: 'FLANGE OUT', n: 'x', fn(D, I, T, B, n) { const r = SCRIPTS.filter.fn(D, I, T, B, n); D.flanger(T + n * B * 0.25, true); showFx('FLANGER', T + n * B * 0.25, false, n * B * 0.75, D.name); return r; } },
  wash: { label: 'REVERB WASH', n: 'x', fn(D, I, T, B, n) {
    const T1 = T + n * B, fI = filterFreqs(I.knob.filter);
    curve(I.xf.gain, 0, 1, T, T1); D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, T + n * B * 0.35, T1);
    D.rSend.gain.setValueAtTime(D.knob.reverb * 0.9, T); lin(D.rSend.gain, 0.8, T1);
    D.lp.frequency.setValueAtTime(filterFreqs(D.knob.filter).lp, T + n * B * 0.4); expo(D.lp.frequency, 650, T1);
    I.hp.frequency.setValueAtTime(480, T); expo(I.hp.frequency, Math.max(10, fI.hp), T + n * B * 0.65);
    return { inAt: T, end: T1 }; } },
  echo: { label: 'ECHO OUT', n: 8, fn(D, I, T, B, n) {
    const T1 = T + n * B, tE = T1 - 2 * B;
    D.xf.gain.setValueAtTime(1, T); D.xf.gain.setValueAtTime(1, T1 - 0.012); lin(D.xf.gain, 0, T1);
    D.echo(tE, 0.85, 0.62, 0.75); D.hp.frequency.setValueAtTime(filterFreqs(D.knob.filter).hp, tE); expo(D.hp.frequency, 520, T1);
    D.loopOn(T1 - B, B / 2); showFx('ECHO OUT', tE, false, 2 * B, D.name); showFx('LOOP 1/2', T1 - B, false, B, D.name);
    I.xf.gain.setValueAtTime(0, T); I.xf.gain.setValueAtTime(0, T1 - 0.004); lin(I.xf.gain, 1, T1 + 0.004); Master.impact(T1, 0.55); showFx('IMPACT', T1, false, 0.7);
    return { inAt: T1, end: T1 }; } },
  roll: { label: 'LOOP ROLL DROP', n: 8, fn(D, I, T, B, n) {
    const T1 = T + n * B, r = T1 - 4 * B;
    Master.riser(T1 - Math.min(8, n) * B, Math.min(8, n) * B); showFx('RISER', T1 - Math.min(8, n) * B, false, Math.min(8, n) * B);
    D.xf.gain.setValueAtTime(1, T); D.xf.gain.setValueAtTime(1, T1 - 0.012); lin(D.xf.gain, 0, T1);
    D.loopOn(r, B); D.loopLen(T1 - 2 * B, B / 2); D.loopLen(T1 - B, B / 4); D.loopLen(T1 - B / 2, B / 8);
    showFx('ROLL 1 → 1/8', r, false, 4 * B, D.name);
    D.hp.frequency.setValueAtTime(filterFreqs(D.knob.filter).hp, r); expo(D.hp.frequency, 950, T1);
    I.xf.gain.setValueAtTime(0, T); I.xf.gain.setValueAtTime(0, T1 - 0.004); lin(I.xf.gain, 1, T1 + 0.004); Master.impact(T1, 1); showFx('IMPACT', T1, false, 0.7);
    return { inAt: T1, end: T1 }; } },
  stutter: { label: 'STUTTER CUT', n: 4, fn(D, I, T, B, n) {
    const T1 = T + n * B;
    D.xf.gain.setValueAtTime(1, T); D.xf.gain.setValueAtTime(1, T1 - 0.012); lin(D.xf.gain, 0, T1);
    D.stutter(T1 - 2 * B, T1 - B, B / 4); D.stutter(T1 - B, T1, B / 8); D.echo(T1 - B / 2, 0.7, 0.5, 0.5);
    showFx('STUTTER 1/16 → 1/32', T1 - 2 * B, false, 2 * B, D.name);
    I.xf.gain.setValueAtTime(0, T); I.xf.gain.setValueAtTime(0, T1 - 0.004); lin(I.xf.gain, 1, T1 + 0.004); Master.impact(T1, 0.5); showFx('IMPACT', T1, false, 0.7);
    return { inAt: T1, end: T1 }; } },
  brake: { label: 'TAPE STOP', n: 4, fn(D, I, T, B, n) {
    const T1 = T + n * B, bt = T1 - 2 * B;
    S.braking = true; D.brake(bt, 2 * B); showFx('TAPE STOP', bt, false, 2 * B, D.name);
    D.xf.gain.setValueAtTime(1, T); D.xf.gain.setValueAtTime(1, T1 - 0.06); lin(D.xf.gain, 0, T1);
    D.rSend.gain.setValueAtTime(D.knob.reverb * 0.9, bt); lin(D.rSend.gain, 0.5, T1);
    I.xf.gain.setValueAtTime(0, T); I.xf.gain.setValueAtTime(0, T1 - 0.004); lin(I.xf.gain, 1, T1 + 0.004); Master.impact(T1, 0.8); showFx('IMPACT', T1, false, 0.7);
    return { inAt: T1, end: T1 }; } },
};

async function transition(kind = 'auto', toIdx = null, forceScript = null) {
  if (S.inTrans || !S.live) return;
  const D = S.live, I = other(D);
  let to = toIdx ?? nextIdx(S.idx + 1);
  if (to < 0) return outro();
  S.inTrans = true; let tr = S.set[to];
  if (I.track !== tr || !I.ready) {
    setStatus(`Cueing “${tr.title}”…`, 'busy');
    try { S.preloading = tr; await I.load(tr, startPosFor(tr, false)); applyAutoGain(I); S.preloading = null; }
    catch (e) { S.preloading = null; tr.bad = true; renderList(); S.inTrans = false; const n = nextIdx(to + 1); if (n >= 0 && kind === 'auto') return transition(kind, n); return; }
  }
  if (!S.playing || S.paused) { S.inTrans = false; return; }
  // tempo sync: match incoming to outgoing (allowing half/double time) if within ±8%
  const outBpm = (D.track.bpm || 120) * D.el.playbackRate, inBpm = tr.bpm || 120;
  const ratio = tempoRatio(inBpm, outBpm);   // multiply incoming rate by this
  const synced = !!(D.track.bpm && tr.bpm && Math.abs(ratio - 1) <= 0.08 && opt('tempoSync').checked);
  I.el.playbackRate = synced ? ratio : 1; I.el.preservesPitch = true;
  const script = forceScript || (kind === 'quick' ? (synced ? pick(['filter', 'echo', 'roll']) : 'echo') : chooseScript(D, I, synced));
  const SC = SCRIPTS[script]; S.lastScript = script;
  const B = D.beatSec;
  let n = SC.n === 'x' ? Math.max(4, Math.round(xfLen() / B / 4) * 4) : SC.n;
  if (kind === 'quick' && SC.n === 'x') n = Math.min(n, 8);
  if (tr.preview || D.track.preview) n = Math.min(n, Math.max(2, Math.floor(8 / B)));
  const remain = ((D.track.dur || D.el.duration) - D.el.currentTime) / (D.el.playbackRate || 1) - 0.3;
  let dt = D.untilBeat(kind === 'quick' ? 1 : 4, 0.12);
  if (dt + n * B > remain) { dt = D.untilBeat(1, 0.08); n = Math.max(1, Math.min(n, Math.floor((remain - dt) / B))); }
  const T = ctx.currentTime + dt;
  D.unride(); I.unride();
  [D, I].forEach(x => { [x.xf.gain, x.low.gain, x.hp.frequency, x.lp.frequency, x.rSend.gain, x.dSend.gain].forEach(p => hold(p, T)); });
  I.restore(ctx.currentTime, 0.01); I.xf.gain.setValueAtTime(0, ctx.currentTime);
  D.auto = I.auto = true;
  const r = SC.fn(D, I, T, B, n);
  showFx(SC.label + (synced ? ' · SYNC' : ''), T, true, Math.max(1.5, r.end - T), D.name + '→' + I.name);
  const lat = 0.035;  // media element start latency compensation
  setTimeout(() => { if (S.inTrans) I.el.play().then(() => setTimeout(() => phaseNudge(D, I), 450)).catch(console.warn); }, Math.max(0, (r.inAt - ctx.currentTime - lat) * 1000));
  setTimeout(() => $('#xfadeBadge').classList.add('on'), dt * 1000);
  setTimeout(() => finishTransition(D, I, to), Math.max(0, (r.end - ctx.currentTime) * 1000 + 60));
}
/* beat-phase correction after the incoming deck starts (like nudging a jog wheel) */
function phaseNudge(D, I) {
  if (!S.inTrans || D.el.paused || I.el.paused || !D.track.an || !I.track.an || S.braking) return;
  let d = (D.beatPos() - I.beatPos()) % 1; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
  const err = d * I.beatSec; if (Math.abs(err) < 0.012) return;
  const r0 = I.el.playbackRate, k = clamp(err / 0.6, -0.04, 0.04);
  I.el.playbackRate = r0 * (1 + k); setTimeout(() => { I.el.playbackRate = r0; }, 600);
}
function finishTransition(D, I, to) {
  const t = ctx.currentTime;
  D.el.pause(); S.braking = false; D.el.preservesPitch = true; D.el.playbackRate = 1;
  hold(D.xf.gain, t); D.xf.gain.setValueAtTime(0, t + 0.01);
  D.restore(t + 0.02, 0.08); I.restore(t, 0.08);
  D.auto = I.auto = false; D.ready = false;
  S.live = I; S.idx = to; S.inTrans = false; S.segStart = I.el.currentTime; S.lastFlourish = -1;
  $('#xfadeBadge').classList.remove('on');
  computeTransAt(); renderAll(); setStatus('Live', 'ok');
  setTimeout(preloadNext, 1500);
}
function outro() {
  if (S.inTrans || !S.live) return;
  S.inTrans = true; const D = S.live, T = ctx.currentTime + D.untilBeat(4, 0.1), B = D.beatSec, n = Math.max(8, Math.round(12 / B / 4) * 4), T1 = T + n * B;
  [D.xf.gain, D.rSend.gain, D.lp.frequency].forEach(p => hold(p, T));
  curve(D.xf.gain, 1, 0, T, T1); D.rSend.gain.setValueAtTime(D.knob.reverb * 0.9, T); lin(D.rSend.gain, 0.8, T1);
  D.lp.frequency.setValueAtTime(filterFreqs(D.knob.filter).lp, T); expo(D.lp.frequency, 500, T1); showFx('OUTRO WASH', T, true, T1 - T, D.name);
  setTimeout(() => { D.el.pause(); D.restore(ctx.currentTime); S.inTrans = false; S.playing = false; S.live = null; S.idx = S.set.length; document.body.classList.remove('playing');
    renderAll(); setStatus('Set complete', 'ok'); }, (T1 - ctx.currentTime) * 1000 + 3000);
}
function onDeckError(d) {
  if (!d.track || !d.el.src) return;
  console.warn('deck error', d.name, d.el.error);
  if (d === S.live && S.playing && !S.inTrans) {   // try to resume once (signed URLs expire), then skip
    if (!d._retried) { d._retried = true; const t = d.el.currentTime, tr = d.track; const go = () => { if (d.track !== tr) return; d.el.src = tr.url; d.el.currentTime = t; d.el.play().catch(() => { }); };
      if (Providers.needsResolve(tr)) Providers.prepare(tr).then(go, go); else go(); return; }
    d.track.bad = true; renderList(); transition('quick');
  }
}

/* main clock: mix-out triggers, tempo glide, scripted flourishes */
function tick() {
  const d = S.live; if (!d || !S.playing || S.paused) return;
  const t = d.el.currentTime;
  if (!S.inTrans) {
    if (t >= S.transAt || d.el.ended) { transition('auto'); return; }
    const r = d.el.playbackRate; if (!S.braking && Math.abs(r - 1) > 0.0005) d.el.playbackRate = r + Math.sign(1 - r) * Math.min(0.00025, Math.abs(1 - r));
    if (opt('autoFx').checked) { flourish(d, t); ride(d, t); }
  }
}

/* "DJ hands" between transitions: one tasteful move per 16-beat phrase at most, decided ~1 beat before the
 * phrase starts and finished before the phrase ends (so it never collides with flourishes / mixes).
 * Moves are real AudioParam automation, so the knobs show them; grabbing a knob cancels that param's move. */
const RIDES = {
  hiCut:   { label: 'EQ RIDE · HIGH', w: [1, 1], fn(d, t0, B) { return rideParam(d, d.high.gain, 'high', d.knob.high - 3 - rng() * 2.5, t0 + 2 * B, 2 * B, 8 * B, 2 * B); } },
  lowDip:  { label: 'EQ RIDE · LOW', w: [0.5, 1.2], fn(d, t0, B) { return rideParam(d, d.low.gain, 'low', d.knob.low - 3 - rng() * 2, t0 + 4 * B, 2 * B, 6 * B, 1 * B); } },
  midLift: { label: 'EQ RIDE · MID', w: [0.8, 0.6], fn(d, t0, B) { return rideParam(d, d.mid.gain, 'mid', d.knob.mid + 1.5 + rng(), t0 + 2 * B, 4 * B, 6 * B, 2 * B); } },
  lpBreath:{ label: 'FILTER · LP BREATH', w: [1.3, 0.5], ok: d => d.knob.filter > -0.01, fn(d, t0, B) { return rideParam(d, d.lp.frequency, 'lp', 2200 + rng() * 1600, t0 + 4 * B, 4 * B, 4 * B, 2 * B, true); } },
  hpTease: { label: 'FILTER · HP SWEEP', w: [0.4, 1.3], ok: d => d.knob.filter < 0.01, fn(d, t0, B) {
    const p = d.hp.frequency, base = filterFreqs(d.knob.filter).hp, a = t0 + 10 * B, e = t0 + 16 * B - 0.01;
    hold(p, a); p.setValueAtTime(Math.max(10, base), a); expo(p, 260 + rng() * 200, e); p.setValueAtTime(base, e + 0.008);
    d._ridden.push([p, 'hp']); return [a, e]; } },
  gainRide:{ label: 'GAIN RIDE', w: [0.7, 0.9], fn(d, t0, B) { const base = d.knob.trim * d.autoGain; return rideParam(d, d.trim.gain, 'trim', base * (0.86 + rng() * 0.06), t0 + 4 * B, 4 * B, 4 * B, 2 * B); } },
  echoTap: { label: 'ECHO TAP', w: [0.6, 1], fn(d, t0, B) { const a = t0 + 7.5 * B; d.echo(a, 0.32, 0.38, 0.75); hold(d.dSend.gain, a + B / 2); glide(d.dSend.gain, d.knob.delay * 0.8, a + B / 2, 0.03); d._ridden.push([d.dSend.gain, 'dSend']); return [a, a + 2.5 * B]; } },
  verbTail:{ label: 'REVERB TAIL', w: [1.1, 0.6], fn(d, t0, B) { return rideParam(d, d.rSend.gain, 'rSend', 0.32 + rng() * 0.12, t0 + 6.5 * B, 1.5 * B, 0.5 * B, 2 * B); } },
};
function rideParam(d, p, key, v, a, rampIn, holdLen, rampOut, exp = false) {
  const k = d.knob, f = filterFreqs(k.filter);
  const base = { low: k.low, mid: k.mid, high: k.high, lp: f.lp, hp: f.hp, trim: k.trim * d.autoGain, dSend: k.delay * 0.8, rSend: k.reverb * 0.9 }[key];
  const r = exp ? expo : lin, e = a + rampIn + holdLen + rampOut;
  hold(p, a); p.setValueAtTime(base, a); r(p, v, a + rampIn); p.setValueAtTime(v, a + rampIn + holdLen); r(p, base, e);
  d._ridden.push([p, key]); return [a, e];
}
function ride(d, t) {
  const tr = d.track; if (!tr || !tr.an || tr.preview) return;
  const B = d.beatSec, bpos = d.beatPos(); if (bpos < 14) return;
  const ph = Math.ceil(bpos / 16) * 16, ahead = ph - bpos;
  if (ahead > 1.4 || ahead < 0.25 || d._rideFor === ph) return;
  d._rideFor = ph;
  const now = ctx.currentTime, t0 = now + ahead * B, toMix = (S.transAt - t) / (d.el.playbackRate || 1);
  if (d._rideUntil > now || toMix < (ahead + 18) * B) return;
  if (rng() > clamp(fxAmt() * 2.2, 0.25, 0.8)) return;
  const chill = isChillSet() ? 0 : 1;
  const opts = Object.entries(RIDES).filter(([k, R]) => (!R.ok || R.ok(d)) && !(k === 'hpTease' && (ph + 16) % 32 === 0) && Object.keys(d.grab).every(g => !d.grab[g]));
  if (!opts.length) return;
  let tot = opts.reduce((a, [, R]) => a + R.w[chill], 0), x = rng() * tot, key = opts[0][0];
  for (const [k, R] of opts) { x -= R.w[chill]; if (x <= 0) { key = k; break; } }
  d._ridden = []; const [a, e] = RIDES[key].fn(d, t0, B); d._rideUntil = e;
  showFx(RIDES[key].label, a, false, e - a, d.name, 'ride');
}

/* ---------- steering: genre / mood chips changed while playing -> morph the upcoming queue ---------- */
let steerTimer = null;
function scheduleSteer() {
  clearTimeout(steerTimer);
  if (!S.playing || !S.set.length || !S.params) return;
  steerTimer = setTimeout(steer, 1500);
}
const tempoDist = (a, b) => (a && b) ? Math.abs(Math.log(tempoRatio(a, b))) : 0.05;
async function steer() {
  if (!S.playing || !S.params) return;
  if (S.steering || S.extending) { scheduleSteer(); return; }
  const genres = selected('genres'), moods = selected('moods');
  if (!genres.length && !moods.length) return;
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  if (same(genres, S.params.genres || []) && same(moods, S.params.moods || [])) return;
  const label = [...genres.map(g => GENRES[g].label), ...moods.map(m => MOODS[m].label)].join(' · ');
  S.steering = true; const bid = S.buildId;
  setStatus(`Shifting to ${label}…`, 'busy'); const chip = showFx('SHIFTING → ' + label.toUpperCase(), fxNow(), false, 30, null, 'ride');
  try {
    const params = { ...S.params, genres, moods, prompt: $('#prompt').value.trim(), source: S.params.source, taste: opt('taste').value };
    const keepN = Math.min(S.set.length, Math.max(0, S.idx) + 2);           // playing + already-cued next stay
    const upcoming = S.set.slice(keepN).filter(t => !t.bad);
    const need = clamp(upcoming.length + 2, 8, 30);
    const res = await digCrates({ ...params, need, onStatus: () => { } });
    if (bid !== S.buildId || !S.playing) return;
    const keep = S.set.slice(0, Math.min(S.set.length, Math.max(0, S.idx) + 2));
    const have = new Set(keep.map(t => t.id));
    let fresh = res.tracks.filter(t => !have.has(t.id));
    if (!fresh.length) { setStatus('Nothing new found for ' + label + ' — keeping the set', 'ok'); return; }
    const anchor = keep[keep.length - 1] || S.live.track;
    const old = S.set.slice(keep.length).filter(t => !t.bad && !have.has(t.id));
    const bpms = fresh.map(t => t.bpm).filter(Boolean).sort((a, b) => a - b), newMid = bpms.length ? bpms[bpms.length >> 1] : anchor.bpm;
    const midBpm = anchor.bpm && newMid ? Math.sqrt(anchor.bpm * newMid) : (anchor.bpm || newMid);
    const fit = (t, ref, toward) => tempoDist(t.bpm, ref.bpm) + 0.6 * tempoDist(t.bpm, toward) + 0.02 * keyDist(t.cam, ref.cam);
    // bridge: one track from the old crate leaning toward the new tempo, then the new track that sits closest to it
    const bridges = [];
    if (old.length) { const b1 = old.slice().sort((a, b) => fit(a, anchor, midBpm) - fit(b, anchor, midBpm))[0]; bridges.push(b1); }
    const ref = bridges[0] || anchor;
    const b2 = fresh.slice().sort((a, b) => fit(a, ref, newMid) - fit(b, ref, newMid))[0]; bridges.push(b2);
    bridges.forEach(t => { t.pinned = true; t.bridge = true; });
    fresh = fresh.filter(t => t !== b2);
    const tail = sequence(fresh, opt('order').value === 'found' ? 'found' : 'build', [b2]).slice(1);
    S.set = keep.concat(bridges, tail);
    S.params = { ...params, genres: res.info.genres, moods: res.info.moods };   // endless mode digs the new vibe from now on
    renderList(); analyzeAll();
    setStatus(`Shifting to ${label} · ${bridges.length} bridge track${bridges.length > 1 ? 's' : ''}, then ${tail.length} new`, 'ok');
    showFx('SET STEERED → ' + label.toUpperCase(), fxNow(), true, 3);
  } catch (e) { console.warn('steer failed', e); setStatus('Could not shift the set — try again', 'err'); }
  finally { S.steering = false; if (chip) chip.t1 = Math.min(chip.t1, fxNow()); }
}
function flourish(d, t) {
  const tr = d.track; if (!tr.an || tr.preview) return;   // only with a measured beat grid
  const B = d.beatSec, bpos = d.beatPos(), nb = Math.ceil(bpos / 32) * 32, ahead = nb - bpos;
  const tb = ctx.currentTime + ahead * B, toMix = (S.transAt - t) / (d.el.playbackRate || 1);
  if (bpos < 24 || toMix < (ahead + 12) * B) return;
  const p = fxAmt(), chill = isChillSet();
  if (ahead > 8.2 && ahead < 9.3 && S.lastRiser !== nb) {
    S.lastRiser = nb;
    if (!chill && (tr.energy ?? .5) > 0.5 && rng() < p * 0.45) { Master.riser(tb - 8 * B, 8 * B); Master.impact(tb, 0.45); showFx('RISER → DROP', tb - 8 * B, false, 8 * B, d.name); }
    return;
  }
  if (ahead > 2.3 || ahead < 1.15 || S.lastFlourish === nb) return;
  S.lastFlourish = nb; if (rng() > p) return;
  const fx = pick(chill ? ['throw', 'dip', 'wash'] : ['roll', 'throw', 'dip', 'stutter', 'roll']);
  if (fx === 'roll') { d.loopOn(tb - B, B / 2); d.loopLen(tb - B / 2, B / 4); d.loopOff(tb); showFx('LOOP ROLL', tb - B, false, B, d.name); }
  else if (fx === 'throw') { d.echo(tb - B, 0.6, 0.45, 0.75); hold(d.dSend.gain, tb - B / 2); glide(d.dSend.gain, d.knob.delay * 0.8, tb - B / 2, 0.02); showFx('ECHO THROW', tb - B, false, B, d.name); return; }
  else if (fx === 'dip') { const f = filterFreqs(d.knob.filter); hold(d.hp.frequency, tb - 2 * B); d.hp.frequency.setValueAtTime(Math.max(10, f.hp), tb - 2 * B); expo(d.hp.frequency, 700, tb - 0.02); showFx('FILTER DIP', tb - 2 * B, false, 2 * B, d.name); }
  else if (fx === 'stutter') { d.stutter(tb - B / 2, tb, B / 8); showFx('STUTTER', tb - B / 2, false, B / 2, d.name); }
  else if (fx === 'wash') { hold(d.rSend.gain, tb - 2 * B); d.rSend.gain.setValueAtTime(d.knob.reverb * 0.9, tb - 2 * B); lin(d.rSend.gain, 0.55, tb); showFx('REVERB SWELL', tb - 2 * B, false, 2 * B, d.name); }
  d.auto = true; setTimeout(() => { if (!S.inTrans) { d.restore(ctx.currentTime, 0.03); d.auto = false; } }, (tb - ctx.currentTime) * 1000 + 20);
}

/* endless mode: dig more of the same vibe before the set runs out */
async function maybeExtend() {
  if (!opt('endless').checked || S.extending || !S.params) return;
  const left = S.set.slice(S.idx + 1).filter(t => !t.bad).length; if (left > 2) return;
  S.extending = true;
  try {
    const exclude = new Set(S.set.map(t => t.id));
    const res = await digCrates({ ...S.params, need: 8, onStatus: () => { } });
    const fresh = res.tracks.filter(t => !exclude.has(t.id));
    if (fresh.length) {
      const head = S.set.slice(0, S.idx + 2); const seq = sequence(fresh, 'build', [head[head.length - 1]]).slice(1);
      S.set = head.concat(seq, S.set.slice(S.idx + 2)); renderList(); analyzeAll(); showFx('+' + fresh.length + ' TRACKS DUG', ctx.currentTime);
    }
  } catch (e) { console.warn('extend failed', e); }
  S.extending = false;
}

/* background analysis + re-sequencing of upcoming tracks */
let analyzing = false;
async function analyzeAll() {
  if (analyzing) return; analyzing = true; const bid = S.buildId;
  try {
    for (; ;) {
      const todo = S.set.map((t, i) => ({ t, i })).filter(x => !x.t.an && !x.t.anFail && !x.t.bad && x.i >= S.idx);
      if (!todo.length || bid !== S.buildId) break;
      todo.sort((a, b) => a.i - b.i);
      await pool(todo.slice(0, 2), 2, async ({ t }) => {
        try { t.an = await analyzeTrack(t); if (!t.bpm && t.an.conf > 1.15) t.bpm = t.an.est; }
        catch (e) { t.anFail = true; console.info('analysis skipped:', t.title, e.message); }
        S.decks.forEach(d => { if (d.track === t && ctx) applyAutoGain(d); });
        if (S.live && S.live.track === t && !S.inTrans) computeTransAt();
        renderList();
      });
    }
    if (bid === S.buildId) resequenceUpcoming();
  } finally { analyzing = false; }
}
function resequenceUpcoming() {
  if (opt('order').value === 'found') return;
  let keep = S.idx < 0 ? 0 : Math.min(S.set.length, S.idx + 2);   // current + preloaded stay put
  while (keep < S.set.length && S.set[keep].pinned) keep++;          // steering bridge tracks stay in order
  if (S.set.length - keep < 3) return;
  const head = S.set.slice(0, keep), rest = S.set.slice(keep);
  const good = rest.filter(t => !t.bad), bad = rest.filter(t => t.bad);
  S.set = sequence(good, opt('order').value, head).concat(bad);
  renderList(); updateListInfo();
}
/* ---------- UI ---------- */
function setStatus(text, kind = '') { $('#statusText').textContent = text; $('#statusDot').className = 'dot ' + kind; }
/* FX timeline: every effect (pads, transition scripts, flourishes, rides) becomes a chip with a progress bar;
 * pads light from the real audio state of the decks (see updateDecks) and from this timeline */
const fxNow = () => ctx ? ctx.currentTime : performance.now() / 1000;
const FX_PAD = [[/RISER/, 'riser'], [/IMPACT/, 'impact'], [/LOOP|ROLL/, 'loop'], [/STUTTER/, 'stutter'], [/ECHO/, 'echo'], [/FILTER|SWEEP|DIP|LP |HP /, 'sweep'],
  [/FLANG/, 'flanger'], [/PHASER/, 'phaser'], [/REVERB|WASH|SWELL|VERB/, 'wash'], [/TAPE/, 'brake']];
const fxq = []; let lastFx = null;
function showFx(label, atCtx, major = false, dur = 0, deck = null, kind = '') {
  const now = fxNow(), t0 = ctx && atCtx ? Math.max(now, atCtx) : now;
  const ev = { label, t0, t1: t0 + (dur > 0 ? dur : major ? 2.6 : 1.6), major, deck, kind, pad: (FX_PAD.find(([re]) => re.test(label)) || [])[1] || null, el: null };
  fxq.push(ev); if (fxq.length > 40) { const o = fxq.shift(); if (o.el) o.el.remove(); }
  lastFx = ev; return ev;
}
function renderFx(now) {
  const box = $('#fxlog');
  for (let k = fxq.length - 1; k >= 0; k--) {
    const ev = fxq[k];
    if (now > ev.t1 + 0.5) { if (ev.el) ev.el.remove(); fxq.splice(k, 1); continue; }
    if (!ev.el && now >= ev.t0 - 0.03) {
      const el = ev.el = document.createElement('span'); el.className = 'fxchip' + (ev.major ? ' major' : '') + (ev.kind ? ' ' + ev.kind : '');
      el.innerHTML = `${esc(ev.label)}${ev.deck ? ` <small>${esc(ev.deck)}</small>` : ''}<i></i>`; box.appendChild(el); ev.bar = el.lastChild;
      while (box.children.length > 5) box.firstChild.remove();
    }
    if (ev.el) { const p = clamp((now - ev.t0) / Math.max(0.05, ev.t1 - ev.t0), 0, 1); ev.bar.style.transform = `scaleX(${p.toFixed(3)})`; if (now > ev.t1 && !ev.out) { ev.out = true; ev.el.classList.add('out'); } }
  }
}
const EMPTY_SET = '<li class="empty"><span class="ei">♪</span><b>No set yet</b><span>Pick a genre, then Generate &amp; Play</span></li>';
const EMPTY_LIKES = '<li class="empty"><span class="ei">♡</span><b>No likes yet</b><span>Tap ♡ on a track you love</span></li>';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function buildChips() {
  const saved = JSON.parse(localStorage.getItem('neondj.sel') || '{"g":["deep-house"],"m":["groovy"]}');
  $('#genres').innerHTML = Object.entries(GENRES).map(([k, v]) => `<button class="chip${saved.g.includes(k) ? ' on' : ''}" data-k="${k}" title="${v.zh}">${v.label}</button>`).join('');
  $('#moods').innerHTML = Object.entries(MOODS).map(([k, v]) => `<button class="chip${saved.m.includes(k) ? ' on' : ''}" data-k="${k}" title="${v.zh}">${v.label}</button>`).join('');
  $$('.chip').forEach(c => c.addEventListener('click', () => { c.classList.toggle('on'); saveSel(); scheduleSteer(); }));
}
/* Source <select> options come from the provider registry (order of registration) */
function buildSources() { const cur = opt('source').value; opt('source').innerHTML = Providers.usable().map(p => `<option value="${esc(p.id)}" title="${esc(p.hint || '')}"${p.id === Providers.defaultId ? ' selected' : ''}>${esc(p.label)}</option>`).join(''); if (cur && Providers.usable().some(p => p.id === cur)) opt('source').value = cur; }
const selected = id => $$(`#${id} .chip.on`).map(c => c.dataset.k);
function saveSel() { localStorage.setItem('neondj.sel', JSON.stringify({ g: selected('genres'), m: selected('moods') })); }
const PERSIST = ['setLen', 'perTrack', 'order', 'source', 'taste', 'xfLen', 'autoFx', 'tempoSync', 'skipIntro', 'endless', 'fxAmt', 'aiOn', 'aiModel'];
function loadOpts() { const o = JSON.parse(localStorage.getItem('neondj.opts') || '{}'); PERSIST.forEach(k => { const el = opt(k); if (!el || o[k] == null) return; el.type === 'checkbox' ? el.checked = o[k] : el.value = o[k]; }); opt('xfLenVal').textContent = xfLen() + 's'; }
function saveOpts() { const o = {}; PERSIST.forEach(k => { const el = opt(k); if (el) o[k] = el.type === 'checkbox' ? el.checked : el.value; }); localStorage.setItem('neondj.opts', JSON.stringify(o)); }

async function build() {
  clearTimeout(steerTimer);
  const btn = $('#buildBtn'); btn.disabled = true;
  ensureAudio(); if (ctx.state === 'suspended') await ctx.resume();
  rng = mulberry32((Date.now() ^ (Math.random() * 1e9)) & 0xffffffff);
  const prov = Providers.resolve(opt('source').value), caps = prov.capabilities;
  const params = { genres: selected('genres'), moods: selected('moods'), prompt: $('#prompt').value.trim(), source: prov.id, taste: opt('taste').value };
  const pt = perTrack() || 300, eff = Math.max(20, (caps.fullTrack ? pt : caps.previewSeconds) - xfLen());
  const need = clamp(Math.ceil(+opt('setLen').value * 60 / eff) + 1, 4, 30);
  S.buildId++;
  try {
    setStatus('Finding tracks…', 'busy');
    let res;
    try { res = await digCrates({ ...params, need, onStatus: s => setStatus(s, 'busy') }); if (!res.tracks.length) throw new Error('no tracks'); }
    catch (e) {
      const fb = Providers.fallbackFor(params.source); if (!fb) throw e;
      const fbName = fb.name + (fb.capabilities.fullTrack ? '' : ' previews');
      console.warn(`${prov.name} failed, falling back to ${fbName}`, e); setStatus(`${prov.name} unavailable — using ${fbName}`, 'busy');
      params.source = fb.id; res = await digCrates({ ...params, need, onStatus: s => setStatus(s, 'busy') });
    }
    if (!res.tracks.length) throw new Error('No tracks found — try other genres/moods');
    S.params = { ...params, genres: res.info.genres, moods: res.info.moods };
    const fresh = res.tracks;
    if (S.playing && S.live && !S.inTrans) {     // keep the groove: current track stays, new set mixes in after it
      const cur = S.live.track; S.set = sequence(fresh.filter(t => t.id !== cur.id), opt('order').value, [cur]); S.idx = 0;
      const o = other(S.live); o.ready = false; o.track = null; S.preloading = null; computeTransAt(); renderAll(); preloadNext();
      setStatus(`New set queued · ${fresh.length} tracks`, 'ok');
    } else {
      S.set = fresh; S.idx = -1; renderAll();
      // listen first: analyse the crate (bounded time) so the opener and arc are chosen from real audio features
      let done = 0; const deadline = sleep(14000);
      const job = pool(fresh, 3, async t => { try { t.an = await analyzeTrack(t); if (!t.bpm && t.an.conf > 1.15) t.bpm = t.an.est; } catch (e) { t.anFail = true; }
        done++; if (!S.playing) setStatus(`Analysing ${done}/${fresh.length}…`, 'busy'); });
      await Promise.race([job, deadline]);
      S.set = sequence(fresh.filter(t => !t.bad), opt('order').value, []); renderAll();
      setStatus('Starting…', 'busy');
      await playFrom(0);
    }
    analyzeAll();
  } catch (e) { console.error(e); setStatus(e.message || 'Build failed', 'err'); }
  finally { btn.disabled = false; }
}

function updateListInfo() {
  const live = S.set.filter(t => !t.bad); const tot = live.reduce((s, t) => s + Math.min(t.dur || 0, perTrack() || t.dur || 0), 0) - xfLen() * Math.max(0, live.length - 1);
  const bpms = live.map(t => t.bpm).filter(Boolean);
  $('#listInfo').textContent = live.length ? `${live.length} · ~${Math.round(tot / 60)} min${bpms.length ? ` · ${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))} BPM` : ''}` : '';
}
function renderList() {
  const ol = $('#tracklist');
  if (!S.set.length) { ol.innerHTML = EMPTY_SET; return; }
  ol.innerHTML = S.set.map((t, i) => {
    const cls = [i === S.idx ? 'cur' : '', i < S.idx ? 'done' : '', t.bad ? 'bad' : ''].join(' ');
    const bpm = t.bpm ? Math.round(t.bpm) : (t.an || t.anFail ? '—' : '…');
    const e = t.energy != null ? Math.round(t.energy * 100) : 0;
    return `<li class="${cls}" data-i="${i}" title="${esc(t.title)} — ${esc(t.artist)}${t.genre ? ' · ' + esc(t.genre) : ''}${t.mood ? ' · ' + esc(t.mood) : ''}">
      <span class="n">${i + 1}</span><img loading="lazy" src="${esc(t.artSmall)}" alt="" data-i="${i}" onerror="artFallback(this)">
      <span class="t"><b>${t.bridge && i > S.idx ? '<em class="btag">BRIDGE</em>' : ''}${esc(t.title)}</b><span>${esc(t.artist)}${t.genre ? ' · ' + esc(t.genre) : ''}</span></span>
      <span class="bpm"><b>${bpm}</b> bpm<br>${t.cam ? t.cam.s : ''}<i class="ebar"><i style="width:${e}%"></i></i></span>${heartBtn(t, i)}</li>`;
  }).join('');
  updateListInfo(); renderUpNext();
}
function artFallback(img) {   // some sources mirror artwork on several hosts (Track.artMirrors); try the next one before hiding
  const t = S.set[+img.dataset.i]; const m = t && t.artMirrors; img._k = (img._k || 0);
  if (m && img._k < m.length) { try { const u = new URL(img.src); img.src = m[img._k++] + u.pathname; return; } catch (e) { } }
  img.onerror = null; img.style.visibility = 'hidden';
}
function renderUpNext() { const i = nextIdx(S.idx + 1); $('#upNext').textContent = i >= 0 ? `${S.set[i].title} — ${S.set[i].artist}` : (S.set.length ? (opt('endless').checked ? 'finding more…' : 'end of set') : '—'); }
/* ---------- ♥ likes UI (store + taste logic in taste.js) ---------- */
const Likes = NEONDJ.taste.Likes;
const heartBtn = (t, i) => { const on = Likes.has(t); return `<button class="heart${on ? ' on' : ''}" data-like="${i}" title="${on ? 'Unlike' : 'Like'}" aria-pressed="${on}">${on ? '♥' : '♡'}</button>`; };
function toggleLike(t, el) {
  if (!t) return; const on = Likes.toggle(t);
  if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  showFx(on ? '♥ LIKED' : '♡ UNLIKED', ctx ? ctx.currentTime : 0);
}
function renderLikeNow() {
  const t = S.live && S.live.track, b = $('#likeNow'); if (!b) return;
  const on = !!t && Likes.has(t); b.disabled = !t; b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡'; b.setAttribute('aria-pressed', on);
  b.title = t ? (on ? 'Unlike (L)' : 'Like (L)') : 'Play something to like it';
}
function renderLikes() {
  const n = Likes.count(); $('#likedCount').textContent = n; $('#likedBtnCount').textContent = n;
  const ol = $('#likedList'); if (!ol) return;
  const all = Likes.all();
  ol.innerHTML = all.length ? all.map((t, i) => `<li data-k="${esc(Likes.key(t))}" title="${esc(t.title)} — ${esc(t.artist)}">
      <span class="n">${i + 1}</span><img loading="lazy" src="${esc(t.artSmall || t.art || '')}" alt="" onerror="this.style.visibility='hidden'">
      <span class="t"><b>${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">${esc(t.title)}</a>` : esc(t.title)}</b><span>${esc(t.artist)}${t.genre ? ' · ' + esc(t.genre) : ''}${t.src ? ' · ' + esc((Providers.get(t.src) || { name: t.src }).name) : ''}</span></span>
      <span class="bpm">${t.bpm ? `<b>${Math.round(t.bpm)}</b> bpm` : ''}<br>${esc((camelot(t.key) || {}).s || '')}</span>
      <button class="heart on" data-unlike="${esc(Likes.key(t))}" title="Unlike">♥</button></li>`).join('')
    : EMPTY_LIKES;
  const P = NEONDJ.taste.profile(all);
  $('#tasteSummary').textContent = P ? [P.genres.size ? [...P.genres.entries()].filter(x => x[0]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(' / ') : '',
    P.bpm ? `${Math.round(P.bpm.lo + 4)}–${Math.round(P.bpm.hi - 4)} BPM` : '', P.topTags.slice(0, 4).join(', ')].filter(Boolean).join(' · ') : '';
}
function showLiked(on) {
  $('#listPanel').classList.toggle('show-liked', on); $('#tabSet').classList.toggle('on', !on); $('#tabLiked').classList.toggle('on', on);
  if (on) renderLikes();
}
function exportLikes() {
  const blob = new Blob([JSON.stringify(Likes.exportData(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `muse-likes-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  setStatus(`Exported ${Likes.count()} likes`, 'ok');
}
async function importLikes(file) {
  try { const r = Likes.importData(JSON.parse(await file.text())); setStatus(`Imported ${r.added} likes (${r.total} total${r.skipped ? ', ' + r.skipped + ' skipped' : ''})`, 'ok'); }
  catch (e) { setStatus('Import failed: ' + (e.message || e), 'err'); }
}
function bindLikes() {
  Likes.onChange(() => { renderLikes(); renderLikeNow(); renderList(); });
  $('#likeNow').addEventListener('click', e => toggleLike(S.live && S.live.track, e.currentTarget));
  $('#tabSet').addEventListener('click', () => showLiked(false));
  $('#tabLiked').addEventListener('click', () => showLiked(true));
  $('#likedBtn').addEventListener('click', () => showLiked(!$('#listPanel').classList.contains('show-liked')));
  $('#likedList').addEventListener('click', e => { const b = e.target.closest('[data-unlike]'); if (b) Likes.remove(b.dataset.unlike); });
  $('#likesExport').addEventListener('click', exportLikes);
  $('#likesImport').addEventListener('click', () => $('#likesFile').click());
  $('#likesFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importLikes(f); e.target.value = ''; });
  window.addEventListener('storage', e => { if (e.key === NEONDJ.taste.KEY) { Likes._reload(); renderLikes(); renderLikeNow(); renderList(); } });   // other tabs
  renderLikes(); renderLikeNow();
}
function renderNow() {
  const d = S.live, t = d && d.track;
  $('#nowTitle').textContent = t ? t.title : (S.set.length ? 'Ready' : 'Pick a vibe and hit Generate');
  $('#nowArtist').textContent = t ? t.artist + (t.genre ? ' · ' + t.genre : '') : '—';
  const img = $('#nowArt'); if (t && t.art) { if (img.dataset.src !== t.art) { img.dataset.src = t.art; img._k = 0; img.src = t.art; img.onerror = () => { const m = t.artMirrors || []; if (img._k < m.length) { const u = new URL(t.art); img.src = m[img._k++] + u.pathname; } }; } } else { img.removeAttribute('src'); img.dataset.src = ''; }
  renderLikeNow();
  $('#nowInfo').textContent = t ? [t.bpm ? Math.round(t.bpm * (d.el.playbackRate || 1)) + ' BPM' : '', t.cam ? t.cam.s : '', t.preview ? Providers.caps(t).previewSeconds + 's preview' : ''].filter(Boolean).join(' · ') : '';
}
function renderDecks() { S.decks.forEach(d => { d.ui.classList.toggle('live', d === S.live); $('.deckTrack', d.ui).textContent = d.track ? `${d.track.title} — ${d.track.artist}` : 'empty'; }); }
function renderAll() { renderList(); renderNow(); renderDecks(); }

/* ---- live decks: knobs follow the real AudioParam values every frame; drag / wheel / arrows to take over ---- */
const dbTxt = v => (v > 0.04 ? '+' : '') + (Math.round(v * 2) / 2).toFixed(Math.abs(v) < 10 && v % 1 ? 1 : 0) + 'dB';
const pctTxt = v => Math.round(v * 100) + '%';
const KNOBS = [
  { p: 'low', label: 'LOW', min: -24, max: 8, zero: 0, read: d => d.low.gain.value, txt: dbTxt },
  { p: 'mid', label: 'MID', min: -24, max: 8, zero: 0, read: d => d.mid.gain.value, txt: dbTxt },
  { p: 'high', label: 'HIGH', min: -24, max: 8, zero: 0, read: d => d.high.gain.value, txt: dbTxt },
  { p: 'filter', label: 'FILTER', min: -1, max: 1, zero: 0, read: d => freqsToFilter(d.hp.frequency.value, d.lp.frequency.value),
    txt: (v, d) => { if (!d) return 'off'; const hp = d.hp.frequency.value, lp = d.lp.frequency.value; const hz = f => f >= 1000 ? (f / 1000).toFixed(1) + 'k' : Math.round(f) + '';
      return hp > 18 ? 'HP ' + hz(hp) : lp < 19000 ? 'LP ' + hz(lp) : 'off'; } },
  { p: 'delay', label: 'ECHO', min: 0, max: 1, zero: 0, read: d => d.dSend.gain.value / 0.8, txt: pctTxt },
  { p: 'reverb', label: 'REVERB', min: 0, max: 1, zero: 0, read: d => d.rSend.gain.value / 0.9, txt: pctTxt },
  { p: 'trim', label: 'GAIN', min: 0, max: 1.5, zero: 0, read: d => d.trim.gain.value / (d.autoGain || 1), txt: v => v.toFixed(2) },
];
const SVGNS = 'http://www.w3.org/2000/svg';
const REDUCED = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
function knobFrac(K, v) { return (clamp(v, K.min, K.max) - K.min) / (K.max - K.min); }
function paintKnob(k, v, d) {
  const K = k.K, f = knobFrac(K, v), z = knobFrac(K, K.zero), a = Math.min(f, z), len = Math.abs(f - z);
  k.val.setAttribute('stroke-dasharray', `${(len * 75).toFixed(2)} 100`); k.val.setAttribute('stroke-dashoffset', (-a * 75).toFixed(2));
  k.ptr.setAttribute('transform', `rotate(${(-135 + f * 270).toFixed(1)} 22 22)`);
  const t = K.txt(v, d); if (t !== k.lastTxt) { k.out.textContent = t; k.lastTxt = t; }
  k.el.setAttribute('aria-valuenow', (+v).toFixed(2));
}
/* builds the deck panel once (at page load, before audio exists); bindDeckUI later attaches the live deck */
function buildDeckShell(ui, name) {
  ui.innerHTML = ''; ui.appendChild($('#deckTpl').content.cloneNode(true)); $('.deckName', ui).textContent = 'DECK ' + name;
  const box = $('.knobs', ui), knobs = {};
  KNOBS.forEach(K => {
    const el = document.createElement('div'); el.className = 'kn'; el.dataset.p = K.p; el.tabIndex = 0;
    el.setAttribute('role', 'slider'); el.setAttribute('aria-label', `Deck ${name} ${K.label}`); el.setAttribute('aria-valuemin', K.min); el.setAttribute('aria-valuemax', K.max);
    el.title = `${K.label} — drag / wheel / arrows · double-click resets`;
    el.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="cap" cx="22" cy="22" r="12.5"/><circle class="trk" cx="22" cy="22" r="18" pathLength="100" stroke-dasharray="75 100" transform="rotate(135 22 22)"/><circle class="val" cx="22" cy="22" r="18" pathLength="100" transform="rotate(135 22 22)"/><line class="ptr" x1="22" y1="13" x2="22" y2="17.5"/></svg><label>${K.label}</label><output></output>`;
    box.appendChild(el);
    const k = knobs[K.p] = { K, el, val: $('.val', el), ptr: $('.ptr', el), out: $('output', el), v: KNOB_DEFAULT[K.p], lastTxt: '', auto: false };
    paintKnob(k, k.v, null);
  });
  ui._refs = { knobs, lv: $('.meter .lv', ui), pk: $('.meter .pk', ui), fv: $('.fader .fv', ui), pbar: $('.pbar i', ui), pval: $('.pval', ui), pitch: $('.pitch', ui),
    bpm: $('.deckBpm', ui), state: $('.deckState', ui), lamps: Object.fromEntries($$('.lamps span', ui).map(x => [x.dataset.fx, x])), lampOn: {}, peak: 0, lvl: 0, fade: 0, rate: 0 };
}
function bindDeckUI() {
  S.decks.forEach(d => {
    if (!d.ui._refs) buildDeckShell(d.ui, d.name);
    const R = d.ui._refs;
    Object.values(R.knobs).forEach(k => {
      const K = k.K, p = K.p, el = k.el, range = K.max - K.min;
      const setK = v => { v = clamp(Math.round(v / (range / 400)) * (range / 400), K.min, K.max); if (Math.abs(K.zero - v) < range * 0.012) v = K.zero; d.setKnob(p, v); k.v = v; paintKnob(k, v, d); };
      let g = null;
      let lastDown = 0;
      el.addEventListener('pointerdown', e => { e.preventDefault(); const tnow = performance.now(); if (tnow - lastDown < 350) { lastDown = 0; setK(KNOB_DEFAULT[p]); return; } lastDown = tnow; el.setPointerCapture(e.pointerId); g = { y: e.clientY, v: d.knob[p] }; d.grab[p] = true; el.classList.add('grab'); el.focus({ preventScroll: true }); setK(d.knob[p]); });
      el.addEventListener('pointermove', e => { if (!g) return; setK(g.v + (g.y - e.clientY) / (e.shiftKey ? 600 : 160) * range); });
      const up = () => { if (!g) return; g = null; d.grab[p] = false; el.classList.remove('grab'); };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
      el.addEventListener('dblclick', () => setK(KNOB_DEFAULT[p]));
      el.addEventListener('wheel', e => { e.preventDefault(); setK(d.knob[p] - Math.sign(e.deltaY) * range / 64); }, { passive: false });
      el.addEventListener('keydown', e => {
        const st = range / (e.shiftKey ? 200 : 40);
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setK(d.knob[p] + st); else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setK(d.knob[p] - st);
        else if (e.key === 'Home' || e.key === 'Delete' || e.key === 'Backspace') setK(KNOB_DEFAULT[p]); else return;
        e.preventDefault(); e.stopPropagation();
      });
    });
  });
}
/* one rAF pass: read every deck's real node values, ease the display toward them, write only transforms/attributes */
let lastDeckFrame = 0;
function updateDecks(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - (lastDeckFrame || now)) / 1000)); lastDeckFrame = now;
  const ease = REDUCED.matches ? 1 : 1 - Math.exp(-dt / 0.055), cnow = ctx.currentTime;
  const padOn = {};
  S.decks.forEach(d => {
    const R = d.ui._refs; if (!R) return;
    for (const k of Object.values(R.knobs)) {
      const K = k.K, p = K.p, range = K.max - K.min;
      const real = d.grab[p] ? d.knob[p] : clamp(K.read(d), K.min, K.max);
      const nv = k.v + (real - k.v) * ease;
      if (Math.abs(nv - k.v) > range * 0.0005 || k.lastTxt === '') { k.v = Math.abs(real - nv) < range * 0.001 ? real : nv; paintKnob(k, k.v, d); }
      const auto = !d.grab[p] && Math.abs(real - d.knob[p]) > range * 0.02;
      if (auto !== k.auto) { k.auto = auto; k.el.classList.toggle('auto', auto); }
    }
    // level meter (dB scaled) with peak hold, channel fader = crossfader gain of this deck
    const lvl = d.vuLevel(), db = 20 * Math.log10(lvl + 1e-6), m = clamp((db + 48) / 48, 0, 1);
    R.lvl = REDUCED.matches ? m : Math.max(m, R.lvl - dt * 1.8); R.peak = Math.max(R.lvl, R.peak - dt * 0.35);
    R.lv.style.transform = `scaleY(${R.lvl.toFixed(3)})`; R.pk.style.transform = `translateY(${(-R.peak * (R.lv.parentNode._h || (R.lv.parentNode._h = R.lv.parentNode.clientHeight || 80))).toFixed(1)}px)`;
    const fade = d.xf.gain.value; R.fade += (fade - R.fade) * ease; R.fv.style.transform = `scaleY(${clamp(R.fade, 0, 1).toFixed(3)})`;
    // tempo / pitch
    const rate = d.track ? d.el.playbackRate || 1 : 1, pct = (rate - 1) * 100; R.rate += (pct - R.rate) * ease;
    R.pbar.style.transform = `translateX(${clamp(R.rate / 8, -1, 1) * 29}px)`;
    const ptxt = (pct >= 0 ? '+' : '') + pct.toFixed(Math.abs(pct) < 10 ? 2 : 1) + '%'; if (ptxt !== R.ptxt) { R.pval.textContent = ptxt; R.ptxt = ptxt; R.pitch.classList.toggle('moving', Math.abs(pct) > 0.05); }
    const btxt = d.track && d.track.bpm ? (d.track.bpm * rate).toFixed(1) + ' BPM' : ''; if (btxt !== R.btxt) { R.bpm.textContent = btxt; R.btxt = btxt; }
    const stxt = d === S.live ? 'LIVE' : d.track ? (!d.el.paused ? 'MIXING IN' : d.ready ? 'CUED' : 'LOADING') : 'EMPTY'; if (stxt !== R.stxt) { R.state.textContent = stxt; R.stxt = stxt; }
    // FX lamps from the real node state
    const f = filterFreqs(d.knob.filter);
    if (d.gate.gain.value < 0.85) d._stutAt = cnow;
    const on = { loop: d.loopWet.gain.value > 0.05, stutter: cnow - (d._stutAt || -9) < 0.25, echo: d.dSend.gain.value > d.knob.delay * 0.8 + 0.06,
      sweep: d.hp.frequency.value > f.hp * 1.4 + 25 || d.lp.frequency.value < f.lp * 0.7, flanger: d.flWet.gain.value > 0.05, phaser: d.phWet.gain.value > 0.05,
      wash: d.rSend.gain.value > d.knob.reverb * 0.9 + 0.08, brake: !d.el.preservesPitch && d.el.playbackRate < 0.97 && !d.el.paused };
    for (const id in on) { const v = on[id] && (d.xf.gain.value > 0.02 || id === 'echo' || id === 'wash'); if (v) padOn[id] = true; if (v !== !!R.lampOn[id]) { R.lampOn[id] = v; R.lamps[id].classList.toggle('on', v); } }
  });
  // crossfader position (eased)
  const a = S.decks[0].xf.gain.value, b = S.decks[1].xf.gain.value, x = (a + b) > 0.001 ? b / (a + b) : (S.live === S.decks[1] ? 1 : 0);
  viz.xf = (viz.xf ?? x) + (x - (viz.xf ?? x)) * ease; $('#xfader').value = viz.xf;
  // pads: lit while their effect is really running (any deck) or on the FX timeline (riser / impact)
  for (const ev of fxq) if (ev.pad && cnow >= ev.t0 - 0.02 && cnow <= ev.t1) padOn[ev.pad] = true;
  if (!viz.pads) viz.pads = Object.fromEntries($$('.pad[data-id]').map(el => [el.dataset.id, el]));
  for (const id in viz.pads) { const v = !!padOn[id]; if (v !== !!viz.padState?.[id]) { (viz.padState = viz.padState || {})[id] = v; viz.pads[id].classList.toggle('live', v); } }
}

/* ---- live FX pads ---- */
const PADS = [
  { id: 'loop', k: '1', label: 'LOOP ROLL', zh: '循环', hold: true },
  { id: 'stutter', k: '2', label: 'STUTTER', zh: '断奏', hold: true },
  { id: 'echo', k: '3', label: 'ECHO THROW', zh: '回声', hold: false },
  { id: 'sweep', k: '4', label: 'FILTER SWEEP', zh: '滤波扫频', hold: true },
  { id: 'flanger', k: '5', label: 'FLANGER', zh: '镶边', hold: true },
  { id: 'phaser', k: '6', label: 'PHASER', zh: '相位', hold: true },
  { id: 'wash', k: '7', label: 'REVERB WASH', zh: '混响', hold: true },
  { id: 'brake', k: '8', label: 'TAPE STOP', zh: '刹盘→下一首', hold: false },
  { id: 'riser', k: '9', label: 'RISER', zh: '噪音上升', hold: false },
  { id: 'impact', k: '0', label: 'IMPACT', zh: '重击', hold: false },
  { id: 'next', k: 'N', label: 'MIX NEXT', zh: '混到下一首', hold: false },
];
let beatLen = 1, target = 'live';
const targetDeck = () => target === 'live' ? S.live : S.decks[target === 'A' ? 0 : 1];
const heldFx = {};
function padDown(id) {
  lastFx = null;
  ensureAudio(); const d = targetDeck(); const now = ctx.currentTime;
  const playing = d && d.track && !d.el.paused;
  if (id === 'riser') { const ref = S.live; const B = ref ? ref.beatSec : 0.5; const dt = ref ? ref.untilBeat(8, 4 * B) : 8 * B; const end = now + dt; const st = Math.max(now, end - 8 * B); Master.riser(st, end - st); Master.impact(end, 0.8); showFx('RISER', now); return; }
  if (id === 'impact') { Master.impact(now + 0.01); showFx('IMPACT', now); return; }
  if (id === 'next') { if (S.live && !S.inTrans) transition('quick'); return; }
  if (!playing) return;
  const B = d.beatSec; d.auto = true; d.unride();
  queueMicrotask(() => { const p = PADS.find(x => x.id === id); if (p && p.hold && lastFx) { lastFx.t1 = fxNow() + 600; heldFx[id] = lastFx; } });
  if (id === 'loop') { const t = now + d.untilBeat(0.25, 0.005); d.loopOn(t, beatLen * B); showFx('LOOP ' + segLabel(beatLen), t, false, 0, d.name); }
  else if (id === 'stutter') { d._stut = setInterval(() => { const t = ctx.currentTime; d.stutter(t, t + B, B / 8); }, B * 1000); d.stutter(now, now + B, B / 8); showFx('STUTTER', now, false, 0, d.name); }
  else if (id === 'echo') { d.echo(now, 0.75, 0.55, beatLen < 1 ? beatLen : 0.75); setTimeout(() => { hold(d.dSend.gain, ctx.currentTime); glide(d.dSend.gain, d.knob.delay * 0.8, ctx.currentTime, 0.03); d.auto = false; }, B * 1000); showFx('ECHO THROW', now, false, 0, d.name); }
  else if (id === 'sweep') { hold(d.hp.frequency, now); d.hp.frequency.setValueAtTime(Math.max(10, d.hp.frequency.value), now); expo(d.hp.frequency, 2600, now + 4 * B); hold(d.hp.Q, now); lin(d.hp.Q, 5, now + 4 * B); showFx('FILTER SWEEP', now, false, 0, d.name); }
  else if (id === 'flanger') { d.flanger(now, true); showFx('FLANGER', now, false, 0, d.name); }
  else if (id === 'phaser') { d.phaser(now, true); showFx('PHASER', now, false, 0, d.name); }
  else if (id === 'wash') { hold(d.rSend.gain, now); glide(d.rSend.gain, 0.85, now, 0.15); hold(d.lp.frequency, now); expo(d.lp.frequency, 2500, now + B); showFx('REVERB WASH', now, false, 0, d.name); }
  else if (id === 'brake') {
    if (d === S.live && !S.inTrans && nextIdx(S.idx + 1) >= 0) transition('quick', null, 'brake');
    else { d.brake(now, 2 * B); hold(d.xf.gain, now); lin(d.xf.gain, 0, now + 2 * B); showFx('TAPE STOP', now, false, 0, d.name); }
  }
}
function padUp(id) {
  const hf = heldFx[id]; if (hf) { hf.t1 = Math.min(hf.t1, fxNow()); delete heldFx[id]; }
  if (!ctx) return; const d = targetDeck(); if (!d) return; const now = ctx.currentTime;
  if (id === 'loop') { d.loopOff(now); }
  else if (id === 'stutter') { clearInterval(d._stut); hold(d.gate.gain, now); glide(d.gate.gain, 1, now, 0.003); }
  else if (id === 'flanger') d.flanger(now, false);
  else if (id === 'phaser') d.phaser(now, false);
  else if (id === 'sweep') { const f = filterFreqs(d.knob.filter); hold(d.hp.frequency, now); glide(d.hp.frequency, f.hp, now, 0.06); hold(d.hp.Q, now); glide(d.hp.Q, 0.9, now, 0.05); }
  else if (id === 'wash') { hold(d.rSend.gain, now); glide(d.rSend.gain, d.knob.reverb * 0.9, now, 0.2); hold(d.lp.frequency, now); glide(d.lp.frequency, filterFreqs(d.knob.filter).lp, now, 0.08); }
  if (!S.inTrans) setTimeout(() => d.auto = false, 400);
}
const segLabel = b => b < 1 ? '1/' + Math.round(1 / b) : String(b);
function buildPads() {
  $('#padgrid').innerHTML = PADS.map(p => `<button class="pad" data-id="${p.id}" title="${p.zh} · ${p.hold ? 'hold' : 'tap'} · key ${p.k}">${p.label}<kbd>${p.k}</kbd></button>`).join('');
  $$('.pad').forEach(b => {
    const p = PADS.find(x => x.id === b.dataset.id);
    b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on'); padDown(p.id); });
    const up = () => { if (!b.classList.contains('on')) return; b.classList.remove('on'); if (p.hold) padUp(p.id); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
  });
  $$('#beatSeg button').forEach(b => b.addEventListener('click', () => {
    $$('#beatSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); beatLen = +b.dataset.b;
    const d = targetDeck(); if (d && $('.pad[data-id=loop]').classList.contains('on')) d.loopLen(ctx.currentTime, beatLen * d.beatSec);
  }));
  $$('#targetSeg button').forEach(b => b.addEventListener('click', () => { $$('#targetSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); target = b.dataset.t; }));
  const keyMap = Object.fromEntries(PADS.map(p => [p.k.toLowerCase(), p]));
  const down = new Set();
  window.addEventListener('keydown', e => {
    if (e.target.matches('input[type=text],input[type=password],select,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'l' || e.key === 'L') { if (!e.repeat && S.live) toggleLike(S.live.track, $('#likeNow')); return; }
    const p = keyMap[e.key.toLowerCase()]; if (!p || down.has(p.id)) return; down.add(p.id);
    $(`.pad[data-id=${p.id}]`).classList.add('on'); padDown(p.id);
  });
  window.addEventListener('keyup', e => { const p = keyMap[e.key.toLowerCase()]; if (!p || !down.has(p.id)) return; down.delete(p.id); $(`.pad[data-id=${p.id}]`).classList.remove('on'); if (p.hold) padUp(p.id); });
}

async function togglePlay() {
  if (!S.set.length) return build();
  ensureAudio();
  if (!S.live) { const i = nextIdx(Math.max(0, S.idx >= S.set.length ? 0 : S.idx)); if (i >= 0) return playFrom(i); return; }
  if (S.paused) {
    await ctx.resume(); S.paused = false;
    S.decks.forEach(d => { if (d._wasPlaying) d.el.play().catch(() => { }); d._wasPlaying = false; });
    setStatus('Live', 'ok'); document.body.classList.add('playing');
  } else {
    S.paused = true; S.decks.forEach(d => { d._wasPlaying = !d.el.paused; d.el.pause(); }); await ctx.suspend();
    setStatus('Paused', ''); document.body.classList.remove('playing');
  }
}

/* ---- visuals ---- */
const viz = { c: null, g: null, freq: null, wave: null, peak: [] };
function draw() {
  requestAnimationFrame(draw);
  const c = viz.c, g = viz.g, dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth * dpr, H = c.clientHeight * dpr; if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  g.clearRect(0, 0, W, H);
  const playing = ctx && S.playing && !S.paused;
  const N = 84, top = H * 0.1, base = H * 0.58;
  if (ctx) { if (!viz.freq) { viz.freq = new Uint8Array(Master.an.frequencyBinCount); viz.wave = new Uint8Array(Master.an.fftSize); } Master.an.getByteFrequencyData(viz.freq); Master.an.getByteTimeDomainData(viz.wave); }
  const grad = g.createLinearGradient(0, base, 0, top); grad.addColorStop(0, 'rgba(0,255,156,0.05)'); grad.addColorStop(0.5, 'rgba(0,255,156,0.42)'); grad.addColorStop(1, 'rgba(190,255,140,0.85)');
  const bw = W / N; const bins = viz.freq ? viz.freq.length : 0;
  for (let i = 0; i < N; i++) {
    let v = 0;
    if (viz.freq) { const a = Math.floor(Math.pow(i / N, 2.1) * bins * 0.7) + 1, b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / N, 2.1) * bins * 0.7) + 1); for (let k = a; k < b; k++) v = Math.max(v, viz.freq[k]); v /= 255; }
    else v = 0.04 + 0.03 * Math.sin(performance.now() / 700 + i / 5);
    const h = Math.max(2 * dpr, v * (base - top));
    viz.peak[i] = Math.max(h, (viz.peak[i] || 0) - 1.4 * dpr);
    const x = i * bw + bw * 0.18, w = bw * 0.64;
    g.fillStyle = grad; g.fillRect(x, base - h, w, h);
    g.fillStyle = 'rgba(0,255,156,0.08)'; g.fillRect(x, base + 2, w, h * 0.35);   // reflection
    g.fillStyle = 'rgba(210,255,230,0.75)'; g.fillRect(x, base - viz.peak[i] - 2 * dpr, w, 1.5 * dpr);
  }
  if (viz.wave && playing) {
    g.beginPath(); const step = viz.wave.length / W * 2;
    for (let x = 0, i = 0; x < W; x += 2, i += step) { const y = H * 0.32 + (viz.wave[Math.floor(i)] - 128) / 128 * H * 0.16; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = 'rgba(160,255,210,0.55)'; g.lineWidth = 1.3 * dpr; g.shadowColor = '#00ff9c'; g.shadowBlur = 12 * dpr; g.stroke(); g.shadowBlur = 0;
  }
  // beat grid ticks + pulse
  const d = S.live;
  if (d && playing) {
    const bp = d.beatPos(), frac = ((bp % 1) + 1) % 1, bar = Math.floor(bp) % 4;
    for (let k = 0; k < 4; k++) { g.fillStyle = k === ((bar + 4) % 4) ? 'rgba(0,255,156,0.95)' : 'rgba(0,255,156,0.2)'; g.fillRect(W - (4 - k) * 18 * dpr - 14 * dpr, H * 0.06 + 22 * dpr, 12 * dpr, 4 * dpr); }
    document.body.classList.toggle('beat', frac < 0.12);
    const tr = d.track, t = d.el.currentTime, dur = tr.dur || d.el.duration || 1;
    $('#nowBar').style.width = (t / dur * 100).toFixed(2) + '%';
    $('#nowTime').textContent = fmt(t); $('#nowLeft').textContent = S.inTrans ? 'mixing' : '-' + fmt(Math.max(0, S.transAt - t)) + ' to mix';
    $('#bpmNow').textContent = tr.bpm ? `${(tr.bpm * d.el.playbackRate).toFixed(1)} BPM` : '— BPM';
  }
  if (ctx && S.decks.length) updateDecks(performance.now());
  renderFx(fxNow());
  $('#playBtn').textContent = playing ? '❚❚' : '▶';
}

/* ---- init ---- */
function init() {
  Providers.list().forEach(p => { if (p.keywords) for (const g in GENRES) if (!p.genreFilters[g]) p.genreFilters[g] = [GENRES[g].label]; });
  buildChips(); buildSources(); buildPads(); loadOpts(); renderList(); bindLikes();
  buildDeckShell($('#deckA'), 'A'); buildDeckShell($('#deckB'), 'B');
  if (!Providers.usable().some(p => p.id === opt('source').value)) opt('source').value = Providers.defaultId;   // stale / removed provider id
  viz.c = $('#viz'); viz.g = viz.c.getContext('2d'); requestAnimationFrame(draw);
  $('#buildBtn').addEventListener('click', build);
  $('#playBtn').addEventListener('click', togglePlay);
  $('#nextBtn').addEventListener('click', () => { if (S.live && !S.inTrans) transition('quick'); });
  $('#prevBtn').addEventListener('click', () => { if (S.live && !S.inTrans) { S.live.el.currentTime = S.segStart; computeTransAt(); } });
  $('#xfLen').addEventListener('input', () => { opt('xfLenVal').textContent = xfLen() + 's'; computeTransAt(); });
  $('#perTrack').addEventListener('change', computeTransAt);
  $('#order').addEventListener('change', () => { resequenceUpcoming(); });
  $('#masterVol').addEventListener('input', e => { if (ctx) Master.out.gain.setTargetAtTime(+e.target.value, ctx.currentTime, 0.03); });
  $('#tracklist').addEventListener('click', e => {
    const hb = e.target.closest('[data-like]'); if (hb) { e.stopPropagation(); toggleLike(S.set[+hb.dataset.like], hb); return; }
    const li = e.target.closest('li[data-i]'); if (!li) return; const i = +li.dataset.i; const t = S.set[i]; if (!t || i === S.idx) return;
    t.bad = false;
    if (!S.live) { ensureAudio(); return playFrom(i); }
    if (S.inTrans) return;
    // move the clicked track to "next" and mix into it now
    const [tr] = S.set.splice(i, 1); const at = i < S.idx ? S.idx : S.idx + 1; if (i < S.idx) S.idx--; S.set.splice(S.idx + 1, 0, tr);
    const o = other(S.live); if (o.track !== tr) { o.ready = false; }
    renderList(); transition('quick', S.idx + 1);
  });
  document.addEventListener('change', e => { if (e.target.closest('.gen, .transport, .pads')) saveOpts(); });
  $('#aiKey').value = localStorage.getItem('neondj.aikey') || '';
  $('#aiKey').addEventListener('change', e => { e.target.value ? localStorage.setItem('neondj.aikey', e.target.value) : localStorage.removeItem('neondj.aikey'); });
  $('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter') build(); });
  // NetEase proxy (Advanced): the NetEase source only appears in the Source menu once a proxy URL is saved
  $('#neteaseProxy').value = Providers.settings.get('neteaseProxy');
  $('#proxySave').addEventListener('click', async () => {
    const v = $('#neteaseProxy').value.trim().replace(/\/+$/, '');
    if (v && !/^https:\/\/[^\s/]+/i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(v)) { setStatus('Proxy URL must start with https://', 'err'); return; }
    Providers.settings.set('neteaseProxy', v); buildSources();
    if (!v) { setStatus('NetEase proxy removed', ''); return; }
    setStatus('Checking proxy…', 'busy');
    try { const r = await Providers.get('netease').search('lofi', { limit: 3 }); setStatus(r.length ? 'NetEase proxy OK — pick it under Source' : 'Proxy answered, but no results', r.length ? 'ok' : 'err'); }
    catch (e) { setStatus('Proxy not reachable: ' + (e.message || e), 'err'); }
  });
  window.NEONDJ = Object.assign(window.NEONDJ || {}, { S, build, digCrates, sequence, analyzeTrack, transition, SCRIPTS });   // for debugging / tests (+ .providers)
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
