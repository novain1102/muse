/* Muse — first-visit tour: dark overlay with a spotlight on one control, a small glass card (step x/y, Back, Next, Skip).
 * Interactive: picking a genre / mood or pressing Generate & Play advances it. Esc or Skip ends it at any time.
 * Shown once (localStorage 'neondj.tour'); the "?" button in the header replays it. ?tour=1 forces it (handy for testing). */
(function () {
  'use strict';
  const KEY = 'neondj.tour';
  const $ = s => document.querySelector(s);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const STEPS = [
    { sel: '#genreSect', title: 'Pick a genre', text: 'Tap one or more styles.', on: { el: '#genres', ev: 'click', match: '.chip' } },
    { sel: '#moodSect', title: 'Set the mood', text: 'Optional — or just hit Next.', on: { el: '#moods', ev: 'click', match: '.chip' } },
    { sel: '#buildBtn', title: 'Generate & Play', text: 'Muse finds tracks and starts mixing.', on: { el: '#buildBtn', ev: 'click' }, last: true, next: 'Play' },
    { sel: '#likeNow', title: 'Like what you hear', text: 'Tap ♥ — your likes shape future sets.', finale: true, next: 'Done' },
  ];
  let root, hole, card, blockers = [], i = -1, off = [], raf = 0, finTimer = 0;

  function build() {
    root = document.createElement('div'); root.className = 'tour'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Quick tour');
    hole = document.createElement('div'); hole.className = 'tour-hole';
    for (let k = 0; k < 4; k++) { const b = document.createElement('div'); b.className = 'tour-block'; blockers.push(b); root.appendChild(b); }
    card = document.createElement('div'); card.className = 'tour-card glass';
    card.innerHTML = '<div class="tc-step"></div><div class="tc-title"></div><div class="tc-text"></div>' +
      '<div class="tc-acts"><button type="button" class="tc-skip">Skip</button><span></span><button type="button" class="tc-back">Back</button><button type="button" class="tc-next">Next</button></div>';
    root.append(hole, card); document.body.appendChild(root);
    card.querySelector('.tc-skip').onclick = () => end();
    card.querySelector('.tc-back').onclick = () => go(i - 1);
    card.querySelector('.tc-next').onclick = () => next();
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', schedule); addEventListener('scroll', schedule, true);
    requestAnimationFrame(() => root.classList.add('on'));
  }
  const onKey = e => { if (!root) return; if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); } };
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };

  function next() {
    const s = STEPS[i];
    if (s && s.sel === '#buildBtn') { $('#buildBtn').click(); return; }   // "Play" on the card = press the real button
    if (s && s.finale) return end();
    go(i + 1);
  }
  function go(n) {
    off.forEach(f => f()); off = []; clearTimeout(finTimer);
    if (n < 0) n = 0;
    if (n >= STEPS.length) return end();
    i = n; const s = STEPS[i], t = $(s.sel);
    if (!t) return go(i + 1);
    root.classList.toggle('fin', !!s.finale);
    card.querySelector('.tc-step').textContent = (i + 1) + ' / ' + STEPS.length;
    card.querySelector('.tc-title').textContent = s.title;
    card.querySelector('.tc-text').textContent = s.text;
    card.querySelector('.tc-back').style.visibility = i > 0 && !s.finale ? 'visible' : 'hidden';
    card.querySelector('.tc-next').textContent = s.next || 'Next';
    if (s.on) {
      const el = $(s.on.el);
      const h = e => { if (s.on.match && !e.target.closest(s.on.match)) return;
        if (s.last) { go(i + 1); finTimer = setTimeout(end, 9000); } else setTimeout(() => { if (STEPS[i] === s) go(i + 1); }, 420); };
      el.addEventListener(s.on.ev, h); off.push(() => el.removeEventListener(s.on.ev, h));
    }
    const r = t.getBoundingClientRect();
    if (r.top < 70 || r.bottom > innerHeight - 20) t.scrollIntoView({ block: 'center', behavior: REDUCED.matches ? 'auto' : 'smooth' });
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    place(); setTimeout(place, 350);
    if (!s.finale) setTimeout(() => card.querySelector('.tc-next').focus({ preventScroll: true }), 50);
  }
  function place() {
    if (!root || i < 0) return;
    const t = $(STEPS[i].sel); if (!t) return;
    const pad = 8, r = t.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad), w = Math.min(W - 8, r.width + pad * 2), h = Math.min(H - 8, r.height + pad * 2);
    Object.assign(hole.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    // four click-blockers around the hole: the highlighted control stays usable, the rest of the page doesn't
    const B = [[0, 0, W, y], [0, y + h, W, Math.max(0, H - y - h)], [0, y, x, h], [x + w, y, Math.max(0, W - x - w), h]];
    blockers.forEach((b, k) => Object.assign(b.style, { left: B[k][0] + 'px', top: B[k][1] + 'px', width: B[k][2] + 'px', height: B[k][3] + 'px' }));
    // card: right of the target, else left, else below, else above; docked to the bottom on narrow screens
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14; let cx, cy;
    if (W < 600) { cx = (W - cw) / 2; cy = (y + h + gap + ch < H - 8) ? y + h + gap : Math.max(8, y - gap - ch); if (cy < 8 || cy + ch > H - 8) cy = H - ch - 12; }
    else if (x + w + gap + cw < W - 8) { cx = x + w + gap; cy = y + Math.min(h, 120) / 2 - 20; }
    else if (x - gap - cw > 8) { cx = x - gap - cw; cy = y; }
    else if (y + h + gap + ch < H - 8) { cx = x + w / 2 - cw / 2; cy = y + h + gap; }
    else { cx = x + w / 2 - cw / 2; cy = y - gap - ch; }
    cx = Math.min(Math.max(8, cx), W - cw - 8); cy = Math.min(Math.max(8, cy), H - ch - 8);
    card.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
  }
  function end() {
    off.forEach(f => f()); off = []; clearTimeout(finTimer);
    try { localStorage.setItem(KEY, 'done'); } catch (e) { }
    if (!root) return;
    const r = root; root = null; i = -1; blockers = [];
    document.removeEventListener('keydown', onKey, true); removeEventListener('resize', schedule); removeEventListener('scroll', schedule, true);
    r.classList.remove('on'); setTimeout(() => r.remove(), REDUCED.matches ? 0 : 260);
  }
  function start() { if (root) end(); build(); go(0); }

  function init() {
    const btn = $('#tourBtn'); if (btn) btn.addEventListener('click', start);
    let seen = null; try { seen = localStorage.getItem(KEY); } catch (e) { }
    const force = /[?&]tour=1\b/.test(location.search);
    if (force || (!seen && !navigator.webdriver)) setTimeout(start, 600);   // automated test browsers skip the auto tour unless ?tour=1
  }
  window.NEONDJ = window.NEONDJ || {}; window.NEONDJ.tour = { start, end, get step() { return i; } };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
