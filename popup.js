const { paint, FIRE, ICE } = globalThis.TabfireFire;
const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);

const STOPS = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1080, 1440, 2880, 4320, 10080]; // minutes
const IGNITE = 0.03;

let data = null;
let currentTabId = null;
let paused = false;
let burning = 0; // rows mid burn-away animation; the list holds still until they finish
const icons = new Map(); // url -> Image of its favicon

// ---------- helpers ----------

function fmtLeft(ms) {
  if (ms <= 0) return 'any second';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm && h < 10 ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function fmtFuse(min) {
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  if (min === 10080) return '1 week';
  return `${min / 1440} day${min === 1440 ? '' : 's'}`;
}

function fmtAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function favicon(url) {
  if (!icons.has(url)) {
    const img = new Image();
    img.src = `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
    icons.set(url, img);
  }
  return icons.get(url);
}

const clock = () => data.pausedAt || Date.now();
const lifetimeMs = () => data.settings.lifetimeMinutes * 60000;
const progressOf = (t) => Math.min(1, Math.max(0, (clock() - t.born) / lifetimeMs()));

// ---------- burning list ----------

const rows = new Map(); // tab id -> { el, canvas, img }

function buildRow(t) {
  const el = $('#tab-row').content.firstElementChild.cloneNode(true);
  el.querySelector('.title').textContent = t.title || t.url;
  el.querySelector('.title').title = t.url;
  el.querySelector('.title').addEventListener('click', async () => {
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    window.close();
  });
  el.querySelector('.douse').addEventListener('click', async () => {
    await send({ type: 'douse', tabId: t.id });
    refresh();
  });
  el.querySelector('.burn').addEventListener('click', async () => {
    el.classList.add('burning');
    burning++;
    await new Promise((r) => setTimeout(r, 480));
    await send({ type: 'burnNow', tabId: t.id });
    burning--;
    refresh();
  });
  const canvas = el.querySelector('.ficon');
  const ctx = canvas.getContext('2d');
  return { el, canvas, ctx, fire: ctx.createImageData(32, 32), off: Object.assign(document.createElement('canvas'), { width: 32, height: 32 }) };
}

function renderTabs() {
  const list = $('#tab-list');
  const s = data.settings;
  const burnable = data.tabs.filter((t) => !t.fireproof);
  const ordered = [...data.tabs].sort((a, b) => (a.fireproof - b.fireproof) || (a.born - b.born));

  if (!data.tabs.length) {
    list.innerHTML = '<li class="empty"><b>Nothing to burn</b>Every tab is accounted for.</li>';
    return;
  }

  const keep = new Set();
  const frag = document.createDocumentFragment();
  for (const t of ordered) {
    let row = rows.get(t.id);
    if (!row) rows.set(t.id, (row = buildRow(t)));
    row.tab = t;
    keep.add(t.id);
    const p = progressOf(t);
    const left = t.born + lifetimeMs() - clock();
    row.el.classList.toggle('current', t.id === currentTabId);
    row.el.classList.toggle('safe', t.fireproof);
    row.el.classList.toggle('hot', !t.fireproof && p > 0.5);
    row.el.classList.toggle('critical', !t.fireproof && left < s.warnMinutes * 60000);
    row.el.querySelector('.title').textContent = t.title || t.url;
    row.el.querySelector('.douse').hidden = t.fireproof;
    row.el.querySelector('.left').textContent = t.fireproof
      ? (t.pinned && s.pinnedFireproof ? 'pinned' : 'fireproof')
      : left <= 0 && t.audible && s.spareAudible ? 'smoldering' : fmtLeft(left);
    row.el.querySelector('.bar i').style.transform = `scaleX(${t.fireproof ? 1 : p.toFixed(4)})`;
    frag.appendChild(row.el);
  }
  for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id);
  list.replaceChildren(frag);

  const soon = burnable.filter((t) => t.born + lifetimeMs() - clock() < 60 * 60000).length;
  $('#summary').innerHTML = paused
    ? 'Holding fire. Every fuse is frozen.'
    : burnable.length
      ? `<b>${burnable.length}</b> tab${burnable.length === 1 ? '' : 's'} burning${soon ? ` · <b>${soon}</b> within the hour` : ''}`
      : 'All quiet. Nothing is burning.';
}

function drawIcons(time) {
  for (const row of rows.values()) {
    const t = row.tab;
    const p = progressOf(t);
    const { ctx, canvas } = row;
    ctx.clearRect(0, 0, 32, 32);
    const img = favicon(t.url);
    ctx.save();
    if (!t.fireproof) ctx.filter = `grayscale(${p * 0.85}) brightness(${1 - p * 0.5})`;
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, 32, 32);
    ctx.restore();
    if (t.fireproof || p < IGNITE) continue;
    paint(row.fire, p, time + t.id * 0.37, paused ? ICE : FIRE);
    row.off.getContext('2d').putImageData(row.fire, 0, 0);
    ctx.drawImage(row.off, 0, 0);
  }
}

// ---------- ashes ----------

function renderAshes() {
  const list = $('#ash-list');
  const ashes = data.ashes;
  $('#ash-count').textContent = ashes.length || '';
  $('#clear-ashes').hidden = !ashes.length;
  if (!ashes.length) {
    list.innerHTML = '<li class="empty"><b>No ashes yet</b>Tabs that burn away land here, so you can bring them back.</li>';
    return;
  }
  list.replaceChildren(...ashes.map((a) => {
    const li = document.createElement('li');
    li.className = 'item ash';
    li.innerHTML = `<canvas class="ficon" width="32" height="32" aria-hidden="true"></canvas>
      <button class="title" type="button"></button><span class="left"></span>
      <div class="acts"><button class="icon-btn" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>Rekindle</button></div>`;
    li.querySelector('.title').textContent = a.title;
    li.querySelector('.title').title = a.url;
    li.querySelector('.left').textContent = fmtAgo(a.burnedAt);
    const ctx = li.querySelector('canvas').getContext('2d');
    const img = favicon(a.url);
    const draw = () => img.naturalWidth && ctx.drawImage(img, 0, 0, 32, 32);
    img.complete ? draw() : img.addEventListener('load', draw, { once: true });
    const rekindle = async () => {
      await send({ type: 'rekindle', url: a.url });
      li.classList.add('leaving');
      setTimeout(refresh, 220);
    };
    li.querySelector('.title').addEventListener('click', rekindle);
    li.querySelector('.icon-btn').addEventListener('click', rekindle);
    return li;
  }));
}

// ---------- settings ----------

function nearestStop(min) {
  let best = 0;
  STOPS.forEach((v, i) => { if (Math.abs(v - min) < Math.abs(STOPS[best] - min)) best = i; });
  return best;
}

function paintSlider(i) {
  const r = $('#lifetime');
  r.style.setProperty('--fill', `${(i / (STOPS.length - 1)) * 100}%`);
  $('#lifetime-out').textContent = fmtFuse(STOPS[i]);
}

function renderSettings() {
  const s = data.settings;
  const i = nearestStop(s.lifetimeMinutes);
  if (document.activeElement !== $('#lifetime')) {
    $('#lifetime').value = i;
    paintSlider(i);
  }
  document.querySelectorAll('input[name="effects"]').forEach((r) => { r.checked = r.value === s.effects; });
  $('#warn').value = String(s.warnMinutes);
  document.querySelectorAll('.switch').forEach((c) => { c.checked = !!s[c.dataset.key]; });
  const pills = $('#fp-list');
  pills.replaceChildren(...s.fireproof.map((d) => {
    const li = document.createElement('li');
    li.textContent = d;
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Remove ${d}`);
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    b.addEventListener('click', () => save({ fireproof: s.fireproof.filter((x) => x !== d) }));
    li.appendChild(b);
    return li;
  }));
}

async function save(patch) {
  await send({ type: 'settings', patch });
  refresh();
}

$('#lifetime').max = STOPS.length - 1;
$('#lifetime').addEventListener('input', (e) => paintSlider(+e.target.value));
$('#lifetime').addEventListener('change', (e) => save({ lifetimeMinutes: STOPS[+e.target.value] }));
document.querySelectorAll('input[name="effects"]').forEach((r) =>
  r.addEventListener('change', () => save({ effects: r.value })));
$('#warn').addEventListener('change', (e) => save({ warnMinutes: +e.target.value }));
document.querySelectorAll('.switch').forEach((c) =>
  c.addEventListener('change', () => save({ [c.dataset.key]: c.checked })));
$('#fp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  let v = $('#fp-input').value.trim().toLowerCase();
  try { if (v.includes('/')) v = new URL(v.includes('://') ? v : `https://${v}`).hostname; } catch {}
  v = v.replace(/^www\./, '');
  if (!v || data.settings.fireproof.includes(v)) return;
  $('#fp-input').value = '';
  save({ fireproof: [...data.settings.fireproof, v] });
});

// ---------- chrome ----------

$('#douse-all').addEventListener('click', async () => {
  await send({ type: 'douseAll' });
  refresh();
});
$('#clear-ashes').addEventListener('click', async () => {
  await send({ type: 'clearAshes' });
  refresh();
});
$('#pause').addEventListener('click', async () => {
  await send({ type: 'pause', paused: !paused });
  refresh();
});

function moveIndicator(tab, instant) {
  const ind = $('.tab-ind');
  if (instant) ind.style.transition = 'none';
  ind.style.width = `${tab.offsetWidth - 20}px`;
  ind.style.transform = `translateX(${tab.offsetLeft + 10}px)`;
  if (instant) requestAnimationFrame(() => { ind.style.transition = ''; });
}

document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
    });
    moveIndicator(tab);
  });
});

async function refresh() {
  data = await send({ type: 'overview' });
  if (!data) return;
  paused = !!data.pausedAt;
  $('#pause').setAttribute('aria-pressed', String(paused));
  $('#pause span').textContent = paused ? 'Resume' : 'Hold fire';
  $('.hero').classList.toggle('frozen', paused);
  document.body.classList.toggle('frozen-ui', paused);
  if (!burning) renderTabs();
  renderAshes();
  renderSettings();
  moveIndicator($('[role="tab"][aria-selected="true"]'), !moveIndicator.ready);
  moveIndicator.ready = true;
}

// Header flames and the little burning icons.
const hero = $('#hero-fire');
const heroCtx = hero.getContext('2d');
const heroImg = heroCtx.createImageData(hero.width, hero.height);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let last = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  if (ts - last < 70 || !data) return;
  last = ts;
  const t = reduceMotion ? 0 : ts / 1000;
  paint(heroImg, 0.38, t, paused ? ICE : FIRE);
  heroCtx.putImageData(heroImg, 0, 0);
  drawIcons(t);
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { currentTabId = t?.id; });
refresh().then(() => requestAnimationFrame(loop));
setInterval(refresh, 5000);
let pending = 0;
chrome.storage.onChanged.addListener(() => {
  clearTimeout(pending);
  pending = setTimeout(refresh, 120);
});
