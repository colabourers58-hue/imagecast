const $ = (id) => document.getElementById(id);
const ch = new BroadcastChannel('imagecast');

// ---------- keys ----------
const KEY_STORE = 'imagecast.keys';
let keys = {};
try { keys = JSON.parse(localStorage.getItem(KEY_STORE)) || {}; } catch {}
const keyFor = (k) => (keys[k] && keys[k].trim()) || DEFAULT_KEYS[k] || '';
const hasKeys = (s) => s.needs.every(keyFor);
const liveKeys = () => Object.fromEntries(SOURCES.flatMap(s => s.needs).map(k => [k, keyFor(k)]));

// ---------- state ----------
let query = '';
let token = 0;
let loading = false;
let filter = 'all';
let all = [];                 // every result, interleaved by batch
const seen = new Set();
const per = {};               // per-source { page, more, count, error }
let rendered = 0;             // tiles rendered for the current view
let view = [];                // current filtered list
let sel = -1;                 // selected index in view
let current = null;           // item on screen
let fit = 'fit';
let black = false;
let lastPing = 0, displayFull = false, displayWin = null;

// ---------- chips ----------
function renderChips() {
  const c = $('chips');
  c.innerHTML = '';
  const chip = (id, label, n, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip ${filter === id ? 'active' : ''} ${cls}`;
    b.innerHTML = `<span></span>${n !== '' ? `<span class="n">${n}</span>` : ''}`;
    b.firstChild.textContent = label;
    b.onclick = () => {
      if (cls.includes('off')) { openKeys(); return; }
      filter = id; renderChips(); rebuildGrid();
    };
    c.appendChild(b);
    return b;
  };
  chip('all', 'All', query ? all.length : '');
  for (const s of SOURCES) {
    const p = per[s.id];
    if (!hasKeys(s)) { chip(s.id, s.name, 'add key', 'off'); continue; }
    if (p?.error) { chip(s.id, s.name, '!', 'err').title = `${s.name}: ${p.error}`; continue; }
    chip(s.id, s.name, query && p ? p.count : '');
  }
  const q = encodeURIComponent(query);
  for (const [name, url] of [
    ['Google Images', `https://www.google.com/search?tbm=isch&q=${q}`],
    ['Bing Images', `https://www.bing.com/images/search?q=${q}`],
    ['DuckDuckGo', `https://duckduckgo.com/?ia=images&iax=images&q=${q}`],
  ]) {
    const g = document.createElement('a');
    g.className = 'chip';
    g.target = '_blank'; g.rel = 'noopener';
    g.href = url;
    g.textContent = `${name} ↗`;
    g.title = `Opens ${name}. Drag any picture back into this window to show it.`;
    c.appendChild(g);
  }
}

// ---------- search ----------
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

async function fetchBatch(first) {
  if (loading) return;
  const my = token;
  const active = SOURCES.filter(s => hasKeys(s) && (first || per[s.id]?.more));
  if (!active.length) { $('more').hidden = true; return; }
  loading = true;
  showSkeleton(true);
  // Sources that answer within the first moment are interleaved together;
  // slower ones are added as they arrive so one slow site never holds up the rest.
  let pending = [], flushed = false, left = active.length;
  const flush = () => {
    if (my !== token || !pending.length) return;
    all.push(...interleave(pending));
    pending = [];
    showSkeleton(false);
    renderChips();
    appendTiles();
    if (left) showSkeleton(true);
  };
  const windowTimer = setTimeout(() => { flushed = true; flush(); }, 1500);
  await Promise.all(active.map(async (s) => {
    const p = per[s.id] || (per[s.id] = { page: 0, more: false, count: 0, error: null });
    const page = first ? 1 : p.page + 1;
    try {
      const r = await withTimeout(s.search(query, page, liveKeys()), 15000);
      if (my !== token) return;
      p.page = page; p.more = r.more; p.error = null;
      const items = r.items.filter(it => it.thumb && it.full && !seen.has(it.full));
      items.forEach(it => { it.source = s.id; it.sourceName = s.name; seen.add(it.full); });
      p.count += items.length;
      pending.push(items);
    } catch (e) {
      if (my !== token) return;
      p.more = false;
      p.error = niceError(e);
    }
    left--;
    if (flushed) flush(); else renderChips();
  }));
  clearTimeout(windowTimer);
  if (my !== token) return;
  flush();
  loading = false;
  showSkeleton(false);
  renderChips();
  $('more').hidden = !SOURCES.some(s => per[s.id]?.more);
  if (first && !all.length) toast('No results. Try other words, or add keys for more sources.');
}

function niceError(e) {
  const m = String(e?.message || e);
  if (/400|401|403/.test(m)) return 'key was refused';
  if (/429/.test(m)) return 'too many searches, wait a minute';
  return m;
}

function search(q) {
  q = q.trim();
  if (!q) return;
  if (/^(https?:\/\/|data:image\/)/i.test(q)) { castUrl(q); $('q').value = ''; return; }
  query = q;
  token++;
  loading = false;
  all = []; seen.clear(); rendered = 0; view = []; sel = -1;
  for (const k in per) delete per[k];
  filter = 'all';
  $('empty').hidden = true;
  $('grid').innerHTML = '';
  renderChips();
  fetchBatch(true);
  try { history.replaceState(null, '', `#q=${encodeURIComponent(q)}`); } catch {}
}

// ---------- grid ----------
function filtered() { return filter === 'all' ? all : all.filter(i => i.source === filter); }

function rebuildGrid() {
  $('grid').innerHTML = '';
  rendered = 0;
  appendTiles();
}

function appendTiles() {
  view = filtered();
  const g = $('grid');
  const frag = document.createDocumentFragment();
  for (let i = rendered; i < view.length; i++) {
    const it = view[i];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile' + (current === it ? ' sel' : '');
    b.dataset.i = i;
    b.title = it.title;
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = it.title; img.src = it.thumb;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { if (img.src !== it.fallback && it.fallback) img.src = it.fallback; else b.remove(); };
    const tag = document.createElement('span');
    tag.className = 'src'; tag.textContent = it.sourceName;
    b.append(img, tag);
    b.onclick = () => select(Number(b.dataset.i));
    frag.appendChild(b);
  }
  g.appendChild(frag);
  rendered = view.length;
}

function showSkeleton(on) {
  document.querySelectorAll('.tile.skel').forEach(t => t.remove());
  if (!on) return;
  const g = $('grid');
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('div');
    s.className = 'tile skel';
    g.appendChild(s);
  }
}

function select(i) {
  if (!view.length) return;
  sel = (i + view.length) % view.length;
  cast(view[sel]);
  const t = $('grid').querySelector(`.tile[data-i="${sel}"]`);
  if (t) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- casting ----------
let previewUrl = null;
function cast(it) {
  current = it;
  document.querySelectorAll('.tile.sel').forEach(t => t.classList.remove('sel'));
  const idx = view.indexOf(it);
  if (idx >= 0) { sel = idx; $('grid').querySelector(`.tile[data-i="${idx}"]`)?.classList.add('sel'); }
  send();
  const img = $('previewImg');
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  img.onerror = () => { if (it.fallback && img.src !== it.fallback) img.src = it.fallback; };
  img.src = it.blob ? (previewUrl = URL.createObjectURL(it.blob)) : it.full;
  $('previewEmpty').hidden = true;
  const cap = $('caption');
  cap.textContent = '';
  const t = document.createElement(it.link ? 'a' : 'span');
  if (it.link) { t.href = it.link; t.target = '_blank'; t.rel = 'noopener'; }
  t.textContent = [it.title, it.credit].filter(Boolean).join(' · ');
  cap.title = t.textContent;
  cap.appendChild(t);
  if (black) setBlack(false);
}

function send() {
  if (!current) return;
  ch.postMessage(current.blob
    ? { type: 'show', blob: current.blob }
    : { type: 'show', src: current.full, fallback: current.fallback });
}

function castUrl(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    if (p.get('imgurl')) url = p.get('imgurl');           // Google
    else if (p.get('mediaurl')) url = p.get('mediaurl');  // Bing
    else if (u.hostname.includes('duckduckgo.') && p.get('u')) url = p.get('u'); // DuckDuckGo proxy
  } catch {}
  cast({ full: url, fallback: null, title: 'Dropped image', credit: url.startsWith('data:') ? '' : new URL(url).hostname, link: url.startsWith('data:') ? null : url });
}

function castBlob(blob, name) {
  cast({ blob, full: 'blob', title: name || 'Pasted image', credit: '' });
}

function setFit(v) {
  fit = v;
  $('fitBtn').textContent = fit === 'fit' ? 'Fit' : 'Fill';
  $('fitBtn').classList.toggle('on', fit === 'fill');
  $('preview').classList.toggle('fill', fit === 'fill');
  ch.postMessage({ type: 'fit', fit });
}
function setBlack(v) {
  black = v;
  $('blackBtn').classList.toggle('on', black);
  $('preview').classList.toggle('black', black);
  ch.postMessage({ type: 'black', on: black });
}

// ---------- display window ----------
async function openDisplay() {
  if (displayWin && !displayWin.closed) { displayWin.focus(); toast('Display window is already open.'); return; }
  let features = 'popup,width=1280,height=720';
  let external = false;
  if ('getScreenDetails' in window) {
    try {
      const sd = await getScreenDetails();
      const ext = sd.screens.find(s => s !== sd.currentScreen) || null;
      if (ext) {
        external = true;
        features = `popup,left=${ext.availLeft},top=${ext.availTop},width=${ext.availWidth},height=${ext.availHeight}`;
      }
    } catch {}
  }
  displayWin = window.open('display.html', 'imagecast-display', features);
  if (!displayWin) { toast('The window was blocked. Click Open display again, or allow pop-ups for this site.'); return; }
  toast(external
    ? 'Display opened on your other screen. Click it once to go fullscreen.'
    : 'Display opened. Drag it onto the HDMI screen, then click it to go fullscreen.');
}

function updateStatus() {
  const live = Date.now() - lastPing < 4000;
  $('dot').classList.toggle('live', live);
  $('displayLabel').textContent = live ? (displayFull ? 'Display live' : 'Display open') : 'Open display';
  $('displayHelp').innerHTML = live
    ? (displayFull ? 'The display is fullscreen and showing what you pick.' : 'Display is open. Click it once on the HDMI screen to make it fullscreen.')
    : 'No display open. Click <b>Open display</b>, or drag that window onto the HDMI screen yourself.';
}
setInterval(updateStatus, 1000);

ch.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'ping' || m.type === 'hello') { lastPing = Date.now(); displayFull = !!m.full; updateStatus(); }
  if (m.type === 'hello') { ch.postMessage({ type: 'fit', fit }); ch.postMessage({ type: 'black', on: black }); send(); }
  if (m.type === 'bye') { lastPing = 0; updateStatus(); }
  if (m.type === 'error') toast('That image would not load. Try another.');
  if (m.type === 'key') handleKey(m.key);
};

// ---------- keys dialog ----------
function openKeys() {
  const f = $('keys').querySelector('form');
  for (const el of f.elements) if (el.name) el.value = keys[el.name] || '';
  $('keys').showModal();
}
$('keys').addEventListener('close', () => {
  if ($('keys').returnValue !== 'save') return;
  const f = $('keys').querySelector('form');
  for (const el of f.elements) if (el.name) keys[el.name] = el.value.trim();
  try { localStorage.setItem(KEY_STORE, JSON.stringify(keys)); } catch {}
  renderChips();
  if (query) search(query);
  toast('Sources saved.');
});

// ---------- keyboard ----------
function handleKey(k) {
  if (k === 'ArrowRight' || k === 'ArrowDown') select(sel + 1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp') select(sel < 0 ? view.length - 1 : sel - 1);
  else if (k === 'b' || k === 'B' || k === '.') setBlack(!black);
  else return false;
  return true;
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target instanceof Element ? e.target : document.body;
  if (t.closest('dialog') || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
  if (handleKey(e.key)) e.preventDefault();
});

// ---------- paste & drop ----------
document.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); castBlob(file); return; }
  if (e.target.tagName === 'INPUT') return;
  const text = e.clipboardData?.getData('text') || '';
  if (/^(https?:\/\/|data:image\/)/i.test(text.trim())) { e.preventDefault(); castUrl(text.trim()); }
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; $('drop').hidden = true;
  const dt = e.dataTransfer;
  const file = [...(dt.files || [])].find(f => f.type.startsWith('image/'));
  if (file) { castBlob(file, file.name); return; }
  const html = dt.getData('text/html');
  const m = html && html.match(/<img[^>]+src="([^"]+)"/i);
  const url = (m && m[1].replace(/&amp;/g, '&')) || dt.getData('text/uri-list').split('\n').find(l => l && !l.startsWith('#')) || dt.getData('text');
  if (url && /^(https?:\/\/|data:image\/)/i.test(url.trim())) castUrl(url.trim());
  else toast('Could not read that. Try copying the image and pasting it here.');
});

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

// ---------- wire up ----------
$('search').addEventListener('submit', (e) => { e.preventDefault(); search($('q').value); $('q').blur(); });
$('moreBtn').onclick = () => fetchBatch(false);
$('openDisplay').onclick = openDisplay;
$('keysBtn').onclick = openKeys;
$('prev').onclick = () => select(sel < 0 ? view.length - 1 : sel - 1);
$('next').onclick = () => select(sel + 1);
$('fitBtn').onclick = () => setFit(fit === 'fit' ? 'fill' : 'fit');
$('blackBtn').onclick = () => setBlack(!black);
$('hereBtn').onclick = () => $('preview').requestFullscreen?.().catch(() => toast('This browser would not go fullscreen.'));

new IntersectionObserver((entries) => {
  if (entries.some(en => en.isIntersecting) && !$('more').hidden && !loading) fetchBatch(false);
}, { rootMargin: '600px' }).observe($('more'));

renderChips();
updateStatus();
const startQ = new URLSearchParams(location.hash.slice(1)).get('q');
if (startQ) { $('q').value = startQ; search(startQ); }
