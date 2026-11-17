# NetEase proxy (optional)

NetEase Cloud Music's web API sends no CORS headers, so a static page can't read it directly.
`worker.js` is a ~60-line Cloudflare Worker that forwards two read-only JSON calls (search, song URL)
and adds CORS headers. Audio is played straight from NetEase's CDN, not through the proxy.

## Deploy (about 3 minutes, free plan)
1. Cloudflare dashboard → Workers & Pages → Create → Worker → name it e.g. `muse-proxy` → Deploy.
2. Edit code → replace everything with the contents of `worker.js` → Deploy.
3. (Optional) Settings → Variables → add `ALLOWED_ORIGINS` = `https://novain1102.github.io` (comma-separate more
   origins, e.g. `http://localhost:8000` for local testing). Without it the defaults at the top of the file apply.
4. Open Muse → Advanced → **NetEase proxy** → paste `https://muse-proxy.<your-subdomain>.workers.dev` → Save.
   "NetEase 网易云" now appears in the Source menu.

CLI alternative: `npm i -g wrangler && wrangler deploy worker.js --name muse-proxy --compatibility-date 2024-11-01`.

Check it: `https://muse-proxy.<you>.workers.dev/netease/api/cloudsearch/pc?s=lofi&type=1&limit=3` should return JSON
(from a browser on an allowed origin; direct visits without an Origin header are refused).

## What it will and won't play
- Only songs NetEase streams for free to an anonymous listener. VIP/paid songs and 30-second trial clips are skipped.
- NetEase checks the **requesting IP — the Worker's**. Cloudflare runs Workers outside mainland China, so NetEase treats
  many songs as region-unavailable; in testing from a non-China IP roughly 10–30 % of search results were playable.
  A proxy hosted on a mainland-China server would see more, but that's outside this project.
- The proxy does no login, no cookies and no region spoofing.
