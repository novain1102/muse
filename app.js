/* Muse — browser DJ: builds a set from a vibe and mixes it live (no build step, no LLM by default)
 * Everything here is deterministic scripting + heuristics in the browser:
 *  - crate digging: curated seed keywords per genre/mood -> music provider search (providers/) -> taste scoring
 *  - music sources are pluggable: see providers/registry.js (interface + normalized Track) and providers/README.md
 *  - sequencing: tempo ladder (×2 / ×½ / 3:2 families, ≤1.6 % steps) + set arc (reset ~45 %, gear shift ~72 %) + artist cooldown,
 *    language spread and familiarity anchors (local search over one scoring function)
 *  - analysis: onset-envelope autocorrelation for tempo/beat-phase, RMS for energy/loudness; full tracks also get a structure pass
 *    (whole-song beat grid, downbeat / phrase phase, vocal activity, drumless intro, breaks, hi-hat density)
 *  - mixing: two decks; hip-hop / 华语 sets play phrase-length excerpts and pick each transition from a deterministic decision table
 *    (phrase cut, drop swap, bass swap, long blend, brake / echo step, ratio cut, drumless reset, echo out); Web Audio FX
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
  'hiphop':     { label: 'Hip-Hop / Trap', zh: '嘻哈 · Trap · 新派说唱', bpm: [70, 100], popTol: 0.6, recent: 2015, minYear: 2010, vocals: true,
                  // fullOnly: no 30 s previews when full tracks can be found; covers: other artists' versions / re-uploads of the
                  // seeds' songs are welcome; alsoCn: also dig the Chinese catalogues (Kugou, QQ, NetEase with a proxy) and merge
                  fullOnly: true, covers: true, alsoCn: true,
                  seeds: ['trap', 'melodic trap', 'rage', 'plugg', 'pluggnb', 'atlanta trap', 'dark trap', 'trap rap', 'melodic rap'],
                  scene: ['Travis Scott', 'Drake', 'Future', '21 Savage', 'Metro Boomin', 'Playboi Carti', 'Don Toliver', 'Lil Uzi Vert', 'Gunna', 'Young Thug', 'Kendrick Lamar'] },
  'lofi':       { label: 'Lo-Fi', zh: '低保真', bpm: [70, 92],
                  seeds: ['lofi beats', 'jazzhop', 'tape', 'dusty', 'chillhop', 'vinyl', 'rainy', 'mellow'] },
  'downtempo':  { label: 'Downtempo / Ambient', zh: '氛围', bpm: [80, 112],
                  seeds: ['downtempo', 'trip hop', 'organic', 'chillout', 'balearic', 'dub', 'ethereal', 'ambient'] },
  // 华语: current Chinese hip-hop / trap / club music (+ some modern R&B). Popular tracks wanted (hits: anti-chart scoring
  // relaxed), dug from Chinese sources first (cn: true), modern releases only (minYear, when the source reports a date)
  'cpop':       { label: '华语 C-Pop', zh: '地下说唱 · Trap · 新浪潮', bpm: [84, 150], hits: true, cn: true, minYear: 2016, fullOnly: true,
                  seeds: ['chinese hip hop', 'chinese trap', 'mandarin rap', 'chinese drill', 'c-rap', 'chinese underground rap', '华语说唱'],
                  // scene seed artists (scene.js ranks everything else by closeness to these: collabs, producers, albums, shared results);
                  // "A|B" = same artist, B is the name the CN catalogues use
                  alsoCn: true,
                  scene: ['Asen', 'ThomBoyDontkill', 'Mac Ova Seas', 'Sasioverlxrd|SASI', '华一龙', 'APMozart'] },
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
  [/华语|中文|国语|c-?pop|c-?rap|mandopop|说唱|中文rap|chinese/i, 'g', 'cpop'],
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
  else if (!ctx.hits) s -= 1.4 * (1 - (ctx.popTol || 0));   // > ~400k: viral / chart territory (hit genres skip it; popTol genres soften it)
  const love = ((sg.likes || 0) + 1.5 * (sg.reposts || 0)) / (p + 25);
  s += clamp(love * 18, 0, 1.3);     // engagement ratio = listeners actually liked it
  const f = sg.followers || 0;
  if (f > 400000) { if (!ctx.hits) s -= 0.7 * (1 - (ctx.popTol || 0)); } else if (f < 60000) s += 0.3;
  let hits = 0; for (const k of ctx.seedTerms) if (blob.includes(k)) hits++;
  s += Math.min(1.6, hits * 0.4);
  if (ctx.genreSet.has(t.genre)) s += 0.8; else if (ctx.genreSet.size) s -= 0.6;
  if (ctx.moodSet.size && t.mood) s += ctx.moodSet.has(t.mood) ? 0.7 : -0.15;
  const aname = sg.artistName ?? t.artist ?? '';
  if (!ctx.hits && (MAINSTREAM.test(title) || MAINSTREAM.test(aname))) s -= 1.3 * (1 - (ctx.popTol || 0));   // chart bait / pop re-rubs
  if (ctx.vocals) { if (/instrumental|\bbeats?\b|\btype\b|for freestyle|\binst\b/i.test(title)) s -= 1.3; else if (/\bprod\.?\b|\bfeat\.?\b|\bft\.?\b/i.test(title)) s += 0.3; }   // genres that want rap / vocals, not beat uploads
  if (ctx.recent && t.year && t.year < ctx.recent) s -= 0.4 + 0.8 * Math.min(1, (ctx.recent - t.year) / 5);   // genres that want the current sound
  const uname = aname.toLowerCase();
  if (ctx.genrePhrases.some(gp => uname.includes(gp)) || /music|records? ?label|beats|official/i.test(uname) && /\d{3,}/.test(uname)) s -= 0.8;   // channel-style uploaders
  if (SOFT_PENALTY.test(title) && !ctx.allowEdits && !ctx.covers) s -= 0.35;
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
  // still outside the home range: a 3:2 reading (triplet feel) may land inside it
  if (dist(best) > 3) for (const c of [b * 1.5, b / 1.5, b * 0.75, b / 0.75]) if (dist(c) === 0) { best = c; break; }
  return Math.round(best * 10) / 10;
}
/* tempo ratio allowing half/double time */
function tempoRatio(from, to, triplet = false) {   // triplet: also 3:2 / 2:3 (for planning only; beat-matching never uses it)
  if (!from || !to) return 1;
  let best = to / from;
  for (const m of triplet ? [0.5, 2, 1.5, 2 / 3, 0.75, 4 / 3] : [0.5, 2]) { const r = (to * m) / from; if (Math.abs(Math.log(r)) < Math.abs(Math.log(best))) best = r; }
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
  const cfg = llmCfg(); if (!cfg.on) return [];
  const desc = [genres.map(g => GENRES[g].label).join('/'), moods.map(m => MOODS[m].label).join('/'), prompt].filter(Boolean).join(', ');
  const ck = 'neondj.ai.' + desc.toLowerCase();
  const cached = localStorage.getItem(ck); if (cached) { try { return JSON.parse(cached); } catch (e) { } }
  try {
    const r = await llmChat(cfg, [{ role: 'user', content: `Vibe: ${desc}. Give 6 short (1-3 word) search keywords a crate-digging DJ would use to find underground, non-chart tracks: sub-genres, scene terms, textures. No artist names. JSON: {"k":[...]}` }]);
    const k = r.k.filter(x => typeof x === 'string').slice(0, 6).map(x => x.toLowerCase().slice(0, 40));
    localStorage.setItem(ck, JSON.stringify(k)); return k;
  } catch (e) { console.warn('keyword expansion failed (ignored):', e); return []; }
}

/* ---------- crate digging ---------- */
const CN_PREFERRED = ['kugou', 'qqmusic', 'netease'];   // Chinese sources tried for 华语 (after the picked one, if it is Chinese); Audius last
const CN_ALL = CN_PREFERRED;   // alsoCn genres: every Chinese catalogue that is set up (NetEase only with a proxy), merged
function parsePrompt(text) {
  const g = new Set(), m = new Set(); let rest = text || '';
  for (const [re, kind, id] of PROMPT_MAP) if (re.test(rest)) { (kind === 'g' ? g : m).add(id); }
  // tech house / deep house shouldn't also select plain house
  if (g.has('deep-house') || g.has('tech-house')) { if (!/\bhouse\b(?! *(music)?$)/i.test(rest.replace(/(deep|tech) ?house/ig, ''))) g.delete('house'); }
  const words = rest.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(w => /^[a-z0-9-]{3,}$/i.test(w) && !/^(and|the|with|for|music|songs?|vibes?|some|set|mix)$/i.test(w));
  return { g: [...g], m: [...m], words: words.slice(0, 4).map(w => w.toLowerCase()) };
}

/* full-track sources never hand back 30 s previews (a preview-only catalogue plays only when you pick it as Source) */
async function digCrates(args) {
  const r = await digCrates0(args), p = Providers.resolve(args.source);
  if (!args._mix && r && r.tracks && p && p.capabilities.fullTrack) r.tracks = r.tracks.filter(t => !t.preview);
  return r;
}
async function digCrates0(args) {
  let { genres, moods, prompt, need, source, onStatus, taste } = args;
  const P = parsePrompt(prompt);
  const prov = Providers.resolve(source);
  if (!prov) throw new Error('no music provider registered');
  // taste (♥ likes, taste.js): TP stays null with zero likes or taste Off -> exactly the plain dig below
  const T = NEONDJ.taste, TM = T.mode(taste), likes = TM.w ? T.Likes.all() : [];
  const TP = likes.length ? T.profile(likes) : null;
  // dislikes: hard exclusion always; the soft down-rank follows the Taste setting (Off = none). AV stays null without dislikes
  const AV = T.avoid(), avW = 0.9 * TM.w;
  genres = [...new Set([...genres, ...P.g])]; moods = [...new Set([...moods, ...P.m])];
  if (TP && !genres.length && !moods.length && !String(prompt || '').trim()) genres = T.genresFor(prov, TP);   // nothing picked: start from what you liked
  if (!genres.length) { const s = new Set(); moods.forEach(m => (MOOD_FALLBACK_GENRES[m] || []).slice(0, 2).forEach(g => s.add(g))); genres = s.size ? [...s] : ['deep-house']; }
  if (!moods.length && !genres.length) moods = ['groovy'];
  // fullOnly genres: a preview-only pick (iTunes) is swapped for the default full-track source; alsoCn genres also dig the
  // Chinese catalogues (Kugou, QQ, NetEase) in parallel. Results are interleaved (one version per song); previews only if nothing full turns up.
  const fullOnly = genres.some(g => GENRES[g].fullOnly), alsoCn = genres.some(g => GENRES[g].alsoCn);
  if ((fullOnly && !prov.capabilities.fullTrack || alsoCn) && !args._mix) {
    const cnG = genres.some(g => GENRES[g].cn);   // Chinese genres: a Chinese catalogue leads (Audius stays the last resort below)
    const main = fullOnly && !prov.capabilities.fullTrack ? Providers.resolve('audius') : cnG && !prov.keywords ? Providers.get('kugou') : prov;
    const n = prov.capabilities.fullTrack ? need : Math.min(need, 14);   // need was sized for 30 s previews: full tracks need fewer
    const cn = [cnG ? null : 'audius', ...(alsoCn ? CN_ALL : [])].filter((id, i, a) => id && id !== main.id && a.indexOf(id) === i && Providers.get(id) && (!Providers.get(id).available || Providers.get(id).available()));   // + Audius (full tracks) for non-Chinese genres
    const runs = await Promise.all([main.id, ...cn].map((id, k) => digCrates({ ...args, genres, moods, need: k ? Math.ceil(n * 0.6) : n, source: id, _mix: true, _cn: true, _until: k ? Date.now() + 45000 : undefined, onStatus: k ? () => { } : onStatus })
      .catch(e => { console.warn(`${Providers.get(id).name}: nothing for this set`, e); return null; })));
    const lists = runs.map(r => r ? r.tracks : []), seen = new Set(), tracks = [];
    for (let i = 0; tracks.length < n && lists.some(l => l.length > i); i++) for (const l of lists) { const t = l[i]; if (!t || tracks.length >= n) continue; const k = NEONDJ.scene.song(t); if (seen.has(k)) continue; seen.add(k); tracks.push(t); }
    if (tracks.length >= Math.min(n, 4) || (tracks.length && !fullOnly)) return { tracks, info: { genres, moods }, source: main.id, liked: tracks.filter(t => t.fromLikes).length,
      sources: Object.fromEntries([main.id, ...cn].map((id, k) => [id, tracks.filter(t => lists[k].includes(t)).length + '/' + lists[k].length])) };   // used / found per source
  }
  // Chinese genres (华语) want a Chinese catalogue: try the picked source if it is one (e.g. QQ in mainland China), then
  // Kugou (plays worldwide); if both come back empty, carry on with the picked source (Audius: Chinese seed terms).
  if (genres.some(g => GENRES[g].cn) && !args._cn) {
    const tries = [prov.keywords ? prov.id : null, ...CN_PREFERRED].filter((x, i, a) => x && Providers.get(x) && (!Providers.get(x).available || Providers.get(x).available()) && a.indexOf(x) === i);
    let best = null;
    for (const id of tries) {
      try { const r = await digCrates({ ...args, genres, moods, source: id, _cn: true, _mix: true }); if (r.tracks.length >= Math.min(need, 4)) return r; if (r.tracks.length && (!best || r.tracks.length > best.tracks.length)) best = r; }
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
  const ctx = { hits: genres.some(g => GENRES[g].hits && !GENRES[g].scene), covers: genres.some(g => GENRES[g].covers), popTol: Math.max(0, ...genres.map(g => GENRES[g].popTol || 0)), vocals: genres.some(g => GENRES[g].vocals), recent: Math.max(0, ...genres.map(g => GENRES[g].recent || 0)), seedTerms, bpmRanges, genreSet: new Set(srcGenres), moodSet: new Set(srcMoods), allowEdits: genres.includes('disco'),
    genrePhrases: [...new Set([...srcGenres, 'lofi', 'lo-fi', 'deep house', 'techno', 'house music', 'hip hop', 'drum and bass'].map(x => x.toLowerCase()))].filter(x => x.length > 3) };
  const info = { genres, moods };

  const tx = TP ? { T, TP, TM, likes, taste } : null;
  if (prov.capabilities.crate !== 'scored') {
    let tracks = await digSimple(prov, genres, moods, P.words.concat(aiWords), need, onStatus, tx, AV && { T, A: AV, w: avW }, args._until || Infinity);
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
  // + the shared scene scorer (scene.js): variety-show penalty always, seed-artist proximity for genres with a scene
  const SC = NEONDJ.scene, sceneSeeds = genres.flatMap(g => GENRES[g].scene || []).flatMap(x => x.split('|'));
  const scoreAll = list => { const G = sceneSeeds.length ? SC.graph(list, sceneSeeds) : null;
    return (TP ? list.filter(t => !TP.ids.has(T.Likes.key(t))) : list).filter(t => !AV || !T.blocked(t, AV))
    .map(t => { let s = tasteScore(t, ctx); if (TP && s > -50) s += TM.w * T.similarity(t, TP); if (AV && avW && s > -50) s -= avW * T.penalty(t, AV);
      const v = SC.variety(t); if (v) s -= 2 * v; if (G) s += 2 * Math.max(SC.proximity(t, G), ctx.covers ? SC.versionOf(t, G) : 0); return { t, s }; }).filter(x => x.s > -50); };
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
async function digSimple(prov, genres, moods, words, need, onStatus, tx = null, av = null, until = Infinity) {   // until: time budget (merged digs)
  const full = prov.capabilities.fullTrack;
  onStatus(`Searching ${prov.name}…`);
  if (prov.init) await prov.init();
  const qs = [], KW = prov.keywords, gOf = new Map();   // gOf: query -> app genre that asked for it
  const add = (q, g) => { q = q.trim(); if (!q || gOf.has(q)) return; gOf.set(q, g); qs.push(q); };
  const SC = NEONDJ.scene, sceneG = genres.filter(g => GENRES[g].scene), seedQ = new Set();
  const sceneSeeds = sceneG.flatMap(g => GENRES[g].scene.flatMap(x => x.split('|')));
  // scene genres: search the seed artists (catalogue name = last alias); everything else is ranked by scene.js
  sceneG.forEach(g => shuffle(GENRES[g].scene).slice(0, GENRES[g].covers ? 7 : 99).forEach(x => { const q = x.split('|').pop(); add(q, g); seedQ.add(q); }));   // covers genres: a few seeds per dig (title searches follow)
  if (KW && KW.genres) {   // provider vocabulary (e.g. Chinese + English terms for CN platforms)
    for (const g of genres) {
      if (GENRES[g].scene && GENRES[g].covers) { shuffle(KW.genres[g] || []).slice(0, 2).forEach(q => add(q, g)); continue; }   // scene + covers: a couple of genre terms too
      if (GENRES[g].scene) continue;
      const terms = shuffle(KW.genres[g] || [GENRES[g].label]), fl = KW.flavors && KW.flavors[g];
      if (fl && moods.length) { moods.forEach(m => shuffle(fl[m] || []).slice(0, 2).forEach(q => add(q, g))); terms.slice(0, 2).forEach(q => add(q, g)); }
      else terms.slice(0, GENRES[g].hits ? 4 : 3).forEach((t, i) => add(t + (moods[0] && i === 1 && !GENRES[g].hits && KW.moods && KW.moods[moods[0]] ? ' ' + pick(KW.moods[moods[0]]) : ''), g));
    }
  } else for (const g of genres) { if (GENRES[g].scene) continue; const G = GENRES[g]; shuffle(G.seeds).slice(0, 3).forEach(s => add(s + (moods[0] ? ' ' + pick(MOODS[moods[0]].words) : ''), g)); }
  words.slice(0, 3).forEach(w => add(w, null));
  if (tx) tx.T.seedQueries(tx.TP, tx.taste, shuffle).forEach(q => add(q, null));
  const tag = (q, list) => { const g = gOf.get(q);
    list.forEach(t => { if (!t._q) t._q = q; });
    if (g) list.forEach(t => { if (!t.genre) t.genre = GENRES[g].label; t._g = g; }); return list; };
  let res;
  if ((prov.capabilities.searchConcurrency || 3) === 1) {   // throttling source: one search at a time, stop once the crate is deep enough
    res = []; const enough = need * (genres.some(g => GENRES[g].hits) ? 6 : 4);
    for (const q of qs) { if (Date.now() > until) break; try { res.push(...tag(q, await prov.search(q))); } catch (e) { } if (!seedQ.has(q) && res.filter(t => t.playable !== false).length >= enough) break; }
  } else res = (await pool(qs, 3, q => prov.search(q).then(list => tag(q, list)))).flat().filter(Boolean);
  let G = null;
  if (sceneG.length) {   // second hop: the seeds' strongest collaborators / producers get searched too
    G = SC.graph(res, sceneSeeds, res.filter(t => seedQ.has(t._q)));
    const coverG = sceneG.find(g => GENRES[g].covers);   // covers genres: the seeds' songs by title -> free versions / re-uploads
    const more = SC.expand(G, coverG ? 3 : 6).concat(coverG ? SC.songTitles(G, 7) : []).filter(q => !gOf.has(q)); more.forEach(q => add(q, sceneG[0]));
    const hop = async q => { try { return tag(q, await prov.search(q)); } catch (e) { return []; } };
    if ((prov.capabilities.searchConcurrency || 3) === 1) { for (const q of more) { if (Date.now() > until) break; res.push(...await hop(q)); } } else res.push(...(await pool(more, 3, hop)).flat());
    G = SC.graph(res, sceneSeeds, res.filter(t => seedQ.has(t._q)));
  }
  if (tx) res = res.concat(await digSimilar(prov, tx.likes, tx.TM, onStatus)).filter(t => !tx.TP.ids.has(tx.T.Likes.key(t)));
  const beatsy = genres.some(g => g === 'lofi' || g === 'downtempo');
  const offGenre = /^(rock|pop|soundtrack|country|singer\/songwriter|alternative|christian.*|children.*|holiday|vocal|classical|latino|k-pop|j-pop|metal|easy listening)$/i;
  const lazy = typeof prov.resolveStream === 'function';   // stream URL fetched per track (signed / expiring / maybe not free)
  const NOT_ORIGINAL = /\bdj\b|dj版|remix|伴奏|纯音乐|钢琴版|八音盒|合唱版|群星|铃声|片段|抖音|翻唱|翻自|\bcover\b|加速|降调|0\.\d+x|\b(slowed|sped)\b|女版|男版|live版|[(（]\s*live\s*[)）]|串烧|中文版|填词|女生版|男生版|\((drill|trap|phonk)\)/i;   // hit genres: originals only
  const ALTERED = /\bdj\b|remix|\bedit\b|mashup|[(（][^)）]*版[)）]|律动|带感|\bbeats?\b|\[free\]|\bfree\b.*\btype\b|\btype\b|\bflip\b|\bfilp\b|\binst\b|vina|\bhouse\b|dj版|氛围版|伴奏|纯音乐|钢琴版|八音盒|铃声|片段|抖音|加速|降调|0\.\d+x|\b(slowed|sped|nightcore|instrumental)\b|串烧|中文版|填词|\(music from/i;   // covers genres: other singers welcome, altered edits not
  const fanUpload = t => /《.+》/.test(t.title);   // "《show》song" re-uploads
  const tooOld = t => !!(t._g && GENRES[t._g].minYear && t.year && t.year < GENRES[t._g].minYear);
  const m = new Map(); res.forEach(t => { if (av && av.T.blocked(t, av.A)) return; if (tooOld(t)) return; if (t._g && GENRES[t._g].covers && (ALTERED.test(t.title + ' ' + (t.artist || '') + ' ' + (t.album || '')) || /\s[x×]\s/i.test(t.title))) return; if (t._g && GENRES[t._g].hits && (NOT_ORIGINAL.test(t.title + ' ' + (t.artist || '')) || fanUpload(t) || tooOld(t))) return; if (t.playable !== false && (t.url || lazy) && (t.fullDur ?? t.dur ?? 0) > 120 && !m.has(t.id) && !HARD_REJECT.test(t.title || '') && (!MAINSTREAM.test((t.artist || '') + ' ' + t.title) || (t._g && (GENRES[t._g].popTol || 0) >= 0.5)) && (beatsy || !offGenre.test(t.genre || ''))) m.set(t.id, t); });
  const per = new Map(), out = [];
  let order = shuffle([...m.values()]);
  if (G && !G.empty) {   // scene genres: the shared scorer (seed proximity − mainstream − variety show), only tracks near the scene
    const pop = SC.popularity(res);
    NEONDJ._lastScene = { G, pop, seen: res.length };   // for tests / debugging
    const tol = t => (t._g && GENRES[t._g].popTol) || 0, old = t => { const R = t._g && GENRES[t._g].recent; return R && t.year && t.year < R ? 0.4 + 0.8 * Math.min(1, (R - t.year) / 5) : 0; };
    order = order.map(t => ({ t, x: SC.score(t, { G, pop, wPop: 1 - tol(t), covers: !!(t._g && GENRES[t._g].covers) }) })).map(o => (o.x.s -= old(o.t), o)).filter(o => !o.t._g || !GENRES[o.t._g].scene || o.x.prox >= 0.3)
      .map(o => ({ t: o.t, s: o.x.s + rng() * 0.5 })).sort((a, b) => b.s - a.s).map(o => o.t);
  } else if (order.some(t => SC.variety(t))) order = order.map((t, k) => ({ t, s: -k * 0.01 - 3 * SC.variety(t) })).sort((a, b) => b.s - a.s).map(o => o.t);   // generic: variety-show cuts last
  if (tx) order = order.map((t, k) => ({ t, s: (G ? -k * 0.05 : 0) + tx.TM.w * tx.T.similarity(t, tx.TP) + rng() * 0.6 })).sort((a, b) => b.s - a.s).map(x => x.t);   // lean toward the ♥ profile (scene genres: on top of the scene rank)
  if (av && av.w) order = order.map((t, k) => ({ t, s: -k * 0.05 - av.w * av.T.penalty(t, av.A) })).sort((a, b) => b.s - a.s).map(x => x.t);   // ✕ dislikes: similar artists / tags further down
  const hitsWanted = genres.some(g => GENRES[g].hits || GENRES[g].covers);   // hit catalogues are partly paid: try more picks
  const oneVersion = genres.some(g => GENRES[g].covers), songs = new Set();   // covers genres: one version per song
  if (lazy) {   // confirm each pick actually has a free stream before it enters the set
    const names = t => hitsWanted ? String(t.artist || '').toLowerCase().split(/\s*[、,&/]\s*|\s+feat\.?\s+/).filter(Boolean).concat(t.artistId) : [t.artistId];   // hit genres: features count for every artist on them
    const picks = []; for (const t of order) { const ks = names(t); if (ks.some(k => (per.get(k) || 0) >= (hitsWanted ? 2 : 1))) continue;  ks.forEach(k => per.set(k, (per.get(k) || 0) + 1)); picks.push(t); }   // hit genres: up to 2 per artist
    (NEONDJ._dig = NEONDJ._dig || {})[prov.id] = { res: res.length, kept: m.size, order: order.length, picks: picks.length };   // tests / debugging
    let i = 0, tried = 0;
    const worker = async () => { while (out.length < need && i < picks.length && Date.now() < until + 15000 && tried < need * (hitsWanted ? 6 : 4)) { const t = picks[i++]; if (oneVersion && songs.has(SC.song(t))) continue; tried++;
      try { await prov.resolveStream(t); if (t.url && t.playable !== false && out.length < need && !(oneVersion && songs.has(SC.song(t)))) { songs.add(SC.song(t)); out.push(finalizeTrack(t)); } } catch (e) { } } };
    await Promise.all(Array.from({ length: prov.capabilities.resolveConcurrency || 4 }, worker));
    Object.assign(NEONDJ._dig[prov.id], { tried, out: out.length, i, need, late: Date.now() > until });
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
/* full tracks up to FULL_MAX s are decoded whole once: tempo / phase from the head as before, plus a 0.1 s energy profile of the
 * whole song (loudness, low end, onset flux) that the mix-out planner reads to find hooks / drops and hold through them */
const FULL_MAX = 480;
/* a short clip where the catalogue promised a full song (metadata > 90 s, clip ≤ 65 s and under 60 % of it) */
const isTrial = (tr, sec) => isFinite(sec) && sec > 1 && sec <= 65 && (tr.dur || 0) > 90 && sec < 0.6 * tr.dur;
async function analyzeTrack(tr) {
  if (!tr.preview && (tr.dur || 0) > 90 && (tr.dur || 0) <= FULL_MAX) {
    let ab = null;
    try { ab = await decode(await fetchBytes(tr, Providers.caps(tr).rangeRequests ? 'bytes=0-' : null, 45000)); }
    catch (e) { console.info('full analysis fell back:', tr.title, e.message); }
    if (ab && isTrial(tr, ab.duration)) { tr.trial = true; tr.bad = true; throw new Error('trial clip (' + Math.round(ab.duration) + ' s)'); }
    if (ab) try { return await analyzeFull(ab, tr.bpm); } catch (e) { console.info('full analysis fell back:', tr.title, e.message); }
  }
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
function sliceBuf(ab, t0, t1) {
  const sr = ab.sampleRate, a = clamp(Math.floor(t0 * sr), 0, ab.length), b = clamp(Math.floor(t1 * sr), a, ab.length);
  const L = ab.getChannelData(0).subarray(a, b), R = ab.numberOfChannels > 1 ? ab.getChannelData(1).subarray(a, b) : L;
  return { sampleRate: sr, length: b - a, numberOfChannels: 2, getChannelData: i => i ? R : L };
}
/* ---------- song structure (full tracks): one STFT pass -> grid, downbeat, phrases, vocals, drums, hats ----------
 * STFT 1024 / hop 512 (22.05 kHz) pooled into 35 bands, a light harmonic / percussive split (median over time vs. over bands):
 *  - beat grid refined over the whole song (tempo within ±1.5 %, phase) on spectral flux, so the grid does not drift
 *  - downbeat (bar phase) from kick onsets + section novelty; phrase phase (4 half-time bars) from novelty + vocal entries
 *  - vocal activity: harmonic energy in the ~300 Hz – 3.4 kHz band, minus the drum share of that band, plus how fast that
 *    band's spectrum changes (voices move, loops repeat), normalised to the song itself -> first vocal entry, vocal phrase ends
 *  - drums per bar (percussive energy + kick / hat onsets): drumless intro, breaks; hi-hat onsets per beat
 * Generic signal heuristics only (no genre lists); every result carries a confidence and callers fall back to the plain grid. */
const ST = { N: 1024, hop: 512 };
let _fftT = null;
function fftTables(N) {
  if (_fftT && _fftT.N === N) return _fftT;
  const rev = new Uint32Array(N), bits = Math.log2(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / N); sin[i] = Math.sin(-2 * Math.PI * i / N); }
  return (_fftT = { N, rev, cos, sin });
}
function fft(re, im) {
  const N = re.length, T = fftTables(N);
  for (let i = 0; i < N; i++) { const j = T.rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= N; len <<= 1) {
    const h = len >> 1, st = N / len;
    for (let i = 0; i < N; i += len) for (let k = 0; k < h; k++) {
      const a = i + k, b = a + h, wr = T.cos[k * st], wi = T.sin[k * st], xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}
const pauseSlice = () => new Promise(r => setTimeout(r, 0));
const medianOf = (buf, n) => { for (let i = 1; i < n; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; } return buf[n >> 1]; };
const robust = a => { const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return { m: 0, d: 1 }; const m = s[s.length >> 1]; const dv = s.map(x => Math.abs(x - m)).sort((x, y) => x - y); return { m, d: Math.max(1e-6, 1.4826 * dv[dv.length >> 1]) }; };
async function structureOf(ab, an) {
  const sr = ab.sampleRate, L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L, N = ST.N, hop = ST.hop;
  const n = Math.max(0, Math.floor((ab.length - N) / hop) + 1), fps = sr / hop, bw = sr / N, dur = ab.length / sr;
  if (n < fps * 30 || !an || !an.bpm) return null;
  // 35 bands: sub, kick (64-150 Hz), 150-215 Hz, then 32 log bands to ~10.5 kHz
  const top = Math.min(N / 2 - 1, Math.round(10500 / bw)), E = [1, 3, 7, 10];
  for (let i = 1; i <= 32; i++) E.push(Math.max(E[E.length - 1] + 1, Math.round(10 * Math.pow(top / 10, i / 32))));
  const NB = E.length - 1, fc = []; for (let j = 0; j < NB; j++) fc.push((E[j] + E[j + 1]) / 2 * bw);
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const P = Array.from({ length: NB }, () => new Float32Array(n)), re = new Float64Array(N), im = new Float64Array(N);
  for (let t = 0; t < n; t++) {
    const o = t * hop; for (let i = 0; i < N; i++) { re[i] = (L[o + i] + R[o + i]) * 0.5 * win[i]; im[i] = 0; }
    fft(re, im);
    for (let j = 0; j < NB; j++) { let s = 0; for (let k = E[j]; k < E[j + 1]; k++) s += re[k] * re[k] + im[k] * im[k]; P[j][t] = s; }
    if ((t & 2047) === 2047) await pauseSlice();
  }
  // harmonic (median over ~0.2 s) vs percussive (median over 5 bands) -> soft masks
  const H = P.map(() => new Float32Array(n)), buf = new Float64Array(9);
  for (let j = 0; j < NB; j++) { const p = P[j], h = H[j]; for (let t = 0; t < n; t++) { let c = 0; for (let u = t - 4; u <= t + 4; u++) buf[c++] = p[u < 0 ? 0 : u >= n ? n - 1 : u]; h[t] = medianOf(buf, 9); } }
  await pauseSlice();
  const vb = [], hb = [], sb = []; fc.forEach((f, j) => { if (f >= 300 && f <= 3400) vb.push(j); if (f >= 6000) hb.push(j); if (f >= 1000 && f < 5000) sb.push(j); });
  const db = x => 10 * Math.log10(x + 1e-12);
  const flux = new Float32Array(n), kickF = new Float32Array(n), snF = new Float32Array(n), hatF = new Float32Array(n);
  const voc = new Float32Array(n), vperc = new Float32Array(n), chg = new Float32Array(n), percE = new Float32Array(n), totE = new Float32Array(n), lowE = new Float32Array(n);
  const prevP = new Float64Array(NB), prevPd = new Float64Array(NB), hist = []; let first = true; const fb = new Float64Array(5);
  for (let t = 0; t < n; t++) {
    let fl = 0, sv = 0, sp = 0, pe = 0, te = 0, snf = 0, hf = 0; const hv = new Float64Array(vb.length);
    const pm = new Float64Array(NB);
    for (let j = 0; j < NB; j++) { let c = 0; for (let u = j - 2; u <= j + 2; u++) fb[c++] = P[u < 0 ? 0 : u >= NB ? NB - 1 : u][t]; pm[j] = medianOf(fb, 5); }
    for (let j = 0; j < NB; j++) {
      const p = P[j][t], h = H[j][t], q = pm[j], mH = h * h / (h * h + q * q + 1e-30), pp = p * (1 - mH), d = db(p), dp = db(pp);
      if (!first) { fl += Math.min(20, Math.max(0, d - prevP[j])); }
      te += p; pe += pp;
      if (!first && j === 1) kickF[t] = Math.max(0, dp - prevPd[j]);
      if (!first && sb.includes(j)) snf += Math.max(0, dp - prevPd[j]);
      if (!first && hb.includes(j)) hf += Math.max(0, dp - prevPd[j]);
      prevP[j] = d; prevPd[j] = dp;
    }
    vb.forEach((j, i) => { const p = P[j][t], h = H[j][t], q = pm[j], mH = h * h / (h * h + q * q + 1e-30); sv += p * mH; sp += p * (1 - mH); hv[i] = Math.sqrt(p * mH); });
    hist.push(hv); if (hist.length > 5) hist.shift();
    if (hist.length === 5) { const a = hist[0], b = hv; let ab_ = 0, aa = 0, bb = 0; for (let i = 0; i < b.length; i++) { ab_ += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } chg[t] = 1 - ab_ / Math.sqrt(aa * bb + 1e-30); }
    flux[t] = fl; snF[t] = snf / sb.length; hatF[t] = hf / Math.max(1, hb.length); voc[t] = db(sv); vperc[t] = db(sp); percE[t] = db(pe + P[1][t]); totE[t] = db(te); lowE[t] = db(P[0][t] + P[1][t]);
    first = false;
    if ((t & 4095) === 4095) await pauseSlice();
  }
  // ---- beat grid over the whole song: local-mean-removed flux, tempo within ±1.5 %, phase
  const O = new Float32Array(n); { const W = Math.round(fps * 0.4); let run = 0; for (let t = 0; t < n; t++) { run += flux[t]; if (t >= W) run -= flux[t - W]; O[t] = Math.max(0, flux[t] - run / Math.min(t + 1, W)); } }
  const Os = new Float32Array(n); for (let t = 1; t < n - 1; t++) Os[t] = 0.25 * O[t - 1] + 0.5 * O[t] + 0.25 * O[t + 1];
  const val = x => { x *= fps; const i = x | 0, f = x - i; return i >= 0 && i + 1 < n ? Os[i] * (1 - f) + Os[i + 1] * f : 0; };
  const gsc = (b, p) => { const B = 60 / b; let s = 0, c = 0; for (let x = p; x < dur - 0.2; x += B) { s += val(x); c++; } return c ? s / c : 0; };
  const bestPh = (b, steps = 32) => { const B = 60 / b; let bp = 0, bs = -1; for (let k = 0; k < steps; k++) { const p = k * B / steps, s = gsc(b, p); if (s > bs) { bs = s; bp = p; } } return [bp, bs]; };
  const bpm0 = an.bpm; let [p0, s0] = bestPh(bpm0); let G = { b: bpm0, p: p0, s: s0 };
  for (let d = -0.015; d <= 0.01501; d += 0.0005) { const b = bpm0 * (1 + d), [p, s] = bestPh(b); if (s > G.s) G = { b, p, s }; }
  { const B = 60 / G.b; for (let k = -8; k <= 8; k++) { const p = ((G.p + k * B / 256) % B + B) % B, s = gsc(G.b, p); if (s > G.s) G = { b: G.b, p, s }; } }
  let meanO = 0; for (let t = 0; t < n; t++) meanO += Os[t]; meanO /= n;
  const gridConf = G.s / (meanO + 1e-9), refined = Math.abs(G.b / bpm0 - 1) > 0.0004 && G.s > s0 * 1.03;
  const bpm = refined ? G.b : bpm0, B = 60 / bpm, ph = refined ? G.p : (gsc(bpm0, p0) >= gsc(bpm0, an.phase || 0) ? p0 : an.phase || 0);
  // ---- beat-level features
  const nbt = Math.floor((dur - ph) / B); if (nbt < 32) return null;
  const fr = x => Math.max(0, Math.min(n - 1, Math.round(x * fps)));
  const Kb = new Float32Array(nbt), Sb = new Float32Array(nbt), Eb = new Float32Array(nbt), Lb = new Float32Array(nbt), Db = new Float32Array(nbt), Hb = new Float32Array(nbt), Vl = new Float32Array(nbt), Vp = new Float32Array(nbt), Cb = new Float32Array(nbt);
  // hat onsets: local peaks of the hat-band percussive flux above a running median
  const hatOn = new Uint8Array(n); { const W = Math.round(fps * 1.5); const tmp = []; for (let t = 2; t < n - 2; t++) { const v = hatF[t]; if (v <= hatF[t - 1] || v < hatF[t + 1] || v < hatF[t - 2] || v < hatF[t + 2]) continue; hatOn[t] = 1; } 
    const all = []; for (let t = 0; t < n; t++) if (hatOn[t]) all.push(hatF[t]); all.sort((a, b) => a - b); const thr = all.length ? all[Math.floor(all.length * 0.35)] : 0; for (let t = 0; t < n; t++) if (hatOn[t] && hatF[t] < Math.max(thr, 1.5)) hatOn[t] = 0; void tmp; void W; }
  for (let j = 0; j < nbt; j++) {
    const t0 = ph + j * B, a = fr(t0 - 0.05), b = fr(t0 + 0.07), A = fr(t0), Z = Math.max(A + 1, fr(t0 + B));
    let k = 0, s = 0; for (let t = a; t <= b; t++) { k = Math.max(k, kickF[t]); s = Math.max(s, snF[t]); } Kb[j] = k; Sb[j] = s;
    let e = 0, l = 0, d = 0, h = 0, v = 0, vp = 0, c = 0; for (let t = A; t < Z; t++) { e += Math.pow(10, totE[t] / 10); l += Math.pow(10, lowE[t] / 10); d += Math.pow(10, percE[t] / 10); h += hatOn[t]; v += Math.pow(10, voc[t] / 10); vp += Math.pow(10, vperc[t] / 10); c += chg[t]; }
    const m = Z - A; Eb[j] = db(e / m); Lb[j] = db(l / m); Db[j] = db(d / m); Hb[j] = h; Vl[j] = db(v / m); Vp[j] = db(vp / m); Cb[j] = c / m;
  }
  // ---- vocal score per beat (song-relative): harmonic mid level, its share over the drums in that band, spectral motion
  const loud = Math.max(...Eb), live = Array.from(Eb, x => x > loud - 30);
  const zf = (arr) => { const r = robust(Array.from(arr).filter((_, j) => live[j])); return Array.from(arr, x => (x - r.m) / r.d); };
  const share = Array.from(Vl, (x, j) => x - Vp[j]), zV = zf(Vl), zS = zf(share), zC = zf(Cb);
  const vs = Array.from(zV, (x, j) => live[j] ? 0.5 * x + 0.25 * zS[j] + 0.25 * zC[j] : -9);
  const vsm = vs.map((x, j) => { const a = vs[j - 1] ?? x, b = vs[j + 1] ?? x; return [a, x, b].sort((p, q) => p - q)[1]; });
  // Otsu split of the live beats -> vocal on / off; confidence from the separation and a plausible vocal share
  const lv = vsm.filter((_, j) => live[j]); let thr = 0, conf = 0, vfrac = 0;
  if (lv.length > 16) {
    const lo = Math.min(...lv), hi = Math.max(...lv), K = 48, hst = new Array(K).fill(0); lv.forEach(x => hst[Math.min(K - 1, Math.floor((x - lo) / (hi - lo + 1e-9) * K))]++);
    let best = -1, tot = lv.length, sumAll = lv.reduce((a, x) => a + x, 0), w0 = 0, s0_ = 0;
    for (let k = 0; k < K - 1; k++) { w0 += hst[k]; s0_ += hst[k] * (lo + (k + 0.5) * (hi - lo) / K); if (!w0 || w0 === tot) continue; const m0 = s0_ / w0, m1 = (sumAll - s0_) / (tot - w0), bv = w0 * (tot - w0) * (m0 - m1) * (m0 - m1); if (bv > best) { best = bv; thr = lo + (k + 1) * (hi - lo) / K; } }
    const on = lv.filter(x => x > thr), off = lv.filter(x => x <= thr), mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length), sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); };
    vfrac = on.length / lv.length; const dprime = (mean(on) - mean(off)) / (Math.sqrt((sd(on) ** 2 + sd(off) ** 2) / 2) + 1e-6);
    conf = Math.max(0, Math.min(1, (dprime - 1.2) / 2)) * (vfrac < 0.12 || vfrac > 0.95 ? 0.3 : 1);
  }
  const von = vsm.map((x, j) => live[j] && x > thr);
  for (let j = 1; j < nbt - 1; j++) if (!von[j] && von[j - 1] && von[j + 1]) von[j] = true;      // a breath between lines
  for (let j = 1; j < nbt - 1; j++) if (von[j] && !von[j - 1] && !von[j + 1]) von[j] = false;    // a lone beat is not a line
  // ---- downbeat: kick on the 1, section changes on the 1, snare off it
  const nov = new Float32Array(nbt); { const fs = [Eb, Lb, Db, Float32Array.from(vsm)], sc = fs.map(f => robust(f).d);
    for (let j = 4; j < nbt - 4; j++) { let s = 0; fs.forEach((f, i) => { let a = 0, b = 0; for (let u = 0; u < 4; u++) { a += f[j - 4 + u]; b += f[j + u]; } s += Math.abs(b - a) / 4 / sc[i]; }); nov[j] = s; } }
  const zK = zf(Kb), zSn = zf(Sb), zN = zf(nov);
  let off = 0, offS = -Infinity; for (let o = 0; o < 4; o++) { let s = 0; for (let j = o; j < nbt; j += 4) s += zK[j] + 1.2 * zN[j] - 0.5 * zSn[j]; if (s > offS) { offS = s; off = o; } }
  const bar = 4 * B, down = (ph + off * B) % bar, m = bpm > 110 ? 2 : 1, hbar = bar * m, PB = 4 * m, phrase = PB * bar;
  const j0 = Math.round((down - ph) / B), nb = Math.floor((dur - down) / bar);
  // ---- per-bar features
  const bars = []; for (let k = 0; k < nb; k++) { let v = 0, d = 0, kk = 0, hh = 0, lo2 = 0, e = 0, c = 0; for (let u = 0; u < 4; u++) { const j = j0 + 4 * k + u; if (j < 0 || j >= nbt) continue; v += von[j] ? 1 : 0; d += Math.pow(10, Db[j] / 10); kk += Kb[j]; hh += Hb[j]; lo2 += Math.pow(10, Lb[j] / 10); e += Math.pow(10, Eb[j] / 10); c++; }
    c = Math.max(1, c); bars.push({ t: down + k * bar, voc: v / c, drum: db(d / c), kick: kk / c, hats: hh / c, low: db(lo2 / c), e: db(e / c), nov: nov[Math.max(0, j0 + 4 * k)] || 0 }); }
  // phrase phase: section changes / vocal entries land on the first bar of a phrase
  let pOff = 0, pS = -Infinity; const zNB = zf(Float32Array.from(bars.map(b => b.nov)));
  for (let q = 0; q < PB; q++) { let s = 0; for (let k = q; k < nb; k += PB) s += zNB[k] + (bars[k].voc > 0.4 && (!bars[k - 1] || bars[k - 1].voc < 0.4) ? 0.8 : 0); if (s > pS) { pS = s; pOff = q; } }
  const phr = (down + pOff * bar) % phrase;
  // ---- drums: body medians, drumless intro, breaks
  const body = bars.slice(Math.floor(nb * 0.2), Math.max(Math.floor(nb * 0.2) + 1, Math.floor(nb * 0.9)));
  const medD = robust(body.map(b => b.drum)).m, medK = robust(body.map(b => b.kick)).m, medH = robust(body.map(b => b.hats)).m;
  const drumOn = bars.map(b => b.drum > medD - 9 && (b.kick > 0.35 * medK || b.hats > 0.35 * medH));
  let dk = 0; while (dk < nb - 1 && !(drumOn[dk] && drumOn[dk + 1])) dk++;
  const drumStart = dk === 0 ? 0 : bars[dk].t, drumless = drumStart >= 4 ? drumStart : 0;
  const brk = bars.map((b, k) => k > dk + 1 && k < nb - 2 && b.drum < medD - 12);
  const breaks = []; for (let k = 0; k < nb; k++) if (brk[k]) { if (breaks.length && breaks[breaks.length - 1][1] === k) breaks[breaks.length - 1][1] = k + 1; else breaks.push([k, k + 1]); }
  // ---- vocals: first entry (frame-refined) and phrase ends
  let firstVocal = null; const vocEnds = [], vocRuns = [];
  if (conf >= 0.2) {
    for (let j = 0; j < nbt - 3; j++) if (von[j] && von.slice(j, j + 4).filter(Boolean).length >= 3) {
      // first frame in the beat before / this beat whose smoothed vocal level crosses the song's on-level
      const ref = robust(Array.from(Vl).filter((_, u) => von[u])).m, refOff = robust(Array.from(Vl).filter((_, u) => live[u] && !von[u])).m, cut = (ref + refOff) / 2;
      let tv = ph + j * B; for (let t = fr(ph + (j - 1) * B); t < fr(ph + (j + 1) * B); t++) { let s = 0; for (let u = -2; u <= 2; u++) s += voc[Math.max(0, Math.min(n - 1, t + u))]; if (s / 5 > cut) { tv = t / fps; break; } }
      firstVocal = Math.max(0, tv); break;
    }
    let st0 = -1; for (let j = 0; j <= nbt; j++) { const o = j < nbt && von[j]; if (o && st0 < 0) st0 = j; if (!o && st0 >= 0) { if (j - st0 >= 2) { vocRuns.push([ph + st0 * B, ph + j * B]); vocEnds.push(ph + j * B); } st0 = -1; } }
  }
  const hats = medH, lowShare = robust(body.map(b => b.low - b.e)).m;
  return { v: 2, bpm, refined, gridConf, ph, down, bar, hbar, m, phrase, phr, nb, bars, beats: { n: nbt, von, Kb: Array.from(Kb) }, vocConf: conf, vocFrac: vfrac, firstVocal, vocEnds, vocRuns,
    drumStart, drumless, breaks, hats, lowShare, medD };
}
async function analyzeFull(ab, knownBpm) {
  const dur = ab.length / ab.sampleRate, head = analyzeBuffer(sliceBuf(ab, 0, 25), knownBpm);
  if (dur > 60) { const b0 = dur * 0.4, body = analyzeBuffer(sliceBuf(ab, b0, b0 + 15), head.bpm, true); head.headDb = head.db; head.db = body.db; head.dens = body.dens; head.lowRatio = body.lowRatio; head.body = true; }
  head.prof = energyProfile(ab); head.fullDur = dur;
  // structure pass: the grid becomes whole-song (refined tempo) and downbeat-aligned, so bars / phrases count from a real "1"
  try { const st = await structureOf(ab, head); if (st) { head.st = st; head.bpm = st.bpm; head.phase = st.down; } }
  catch (e) { console.info('structure analysis skipped:', e.message); }
  return head;
}
/* store an analysis on the track; the structure pass's refined tempo replaces the head / metadata reading */
function applyAnalysis(t, an) { t.an = an; if (!t.bpm && an.conf > 1.15) t.bpm = an.est; if (an.st) t.bpm = Math.round(an.st.bpm * 100) / 100; }
/* 0.1 s frames: e = level dB, lo = <150 Hz level dB (kick / 808), on = onset flux (rhythmic density) */
function energyProfile(ab) {
  const sr = ab.sampleRate, L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L, hop = Math.round(sr * 0.1), n = Math.floor(ab.length / hop), sub = 256;
  const e = new Float32Array(n), lo = new Float32Array(n), on = new Float32Array(n), a = Math.exp(-2 * Math.PI * 150 / sr);
  let lp = 0, prev = null;
  for (let i = 0; i < n; i++) {
    let s = 0, sl = 0, flux = 0, acc = 0, k = 0;
    for (let j = i * hop, J = j + hop; j < J; j++) { const x = (L[j] + R[j]) * 0.5; lp = (1 - a) * x + a * lp; s += x * x; sl += lp * lp; acc += x * x;
      if (++k === sub) { const v = Math.log(1e-9 + acc / sub); if (prev !== null) flux += Math.max(0, v - prev); prev = v; acc = 0; k = 0; } }
    e[i] = 10 * Math.log10(1e-10 + s / hop); lo[i] = 10 * Math.log10(1e-10 + sl / hop); on[i] = flux;
  }
  return { fr: hop / sr, e, lo, on };
}
/* per-bar energy on the deck's beat grid + high-energy sections (hooks / drops): bars clearly above the song's own median
 * (robust z of level, low end and onset density), 1-bar gaps closed, single stray bars dropped. Generic: no genre lists. */
function barMap(tr) {
  const an = tr && tr.an, P = an && an.prof; if (!P) return null;
  const bpm = tr.bpm || 120, key = bpm.toFixed(3) + ':' + (an.phase || 0).toFixed(3); if (an._bars && an._bars.key === key) return an._bars;
  const bar = 240 / bpm, ph = an.phase || 0, nb = Math.floor((P.e.length * P.fr - ph) / bar); if (nb < 8) return null;
  const E = [], LO = [], ON = [];
  for (let k = 0; k < nb; k++) {
    const a = Math.floor((ph + k * bar) / P.fr), b = Math.max(a + 1, Math.floor((ph + (k + 1) * bar) / P.fr)); let se = 0, sl = 0, so = 0;
    for (let i = a; i < b; i++) { se += Math.pow(10, P.e[i] / 10); sl += Math.pow(10, P.lo[i] / 10); so += P.on[i]; }
    E.push(10 * Math.log10(se / (b - a) + 1e-10)); LO.push(10 * Math.log10(sl / (b - a) + 1e-10)); ON.push(so / (b - a));
  }
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const z = (a, floor) => { const m = med(a), d = Math.max(floor, 1.4826 * med(a.map(x => Math.abs(x - m)))); return a.map(x => (x - m) / d); };
  const mO = med(ON), zE = z(E, 0.6), zL = z(LO, 1), zO = z(ON, Math.max(1e-3, mO * 0.12));
  const sc = E.map((_, k) => 0.45 * zE[k] + 0.35 * zL[k] + 0.2 * zO[k]);
  // hooks / drops come in phrases: a 4-bar phrase is high when it sits in the song's loudest third (and clearly above its
  // median); so is the phrase that re-enters after a break (the drop), and any single bar far above the rest
  const pm = []; for (let q = 0; q * 4 < nb; q++) { let su = 0, n = 0; for (let k = q * 4; k < Math.min(nb, q * 4 + 4); k++) { su += sc[k]; n++; } pm.push(su / n); }
  const body = pm.filter(v => v > -2).sort((x, y) => x - y), thr = Math.max(0.3, body.length ? body[Math.floor(body.length * 0.65)] : 0.3);
  const brk = q => q > 0 && sc.slice((q - 1) * 4, q * 4).some(v => v < -2);
  const hi = sc.map((v, k) => { const q = k >> 2; return v > 1 || (v > -1 && (pm[q] >= thr || (pm[q] > 0.1 && brk(q)))); });
  for (let k = 1; k < nb - 1; k++) if (!hi[k] && hi[k - 1] && hi[k + 1]) hi[k] = true;           // close 1-bar gaps
  for (let k = 0; k < nb; k++) if (hi[k] && !hi[k - 1] && !hi[k + 1]) hi[k] = false;              // a lone loud bar is not a section
  const secs = []; for (let k = 0; k < nb; k++) if (hi[k]) { if (secs.length && secs[secs.length - 1][1] === k) secs[secs.length - 1][1] = k + 1; else secs.push([k, k + 1]); }
  return (an._bars = { key, bar, ph, nb, sc, hi, secs, t: k => ph + k * bar, at: t => Math.floor((t - ph) / bar) });
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

/* ---------- sequencing: tempo ladder + set arc (warm-up -> build -> reset ~45 % -> peak / gear shift ~72 % -> last block) ---------- */
/* familiarity tier from play counts, ranked within each source (counts are not comparable across catalogues); no name lists */
function markTiers(all) {
  const bySrc = new Map(); all.forEach(t => { const k = t.src || '?'; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(t); });
  const plays = t => (t.signals && t.signals.plays) || t.plays || 0;
  bySrc.forEach(ts => {
    const withP = ts.filter(t => plays(t) > 0), use = withP.length >= 4 && new Set(withP.map(plays)).size >= 3 ? plays : (t => t.prior || 0);
    const s = ts.map(use).sort((a, b) => a - b);
    ts.forEach(t => { const v = use(t); let r = 0; while (r < s.length && s[r] < v) r++; t._pct = s.length > 1 ? r / (s.length - 1) : 0.5; });
  });
  all.forEach(t => t._tier = t._pct >= 0.82 ? 'A' : 'B');
}
const grooveOf = t => { const st = stOf(t); return st ? st.hats : null; };
function energyOf(t, norm) {
  const bpmN = t.bpm ? clamp((Math.min(t.bpm, 180) - 75) / 100, 0, 1) : 0.5, tier = t._tier === 'A' ? 1 : 0;
  if (t.an) {   // level matters little (DJs ride the gain); groove density and familiarity shape the arc
    const dbN = clamp((t.an.db + 24) / 16, 0, 1), g = norm && norm.useG ? grooveOf(t) : t.an.dens;
    const lo = norm ? (norm.useG ? norm.gMin : norm.dMin) : 0, hi = norm ? (norm.useG ? norm.gMax : norm.dMax) : 1;
    const dN = norm && g != null ? clamp((g - lo) / (hi - lo + 1e-9), 0, 1) : 0.5;
    return 0.12 * dbN + 0.3 * dN + 0.2 * bpmN + 0.2 * (t.prior ?? 0.5) + 0.18 * tier;
  }
  return 0.45 * (t.prior ?? 0.5) + 0.4 * bpmN + 0.15 * tier;
}
function targetCurve(x, mode) {
  if (mode === 'build') return 0.12 + 0.85 * Math.pow(x, 1.15);
  return x < 0.72 ? 0.12 + 0.88 * smooth(0, 0.72, x) : 1 - 0.42 * smooth(0.72, 1, x);  // arc
}
function artistSet(t) {
  if (t._as) return t._as; const SC = window.NEONDJ && NEONDJ.scene, a = new Set(SC && SC.artistsOf ? SC.artistsOf(t) : []);
  if (t.artistId) a.add('id:' + t.artistId); if (!a.size && t.artist) a.add(String(t.artist).toLowerCase()); return (t._as = a);
}
const inWin = (x, a, b) => x >= a && x <= b;
/* fixedHead: tracks that stay at the front (playing / cued); absStart: set index of fixedHead[0] (arc positions are time-based) */
function sequence(tracks, mode, fixedHead = [], absStart = 0) {
  const list = tracks.slice(); if (!list.length) return fixedHead.slice();
  const all = list.concat(fixedHead); markTiers(all);
  const an = all.filter(t => t.an), withG = an.filter(t => grooveOf(t) != null), useG = withG.length >= Math.max(3, an.length * 0.6);
  const norm = an.length > 2 ? { useG, gMin: useG ? Math.min(...withG.map(grooveOf)) : 0, gMax: useG ? Math.max(...withG.map(grooveOf)) : 1, dMin: Math.min(...an.map(t => t.an.dens)), dMax: Math.max(...an.map(t => t.an.dens)) } : null;
  all.forEach(t => t.energy = energyOf(t, norm));
  if (mode === 'found') return fixedHead.concat(avoidArtistRepeats(list, fixedHead));
  // tempo outliers (>15 % from the set's median after folding ×2 / ×½ / 3:2) go to the back as spares
  let spares = [];
  const bpms = all.map(t => t.bpm).filter(Boolean).sort((a, b) => a - b);
  if (bpms.length >= 5) {
    const med = bpms[Math.floor(bpms.length / 2)], out = list.filter(t => t.bpm && Math.abs(tempoFam(med, t.bpm).d) > Math.log(1.15));
    if (out.length && out.length <= list.length * 0.3) { spares = out; for (const t of out) list.splice(list.indexOf(t), 1); }
  }
  if (!list.length) return fixedHead.concat(spares);
  const H = fixedHead.length, xs = list.map((_, i) => arcX(absStart + H + i)), targets = xs.map(x => targetCurve(x, mode));
  // initial order: rank-match energies to the arc
  const byE = list.slice().sort((a, b) => a.energy - b.energy), slots = targets.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  let seq = new Array(list.length); slots.forEach((s, k) => seq[s.i] = byE[k]);
  const eMin = byE[0].energy, span = Math.max(0.05, byE[byE.length - 1].energy - eMin);
  // language mix (mixed-language sets only; an all-华语 / vocal-led set is not capped)
  const zhShare = all.filter(isZh).length / all.length, mixed = zhShare >= 0.08 && zhShare <= 0.9 && fxStyle() !== 'song', gapMax = clamp(Math.round(1 / Math.max(zhShare, 0.1)) + 2, 3, 8);
  const gs = all.map(grooveOf).filter(v => v != null), gSpan = gs.length > 1 ? Math.max(1e-6, Math.max(...gs) - Math.min(...gs)) : 1;
  const lowB = bpms.length ? bpms[Math.floor(bpms.length * 0.2)] : null;
  const prev0 = fixedHead[H - 1] || (lowB ? { bpm: lowB, cam: null } : null);
  const cost = s => {
    let c = 0, prev = prev0, zhRun = 0, sinceZh = 99, sinceA = 99, zhN = 0, zhFinal = false, prevReset = false; const seen = new Map();
    fixedHead.forEach((t, i) => { artistSet(t).forEach(a => seen.set(a, i)); if (isZh(t)) { zhRun++; zhN++; sinceZh = 0; } else { zhRun = 0; sinceZh++; } sinceA = t._tier === 'A' ? 0 : sinceA + 1; });
    for (let i = 0; i < s.length; i++) {
      const t = s[i], x = xs[i], pos = H + i, st = stOf(t);
      // tempo: ≤ 1.6 % steps free, monotonic within a block, big jumps / 3:2 only at block boundaries (reset / shift windows)
      const f = prev && prev.bpm && t.bpm ? tempoFam(prev.bpm, t.bpm) : { d: 0, kind: '?' }, ad = Math.abs(f.d), boundary = inWin(x, 0.38, 0.5) || inWin(x, 0.66, 0.82), dir = mode === 'build' ? 1 : x < 0.72 ? 1 : -1;
      c += (boundary ? 30 : 150) * Math.max(0, ad - 0.016);   // block boundaries may jump (masked by brake / reset / echo)
      if (f.kind === '3:2') c += boundary ? 0.5 : 6; else if (ad > 0.03 && !boundary) c += 8;
      if (f.kind === '1:1' && ad > 0.003 && Math.sign(f.d) === -dir) c += 1.5;
      if (inWin(x, 0.66, 0.8) && (ad > 0.04 || f.kind === '3:2')) c -= 1;                          // the set's gear shift lands here
      if (prev) c += 0.12 * keyDist(prev.cam, t.cam);
      c += 8 * Math.pow((t.energy - eMin) / span - (targets[i] - 0.12) / 0.88, 2);
      // artists: at least 4 other tracks in between, soft until 8
      let gap = 99; artistSet(t).forEach(a => { if (seen.has(a)) gap = Math.min(gap, pos - seen.get(a)); }); c += gap < 5 ? 99 : gap < 9 ? 1 : 0;
      // language: Chinese-language tracks single or in pairs (hard cap 3 in a row), spread out, one in the last block
      const zh = isZh(t);
      if (mixed) { if (zh) { c += zhRun >= 3 ? 99 : zhRun >= 2 ? 2.5 : 0; c += 6 * Math.max(0, (zhN + 1) / (pos + 1) - zhShare); if (sinceZh >= gapMax) c -= 1.5; if (x >= 0.8 && !zhFinal) c -= 1; } else if (sinceZh >= gapMax + 2) c += 0.8; }
      // familiarity: an anchor opens the set, then about one every 8, never two within 3
      if (t._tier === 'A') { c += sinceA < 3 ? 4 : sinceA >= 8 ? -1.5 : 0; if (pos === 0) c -= 2; if (inWin(x, 0.66, 0.8)) c -= 0.8; } else if (pos === 0) c += 0.5;
      // mixability: clear vocal entries cut well; drumless intros are kept for the reset (~45 %) / shift (~72 %) windows
      if (st) { c -= 0.6 * (st.firstVocal != null ? st.vocConf : 0); if (st.drumless >= 8) c += inWin(x, 0.38, 0.5) ? -2.5 : inWin(x, 0.66, 0.8) ? -1 : 1.5; }
      if (prevReset && st && prev && grooveOf(prev) != null) c += 1.2 * Math.max(0, (grooveOf(prev) - st.hats) / gSpan);   // after a reset: harder drums
      prevReset = !!(st && st.drumless >= 8 && inWin(x, 0.38, 0.5));
      artistSet(t).forEach(a => seen.set(a, pos)); if (zh) { zhRun++; zhN++; sinceZh = 0; if (x >= 0.8) zhFinal = true; } else { zhRun = 0; sinceZh++; } sinceA = t._tier === 'A' ? 0 : sinceA + 1;
      prev = t;
    }
    return c;
  };
  // local search (swap / move / reverse a run) from two starts: the energy rank-match and a tempo ladder
  // (slow → fast up to the reset, again up to the gear shift, then easing down); keep the cheaper result
  const search = s0 => {
    let seq = s0.slice(), cur = cost(seq);
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) {
        [seq[i], seq[j]] = [seq[j], seq[i]]; const c = cost(seq);
        if (c < cur - 1e-6) { cur = c; improved = true; } else[seq[i], seq[j]] = [seq[j], seq[i]];
      }
      for (let i = 0; i < seq.length; i++) for (let j = 0; j < seq.length; j++) {   // move one track elsewhere (ladders need shifts, not swaps)
        if (i === j) continue; const s2 = seq.slice(); const [t] = s2.splice(i, 1); s2.splice(j, 0, t); const c = cost(s2);
        if (c < cur - 1e-6) { cur = c; seq = s2; improved = true; }
      }
      for (let i = 0; i < seq.length - 2; i++) for (let j = i + 2; j < Math.min(seq.length, i + 12); j++) {   // reverse a run (turns a falling ladder into a rising one)
        const s2 = seq.slice(0, i).concat(seq.slice(i, j + 1).reverse(), seq.slice(j + 1)); const c = cost(s2);
        if (c < cur - 1e-6) { cur = c; seq = s2; improved = true; }
      }
      if (!improved) break;
    }
    return { seq, cur };
  };
  const ladder = (() => {
    const sb = list.slice().sort((a, b) => (a.bpm || 0) - (b.bpm || 0)), n = sb.length, cut = xs.findIndex(x => x >= 0.45), k1 = cut > 0 ? cut : Math.round(n * 0.45);
    const lo = [], hi = []; sb.forEach((t, i) => (i % 2 ? hi : lo).push(t));   // two interleaved ramps covering the same tempo range
    const first = lo.slice(0, k1), rest = lo.slice(k1).concat(hi).sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
    const peak = Math.max(0, Math.round(rest.length * 0.75)), up = rest.filter((_, i) => i % 4 !== 3), down = rest.filter((_, i) => i % 4 === 3).reverse();
    return first.concat(up, down).slice(0, n).concat(sb.filter(t => !first.includes(t) && !up.includes(t) && !down.includes(t)));
  })();
  let best = search(seq); const alt = search(ladder); if (alt.cur < best.cur) best = alt;
  seq = best.seq;
  // slot roles for the transition planner: the reset (drumless intro in the 38–50 % window) and the gear shift (biggest step, 66–80 %)
  list.forEach(t => { t._slot = null; }); let resetDone = false, shift = null;
  seq.forEach((t, i) => { const x = xs[i], st = stOf(t); t._x = +x.toFixed(3);
    if (!resetDone && st && st.drumless >= 8 && inWin(x, 0.38, 0.5)) { t._slot = 'reset'; resetDone = true; }
    const p = i ? seq[i - 1] : fixedHead[H - 1]; if (p && inWin(x, 0.66, 0.8)) { const f = tempoFam(p.bpm, t.bpm), m = f.kind === '3:2' ? 1 : Math.abs(f.d); if (!shift || m > shift.m) shift = { t, m }; } });
  if (shift && shift.m > 0.03 && !shift.t._slot) shift.t._slot = 'shift';
  return fixedHead.concat(seq, spares);
}
/* 'found' order: keep it, but push a track back when its artist played within the last 4 */
function avoidArtistRepeats(list, prev = []) {
  const out = list.slice(), head = Array.isArray(prev) ? prev : prev ? [prev] : [];
  const clash = (t, i) => { for (let k = 1; k <= 4; k++) { const p = i - k >= 0 ? out[i - k] : head[head.length - (k - i)]; if (p && [...artistSet(t)].some(a => artistSet(p).has(a))) return true; } return false; };
  for (let i = 0; i < out.length; i++) if (clash(out[i], i)) { const j = out.findIndex((t, k) => k > i && !clash(t, i)); if (j > 0) { const [t] = out.splice(j, 1); out.splice(i, 0, t); } }
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

    this.secAn = ctx.createAnalyser(); this.secAn.fftSize = 1024; this.secBuf = new Float32Array(1024); this.trim.connect(this.secAn);   // pre-FX level for section detection
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
    if (this._abort) this._abort();   // a newer load supersedes a pending one (its stale listeners must not seek this deck later)
    this.track = track; this.ready = false; this.startAt = startAt; this.sec = null; this._perfFor = -1;
    this.el.preservesPitch = true; this.el.playbackRate = 1; this.lockRate = 1;   // lockRate: the block tempo this deck holds (tick glides toward it)
    return new Promise((resolve, reject) => {
      const el = this.el; let done = false;
      const fin = (ok, err) => { if (done) return; done = true; if (this._abort === abort) this._abort = null; clearTimeout(to); el.removeEventListener('canplay', onCan); el.removeEventListener('error', onErr); el.removeEventListener('loadedmetadata', onMeta); ok ? resolve() : reject(err); };
      const abort = () => fin(true); this._abort = abort;
      // this.startAt (not the argument): the planner may re-cue the deck while it is still loading
      const onMeta = () => {
        // a 30–60 s trial clip behind a full song's metadata (paid songs on Chinese catalogues): not a playable full track
        if (!track.preview && isTrial(track, el.duration)) { track.trial = true; el.removeAttribute('src'); return fin(false, new Error('trial clip (' + Math.round(el.duration) + ' s)')); }
        if (isFinite(el.duration) && el.duration > 1) track.dur = el.duration; const sa = this.startAt; if (sa > 0 && sa < track.dur - 5) el.currentTime = sa; };
      const onCan = () => { const sa = this.startAt; if (sa > 0 && Math.abs(el.currentTime - sa) > 1 && sa < track.dur - 5) { el.currentTime = sa; return; } this.ready = true; fin(true); };
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
  /* back to the knobs for what performance moves touch (EQ low, HP, gate, loop, echo) — leaves a running swell alone */
  restoreMain(t, tc = 0.03) {
    const k = this.knob, f = filterFreqs(k.filter), set = (param, v) => { hold(param, t); glide(param, v, t, tc); };
    set(this.low.gain, k.low); set(this.hp.frequency, f.hp); set(this.gate.gain, 1); set(this.dSend.gain, k.delay * 0.8); set(this.dFb.gain, 0.3 + k.delay * 0.3);
    set(this.loopDry.gain, 1); set(this.loopIn.gain, 1); set(this.loopWet.gain, 0); set(this.loopFb.gain, 0); this.hp.Q.setValueAtTime(0.9, t);
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
  /* mid-track tape stop that lands back on the beat: slow down over `dur`, then restart at track time `resumeAt` */
  brakeDrop(t, dur, resumeAt) {
    const startIn = Math.max(0, (t - ctx.currentTime) * 1000), el = this.el, tr = this.track;
    setTimeout(() => {
      if (this.track !== tr || el.paused) return;
      const r0 = el.playbackRate || 1, t0 = performance.now(); S.braking = true;
      el.preservesPitch = false; el.webkitPreservesPitch = false;
      const step = () => { if (this.track !== tr) { S.braking = false; return; } const x = (performance.now() - t0) / (dur * 1000);
        if (x >= 1) { el.currentTime = resumeAt; el.playbackRate = r0; el.preservesPitch = true; el.webkitPreservesPitch = true; S.braking = false; return; }
        el.playbackRate = Math.max(0.1, r0 * Math.pow(1 - x, 1.5)); requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }, startIn);
  }
  secLevel() { this.secAn.getFloatTimeDomainData(this.secBuf); let s = 0; for (const x of this.secBuf) s += x * x; return Math.sqrt(s / this.secBuf.length); }
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
  lastScript: '', perfLog: [], plan: null, lastFlourish: -1, lastRiser: -1, buildId: 0, params: null, extending: false, braking: false, preloading: null };
const opt = id => $('#' + id);
const xfLen = () => +opt('xfLen').value;
const fxAmt = () => ({ smooth: 0.1, club: 0.25, wild: 0.42 })[opt('fxAmt').value] || 0.25;   // the Hype select (Smooth / Club / Wild)
const isChillSet = () => { const p = S.params || {}; return (p.moods || []).some(m => m === 'chill' || m === 'dreamy') || (p.genres || []).some(g => g === 'lofi' || g === 'downtempo'); };

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

/* ---------- phrase-based mix planning (deterministic: every choice comes from the two tracks' measured structure) ----------
 * Play length: no fixed minimum. A track plays a whole number of phrases from its cue (usually 12–24 half-time bars,
 * ≈ 40–80 s; 16 by default), longer in the last block of the set; the cut lands on a phrase end or where A's vocal line ends,
 * never inside a highlight / drop. B comes in on the downbeat a beat to a bar before its first vocal line (or on its drop / hook);
 * it starts from its intro only when that intro is musically useful (a drumless intro used as a reset, a long blend).
 * The transition type comes from a decision table over tempo relation, key, vocals, drums / breaks and set position. */
const EST_PLAY = 56;                                           // typical seconds per track mid-set (≈ 16 half-time bars)
const setLenSec = () => (+opt('setLen').value || 30) * 60;
const fullSongs = () => opt('perTrack').value === '0';
const stOf = t => (t && !t.preview && t.an && t.an.st) || null;
const isZh = t => /[\u3400-\u9fff]/.test(`${t.title || ''} ${t.artist || ''}`);
/* arc position 0..1 of set slot j: real played time before the current track + typical lengths after it (laps in endless) */
function arcX(j) {
  const T = setLenSec(), cur = Math.max(0, S.idx);
  let t = S.playing && S.idx >= 0 ? (S.playedSec || 0) + (j - cur) * EST_PLAY : j * EST_PLAY; t = Math.max(0, t);
  const x = t / T; return x <= 1 ? x : opt('endless').checked ? x % 1 : 1;
}
/* tempo family incl. 3:2 — d: signed log ratio of b against a after folding (×2, ×½; 3:2 kinds: ×1.5, ×⅔, ×¾, ×4/3) */
function tempoFam(a, b) {
  if (!a || !b) return { d: 0, kind: '?', m: 1 };
  let best = { d: Math.log(b / a), kind: '1:1', m: 1 };
  for (const m of [2, 0.5]) { const d = Math.log(b * m / a); if (Math.abs(d) < Math.abs(best.d)) best = { d, kind: '1:1', m }; }
  if (Math.abs(best.d) > 0.016) for (const m of [1.5, 2 / 3, 3, 1 / 3]) { const d = Math.log(b * m / a); if (Math.abs(d) < Math.abs(best.d) - 0.004) best = { d, kind: '3:2', m }; }
  return best;
}
const barIdx = (st, t) => Math.floor((t - st.down) / st.bar + 1e-6);
const barT = (st, k) => st.down + k * st.bar;
const onPhrase = (st, t) => { const q = (t - st.phr) / st.phrase; return Math.abs(q - Math.round(q)) * st.phrase < 0.04; };
/* fraction of beats in [a, b) with vocals (null: unknown) */
function vocalIn(st, a, b) {
  if (!st || st.vocConf < 0.2) return null; const B = 60 / st.bpm, V = st.beats.von;
  let n = 0, v = 0; for (let j = Math.max(0, Math.floor((a - st.ph) / B + 1e-6)); j < Math.min(V.length, Math.ceil((b - st.ph) / B - 1e-6)); j++) { n++; if (V[j]) v++; }
  return n ? v / n : 0;
}
const heavyLow = st => !!st && st.lowShare > -1.5;   // 808 / kick carries most of the level (corpus: -4.5..-0.5 dB, top third)
/* B's cue (track seconds) — kind: 'vocal' (default), 'drop' (first hook / drop with drums), 'intro' (drumless intro reset) */
function cueFor(tr, kind = 'vocal') {
  const st = stOf(tr), bs = 60 / (tr.bpm || 120), dur = tr.dur || 180;
  if (!st) {   // no structure: the old skip-intro guess on the 16-beat grid
    const ph = (tr.an && tr.an.phase) || 0, target = opt('skipIntro').checked ? Math.min(dur * 0.1, 32) : 0;
    return { t: Math.max(0, ph + Math.max(0, Math.round((target - ph) / bs / 16) * 16) * bs), kind: 'grid', conf: 0 };
  }
  const B = 60 / st.bpm, bar = st.bar;
  if (kind === 'intro' && st.drumless >= 8) {   // a phrase or two of the drumless intro before the drums land (or from the top)
    const n = Math.min(2, Math.floor(st.drumStart / st.phrase + 1e-6)), t = st.drumStart - n * st.phrase;
    return { t: t < 1.5 ? 0 : t, kind: 'intro', conf: 1 };
  }
  if (kind === 'drop') {   // the first hook / drop (high-energy section with drums), not in the outro
    const M = barMap(tr); if (M) for (const [a] of M.secs) { const t = M.t(a), k = barIdx(st, t + 0.05); if (t >= 4 && t < dur * 0.6 && st.bars[k] && st.bars[k].drum > st.medD - 6) return { t, kind: 'drop', conf: 0.8 }; }
  }
  const tv = st.firstVocal;
  if (tv != null && st.vocConf >= 0.2 && tv < dur * 0.45) {
    if (tv < 0.75 * B) return { t: 0, kind: 'vocal', conf: st.vocConf, vocal: tv };
    let t = Math.max(0, barT(st, barIdx(st, tv - 0.25 * B)));                       // the downbeat 1 beat .. 1 bar before the line
    const q = Math.floor((tv - 0.25 * B - st.phr) / st.phrase + 1e-6), p = st.phr + q * st.phrase;
    if (p >= 0 && tv - p <= bar + 0.25 * B + 1e-6) t = p;                             // the phrase start, when it is that close
    return { t, kind: 'vocal', conf: st.vocConf, vocal: tv };
  }
  // no vocal entry found: the first phrase with drums (instrumentals start on the beat, not on a long intro)
  const q = Math.ceil((st.drumStart - st.phr) / st.phrase - 1e-6), p = Math.max(0, st.phr + q * st.phrase);
  return { t: p < dur * 0.4 ? p : 0, kind: 'drums', conf: 0.3 };
}
/* how many half-time bars this track should play (before snapping to its phrases) */
function targetHb(tr, x, rest) {
  let T = 16;
  if (x >= 0.8) T += 12 * Math.min(1, (x - 0.8) / 0.2);           // the last block plays longer, track by track
  if (rest === 1) T = Math.max(T, 28);                            // second-to-last track of a fixed-length set
  if ((tr.energy ?? 0.5) < 0.35) T += 4;                           // sparse / R&B-leaning tracks get more room
  return T;
}
/* no structure (analysis pending / partial / failed): still whole phrases near the target, varied by what we know about the
 * song (length, energy, set position) — never the shortest grid point for every track */
function fallbackHb(tr, x, rest) {
  let T = targetHb(tr, x, rest); const d = tr.dur || 0;
  if (d >= 270) T += 4; else if (d && d < 165) T -= 4;               // long songs breathe longer, short ones get to the point
  return clamp(Math.round(T / 4) * 4, 12, x >= 0.8 ? 40 : 24);
}
/* A's out point P (track seconds, a downbeat): phrase-snapped length near the target, on a phrase end / vocal end, never
 * inside a highlight; prefers the end of a highlight and a break right before P (a drop-swap). */
function planOut(tr, start, x, opts = {}) {
  if (Number.isFinite(opts.rest) && opts.rest <= 4) x = Math.max(x, 1 - 0.05 * opts.rest);   // fixed-length set: the last four tracks are the closing block
  const st = stOf(tr), M = barMap(tr), dur = tr.dur || 180, now = opts.now ?? start, cap = dur - (opts.tail ?? 4);
  if (!st) return null;
  const hb = st.hbar, bar = st.bar, B = 60 / st.bpm, T = targetHb(tr, x, opts.rest), Lmin = 12, Lmax = x >= 0.8 ? 40 : 24;
  const hiAt = k => !!(M && k >= 0 && k < M.nb && M.hi[k]);
  const cands = [];
  for (let k = barIdx(st, start + Lmin * hb - 0.05) + 1; ; k++) {
    const P = barT(st, k), L = (P - start) / hb; if (P > cap || L > Lmax + 0.01) break; if (P < now + (opts.lead ?? 2)) continue;
    const through = hiAt(k - 1) && hiAt(k), after = hiAt(k - 1) && !hiAt(k), before = !hiAt(k - 1) && hiAt(k);
    const vEnd = st.vocConf >= 0.2 && st.vocEnds.some(e => e >= P - bar - 0.3 * B && e <= P + 0.3 * B);
    const vThru = (vocalIn(st, P - B, P) || 0) > 0.5 && (vocalIn(st, P, P + B) || 0) > 0.5;
    const brk = st.breaks.some(([a, b]) => b === k && b - a <= 4), phr = onPhrase(st, P), el = Math.abs(L / 4 - Math.round(L / 4)) < 0.02;
    let s = -0.6 * Math.pow((L - T) / 4, 2) + (phr ? 2 : 0) + (el ? 0.5 : 0) + (vEnd ? 1.5 : 0) - (vThru ? 1.5 : 0) + (after ? 1 : 0) + (brk ? 1.2 : 0) - (before ? 0.5 : 0);
    if (st.bpm > 110 && Math.abs(L - Math.round(L)) > 0.01) s -= 1;   // mid half-time bar
    cands.push({ P, k, L, s, through, phr, vEnd, vThru, after, brk });
  }
  const ok = cands.filter(c => !c.through);
  if (ok.length) { const b = ok.reduce((a, c) => c.s > a.s + 1e-9 ? c : a), why = c => c.brk ? 'break' : c.after ? 'after-highlight' : c.vEnd ? 'vocal-end' : c.phr ? 'phrase' : 'bar';
    const alts = ok.slice().sort((a, c) => c.s - a.s).slice(0, 4).map(c => ({ P: c.P, L: c.L, s: c.s, reason: why(c), vThru: c.vThru, phr: c.phr }));   // menu for the optional LLM layer
    return { ...b, reason: why(b), map: true, target: T, alts }; }
  // everything in range sits inside a highlight: hold until it ends, else let the song play out
  for (let k = barIdx(st, start + Lmax * hb) + 1; barT(st, k) <= cap; k++) if (!(hiAt(k - 1) && hiAt(k))) return { P: barT(st, k), k, L: (barT(st, k) - start) / hb, reason: 'held-past-highlight', map: true, target: T };
  return { P: Math.max(start + 8, cap), L: (cap - start) / hb, reason: 'played-out', map: true, target: T };
}
/* script timing: lead = beats of A before the 1 where automation starts; pre = B beats rolled before the 1 (silent for cuts) */
const MIXT = {
  phraseCut: { lead: 1, pre: 2 }, dropSwap: { lead: 0.5, pre: 2 }, ratioCut: { lead: 1, pre: 2 }, bassSwap: { lead: 4, pre: 4 },
  longBlend: { lead: 'n', pre: 'n' }, brake: { lead: 1.5, pre: 2 }, tempoMask: { lead: 2, pre: 2 }, drumlessReset: { lead: 1, pre: 2 }, echoOut: { lead: 4, pre: 2 },
};
/* the decision table: A playing at rateA, out at P (track seconds) -> how B comes in */
function decideMix(A, rateA, P, Bt, info = {}) {
  const sa = stOf(A), sb = stOf(Bt), aT = (A.bpm || 120) * rateA, bpmB = Bt.bpm || 120;
  const fam = tempoFam(aT, bpmB), gap = Math.abs(Math.exp(-fam.d) - 1), grid = beatOk(A) && beatOk(Bt), canSync = opt('tempoSync').checked && grid && fam.kind === '1:1';
  const keyOk = !!(A.cam && Bt.cam && keyDist(A.cam, Bt.cam) <= 0.6);
  const Ba = 60 / aT, Bb = 60 / bpmB, cueV = cueFor(Bt, 'vocal');
  const vA = x => sa ? vocalIn(sa, x[0], x[1]) : null;
  let type, why = [], cue = cueV, rateB = 1, lockB = 1, n = 0;
  const sync = canSync && gap <= 0.025;                               // stretch ≤ 2.5 %: B joins the block tempo
  const rSync = sync ? Math.exp(-fam.d) : 1;
  const aBreak = !!(sa && sa.breaks.some(([a, b]) => b === barIdx(sa, P + 0.05) && b - a <= 4));
  const aVocThru = (vA([P - Ba, P]) || 0) > 0.5;
  const bPreFree = sb && cueV.t >= 4 * Bb ? (vocalIn(sb, cueV.t - 4 * Bb, cueV.t) ?? 1) <= 0.25 : false;
  const drop = cueFor(Bt, 'drop');
  const nb = sa ? 4 * sa.hbar / Ba : 16, bInst = sb ? cueV.t - nb * Bb >= 0 && (vocalIn(sb, cueV.t - nb * Bb, cueV.t) ?? 1) <= 0.1 : false;
  const aInst = sa ? (vA([P - nb * Ba, P]) ?? 1) <= 0.1 || sa.breaks.some(([a, b]) => barT(sa, a) <= P - nb * Ba && barT(sa, b) >= P) : false;
  const quota = ((S.mixN || 0) ? (S.longN || 0) / (S.mixN || 1) : 0) < 0.12 && S.lastType !== 'longBlend';
  const longOk = sync && gap <= 0.016 && keyOk && aInst && bInst && quota && !info.manual;
  if (info.reset && sb && sb.drumless >= 8) { type = 'drumlessReset'; why.push(`reset slot, ${Math.round(sb.drumless)} s drumless intro`); }
  else if (sync) {
    if (aBreak && (drop.kind === 'drop' || (sb && cueV.kind === 'vocal'))) { type = 'dropSwap'; if (drop.kind === 'drop') cue = drop; why.push('A breaks before the 1, B lands full-band'); }
    else if (longOk) { type = 'longBlend'; n = Math.round(nb); why.push('same key, both sides instrumental'); }
    else if (bPreFree && (aVocThru || (heavyLow(sa) && heavyLow(sb)))) { type = 'bassSwap'; why.push(aVocThru ? 'A still rapping at the 1: one bar of B tops, lows swapped on the 1' : 'two heavy 808s: lows swapped on the 1'); }
    else { type = 'phraseCut'; why.push(sa && sa.vocConf >= 0.2 ? (aVocThru ? 'B line starts on the 1' : 'A line ends, B line starts on the 1') : 'phrase boundary'); }
    rateB = lockB = rSync;
  } else if (opt('tempoSync').checked && grid && fam.kind === '3:2' && Math.abs(fam.d) <= 0.01) { type = 'ratioCut'; why.push('3:2 tempo relation: straight cut, no stretch'); }
  else if (info.lastChange) { type = 'echoOut'; why.push('final tempo change of the set'); }
  else if (opt('tempoSync').checked && grid && fam.kind === '1:1' && gap <= 0.05) {
    const hard = (Bt.energy ?? 0.5) >= (A.energy ?? 0.5) - 0.02 && cueV.kind === 'vocal';
    type = hard && S.lastType !== 'brake' ? 'brake' : 'tempoMask';
    if (type === 'tempoMask') { rateB = clamp(Math.exp(-fam.d), 0.96, 1.04); lockB = 1; }   // starts near A's tempo, glides home
    why.push(`tempo step ${(gap * 100).toFixed(1)} %: ${type === 'brake' ? 'one-beat stop, B slams in' : 'echo throw, B glides to its own tempo'}`);
  } else if (sb && sb.drumless >= 8) { type = 'drumlessReset'; why.push(`tempo ${(gap * 100).toFixed(0)} % away: into B's ${Math.round(sb.drumless)} s drumless intro`); }
  else { type = 'echoOut'; why.push(grid ? `tempo ${(gap * 100).toFixed(0)} % away, no drumless intro` : 'no trustworthy beat grid'); }
  // types the rules accept for this pair (hard limits: tempo, grid, 808 / vocal stacking, long-blend quota); the LLM may only pick among these
  const allowed = new Set([type, 'echoOut']), grid1 = opt('tempoSync').checked && grid;
  if (sync) { allowed.add('phraseCut'); if (bPreFree && cueV.t >= 4 * Bb) allowed.add('bassSwap'); if (aBreak && (drop.kind === 'drop' || (sb && cueV.kind === 'vocal'))) allowed.add('dropSwap'); if (longOk) allowed.add('longBlend'); }
  else { if (grid1 && fam.kind === '3:2' && Math.abs(fam.d) <= 0.01) allowed.add('ratioCut'); if (grid1 && fam.kind === '1:1' && gap <= 0.05) { allowed.add('tempoMask'); if (cueV.kind === 'vocal') allowed.add('brake'); } }
  if (sb && sb.drumless >= 8) allowed.add('drumlessReset');
  if (info.force && info.force !== type && allowed.has(info.force)) {
    type = info.force; why = ['LLM pick among rule candidates']; cue = cueV; n = 0;
    rateB = lockB = sync && ['phraseCut', 'bassSwap', 'dropSwap', 'longBlend'].includes(type) ? rSync : 1;
    if (type === 'dropSwap' && drop.kind === 'drop') cue = drop;
    if (type === 'longBlend') n = Math.round(nb);
    if (type === 'tempoMask') { rateB = clamp(Math.exp(-fam.d), 0.96, 1.04); lockB = 1; }
  }
  if (type === 'drumlessReset') { cue = cueFor(Bt, 'intro'); if (canSync && gap <= 0.04) { rateB = lockB = Math.exp(-fam.d); } }
  if (type === 'bassSwap' && !(cue.t >= 4 * Bb)) type = 'phraseCut';
  const T = MIXT[type], lead = T.lead === 'n' ? n : T.lead, preBeats = T.pre === 'n' ? n : T.pre;
  const preB = Math.min(cue.t, preBeats * Bb);                       // B track seconds before its cue (≥ 0)
  return { type, why: why.join('; '), cue: cue.t, cueKind: cue.kind, cueVocal: cueV.vocal ?? null, preB, rateB, lockB, lead, n, gap: +(gap * 100).toFixed(2), fam: fam.kind, sync, next: Bt.id,
    aVocThru, aBreak, keyOk, allowed: [...allowed] };
}
/* ---------- optional LLM layer (Advanced → LLM assist; off by default) ----------
 * Hybrid: the rules build a small candidate menu per pair (out-point from planOut's best phrase ends × the transition types
 * decideMix accepts for that pair, each with its cue / play length); the model only returns candidate ids; the rules re-check
 * the pick when it is used. Rolling cache: decisions for the next few pairs (≤ 5 ahead, 3–4 per request), keyed by the exact
 * chain state (A, B, A's start, A's rate), so a changed order / pick simply misses and is re-asked. Transitions never wait:
 * a cache hit is used, a miss plays the rules plan while the model answers in the background. Any failure → rules. */
const LLM = { cache: new Map(), busy: false, fails: 0, until: 0, last: null, log: [], req: 0, tok: { in: 0, out: 0, calls: 0 } };
/* LLM assist mode (Advanced → LLM assist): Default = gpt-4o-mini (best score / cost in the real-API benchmark, see docs/DETAILS.md);
   Custom = any model typed in the model field (use it for other providers / OpenAI-compatible servers). */
const LLM_PRESETS = {
  default: { model: 'gpt-4o-mini', timeout: 6000, batch: 4, ahead: 5 },
  custom:  { timeout: 8000, batch: 4, ahead: 5 },
};
const llmCfg = () => {
  const on = opt('aiOn') && opt('aiOn').checked, base = ((opt('aiBase') && opt('aiBase').value) || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const key = ((opt('aiKey') && opt('aiKey').value) || '').trim(), pv = (opt('aiPreset') && opt('aiPreset').value) === 'custom' ? 'custom' : 'default';
  const pr = pv === 'custom' ? { ...LLM_PRESETS.custom, model: ((opt('aiModel') && opt('aiModel').value) || '').trim() } : LLM_PRESETS.default;
  return { on: !!(on && base && pr.model && (key || !/api\.openai\.com/.test(base))), base, key, preset: pv, ...pr };
};
const llmStart = () => S.segCue && S.live && S.segCue.id === S.live.track.id ? S.segCue.t : (S.segStart || 0);   // where the live track came in (its planned cue)
const llmKey = (A, B) => `${A.id}>${B.id}`;
/* a cached pick still fits if A came in within 4 half-time bars of the start it was planned for, at about the same tempo */
const llmFits = (hit, A, start, rate) => { const st = stOf(A); return !!(hit && st && Math.abs(start - hit.start) <= 4 * st.hbar + 0.05 && Math.abs(rate / hit.rate - 1) <= 0.02); };
const llmReasoning = m => /^(o\d|gpt-5|gpt-6)/i.test(m);   // reasoning models: max_completion_tokens, no temperature, low effort
async function llmChat(cfg, messages, json = true) {
  const tmo = cfg.timeout || 6000, ctl = new AbortController(), to = setTimeout(() => ctl.abort(), tmo), t0 = performance.now();
  try {
    const headers = { 'Content-Type': 'application/json' }; if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
    const body = { model: cfg.model, messages };
    if (llmReasoning(cfg.model)) { body.max_completion_tokens = 4000; body.reasoning_effort = cfg.effort || (/^gpt-5(-|$)/i.test(cfg.model) ? 'minimal' : /^o\d/i.test(cfg.model) ? 'low' : 'none'); } else { body.temperature = 0; body.max_tokens = 500; }
    if (json) body.response_format = { type: 'json_object' };
    let r;
    for (let k = 0; k < 2; k++) {   // one retry without a parameter the provider rejects (e.g. reasoning_effort / response_format)
      r = await fetch(cfg.base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      if (r.ok || r.status !== 400 || k) break;
      const t = await r.clone().text().catch(() => ''), m = /'?(reasoning_effort|response_format|temperature|max_tokens)'?/.exec(t); if (!m) break;
      if (m[1] === 'max_tokens') { delete body.max_tokens; body.max_completion_tokens = 4000; } else delete body[m[1]];
    }
    if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(`HTTP ${r.status}`); e.status = r.status; e.body = t.slice(0, 200); throw e; }
    const j = await r.json(), c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const u = j && j.usage; if (u) { LLM.tok.in += u.prompt_tokens || 0; LLM.tok.out += u.completion_tokens || 0; } LLM.tok.calls++;
    if (typeof c !== 'string' || !c.trim()) throw new Error('no message content');
    const data = JSON.parse(c.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    Object.defineProperty(data, '_meta', { value: { ms: Math.round(performance.now() - t0), usage: u || null }, enumerable: false });
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('timeout ' + tmo + ' ms');
    if (e instanceof TypeError) throw new Error('network/CORS error' + (/api\.openai\.com/.test(cfg.base) ? ' (check the API key: OpenAI answers a bad key without CORS headers)' : ' (server unreachable or not sending CORS headers)'));
    throw e;
  }
  finally { clearTimeout(to); }
}
/* the candidate menu for one pair: A from `start` at `rate`, into B. Ranked: c1 is the rules' own choice. Pruned to what the
 * reference DJ would do: echo / drumless reset only to mask a real tempo change (or in the reset slot), never when the pair
 * syncs; out-points only if they score close to the best phrase end. */
function llmMenu(A, B, start, rate, x, rest, info) {
  const sa = stOf(A), sb = stOf(B); if (!sa || !sb || rest <= 0) return null;
  const out = planOut(A, start, x, { now: start + 1, rest, lead: 4 * 60 / (A.bpm || 120) + 1 }); if (!out || !out.alts) return null;
  const best = out.alts[0].s, outs = out.alts.filter((o, k) => k === 0 || (o.phr && o.s >= best - 1.2)).slice(0, 3);   // alternatives only on the phrase grid
  const cands = []; const seen = new Set(); let ctx = null;
  outs.forEach((o, oi) => {
    const base = decideMix(A, rate, o.P, B, info);
    if (!ctx) ctx = { tempo_gap_pct: base.gap, tempo_family: base.fam, beat_synced: base.sync, key_ok: base.keyOk, b_slot: B._slot || null, last_change: !!info.lastChange, target_bars: +targetHb(A, x, rest).toFixed(0) };
    const masked = !base.sync && !(base.fam === '1:1' && base.gap <= 2.5);
    const ok = t => t === base.type || (t === 'echoOut' ? masked || info.lastChange : t === 'drumlessReset' ? info.reset || masked : true);
    [base.type, ...base.allowed.filter(t => t !== base.type)].filter(ok).forEach(t => {
      const p = t === base.type ? base : decideMix(A, rate, o.P, B, { ...info, force: t }); if (p.type !== t) return;
      const k = o.P.toFixed(2) + t; if (seen.has(k) || cands.length >= 8) return; seen.add(k);
      cands.push({ id: 'c' + (cands.length + 1), P: o.P, type: t, rule: oi === 0 && t === base.type, pair: p,
        d: { type: t, cut_at: o.reason, bars: +o.L.toFixed(0), play_s: +((o.P - start) / rate).toFixed(0), a_vocal_runs_through_cut: !!o.vThru || undefined, b_enters: p.cueKind, b_enter_s: +p.cue.toFixed(1) } });
    });
  });
  return cands.length ? { out, cands, ctx } : null;
}
const llmTrack = t => ({ title: (t.title || '').slice(0, 48), artist: (t.artist || '').slice(0, 32), bpm: t.bpm ? +t.bpm.toFixed(1) : null, key: (t.cam && t.cam.s) || null, energy: t.energy != null ? +t.energy.toFixed(2) : null });
function llmPrompt(ask, ctx) {
  const sys = [
    'You choose transitions for a hip-hop / Chinese-rap DJ set. Each pair lists rule-checked candidates, ranked: c1 is the rule engine\'s choice.',
    'Pick c1 unless a rule below clearly prefers another candidate of the same pair. Reference DJ rules:',
    '1. Cut A where a vocal line or phrase ends (cut_at vocal-end / break / after-highlight beat plain phrase); never mid-hook.',
    '2. B enters on a downbeat right before its first vocal or hook (b_enters vocal / drop); start B from its intro only for a reset.',
    '3. Mostly tight cuts: phraseCut, bassSwap, dropSwap, brake, ratioCut (>= 80 % of the set). longBlend at most 15 %, only same key and both sides instrumental.',
    '4. When the pair is beat_synced, cut on the beat; echoOut / drumlessReset are only for masking a tempo change > 2.5 % or the planned reset slot (b_slot "reset", ~40-50 % of the set).',
    '5. Play length: whole phrases of 12, 16 or 24 half-time bars; prefer bars close to target_bars (it grows toward the end of the set).',
    '6. Variety comes from the music: avoid the same type 3 times in a row (see recent), but never trade a clean cut for variety.',
    'Answer JSON only, exactly one pick for every pair in answer_for: {"picks":[{"pair":"p1","id":"c1"},{"pair":"p2","id":"c1"}]}'].join('\n');
  const user = { set_position: +(ctx.x || 0).toFixed(2), recent: ctx.last || [], answer_for: ask.map((b, k) => 'p' + (k + 1)),
    pairs: ask.map((b, k) => ({ pair: 'p' + (k + 1), from: llmTrack(b.A), to: llmTrack(b.B), ...(b.m.ctx || {}), candidates: b.m.cands.map(c => ({ id: c.id, ...c.d })) })) };
  return [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(user) }];
}
/* the model's reply → [{ b, c }] for known ids only (unknown ids leave that pair on the rules); throws if nothing usable */
function llmParse(res, ask) {
  const picks = res && Array.isArray(res.picks) ? res.picks : null; if (!picks) throw new Error('malformed reply (no picks[])');
  const got = [];
  ask.forEach((b, k) => { const p = picks.find(q => q && String(q.pair) === 'p' + (k + 1)), c = p && b.m.cands.find(c => c.id === String(p.id)); if (c) got.push({ b, c, k }); });
  if (!got.length) throw new Error('no valid candidate ids');
  return got;
}
/* walk the chain from the live track: cached picks advance it, misses are batched (3–4) and asked in the background */
function llmPrefetch(why = '') {
  const cfg = llmCfg(); if (!cfg.on || !shortBlend() || fullSongs() || LLM.busy || performance.now() < LLM.until) return;
  const d = S.live; if (!d || !d.track || S.idx < 0) return;
  const endless = opt('endless').checked; let i = S.idx, A = d.track, start = llmStart(), rate = d.lockRate || 1;
  const batch = [];
  for (let h = 0; h < cfg.ahead; h++) {
    const j = nextIdx(i + 1); if (j < 0) break; const B = S.set[j];
    const rest = endless ? 99 : S.set.slice(i + 1).filter(t => !t.bad).length, info = { x: arcX(i + 1), reset: B._slot === 'reset', lastChange: !endless && nextIdx(j + 1) < 0 };
    const key = llmKey(A, B), hit0 = LLM.cache.get(key), hit = llmFits(hit0, A, start, rate) ? hit0 : null;
    let next;
    if (hit) next = hit.pair;
    else { const m = llmMenu(A, B, start, rate, arcX(i), rest, info); if (!m) break; batch.push({ key, A, B, m, h, start, rate }); next = m.cands[0].pair; }
    i = j; start = next.cue; rate = next.lockB; A = B;
  }
  // small batches: ask when 3+ are missing, or when the live / next pair has nothing yet
  if (!batch.length || (batch.length < Math.min(3, cfg.batch) && batch[0].h > 1)) return;
  const ask = batch.slice(0, cfg.batch); LLM.busy = true; const t0 = performance.now(), rid = ++LLM.req;
  const entry = { rid, at: Date.now(), why, pairs: ask.length, ok: false };
  llmChat(cfg, llmPrompt(ask, { x: arcX(S.idx), last: (S.mixLog || []).slice(-3).map(e => e.script) }))
    .then(res => {
      const got = llmParse(res, ask); let n = 0;
      got.forEach(({ b, c }) => { LLM.cache.set(b.key, { P: c.P, type: c.type, id: c.id, rule: c.rule, pair: c.pair, start: b.start, rate: b.rate, at: performance.now(), rid }); n++; });
      entry.ok = true; entry.n = n; entry.rej = ask.length - n; LLM.fails = 0; if (res._meta) { entry.api = res._meta.ms; entry.usage = res._meta.usage; }
      if (LLM.cache.size > 60) [...LLM.cache.keys()].slice(0, LLM.cache.size - 60).forEach(k => LLM.cache.delete(k));
    })
    .catch(e => { entry.err = String(e.message || e).slice(0, 120); LLM.fails++; LLM.until = performance.now() + Math.min(120000, 15000 * LLM.fails); console.warn('[llm] fallback to rules:', entry.err); })
    .finally(() => {
      entry.ms = Math.round(performance.now() - t0); LLM.busy = false; LLM.last = entry; LLM.log.push(entry); if (LLM.log.length > 50) LLM.log.shift();
      // a fresh answer for the live pair replaces its rules plan if there is still time; then keep rolling
      if (entry.ok && S.live && !S.inTrans && S.mixPlan && S.mixPlan.src === 'rules' && S.mixPlan.id === S.live.track.id) computeTransAt();
      if (entry.ok) setTimeout(() => llmPrefetch('roll'), 50);
    });
}
/* at plan time: the cached pick for the live pair, re-validated by the rules now (else null → rules) */
function llmUse(A, B, rate, info, now, lead) {
  const cfg = llmCfg(); if (!cfg.on || !B || !S.live) return null;
  const hit = LLM.cache.get(llmKey(A, B)); if (!llmFits(hit, A, llmStart(), S.live.lockRate || 1)) return null;
  const st = stOf(A), M = barMap(A), cap = (A.dur || 180) - 4; if (!st) return null;
  if (!(hit.P > now + lead && hit.P <= cap && hit.P - S.segStart >= 8 * st.hbar)) return null;           // still ahead, not too short
  const k = barIdx(st, hit.P + 0.05); if (M && k > 0 && k < M.nb && M.hi[k - 1] && M.hi[k]) return null;  // never through a hook / drop
  const pair = decideMix(A, rate, hit.P, B, { ...info, force: hit.type }); if (pair.type !== hit.type) return null;   // the rules still accept it
  return { P: hit.P, pair, hit };
}
function startPosFor(tr, isFirst) {
  if (tr.preview) return 0;
  tr._pre = 0;
  if (!isFirst && shortBlend()) {   // the planned cue minus its pre-roll (decideMix); else the vocal cue with a 2-beat pre-roll
    const MP = S.mixPlan, p = MP && MP.pair && MP.pair.next === tr.id ? MP.pair : null; if (p) return Math.max(0, p.cue - p.preB);
    const c = cueFor(tr, 'vocal'); return Math.max(0, c.t - Math.min(c.t, 2 * 60 / (tr.bpm || 120)));
  }
  const bs = 60 / (tr.bpm || 120), ph = (tr.an && tr.an.phase) || 0;
  let target = 0;
  if (!isFirst && opt('skipIntro').checked) target = Math.min(tr.dur * 0.1, 32);
  const need = (fullSongs() ? 180 : 70) + xfLen() + 4;
  target = Math.max(0, Math.min(target, tr.dur - need));
  const k = Math.max(0, Math.round((target - ph) / bs / 16) * 16);
  return Math.max(0, ph + k * bs);
}
/* rhythm-dense, vocal-led sets (hip-hop / trap, 华语 rap) mix with short beat-aligned bass swaps; club / chill keep long blends */
const shortBlend = () => { const s = fxStyle(); return s === 'trap' || s === 'song'; };
const GRID_CONF = 2.2;   // whole-song grid: mean flux on the beats / mean flux (structure pass)
const BEAT_CONF = 1.3;   // onset-autocorrelation peak / mean; below this (and no metadata agreement) the grid is a guess
const beatOk = t => !!(t && t.bpm && t.an && !t.preview && (t.an.bpmSrc === 'both' || t.an.conf >= BEAT_CONF || (t.an.st && t.an.st.gridConf >= GRID_CONF)));
/* mix-out point: the best phrase boundary in [lo, hi] whose overlap window [P, P + w] holds no high-energy bar. Prefers a
 * boundary right after a hook / drop ends (the highlight completed), then a calmer window, then earlier. Past hi it takes the
 * first clean boundary up to cap; with no clean one it plays out to cap (the song's end). */
function planMixOut(d, lo, hi, cap, w, want = null) {
  const tr = d.track, M = barMap(tr), bs = 60 / (tr.bpm || 120), ph = d.phase, now = d.el.currentTime + 1;
  lo = Math.max(lo, now); hi = Math.max(lo, Math.min(hi, cap)); cap = Math.max(lo, cap);
  const grid = (a, b, step) => { const out = []; for (let k = Math.ceil((a - ph) / (step * bs) - 1e-6); ph + k * step * bs <= b + 1e-6; k++) out.push(ph + k * step * bs); return out; };
  if (!M) { const c = grid(lo, hi, 16), wt = want ?? lo; return { P: c.length ? c.reduce((a, p) => Math.abs(p - wt) < Math.abs(a - wt) ? p : a) : lo, reason: 'no-map', map: false }; }
  const win = P => { const a = M.at(P + 0.05), b = M.at(P + w - 0.05); let bad = false, sum = 0, n = 0; for (let k = a; k <= b; k++) { if (k >= 0 && k < M.nb) { bad = bad || M.hi[k]; sum += M.sc[k]; n++; } } return { bad, mean: n ? sum / n : 0 }; };
  const after = P => { const k = M.at(P - 0.05); return k >= 0 && k < M.nb && M.hi[k]; };
  let best = null;
  for (const P of grid(lo, hi, 16)) {
    const W = win(P); if (W.bad) continue;
    const sc = (after(P) ? 1 : 0) + 0.5 * clamp(-W.mean, -1, 1.5) - (want != null ? 0.8 * Math.abs(P - want) / (hi - lo + 1) : 0.35 * (P - lo) / (hi - lo + 1));
    if (!best || sc > best.sc) best = { P, sc, reason: after(P) ? 'after-highlight' : W.mean < -0.5 ? 'low-energy' : 'phrase' };
  }
  if (best) return { P: best.P, reason: best.reason, map: true };
  for (const step of [16, 4]) for (const P of grid(hi, cap, step)) if (!win(P).bad) return { P, reason: 'held-past-highlight', map: true };
  // the song ends on its hook: let the hook finish, then hand over in the last moments (transition() shortens the blend)
  const last = M.secs.find(([a, b]) => M.t(b) > cap && M.t(a) < cap + w);
  if (last) return { P: Math.max(cap, Math.min(M.t(last[1]), (tr.dur || cap) - 1.2)), reason: 'played-out-after-hook', map: true };
  return { P: cap, reason: 'played-out', map: true };
}
function computeTransAt() {
  const d = S.live; if (!d || !d.track) return;
  const tr = d.track, bs = 60 / (tr.bpm || 120), ph = d.phase, start = S.segStart, rate = d.el.playbackRate || 1;
  const dur = tr.dur || d.el.duration || 180;
  if (tr.preview) { const end = dur - 0.6, xft = Math.min(xfLen() * rate, (end - start) * 0.4); S.transAt = Math.max(start + 8, end - xft); S.mixPlan = { id: tr.id, P: S.transAt, reason: 'preview', map: false }; return; }
  const short = shortBlend(); let w;   // w: overlap window, track seconds
  if (short) {   // structure-aware: phrase-based length + decision table (see planOut / decideMix)
    S.plan = null;
    const ni = nextIdx(S.idx + 1), nx = ni >= 0 ? S.set[ni] : null, endless = opt('endless').checked, x = arcX(S.idx);
    const rest = endless ? 99 : S.set.slice(S.idx + 1).filter(t => !t.bad).length;
    const st = stOf(tr), cap = dur - 4;
    let out = null;
    if (rest === 0 || fullSongs()) {   // last track of the set (or Full): play to the outro, hand over on a clean bar
      const M = barMap(tr); out = { P: cap, reason: 'played-out', map: !!M, L: 0 };
      if (M) { const lo = Math.max(start + 8, cap - 32 * bs); for (let k = M.at(lo) + 1; M.t(k) <= cap; k++) if (!(M.hi[k - 1] && M.hi[k])) { out = { P: M.t(k), reason: 'outro', map: true }; } }
    } else if (st) out = planOut(tr, start, x, { now: d.el.currentTime + 1, rest, lead: 4 * bs + 1 });
    if (!out) {   // no structure (analysis pending / failed): the plain 16-beat grid near the typical length, around hooks
      // half-time bar: from the tempo when known; unknown tempo (no BPM metadata, e.g. Chinese catalogues) ≈ a 75–95 BPM bar
      w = 8 * bs; const hb = tr.bpm ? 4 * bs * (tr.bpm > 110 ? 2 : 1) : 3.2, T = fallbackHb(tr, x, rest);
      const lo = Math.min(start + (T - 4) * hb, cap), hi = Math.min(start + (T + 4) * hb, cap);
      out = planMixOut(d, lo, hi, cap, w, Math.min(start + T * hb, cap)); out.L = (out.P - start) / hb; out.target = T;
    }
    const info = { x: arcX(S.idx + 1), reset: nx && nx._slot === 'reset', lastChange: !endless && nextIdx(ni + 1) < 0 };
    let pair = nx ? decideMix(tr, rate, out.P, nx, info) : null, src = 'rules', llm = null;
    // optional LLM layer: the cached pick for this pair, if the rules still accept it (else the rules plan above)
    const u = nx && st && rest > 0 && !fullSongs() ? llmUse(tr, nx, rate, info, d.el.currentTime + 1, 4 * bs + 1) : null;
    if (u) { out = { ...out, P: u.P, reason: 'llm:' + u.hit.id }; pair = u.pair; src = S.mixPlan && S.mixPlan.id === tr.id && S.mixPlan.src === 'rules' ? 'llm' : 'cache'; llm = { id: u.hit.id, rule: u.hit.rule }; }
    S.mixPlan = { id: tr.id, ...out, start, x: +x.toFixed(3), short: true, holds: 0, pair, src, llm };
    if (llmCfg().on) setTimeout(() => llmPrefetch('plan'), 0);
    const B = bs / rate, lead = pair ? Math.max(pair.lead * B, pair.preB / pair.rateB) + 0.05 : 4 * B;
    S.transAt = Math.max(start + 4, out.P - (lead + 0.6) * rate);
    // the next deck is already cued: move it to the planned pre-roll point now (not at the last moment)
    const o = other(d); if (pair && o.track === nx && o.el.paused && !S.inTrans) { const want = Math.max(0, pair.cue - pair.preB); o.startAt = want; if (o.ready && Math.abs(o.el.currentTime - want) > 0.05) o.el.currentTime = want; }
    return;
  }
  w = xfLen() * rate;
  // Hype: plan a long mashup into the next track (decided once per pair) and leave room for it
  const H = hype(), nx = S.set[nextIdx(S.idx + 1)];
  if (H && nx && !nx.preview && tr.bpm && nx.bpm && opt('tempoSync').checked && Math.abs(tempoRatio(nx.bpm, tr.bpm * rate) - 1) <= 0.04) {
    const key = tr.id + '>' + nx.id; if (!S.plan || S.plan.key !== key) S.plan = { key, script: planMash(tr, nx, H) };
    if (S.plan.script) w = Math.max(w, SCRIPTS[S.plan.script].beats(H) * bs);
  } else S.plan = null;
  const cap = dur - w - 0.6;
  let lo, hi;
  if (fullSongs()) { lo = cap - 32 * bs; hi = cap; }                                         // Full: play to the outro
  let want = null;
  if (!fullSongs()) {   // club: phrase-based (≈ 16 half-time bars, per song: length, energy, set position), may hold 16 bars for a drop
    const hb = 4 * bs * (tr.bpm > 110 ? 2 : 1), T = fallbackHb(tr, arcX(S.idx), opt('endless').checked ? 99 : S.set.slice(S.idx + 1).filter(t => !t.bad).length);
    const Tc = Math.max(16, T), floor = start + 12 * hb;   // club keeps its 16-bar floor; a long mashup never starts before 12 half-time bars
    lo = Math.max(floor, start + 16 * hb - w); want = Math.max(floor, start + Tc * hb - w); hi = Math.max(want, start + Tc * hb - w + 64 * bs);
  }
  lo = Math.min(lo, cap);
  const m = planMixOut(d, lo, hi, cap, w, fullSongs() ? null : Math.min(want, cap));
  S.mixPlan = { id: tr.id, ...m, lo, hi, cap, w, short, holds: 0 };
  S.transAt = Math.max(start + 8, m.P - 0.5 * rate);   // tick fires just before P; transition() starts on the bar at P
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
  S.live = d; d.lockRate = 1; applyAutoGain(d); S.liveSince = ctx.currentTime;
  const t = ctx.currentTime + 0.05;
  await d.el.play().catch(e => console.warn(e));
  S.playing = true; S.paused = false; document.body.classList.add('playing');
  const B = d.beatSec, fadeEnd = t + Math.max(3, B * 8);
  curve(d.xf.gain, 0, 1, t, fadeEnd, 'eqp');
  if (opt('autoFx').checked) { const f = filterFreqs(d.knob.filter); d.lp.frequency.setValueAtTime(400, t); expo(d.lp.frequency, f.lp, fadeEnd); showFx('INTRO FILTER', t, false, fadeEnd - t, d.name); }
  S.segStart = d.el.currentTime; computeTransAt(); S.lastFlourish = -1;
  setStatus('Live', 'ok'); renderAll(); preloadNext();
}

function planMash(a, b, H) {
  if (shortBlend() || rng() > H.mash) return null;   // no long layered mashups where rhythms are dense (trap / rap)
  const compat = !!(a.cam && b.cam && keyDist(a.cam, b.cam) <= 1);
  if (compat && (a.energy ?? .5) > 0.5 && (b.energy ?? .5) > 0.5 && rng() < H.dbl / H.mash) return 'double';
  if (compat && rng() < H.vocal / H.mash) return 'vocal';
  return pick(['mashup', 'mashloop']);
}
function chooseScript(D, I, synced) {
  // previews in a hip-hop / 华语 set (full tracks go through decideMix): short bass swap, else echo out
  if (shortBlend()) return synced ? 'swap' : opt('autoFx').checked ? 'echoOut' : 'quick';
  // club / chill: deterministic from the pair (sync, key, energy step) — the music is the reason, no random picks
  if (!opt('autoFx').checked) return 'fade';
  const dE = (I.track.energy ?? .5) - (D.track.energy ?? .5), keyOk = !!(D.track.cam && I.track.cam && keyDist(D.track.cam, I.track.cam) <= 0.6), chill = isChillSet();
  if (!synced) return chill || fxStyle() === 'song' ? 'wash' : 'echo';
  if (chill) return keyOk ? 'blend' : 'wash';
  if (dE > 0.12) return 'filter';
  if (dE < -0.15) return 'wash';
  return keyOk ? 'blend' : 'filter';
}

/* scripted transitions: (D)eck out, (I)ncoming, T start, B beat seconds, n beats -> {inAt, end} */
const SCRIPTS = {
  /* short bass swap (one = where the incoming's phrase "1" should land): one bar of the incoming's tops under the outgoing,
   * kick / 808 handed over on the 1, outgoing gone two beats later — only one low end plays at any time */
  swap: { label: 'BASS SWAP', n: 6, fn(D, I, T, B, n) {
    const sw = T + 4 * B, T1 = T + n * B, fI = filterFreqs(I.knob.filter), fD = filterFreqs(D.knob.filter);
    curve(I.xf.gain, 0, 0.88, T, sw, 'eqp'); I.xf.gain.setValueAtTime(0.88, sw); lin(I.xf.gain, 1, sw + B);
    I.low.gain.setValueAtTime(-32, T); I.low.gain.setValueAtTime(-32, sw - 0.025); lin(I.low.gain, I.knob.low, sw + 0.01);
    I.hp.frequency.setValueAtTime(190, T); I.hp.frequency.setValueAtTime(190, sw - 0.025); expo(I.hp.frequency, Math.max(10, fI.hp), sw + 0.015);
    D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, sw, T1, 'eqp');
    D.low.gain.setValueAtTime(D.knob.low, sw - 0.025); lin(D.low.gain, -32, sw + 0.01);
    D.hp.frequency.setValueAtTime(Math.max(10, fD.hp), sw - 0.025); expo(D.hp.frequency, 220, sw + 0.015); expo(D.hp.frequency, 650, T1);
    showFx('BASS SWAP', sw - B / 2, false, B, D.name + '→' + I.name);
    return { inAt: T, end: T1, one: sw }; } },
  /* no trustworthy grid: the outgoing bar filters up and throws an echo, the new track starts clean on its own downbeat */
  echoOut: { label: 'ECHO OUT', n: 4, fn(D, I, T, B, n) {
    const T1 = T + n * B, fD = filterFreqs(D.knob.filter);
    D.xf.gain.setValueAtTime(1, T); D.xf.gain.setValueAtTime(1, T + 2 * B); curve(D.xf.gain, 1, 0, T + 2 * B, T1, 'eqp');
    D.hp.frequency.setValueAtTime(Math.max(10, fD.hp), T); expo(D.hp.frequency, 700, T1); D.echo(T + 2 * B, 0.6, 0.42, 0.75);
    I.xf.gain.setValueAtTime(0, T); I.xf.gain.setValueAtTime(0, T1 - 0.005); lin(I.xf.gain, 1, T1 + 0.03);
    showFx('ECHO OUT', T + 2 * B, false, 2 * B, D.name);
    return { inAt: T1, end: T1, one: T1 }; } },
  /* plain quick blend (Auto FX off): two beats, lows of the incoming held back until it owns the mix */
  quick: { label: 'QUICK BLEND', n: 2, fn(D, I, T, B, n) {
    const T1 = T + n * B;
    curve(I.xf.gain, 0, 1, T, T1, 'eqp'); D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, T, T1, 'eqp');
    I.low.gain.setValueAtTime(-32, T); I.low.gain.setValueAtTime(-32, T1 - 0.03); lin(I.low.gain, I.knob.low, T1);
    D.low.gain.setValueAtTime(D.knob.low, T); lin(D.low.gain, -32, T + B);
    return { inAt: T, end: T1, one: T1 }; } },
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
  /* Hype mashups (planned in computeTransAt; tempo-synced only) — lows from one deck, mids / highs from the other */
  mashup: { label: 'MASHUP · DRUMS UNDER', n: 'm', beats: H => H.mashBeats, fn(D, I, T, B, n) {
    const T1 = T + n * B, h = T + Math.round(n / 2) * B;
    [I.mid.gain, I.high.gain].forEach(p => hold(p, T)); I.mid.gain.setValueAtTime(-18, T); I.high.gain.setValueAtTime(-9, T);   // next track's kick + bass under this one
    curve(I.xf.gain, 0, 0.9, T, T + 4 * B); D.xf.gain.setValueAtTime(1, T);
    D.low.gain.setValueAtTime(D.knob.low, T + 3.75 * B); lin(D.low.gain, -30, T + 4 * B); showFx('BASS SWAP', T + 3 * B, false, 1.5 * B, D.name + '→' + I.name, 'perf');
    I.mid.gain.setValueAtTime(-18, h); lin(I.mid.gain, I.knob.mid, h + 2 * B); I.high.gain.setValueAtTime(-9, h); lin(I.high.gain, I.knob.high, h + 2 * B);
    I.xf.gain.setValueAtTime(0.9, h); lin(I.xf.gain, 1, h + 2 * B);
    curve(D.xf.gain, 1, 0, h, T1); D.hp.frequency.setValueAtTime(filterFreqs(D.knob.filter).hp, h); expo(D.hp.frequency, 420, T1); D.echo(T1 - 2 * B, 0.55, 0.5, 0.75);
    showFx('HANDS OVER · TOPS', h, false, 2 * B, I.name, 'perf'); showFx('ECHO THROW', T1 - 2 * B, false, 2 * B, D.name, 'perf');
    return { inAt: T, end: T1 }; } },
  mashloop: { label: 'MASHUP · LOOP UNDER', n: 'm', beats: H => H.mashBeats, fn(D, I, T, B, n) {
    const T1 = T + n * B, L = 4 * B, l0 = T + L, l1 = T + 16 * B;
    [I.mid.gain, I.high.gain].forEach(p => hold(p, T)); I.mid.gain.setValueAtTime(-12, T); I.high.gain.setValueAtTime(-4, T);
    curve(I.xf.gain, 0, 0.72, T, T + B);
    I.loopOn(l0, L); I.loopOff(l1); showFx('LOOP 1 BAR × 3 · ' + I.name, l0, false, l1 - l0, I.name, 'perf');   // the next track's first bar, looped under this one
    D.xf.gain.setValueAtTime(1, T); D.low.gain.setValueAtTime(D.knob.low, l1 - 0.25 * B); lin(D.low.gain, -30, l1);
    I.mid.gain.setValueAtTime(-12, l1); lin(I.mid.gain, I.knob.mid, l1 + 2 * B); I.high.gain.setValueAtTime(-4, l1); lin(I.high.gain, I.knob.high, l1 + 2 * B);
    I.xf.gain.setValueAtTime(0.72, l1); lin(I.xf.gain, 1, l1 + 2 * B); Master.impact(l1, 0.45); showFx('BASS SWAP', l1 - B, false, 1.5 * B, D.name + '→' + I.name, 'perf');
    curve(D.xf.gain, 1, 0, l1, T1); D.hp.frequency.setValueAtTime(filterFreqs(D.knob.filter).hp, l1); expo(D.hp.frequency, 450, T1); D.echo(T1 - 2 * B, 0.5, 0.5, 0.75);
    return { inAt: T, end: T1 }; } },
  double: { label: 'DOUBLE DROP', n: 'm', beats: () => 16, fn(D, I, T, B, n) {
    const T1 = T + n * B;
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 0.85, T + 0.004); D.xf.gain.setValueAtTime(1, T - 0.004); lin(D.xf.gain, 0.85, T + 0.004);
    D.low.gain.setValueAtTime(D.knob.low, T - 0.004); lin(D.low.gain, -40, T + 0.004); Master.impact(T, 0.8);   // both drops, one bass (the incoming)
    D.xf.gain.setValueAtTime(0.85, T1 - 2 * B); lin(D.xf.gain, 0, T1); I.xf.gain.setValueAtTime(0.85, T1 - 2 * B); lin(I.xf.gain, 1, T1);
    D.echo(T1 - 2 * B, 0.6, 0.5, 0.75); showFx('ECHO THROW', T1 - 2 * B, false, 2 * B, D.name, 'perf');
    return { inAt: T, end: T1 }; } },
  vocal: { label: 'VOCAL OVER BEAT', n: 'm', beats: () => 16, fn(D, I, T, B, n) {
    const T1 = T + n * B, fD = filterFreqs(D.knob.filter);
    D.xf.gain.setValueAtTime(1, T); D.hp.frequency.setValueAtTime(Math.max(10, fD.hp), T); expo(D.hp.frequency, 380, T + 2 * B);   // outgoing: vocal band only
    D.lp.frequency.setValueAtTime(fD.lp, T); expo(D.lp.frequency, 7000, T + 2 * B);
    hold(I.mid.gain, T); I.mid.gain.setValueAtTime(-7, T); curve(I.xf.gain, 0, 1, T, T + 2 * B);   // incoming: the beat, mids pulled back to make room
    D.xf.gain.setValueAtTime(1, T1 - 4 * B); curve(D.xf.gain, 1, 0, T1 - 4 * B, T1); D.rSend.gain.setValueAtTime(D.knob.reverb * 0.9, T1 - 4 * B); lin(D.rSend.gain, 0.5, T1);
    I.mid.gain.setValueAtTime(-7, T1 - 4 * B); lin(I.mid.gain, I.knob.mid, T1);
    return { inAt: T, end: T1 }; } },
  /* ---- structure-aware transitions (hip-hop / 华语 sets): fn(D, I, T, B, plan) with T = the 1 (B's cue lands here) ---- */
  /* phrase cut: A's kick / 808 out a beat before the 1, B in on the 1, at most half a beat of A's tail */
  phraseCut: { label: 'PHRASE CUT', fn(D, I, T, B) {
    D.low.gain.setValueAtTime(D.knob.low, T - B); lin(D.low.gain, -30, T - B + 0.03);
    D.xf.gain.setValueAtTime(1, T - 0.004); curve(D.xf.gain, 1, 0, T - 0.004, T + 0.5 * B, 'eqp');
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 1, T + 0.004);
    return { end: T + 0.5 * B + 0.02 }; } },
  /* drop swap: A plays its own break, B's drop / hook lands full-band on the 1 */
  dropSwap: { label: 'DROP SWAP', fn(D, I, T) {
    D.xf.gain.setValueAtTime(1, T - 0.012); lin(D.xf.gain, 0, T);
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 1, T + 0.004);
    return { end: T + 0.03 }; } },
  /* 3:2 / 2:1 relation: no stretch, a clean cut on the 1 */
  ratioCut: { label: 'RATIO CUT', fn(D, I, T, B) {
    D.low.gain.setValueAtTime(D.knob.low, T - B); lin(D.low.gain, -30, T - B + 0.03);
    D.xf.gain.setValueAtTime(1, T - 0.012); lin(D.xf.gain, 0, T);
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 1, T + 0.004);
    return { end: T + 0.03 }; } },
  /* short bass swap: one bar of B's tops (no vocal, high-passed) under A, lows handed over on the 1, A gone within a beat */
  bassSwap: { label: 'BASS SWAP', fn(D, I, T, B) {
    const T0 = T - 4 * B, fI = filterFreqs(I.knob.filter), fD = filterFreqs(D.knob.filter);
    curve(I.xf.gain, 0, 0.85, T0, T, 'eqp'); I.xf.gain.setValueAtTime(0.85, T); lin(I.xf.gain, 1, T + B);
    I.low.gain.setValueAtTime(-32, T0); I.low.gain.setValueAtTime(-32, T - 0.025); lin(I.low.gain, I.knob.low, T + 0.01);
    I.hp.frequency.setValueAtTime(190, T0); I.hp.frequency.setValueAtTime(190, T - 0.025); expo(I.hp.frequency, Math.max(10, fI.hp), T + 0.015);
    D.xf.gain.setValueAtTime(1, T); curve(D.xf.gain, 1, 0, T, T + B, 'eqp');
    D.low.gain.setValueAtTime(D.knob.low, T - 0.025); lin(D.low.gain, -32, T + 0.01);
    D.hp.frequency.setValueAtTime(Math.max(10, fD.hp), T - 0.025); expo(D.hp.frequency, 260, T + 0.015); expo(D.hp.frequency, 700, T + B);
    showFx('BASS SWAP', T - B / 2, false, B, D.name + '→' + I.name);
    return { end: T + B + 0.02 }; } },
  /* long blend (same key, instrumental on both sides): B's intro under A's instrumental phrase, lows swapped half-way */
  longBlend: { label: 'LONG BLEND', fn(D, I, T, B, p) {
    const n = p.n, T0 = T - n * B, mid = T0 + Math.round(n / 8) * 4 * B;
    curve(I.xf.gain, 0, 1, T0, mid, 'eqp'); D.xf.gain.setValueAtTime(1, T0); D.xf.gain.setValueAtTime(1, mid); curve(D.xf.gain, 1, 0, mid, T, 'eqp');
    I.low.gain.setValueAtTime(-26, T0); I.low.gain.setValueAtTime(-26, mid - 0.025); lin(I.low.gain, I.knob.low, mid + 0.01);
    D.low.gain.setValueAtTime(D.knob.low, mid - 0.025); lin(D.low.gain, -26, mid + 0.01);
    const q = T - 4 * B; D.hp.frequency.setValueAtTime(filterFreqs(D.knob.filter).hp, q); expo(D.hp.frequency, 380, T);
    showFx('BASS SWAP', mid - B, false, 2 * B, D.name + '→' + I.name);
    return { end: T + 0.02 }; } },
  /* tempo step (brake): A stops in one beat, B slams in on the 1 at its own tempo */
  brake: { label: 'BRAKE', fn(D, I, T, B) {
    S.braking = true; D.brake(T - B, B * 0.95); showFx('TAPE STOP', T - B, false, B, D.name);
    D.xf.gain.setValueAtTime(1, T - 0.04); lin(D.xf.gain, 0, T);
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 1, T + 0.004);
    return { end: T + 0.03 }; } },
  /* tempo step (mask): an echo throw on A's last beat covers the step; B starts near A's tempo and glides to its own */
  tempoMask: { label: 'ECHO STEP', fn(D, I, T, B) {
    D.echo(T - B, 0.5, 0.42, 0.5); D.hp.frequency.setValueAtTime(Math.max(10, filterFreqs(D.knob.filter).hp), T - 2 * B); expo(D.hp.frequency, 520, T);
    D.xf.gain.setValueAtTime(1, T - 0.012); lin(D.xf.gain, 0, T); showFx('ECHO THROW', T - B, false, B, D.name);
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 1, T + 0.004);
    return { end: T + 0.03 }; } },
  /* drumless reset: A leaves on its phrase end with a short echo, B's drumless intro takes over (the drums arrive in B's tempo) */
  drumlessReset: { label: 'DRUMLESS RESET', fn(D, I, T, B) {
    D.echo(T - B / 2, 0.45, 0.4, 0.5); D.xf.gain.setValueAtTime(1, T - 0.004); curve(D.xf.gain, 1, 0, T - 0.004, T + B, 'eqp');
    D.hp.frequency.setValueAtTime(Math.max(10, filterFreqs(D.knob.filter).hp), T); expo(D.hp.frequency, 600, T + B);
    I.xf.gain.setValueAtTime(0, T - 0.004); lin(I.xf.gain, 1, T + 0.004);
    return { end: T + B + 0.02 }; } },
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
  if (shortBlend() && !tr.preview && !D.track.preview && !forceScript) return mixShort(D, I, tr, to, kind);
  // tempo sync: match incoming to outgoing (allowing half/double time) within ±4 %, and hold that block tempo
  const outBpm = (D.track.bpm || 120) * D.el.playbackRate, inBpm = tr.bpm || 120;
  const ratio = tempoRatio(inBpm, outBpm);   // multiply incoming rate by this
  const short = shortBlend();
  const synced = !!(D.track.bpm && tr.bpm && Math.abs(ratio - 1) <= 0.04 && opt('tempoSync').checked && (!short || (beatOk(D.track) && beatOk(tr))));
  I.el.playbackRate = synced ? ratio : 1; I.lockRate = I.el.playbackRate; I.el.preservesPitch = true;
  const planned = kind === 'auto' && synced && S.plan && S.plan.script && S.plan.key === D.track.id + '>' + tr.id ? S.plan.script : null;
  let script = forceScript || planned || (kind === 'quick' ? (short ? (synced ? 'swap' : 'echoOut') : synced ? 'filter' : 'echo') : chooseScript(D, I, synced));
  let SC = SCRIPTS[script]; S.lastScript = script;
  const B = D.beatSec;
  if (short && script === 'swap' && ((D.track.dur || D.el.duration) - D.el.currentTime) / (D.el.playbackRate || 1) < 7 * B + 0.4) { script = 'quick'; SC = SCRIPTS.quick; S.lastScript = script; }   // no room for a bar of overlap at the very end
  let n = SC.n === 'm' ? SC.beats(hype() || HYPE.club) : SC.n === 'x' ? Math.max(4, Math.round(xfLen() / B / 4) * 4) : SC.n;
  if (kind === 'quick' && SC.n === 'x') n = Math.min(n, 8);
  if (short && SC.n === 'x') n = Math.max(2, Math.min(8, Math.floor(8 / B)));   // short-blend sets: never more than ~8 s of overlap
  if (tr.preview || D.track.preview) n = Math.min(n, Math.max(2, Math.floor(8 / B)));
  const remain = ((D.track.dur || D.el.duration) - D.el.currentTime) / (D.el.playbackRate || 1) - 0.3;
  let dt = D.untilBeat(kind === 'quick' ? 1 : 4, 0.12);
  if (dt + n * B > remain) { dt = D.untilBeat(1, 0.08); n = Math.max(1, Math.min(n, Math.floor((remain - dt) / B))); }
  const T = ctx.currentTime + dt;
  D.unride(); I.unride();
  [D, I].forEach(x => { [x.xf.gain, x.low.gain, x.mid.gain, x.high.gain, x.hp.frequency, x.lp.frequency, x.rSend.gain, x.dSend.gain, x.gate.gain].forEach(p => hold(p, T)); });
  I.restore(ctx.currentTime, 0.01); I.xf.gain.setValueAtTime(0, ctx.currentTime);
  D.auto = I.auto = true;
  const r = SC.fn(D, I, T, B, n);
  showFx(SC.label + (synced ? ' · SYNC' : ''), T, true, Math.max(1.5, r.end - T), D.name + '→' + I.name);
  logMix(D, tr, script, synced, kind, T, r);
  const lat = 0.035;  // media element start latency compensation
  // cue: the incoming was loaded one bar early (tr._pre); shift so its phrase start lands on r.one
  const want = I.el.currentTime + (tr._pre || 0) - (r.one != null ? (r.one - r.inAt) * I.el.playbackRate : (tr._pre || 0));
  if (Math.abs(want - I.el.currentTime) > 0.03 && want >= 0) I.el.currentTime = want;
  setTimeout(() => { if (S.inTrans) I.el.play().then(() => { if (synced) setTimeout(() => phaseNudge(D, I, 3), 350); }).catch(console.warn); }, Math.max(0, (r.inAt - ctx.currentTime - lat) * 1000));
  setTimeout(() => $('#xfadeBadge').classList.add('on'), dt * 1000);
  setTimeout(() => finishTransition(D, I, to), Math.max(0, (r.end - ctx.currentTime) * 1000 + 60));
}
/* hip-hop / 华语 transitions: the planned pair (decideMix) lands B's cue exactly on A's out point P (a downbeat) */
function mixShort(D, I, tr, to, kind) {
  const rateA = D.el.playbackRate || 1, B = D.beatSec, now = ctx.currentTime, MP = S.mixPlan;
  let plan = kind === 'auto' && MP && MP.id === D.track.id && MP.pair && MP.pair.next === tr.id ? MP.pair : null, Tone = null, P = MP && MP.P;
  const leadOf = p => Math.max(p.lead * B, p.preB / p.rateB) + 0.05;
  if (plan) { const dtP = (P - D.el.currentTime) / rateA; if (dtP >= leadOf(plan) + 0.03 && dtP < leadOf(plan) + 3) Tone = now + dtP; }
  if (Tone == null) {   // manual skip / late trigger: the next downbeat that leaves room for the lead-in
    const x = arcX(S.idx + 1), info = { x, reset: tr._slot === 'reset', manual: kind !== 'auto' };
    let dt = D.untilBeat(4, 1.1 * B + 0.1); P = D.el.currentTime + dt * rateA; plan = decideMix(D.track, rateA, P, tr, info);
    if (leadOf(plan) + 0.03 > dt) { dt = D.untilBeat(4, leadOf(plan) + 0.1); P = D.el.currentTime + dt * rateA; plan = decideMix(D.track, rateA, P, tr, info); }
    Tone = now + dt;
  }
  const SC = SCRIPTS[plan.type]; S.lastScript = plan.type; S.lastType = plan.type; S.mixN = (S.mixN || 0) + 1; if (plan.type === 'longBlend') S.longN = (S.longN || 0) + 1;
  I.el.playbackRate = plan.rateB; I.lockRate = plan.lockB; I.el.preservesPitch = true;
  const inAt = Tone - plan.preB / plan.rateB, want = Math.max(0, plan.cue - plan.preB);
  I.startAt = want; if (Math.abs(I.el.currentTime - want) > 0.03) I.el.currentTime = want;
  S.segCue = { id: tr.id, t: plan.cue };
  const T0 = Math.min(Tone - plan.lead * B, inAt) - 0.02;
  D.unride(); I.unride();
  [D, I].forEach(x => { [x.xf.gain, x.low.gain, x.mid.gain, x.high.gain, x.hp.frequency, x.lp.frequency, x.rSend.gain, x.dSend.gain, x.gate.gain].forEach(p => hold(p, Math.max(now, T0))); });
  I.restore(now, 0.01); I.xf.gain.setValueAtTime(0, now);
  D.auto = I.auto = true;
  const r = plan.type === 'echoOut' ? SC.fn(D, I, Tone - 4 * B, B, 4) : SC.fn(D, I, Tone, B, plan);
  showFx(SC.label + (plan.sync ? ' · SYNC' : ''), Math.max(now, T0), true, Math.max(1.5, r.end - T0), D.name + '→' + I.name);
  logMix(D, tr, plan.type, plan.sync, kind, Tone, { inAt, end: r.end, one: Tone }, plan);
  const lat = 0.035;
  setTimeout(() => { if (S.inTrans) I.el.play().then(() => { if (plan.sync) setTimeout(() => phaseNudge(D, I, 3), 300); }).catch(console.warn); }, Math.max(0, (inAt - ctx.currentTime - lat) * 1000));
  setTimeout(() => $('#xfadeBadge').classList.add('on'), Math.max(0, (T0 - now) * 1000));
  setTimeout(() => finishTransition(D, I, to), Math.max(0, (r.end - ctx.currentTime) * 1000 + 60));
}
/* beat-phase correction after the incoming deck starts (like nudging a jog wheel) */
function phaseNudge(D, I, tries = 1) {
  if (!S.inTrans || D.el.paused || I.el.paused || !D.track.an || !I.track.an || S.braking) return;
  let d = (D.beatPos() - I.beatPos()) % 1; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
  const err = d * I.beatSec; (S.nudges || (S.nudges = [])).push(+err.toFixed(3)); if (Math.abs(err) < 0.012) return;
  // a big start error (media start latency) is fixed with one small jump while the incoming is still quiet, then re-checked
  if (Math.abs(err) > 0.035 && tries > 1) { I.el.currentTime += d * 60 / I.track.bpm; setTimeout(() => phaseNudge(D, I, tries - 1), 300); return; }
  const r0 = I.el.playbackRate, k = clamp(err / 0.5, -0.06, 0.06);
  I.el.playbackRate = r0 * (1 + k); setTimeout(() => { I.el.playbackRate = r0; if (tries > 1) setTimeout(() => phaseNudge(D, I, tries - 1), 150); }, 500);
}
/* mix log (window.NEONDJ.S.mixLog): where each track was mixed out, how much of it played, overlap, grid used, and whether the
 * overlap touched a detected high-energy bar of the outgoing track */
function logMix(D, tr, script, synced, kind, T, r, plan = null) {
  const o = D.track, rate = D.el.playbackRate || 1, outT = D.el.currentTime + (T - ctx.currentTime) * rate, outEnd = outT + (r.end - T) * rate;
  const dur = o.dur || D.el.duration || 0, M = barMap(o), P = S.mixPlan && S.mixPlan.id === o.id ? S.mixPlan : {}, st = stOf(o), sb = stOf(tr);
  let inHigh = false; if (M) for (let k = M.at(outT + 0.05); k <= M.at(outEnd - 0.05); k++) if (M.hi[k]) inHigh = true;
  const e = { title: o.title, artist: o.artist, dur: +dur.toFixed(1), from: +S.segStart.toFixed(1), out: +outT.toFixed(1), played: +(outT - S.segStart).toFixed(1),
    pct: dur ? +((outT - S.segStart) / dur * 100).toFixed(1) : null, script, kind, aligned: synced, beatOk: [beatOk(o), beatOk(tr)], overlap: +Math.max(0, r.end - r.inAt).toFixed(2),
    reason: P.reason || kind, map: !!M, highs: M ? M.secs.map(([a, b]) => [+M.t(a).toFixed(1), +M.t(b).toFixed(1)]) : [], inHigh, holds: P.holds || 0, next: tr.title };
  if (plan) Object.assign(e, { hb: st ? +((outT - S.segStart) / st.hbar).toFixed(1) : null, onPhrase: st ? onPhrase(st, outT) : null, x: P.x ?? null, why: plan.why, cue: +plan.cue.toFixed(2), cueKind: plan.cueKind,
    src: P.pair === plan ? (P.src || 'rules') : 'rules', llmId: P.pair === plan && P.llm ? P.llm.id : null, cueVocal: plan.cueVocal != null ? +plan.cueVocal.toFixed(2) : null, rateB: +plan.rateB.toFixed(4), lockB: +plan.lockB.toFixed(4), gap: plan.gap, fam: plan.fam, rateA: +rate.toFixed(4), vocConfB: sb ? +sb.vocConf.toFixed(2) : null });
  (S.mixLog || (S.mixLog = [])).push(e); console.info('[mix]', JSON.stringify(e));
}
function finishTransition(D, I, to) {
  const t = ctx.currentTime;
  D.el.pause(); S.braking = false; D.el.preservesPitch = true; D.el.playbackRate = 1; D.lockRate = 1;
  S.playedSec = (S.playedSec || 0) + Math.max(0, t - (S.liveSince ?? t)); S.liveSince = t;
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
    if (t >= S.transAt || d.el.ended) {
      // no energy map for this track: the live section detector holds a mix that would land in a drop (max 2 phrases)
      const P = S.mixPlan, bs = 60 / ((d.track && d.track.bpm) || 120);
      if (!d.el.ended && P && P.id === d.track.id && !P.map && P.reason !== 'preview' && d.sec && d.sec.name === 'drop' && P.holds < 2 && S.transAt + 16 * bs < (P.cap || 0)) { P.holds++; S.transAt += 16 * bs; return; }
      transition('auto'); return;
    }
    const r = d.el.playbackRate, tg = d.lockRate || 1; if (!S.braking && Math.abs(r - tg) > 0.0005) d.el.playbackRate = r + Math.sign(tg - r) * Math.min(0.00025, Math.abs(tg - r));   // hold the block tempo (≤ ±4 %); glide ≈ 0.25 %/s after a tempo step
    if (opt('autoFx').checked) { trackSection(d); if (hype()) perform(d, t); else flourish(d, t); ride(d, t); }
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
  if (d._rideUntil > now || d._perfUntil > now || d._modUntil > now || toMix < (ahead + 18) * B) return;
  if ((now - (d._lastMove || 0)) / (16 * B) < 3 || rng() > 0.3) return;   // subtle EQ rides only after a long untouched stretch
  const chill = isChillSet() ? 0 : 1;
  const opts = Object.entries(RIDES).filter(([k, R]) => (!R.ok || R.ok(d)) && !(k === 'hpTease' && (ph + 16) % 32 === 0) && Object.keys(d.grab).every(g => !d.grab[g]));
  if (!opts.length) return;
  let tot = opts.reduce((a, [, R]) => a + R.w[chill], 0), x = rng() * tot, key = opts[0][0];
  for (const [k, R] of opts) { x -= R.w[chill]; if (x <= 0) { key = k; break; } }
  d._ridden = []; const [a, e] = RIDES[key].fn(d, t0, B); d._rideUntil = e; d._lastMove = e; S.perfLog.push({ at: a, key: 'ride:' + key, sec: d.sec && d.sec.name, deck: d.name });
  showFx(RIDES[key].label, a, false, e - a, d.name, 'ride');
}

/* ---------- Hype: mid-track performance ----------
 * Default is to do nothing. A move only happens when the music gives it a reason, and its style follows the genre:
 *   dropSoon   build, or a breakdown that has run 4+ bars: the next phrase probably drops -> filter build-up, a bass kill
 *              into the 1; only here, rarely, a cut (loop roll / stutter / tape stop), never in chill or vocal-led styles
 *   intoBreak  the energy just fell                    -> reverb swell or a low-pass sweep down into the breakdown
 *   plateau    same energy for 4+ untouched phrases     -> one slow HP / LP sweep over 8 bars, or a bass swap on the 1
 *   phraseEnd  a 32-beat boundary after 2+ quiet phrases -> echo throw on the last beat
 * Flanger / phaser only under builds. After each move the track is left alone for a while (Club ≥ 2 phrases, Wild ≥ 1),
 * cuts have their own long cooldown (Club ~3 min, Wild ~75 s). Sections come from the deck's pre-FX level. */
const HYPE = {
  club: { p: 1, rest: 2, plateau: 4, cutGap: 180, layers: false, mash: 0.45, dbl: 0.12, vocal: 0.12, brake: 0.05, mashBeats: 32 },
  wild: { p: 1.5, rest: 1, plateau: 2, cutGap: 75, layers: true, mash: 0.65, dbl: 0.3, vocal: 0.2, brake: 0.14, mashBeats: 32 },
};
const hype = () => (opt('autoFx').checked && HYPE[opt('fxAmt').value]) || null;
function trackSection(d) {
  if (!d.track || !d.track.an) return;
  const s = d.sec || (d.sec = { fast: 0, slow: 0, bars: [], acc: 0, n: 0, bar: -1, max: 0, lowRun: 0, name: 'groove' });
  const l = d.secLevel(), B = d.beatSec, a1 = 1 - Math.exp(-0.1 / (2 * B)), a2 = 1 - Math.exp(-0.1 / (24 * B));
  if (!s.slow) s.fast = s.slow = l;
  s.fast += a1 * (l - s.fast); s.slow += a2 * (l - s.slow);
  const bar = Math.floor(d.beatPos() / 4);
  if (bar !== s.bar) {
    if (s.n) { const v = s.acc / s.n; s.bars.push(v); if (s.bars.length > 16) s.bars.shift(); s.max = Math.max(s.max * 0.97, v); }   // loudest recent bar
    s.bar = bar; s.acc = 0; s.n = 0; s.name = sectionOf(d); s.lowRun = s.name === 'breakdown' ? s.lowRun + 1 : 0; (s.hist || (s.hist = [])).push(s.name); if (s.hist.length > 16) s.hist.shift();
  }
  s.acc += l; s.n++;
}
function sectionOf(d) {
  const s = d.sec; if (!s || s.bars.length < 3) return 'groove';
  const b = s.bars, last = b[b.length - 1], prev = b[Math.max(0, b.length - 4)], r = s.fast / (s.slow + 1e-6);
  if (r < 0.7 || last < 0.55 * s.max) return 'breakdown';
  if (last > prev * 1.15 && r < 1.08) return 'build';
  if (r > 1.1 || last > 0.9 * s.max) return 'drop';
  return 'groove';
}
/* style of the set: 'club' (house / techno / bass …), 'trap' (hip-hop), 'song' (vocal-led: 华语 …), 'chill' */
function fxStyle() {
  if (isChillSet()) return 'chill';
  const g = (S.params && S.params.genres) || [];
  if (g.some(x => GENRES[x] && GENRES[x].cn)) return 'song';
  if (g.some(x => x === 'hiphop')) return 'trap';
  return 'club';
}
/* moves: fn(d, t0 = start of the bar the move begins in, B, len) -> [start, end, label]; cut = a glitch move */
const MOVES = {
  hpBuild: { fn(d, t0, B, len) { const e = t0 + len * B, f = filterFreqs(d.knob.filter), hp = d.hp.frequency;
    hold(hp, t0); hp.setValueAtTime(Math.max(10, f.hp), t0); expo(hp, len >= 16 ? 1100 : 750, e - 0.03); hp.setValueAtTime(Math.max(10, f.hp), e);
    if (fxStyle() === 'club' && len >= 8) Master.riser(e - 8 * B, 8 * B);
    return [t0, e, 'FILTER BUILD → DROP']; } },
  bassKill:{ fn(d, t0, B) { const a = t0 + 3 * B, e = t0 + 4 * B; hold(d.low.gain, a); glide(d.low.gain, -40, a, 0.006); d.low.gain.setValueAtTime(-40, e - 0.004); lin(d.low.gain, d.knob.low, e); return [a, e + 0.05, 'BASS OUT → IN ON THE 1']; } },
  bassSwap:{ fn(d, t0, B) { const a = t0, e = t0 + 4 * B; hold(d.low.gain, a); lin(d.low.gain, d.knob.low - 9, a + 2 * B); d.low.gain.setValueAtTime(d.knob.low - 9, e - 0.01); lin(d.low.gain, d.knob.low, e); return [a, e + 0.05, 'BASS SWAP · BACK ON THE 1']; } },
  roll:    { cut: true, fn(d, t0, B) { const a = t0 + 3 * B; d.loopOn(a, B / 2); d.loopLen(a + B / 2, B / 4); d.loopOff(t0 + 4 * B); return [a, t0 + 4 * B, 'LOOP ROLL → DROP']; } },
  stutter: { cut: true, fn(d, t0, B) { d.stutter(t0 + 3.5 * B, t0 + 4 * B, B / 8); return [t0 + 3.5 * B, t0 + 4 * B, 'STUTTER → DROP']; } },
  brake:   { cut: true, fn(d, t0, B) { const a = t0 + 3 * B, at = d.phase + (d._perfFor + 4) * 60 / (d.track.bpm || 120);   // track time of the next phrase's 1
    d.brakeDrop(a, B * 0.92, at); Master.impact(t0 + 4 * B, 0.5); return [a, t0 + 4 * B, 'TAPE STOP → DROP']; } },
  gate:    { cut: true, fn(d, t0, B) { const p = d.gate.gain, div = B / 4, e = t0 + 8 * B; hold(p, t0);
    for (let t = t0; t < e - 1e-4; t += div) { glide(p, 1, t, 0.002); glide(p, 0.3, t + div * 0.55, 0.004); }
    glide(p, 1, e, 0.004); return [t0, e, 'TRANCE GATE ⅛']; } },
  throw:   { fn(d, t0, B) { const a = t0 + 3 * B; d.echo(a, 0.5, 0.45, 0.75); hold(d.dSend.gain, a + B * 0.6); glide(d.dSend.gain, d.knob.delay * 0.8, a + B * 0.6, 0.02); return [a, t0 + 5 * B, 'ECHO THROW']; } },
  verb:    { fn(d, t0, B) { const r = d.rSend.gain, base = d.knob.reverb * 0.9, e = t0 + 12 * B; hold(r, t0); r.setValueAtTime(base, t0); lin(r, 0.5, t0 + 2 * B); r.setValueAtTime(0.5, t0 + 4 * B); lin(r, base, e); return [t0, e, 'REVERB SWELL INTO BREAK']; } },
  lpSweep: { ok: d => d.knob.filter > -0.01, fn(d, t0, B, len) { const p = d.lp.frequency, base = filterFreqs(d.knob.filter).lp, lo = 700 + rng() * 700, mid = t0 + len * B * 0.6, e = t0 + len * B - 0.01;
    hold(p, t0); p.setValueAtTime(base, t0); expo(p, lo, mid); expo(p, base, e); return [t0, e, `LP SWEEP · ${len / 4} BARS`]; } },
  hpSweep: { ok: d => d.knob.filter < 0.01, fn(d, t0, B, len) { const p = d.hp.frequency, base = Math.max(10, filterFreqs(d.knob.filter).hp), e = t0 + len * B - 0.01;
    hold(p, t0); p.setValueAtTime(base, t0); expo(p, 220 + rng() * 160, e); p.setValueAtTime(base, e + 0.008); return [t0, e, `HP SWEEP · ${len / 4} BARS → 1`]; } },
  flange:  { layer: 'mod', fn(d, t0, B, len) { const e = t0 + len * B; d.flanger(t0, true); d.flanger(e - B / 2, false); return [t0, e, 'FLANGER UNDER THE BUILD']; } },
  phaser:  { layer: 'mod', fn(d, t0, B, len) { const e = t0 + len * B; d.phaser(t0, true); d.phaser(e - B / 2, false); return [t0, e, 'PHASER UNDER THE BUILD']; } },
};
/* which moves suit a reason in each style (weights); cuts are filtered again by the cooldown */
const MOVE_MENU = {
  dropSoonEarly: { club: { hpBuild: 1, flange: 0.3, phaser: 0.2 }, trap: { hpBuild: 0.6, lpSweep: 0.4 }, song: { lpSweep: 0.6, hpBuild: 0.4 }, chill: { lpSweep: 1 } },
  dropSoonLast:  { club: { bassKill: 1 }, trap: { bassKill: 1 }, song: { bassKill: 0.5, throw: 0.5 }, chill: { throw: 1 } },   // no mid-song loop rolls / stutters
  intoBreak:     { club: { verb: 0.6, lpSweep: 0.6 }, trap: { verb: 0.5, throw: 0.5 }, song: { verb: 1 }, chill: { verb: 1 } },
  plateau:       { club: { hpSweep: 0.6, lpSweep: 0.6, bassSwap: 0.5, gate: 0.12 }, trap: {}, song: {}, chill: { lpSweep: 1 } },   // hip-hop / 华语: no moves for their own sake
  phraseEnd:     { club: { throw: 1 }, trap: {}, song: {}, chill: { throw: 1 } },
};
const REASON_P = { dropSoonEarly: 0.55, dropSoonLast: 0.5, intoBreak: 0.4, plateau: 0.3, phraseEnd: 0.22 };
function perform(d, t) {
  const H = hype(), tr = d.track; if (!H || !tr || !tr.an || tr.preview) return;
  const B = d.beatSec, bpos = d.beatPos(); if (bpos < 6) return;
  const nb = Math.ceil(bpos / 4) * 4, ahead = nb - bpos;
  if (ahead > 1.4 || ahead < 0.2 || d._perfFor === nb) return;
  d._perfFor = nb;
  const now = ctx.currentTime, t0 = now + ahead * B, toMix = (S.transAt - t) / (d.el.playbackRate || 1);
  if (d._rideUntil > now || S.braking || Object.values(d.grab).some(Boolean)) return;
  const sc = d.sec || {}, sec = sc.name || 'groove', hist = sc.hist || [], barIn = (nb / 4) % 4, style = fxStyle();
  const quiet = (now - (d._lastMove || d._trackStart || 0)) / (16 * B);   // phrases since the last move on this deck
  if (d._trackStart == null || d._trackFor !== tr.id) { d._trackFor = tr.id; d._trackStart = now; d._lastMove = now; return; }
  // the reason, if any (one per bar boundary)
  let reason = null, len = 4;
  const dropSoon = sec === 'build' || (sec === 'breakdown' && sc.lowRun >= 4);
  if (dropSoon && barIn === 2 && !(d._perfUntil > now)) { reason = 'dropSoonEarly'; len = 8; }
  else if (dropSoon && barIn === 0 && sc.lowRun >= 4 && quiet >= 1 && !(d._perfUntil > now)) { reason = 'dropSoonEarly'; len = 16; }
  else if (dropSoon && barIn === 3) reason = 'dropSoonLast';
  else if (sec === 'breakdown' && sc.lowRun >= 1 && sc.lowRun <= 2 && hist.slice(-6, -2).every(x => x !== 'breakdown') && quiet >= 0.5) { reason = 'intoBreak'; len = 12; }
  else if (barIn === 0 && quiet >= H.plateau && (sec === 'groove' || sec === 'drop') && hist.slice(-4 * H.plateau).every(x => x === sec || x === 'groove' || x === 'drop')) { reason = 'plateau'; len = rng() < 0.5 ? 32 : 64; }
  else if (barIn === 3 && nb % 32 === 0 && quiet >= H.rest && sec !== 'breakdown') reason = 'phraseEnd';
  if (!reason) return;
  if (reason !== 'dropSoonLast' && quiet < H.rest && !(reason === 'dropSoonEarly' && quiet >= 1)) return;   // let the track breathe
  if (d._perfUntil > now && !(reason === 'dropSoonLast' && d._perfKey === 'hpBuild')) return;          // the build-up may end in a bass kill
  if (toMix < (ahead + len + 8) * B) return;                                                             // never run into the mix
  if (rng() > Math.min(0.9, REASON_P[reason] * H.p * (style === 'trap' || style === 'song' ? 0.6 : 1))) return;   // rap / R&B get more space
  const menu = MOVE_MENU[reason][style];
  const cutOk = style === 'club' || style === 'trap' ? now - (S.lastCut || -1e9) > H.cutGap && rng() < (H === HYPE.wild ? 0.6 : 0.35) : false;
  const fits = Object.entries(menu).filter(([k]) => { const M = MOVES[k]; return (!M.cut || cutOk) && (!M.ok || M.ok(d)) && (k !== 'gate' || H === HYPE.wild) && (M.layer !== 'mod' || (H.layers && !(d._modUntil > now))); });
  if (!fits.length) return;
  let tot = fits.reduce((a, [, w]) => a + w, 0), x = rng() * tot, key = fits[0][0];
  for (const [k, w] of fits) { x -= w; if (x <= 0) { key = k; break; } }
  const M = MOVES[key], [a, e, label] = M.fn(d, t0, B, len);
  if (M.cut) S.lastCut = now;
  d._lastMove = e; S.perfLog.push({ at: a, key, sec, reason, style, deck: d.name }); showFx(label, a, false, e - a, d.name, 'perf');
  if (M.layer === 'mod') { d._modUntil = e; return; }   // swells switch themselves off
  if (reason === 'dropSoonEarly' && H.layers && key === 'hpBuild' && !(d._modUntil > now) && style === 'club' && rng() < 0.5) { const [, me] = MOVES.flange.fn(d, t0, B, len); d._modUntil = me; }   // Wild: flanger under the build
  d._perfUntil = e; d._perfKey = key; d.auto = true;
  setTimeout(() => { if (!S.inTrans && d === S.live && d._perfUntil === e) { d.restoreMain(ctx.currentTime, 0.03); d.auto = false; } }, (e - ctx.currentTime) * 1000 + 30);
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
    if (bridges[0]) { const f2 = fresh.filter(t => t.id !== bridges[0].id); if (f2.length) fresh = f2; else bridges.length = 0; }   // the same track can come back from the new dig
    const b2 = fresh.slice().sort((a, b) => fit(a, ref, newMid) - fit(b, ref, newMid))[0]; bridges.push(b2);
    bridges.forEach(t => { t.pinned = true; t.bridge = true; });
    fresh = fresh.filter(t => t !== b2);
    const tail = sequence(fresh, opt('order').value === 'found' ? 'found' : 'build', [b2], keep.length + bridges.length - 1).slice(1);
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
  const p = fxAmt() * (shortBlend() ? 0.5 : 1), chill = isChillSet(), sc = d.sec || {}, dropSoon = sc.name === 'build' || (sc.name === 'breakdown' && sc.lowRun >= 3);
  if (ahead > 8.2 && ahead < 9.3 && S.lastRiser !== nb) {
    S.lastRiser = nb;
    if (!chill && dropSoon && (tr.energy ?? .5) > 0.5 && rng() < p * 3) {   /* only when a drop is actually coming */ Master.riser(tb - 8 * B, 8 * B); Master.impact(tb, 0.45); showFx('RISER → DROP', tb - 8 * B, false, 8 * B, d.name); }
    return;
  }
  if (ahead > 2.3 || ahead < 1.15 || S.lastFlourish === nb) return;
  S.lastFlourish = nb;
  // Smooth: no cuts; a filter dip only into a coming drop, an echo / reverb tail only on a phrase change after a quiet stretch
  const quiet = (ctx.currentTime - (d._lastMove || 0)) / (16 * B);
  const fx = dropSoon ? 'dip' : sc.name === 'breakdown' ? 'wash' : quiet >= 4 ? (chill ? 'wash' : 'throw') : null;
  if (!fx || rng() > p * 3) return;
  d._lastMove = tb; S.perfLog.push({ at: tb, key: 'smooth:' + fx, sec: sc.name, deck: d.name });
  if (fx === 'throw') { d.echo(tb - B, 0.6, 0.45, 0.75); hold(d.dSend.gain, tb - B / 2); glide(d.dSend.gain, d.knob.delay * 0.8, tb - B / 2, 0.02); showFx('ECHO THROW', tb - B, false, B, d.name); return; }
  else if (fx === 'dip') { const f = filterFreqs(d.knob.filter); hold(d.hp.frequency, tb - 2 * B); d.hp.frequency.setValueAtTime(Math.max(10, f.hp), tb - 2 * B); expo(d.hp.frequency, 700, tb - 0.02); showFx('FILTER DIP', tb - 2 * B, false, 2 * B, d.name); }
  else if (fx === 'wash') { hold(d.rSend.gain, tb - 2 * B); d.rSend.gain.setValueAtTime(d.knob.reverb * 0.9, tb - 2 * B); lin(d.rSend.gain, 0.55, tb); showFx('REVERB SWELL', tb - 2 * B, false, 2 * B, d.name); }
  d.auto = true; setTimeout(() => { if (!S.inTrans) { d.restore(ctx.currentTime, 0.03); d.auto = false; } }, (tb - ctx.currentTime) * 1000 + 20);
}

/* endless mode: dig more of the same vibe before the set runs out */
async function maybeExtend() {
  if (S.extending || !S.params) return;
  const ahead = S.set.slice(S.idx + 1).filter(t => !t.bad).length;
  // endless: keep ~6 tracks queued; fixed length: top up while the queue would end before the chosen set length
  const short = !opt('endless').checked && (S.playedSec || 0) + (ahead + 1) * EST_PLAY * 1.1 < setLenSec() - 2 * EST_PLAY;   // ×1.1: the closing block runs longer
  if (!(opt('endless').checked ? ahead <= 6 : short)) return;
  S.extending = true;
  try {
    const exclude = new Set(S.set.map(t => t.id));
    const res = await digCrates({ ...S.params, need: 12, onStatus: () => { } });
    const fresh = res.tracks.filter(t => !exclude.has(t.id));
    if (fresh.length) {
      const head = S.set.slice(0, S.idx + 2); const seq = sequence(fresh, 'build', [head[head.length - 1]], head.length - 1).slice(1);
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
        try { applyAnalysis(t, await analyzeTrack(t)); }
        catch (e) { t.anFail = true; console.info('analysis skipped:', t.title, e.message); }
        S.decks.forEach(d => { if (d.track === t && ctx) applyAutoGain(d); });
        if (S.live && !S.inTrans && (S.live.track === t || S.set[nextIdx(S.idx + 1)] === t)) computeTransAt();
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
const FX_PAD = [[/RISER|BUILD/, 'riser'], [/GATE|CHOP/, 'stutter'], [/IMPACT/, 'impact'], [/LOOP|ROLL/, 'loop'], [/STUTTER/, 'stutter'], [/ECHO/, 'echo'], [/FILTER|SWEEP|DIP|LP |HP /, 'sweep'],
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
const EMPTY_DISLIKES = '<li class="empty"><span class="ei"><i class="dico"></i></span><b>No dislikes</b><span>Disliked tracks are never picked again</span></li>';
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
const PERSIST = ['setLen', 'perTrack', 'order', 'source', 'taste', 'xfLen', 'autoFx', 'tempoSync', 'skipIntro', 'endless', 'fxAmt', 'aiOn', 'aiPreset', 'aiBase', 'aiModel'];
function loadOpts() { const o = JSON.parse(localStorage.getItem('neondj.opts') || '{}'); if (o.perTrack != null && o.perTrack !== '0') o.perTrack = 'auto';   /* old fixed lengths (1:30 / 2:30 / 3:30) -> phrase-based */ if (o.aiPreset != null) o.aiPreset = o.aiPreset === 'custom' ? 'custom' : 'default';   /* old Fast / Balanced / Best quality presets -> Default */ if (o.fxAmt) o.fxAmt = ({ subtle: 'smooth', normal: 'club' })[o.fxAmt] || o.fxAmt; /* old Auto-FX values -> Hype */ PERSIST.forEach(k => { const el = opt(k); if (!el || o[k] == null) return; el.type === 'checkbox' ? el.checked = o[k] : el.value = o[k]; }); opt('xfLenVal').textContent = xfLen() + 's'; }
function saveOpts() { const o = {}; PERSIST.forEach(k => { const el = opt(k); if (el) o[k] = el.type === 'checkbox' ? el.checked : el.value; }); localStorage.setItem('neondj.opts', JSON.stringify(o)); }

async function build() {
  clearTimeout(steerTimer);
  const btn = $('#buildBtn'); btn.disabled = true;
  ensureAudio(); if (ctx.state === 'suspended') await ctx.resume();
  rng = mulberry32((Date.now() ^ (Math.random() * 1e9)) & 0xffffffff);
  const prov = Providers.resolve(opt('source').value), caps = prov.capabilities;
  const params = { genres: selected('genres'), moods: selected('moods'), prompt: $('#prompt').value.trim(), source: prov.id, taste: opt('taste').value };
  // phrase-based lengths: ~52 s a track (hip-hop / 华语), ~70 s in club sets; Full plays whole songs. Longer sets top up while playing.
  const vocalLed = params.genres.some(g => g === 'hiphop' || (GENRES[g] && GENRES[g].cn)), pt = fullSongs() ? 210 : vocalLed ? EST_PLAY : 70, eff = Math.max(20, caps.fullTrack ? pt : caps.previewSeconds - xfLen());
  // the closing block runs longer (~1.4×) and the closer plays out, so it needs fewer tracks than a flat estimate
  const L = +opt('setLen').value * 60, phr = caps.fullTrack && !fullSongs();
  const need = clamp(phr ? Math.ceil(0.8 * L / eff + Math.max(0, 0.2 * L - 150) / (1.4 * eff)) + 2 : Math.ceil(L / eff) + 2, 4, 48);
  S.buildId++;
  try {
    setStatus('Finding tracks…', 'busy');
    if (!(S.playing && S.live && !S.inTrans)) { S.playedSec = 0; S.mixN = 0; S.longN = 0; S.lastType = ''; S.mixLog = []; }
    let res;
    try { res = await digCrates({ ...params, need, onStatus: s => setStatus(s, 'busy') }); if (!res.tracks.length) throw new Error('no tracks'); }
    catch (e) {
      const fb = Providers.fallbackFor(params.source); if (!fb) throw e;
      if (caps.fullTrack && !fb.capabilities.fullTrack) throw new Error(`${prov.name} unavailable right now — Muse plays full tracks only here; pick “${fb.label || fb.name}” under Source to play 30 s previews`);
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
      const job = pool(fresh, 3, async t => { try { applyAnalysis(t, await analyzeTrack(t)); } catch (e) { t.anFail = true; }
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
  const live = S.set.filter(t => !t.bad), per = fullSongs() ? Infinity : shortBlend() ? EST_PLAY : 70; const tot = live.reduce((s, t) => s + Math.min(t.dur || 0, per), 0) - (shortBlend() ? 0 : xfLen() * Math.max(0, live.length - 1));
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
      <span class="bpm"><b>${bpm}</b> bpm<br>${t.cam ? t.cam.s : ''}<i class="ebar"><i style="width:${e}%"></i></i></span>${disBtn(t, i)}${heartBtn(t, i)}</li>`;
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
/* ---------- ✕ dislikes: skip / drop from the queue, never picked again, negative taste signal (taste.js) ---------- */
const Dislikes = NEONDJ.taste.Dislikes;
const ICON_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
const ICON_UNDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>';
const disBtn = (t, i) => { const on = Dislikes.has(t), q = i > S.idx; return `<button class="dis${on ? ' on' : ''}" data-dislike="${i}" title="${on ? 'Undo dislike' : q ? 'Dislike — remove from the set' : 'Dislike'}" aria-pressed="${on}">${ICON_DOWN}</button>`; };
/* is this track the one being mixed in right now (can't be pulled from under the crossfade) */
const isIncoming = t => S.inTrans && S.live && other(S.live).track === t;
function dislikeTrack(t, el) {
  if (!t) return;
  if (Dislikes.has(t)) { Dislikes.remove(t); showFx('DISLIKE UNDONE', ctx ? ctx.currentTime : 0); return; }
  Dislikes.add(t);
  if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  const nowPlaying = S.live && S.live.track === t && !S.inTrans;
  // drop it (and anything else now excluded, e.g. a 2nd strike on an artist) from the upcoming queue
  const A = NEONDJ.taste.avoid(), o = S.live ? other(S.live) : null;
  let cuedGone = false;
  for (let j = S.set.length - 1; j > S.idx; j--) { const u = S.set[j]; if (u === t || NEONDJ.taste.blocked(u, A)) { if (isIncoming(u)) continue; if (o && o.track === u) cuedGone = true; S.set.splice(j, 1); } }
  if (!S.live && S.idx >= 0 && S.set[S.idx] === t) { S.set.splice(S.idx, 1); S.idx--; }
  if (cuedGone && o) { o.ready = false; o.track = null; S.preloading = null; renderDecks(); }
  renderList();
  if (nowPlaying && S.playing) { showFx('✕ DISLIKED · NEXT', ctx.currentTime, false, 1.2, null, 'ride'); transition('quick'); }   // quick DJ-style mix out
  else { showFx('✕ DISLIKED', ctx ? ctx.currentTime : 0); if (S.live) { computeTransAt(); preloadNext(); } }
  if (S.live && typeof maybeExtend === 'function') maybeExtend();
}
function renderDislikeNow() {
  const t = S.live && S.live.track, b = $('#dislikeNow'); if (!b) return;
  if (!b.firstChild) b.innerHTML = ICON_DOWN;
  const on = !!t && Dislikes.has(t); b.disabled = !t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  b.title = t ? (on ? 'Undo dislike (X)' : 'Dislike — skip to the next track (X)') : 'Play something first';
}
function renderDislikes() {
  $('#dislikedCount').textContent = Dislikes.count();
  const ol = $('#dislikedList'); if (!ol) return;
  const all = Dislikes.all();
  ol.innerHTML = all.length ? all.map((t, i) => `<li data-k="${esc(Dislikes.key(t))}" title="${esc(t.title)} — ${esc(t.artist)}">
      <span class="n">${i + 1}</span><img loading="lazy" src="${esc(t.artSmall || t.art || '')}" alt="" onerror="this.style.visibility='hidden'">
      <span class="t"><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.genre ? ' · ' + esc(t.genre) : ''}${t.src ? ' · ' + esc((Providers.get(t.src) || { name: t.src }).name) : ''}</span></span>
      <span class="bpm">${t.bpm ? `<b>${Math.round(t.bpm)}</b> bpm` : ''}</span>
      <button class="dis undo" data-undislike="${esc(Dislikes.key(t))}" title="Undo dislike">${ICON_UNDO}</button></li>`).join('')
    : EMPTY_DISLIKES;
}
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
function showLiked(on, dis = false) {
  $('#listPanel').classList.toggle('show-liked', on); $('#listPanel').classList.toggle('show-disliked', on && dis);
  $('#tabSet').classList.toggle('on', !on); $('#tabLiked').classList.toggle('on', on && !dis); $('#tabDisliked').classList.toggle('on', on && dis);
  if (on) { renderLikes(); renderDislikes(); }
}
function exportLikes() {
  const blob = new Blob([JSON.stringify(Likes.exportData(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `muse-likes-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  setStatus(`Exported ${Likes.count()} likes${Dislikes.count() ? ' + ' + Dislikes.count() + ' dislikes' : ''}`, 'ok');
}
async function importLikes(file) {
  try { const r = Likes.importData(JSON.parse(await file.text())); setStatus(`Imported ${r.added} likes${r.disliked ? ' + ' + r.disliked + ' dislikes' : ''} (${r.total} total${r.skipped ? ', ' + r.skipped + ' skipped' : ''})`, 'ok'); }
  catch (e) { setStatus('Import failed: ' + (e.message || e), 'err'); }
}
function bindLikes() {
  Likes.onChange(() => { renderLikes(); renderLikeNow(); renderDislikeNow(); renderList(); });
  Dislikes.onChange(() => { renderDislikes(); renderLikes(); renderDislikeNow(); renderLikeNow(); renderList(); });
  $('#dislikeNow').addEventListener('click', e => dislikeTrack(S.live && S.live.track, e.currentTarget));
  $('#tabDisliked').addEventListener('click', () => showLiked(true, true));
  $('#dislikedList').addEventListener('click', e => { const b = e.target.closest('[data-undislike]'); if (b) Dislikes.remove(b.dataset.undislike); });
  $('#likeNow').addEventListener('click', e => toggleLike(S.live && S.live.track, e.currentTarget));
  $('#tabSet').addEventListener('click', () => showLiked(false));
  $('#tabLiked').addEventListener('click', () => showLiked(true));
  $('#likedBtn').addEventListener('click', () => showLiked(!$('#listPanel').classList.contains('show-liked')));
  $('#likedList').addEventListener('click', e => { const b = e.target.closest('[data-unlike]'); if (b) Likes.remove(b.dataset.unlike); });
  $('#likesExport').addEventListener('click', exportLikes);
  $('#likesImport').addEventListener('click', () => $('#likesFile').click());
  $('#likesFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importLikes(f); e.target.value = ''; });
  window.addEventListener('storage', e => { if (e.key === NEONDJ.taste.KEY || e.key === NEONDJ.taste.DKEY) { Likes._reload(); Dislikes._reload(); renderLikes(); renderDislikes(); renderLikeNow(); renderDislikeNow(); renderList(); } });   // other tabs
  renderLikes(); renderDislikes(); renderLikeNow(); renderDislikeNow();
}
function renderNow() {
  const d = S.live, t = d && d.track;
  $('#nowTitle').textContent = t ? t.title : (S.set.length ? 'Ready' : 'Pick a vibe and hit Generate');
  $('#nowArtist').textContent = t ? t.artist + (t.genre ? ' · ' + t.genre : '') : '—';
  const img = $('#nowArt'); if (t && t.art) { if (img.dataset.src !== t.art) { img.dataset.src = t.art; img._k = 0; img.src = t.art; img.onerror = () => { const m = t.artMirrors || []; if (img._k < m.length) { const u = new URL(t.art); img.src = m[img._k++] + u.pathname; } }; } } else { img.removeAttribute('src'); img.dataset.src = ''; }
  renderLikeNow(); renderDislikeNow();
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
    if (e.key === 'x' || e.key === 'X') { if (!e.repeat && S.live) dislikeTrack(S.live.track, $('#dislikeNow')); return; }
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
    const db = e.target.closest('[data-dislike]'); if (db) { e.stopPropagation(); dislikeTrack(S.set[+db.dataset.dislike], db); return; }
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
  ['aiOn', 'aiPreset', 'aiBase', 'aiKey', 'aiModel'].forEach(id => $('#' + id).addEventListener('change', () => { saveOpts(); LLM.cache.clear(); LLM.fails = 0; LLM.until = 0; if (llmCfg().on) llmPrefetch('settings'); }));
  $('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter') build(); });
  // NetEase proxy (Advanced): the NetEase source only appears in the Source menu once a proxy URL is saved
  $('#neteaseProxy').value = Providers.settings.get('neteaseProxy');
  $('#proxySave').addEventListener('click', async () => {
    const v = $('#neteaseProxy').value.trim().replace(/\/+$/, '');
    if (v && !/^https:\/\/[^\s/]+/i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(v)) { setStatus('Proxy URL must start with https://', 'err'); return; }
    Providers.settings.set('neteaseProxy', v); buildSources();
    if (!v) { setStatus('Using the built-in NetEase proxy', ''); return; }
    setStatus('Checking proxy…', 'busy');
    try { const r = await Providers.get('netease').search('lofi', { limit: 3 }); setStatus(r.length ? 'NetEase proxy OK — pick it under Source' : 'Proxy answered, but no results', r.length ? 'ok' : 'err'); }
    catch (e) { setStatus('Proxy not reachable: ' + (e.message || e), 'err'); }
  });
  window.NEONDJ = Object.assign(window.NEONDJ || {}, { S, LLM, LLM_PRESETS, __targetHb: targetHb, llmCfg, llmPrefetch, llmMenu, llmPrompt, llmParse, llmChat, llmUse, planOut, decideMix, barMap, build, digCrates, sequence, analyzeTrack, applyAnalysis, transition, SCRIPTS, Master, MOVES,
    structureOf, cueFor, planOut, decideMix, tempoFam, arcX, stOf, beatOk, isZh, energyOf, markTiers, computeTransAt, onPhrase, vocalIn, keyDist });   // for debugging / tests (+ .providers)
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
