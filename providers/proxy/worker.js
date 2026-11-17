/* Muse — tiny CORS proxy for NetEase Cloud Music, as a Cloudflare Worker (free plan is plenty).
 *
 * It forwards exactly two read-only JSON calls and adds CORS headers so a static page (e.g. GitHub Pages)
 * can read them. Audio is NOT proxied: the browser plays m*.music.126.net directly (that CDN already sends CORS).
 *
 *   GET /netease/api/cloudsearch/pc?s=…&type=1&limit=…&offset=…       -> music.163.com/api/cloudsearch/pc
 *   GET /netease/api/song/enhance/player/url?ids=[123]&br=128000       -> music.163.com/api/song/enhance/player/url
 *
 * It does not log in, send cookies, fake a region (no X-Real-IP / X-Forwarded-For tricks) or unlock anything:
 * NetEase answers exactly as it would answer any anonymous visitor from the Worker's IP.
 *
 * Config (Worker → Settings → Variables): ALLOWED_ORIGINS = comma-separated origins allowed to call it,
 * e.g. "https://novain1102.github.io,http://localhost:8000". Default below if unset.
 */
const DEFAULT_ORIGINS = 'https://novain1102.github.io,http://localhost:8000,http://127.0.0.1:8000';
const ROUTES = {
  '/netease/api/cloudsearch/pc': { upstream: 'https://music.163.com/api/cloudsearch/pc', params: ['s', 'type', 'limit', 'offset'], ttl: 600 },
  '/netease/api/song/enhance/player/url': { upstream: 'https://music.163.com/api/song/enhance/player/url', params: ['ids', 'br'], ttl: 0 },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = String((env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes('*') || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (allowed.includes('*') ? '*' : origin) : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    if (!okOrigin) return json({ error: 'origin not allowed' }, 403, cors);
    const route = ROUTES[url.pathname];
    if (!route) return json({ error: 'not found' }, 404, cors);

    // forward only the whitelisted query parameters, with sane bounds
    const up = new URL(route.upstream);
    for (const k of route.params) { const v = url.searchParams.get(k); if (v != null && v.length < 200) up.searchParams.set(k, v); }
    if (up.searchParams.has('limit')) up.searchParams.set('limit', String(Math.min(50, +up.searchParams.get('limit') || 30)));
    if (route.params.includes('ids') && !/^\[\d{1,12}(,\d{1,12}){0,9}\]$/.test(up.searchParams.get('ids') || '')) return json({ error: 'bad ids' }, 400, cors);

    const cache = caches.default, key = new Request(up.toString());
    if (route.ttl) { const hit = await cache.match(key); if (hit) return withHeaders(hit, cors); }
    const r = await fetch(up.toString(), { headers: { 'Referer': 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0 (Muse proxy)' } });
    const body = await r.text();
    const res = new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': route.ttl ? `public, max-age=${route.ttl}` : 'no-store' } });
    if (route.ttl && r.ok) ctx.waitUntil(cache.put(key, res.clone()));
    return withHeaders(res, cors);
  },
};
function json(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }
function withHeaders(res, extra) { const h = new Headers(res.headers); for (const [k, v] of Object.entries(extra)) h.set(k, v); return new Response(res.body, { status: res.status, headers: h }); }
