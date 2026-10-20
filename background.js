// Tabfire background: remembers when each tab caught fire and burns the ones left open too long.

const DEFAULTS = {
  lifetimeMinutes: 12 * 60,
  warnMinutes: 15,
  effects: 'subtle', // off | subtle | dramatic
  flameTitles: false,
  resetOnVisit: false,
  pinnedFireproof: true,
  spareAudible: true,
  spareActive: true,
  clockRunsWhileClosed: false,
  fireproof: [], // hostnames that never ignite
};
const ASHES_MAX = 60;
const TICK = 'tabfire-tick';

// Every read-modify-write of storage goes through this queue so events can't clobber each other.
// The first thing in it each browser session is matching restored tabs back to their fuses.
let queue = Promise.resolve().then(() => chrome.storage.session.get('reconciled')).then(async (d) => {
  if (d.reconciled) return;
  await reconcile();
  await chrome.storage.session.set({ reconciled: true });
}).catch((e) => console.error('[tabfire]', e));
function locked(fn) {
  const run = queue.then(() => fn());
  queue = run.catch((e) => console.error('[tabfire]', e));
  return run;
}

async function load() {
  const d = await chrome.storage.local.get(['settings', 'tabs', 'ashes', 'pausedAt', 'lastAlive']);
  return {
    settings: { ...DEFAULTS, ...d.settings },
    tabs: d.tabs || {},
    ashes: d.ashes || [],
    pausedAt: d.pausedAt || null,
    lastAlive: d.lastAlive || null,
  };
}

const clock = (pausedAt) => pausedAt || Date.now();
const urlOf = (tab) => tab.url || tab.pendingUrl || '';
const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

function isFireproof(tab, s) {
  if (s.pinnedFireproof && tab.pinned) return true;
  const host = hostOf(urlOf(tab));
  return !!host && s.fireproof.some((d) => host === d || host.endsWith('.' + d));
}

function stateFor(tab, rec, s, pausedAt) {
  return {
    lit: !isFireproof(tab, s),
    born: rec.born,
    lifetimeMs: s.lifetimeMinutes * 60000,
    warnMs: s.warnMinutes * 60000,
    pausedAt,
    effects: s.effects,
    flameTitles: s.flameTitles,
    spareActive: s.spareActive,
  };
}

async function push(tab, rec, s, pausedAt) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'state', state: stateFor(tab, rec, s, pausedAt) });
  } catch {} // no content script there (chrome:// pages, new tab, still loading)
}

async function pushAll() {
  const { settings, tabs, pausedAt } = await load();
  for (const tab of await chrome.tabs.query({})) {
    if (tabs[tab.id]) push(tab, tabs[tab.id], settings, pausedAt);
  }
}

async function sendState(tabId) {
  const { settings, tabs, pausedAt } = await load();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tabs[tabId]) push(tab, tabs[tabId], settings, pausedAt);
}

// Tab ids change across browser restarts, so restored tabs are matched back to their records by URL.
async function reconcile() {
  const { settings, tabs: old, lastAlive, pausedAt } = await load();
  const now = clock(pausedAt);
  const gap = lastAlive ? Date.now() - lastAlive : 0;
  // Ticks stamp lastAlive every 30s, so a long gap means the browser was closed.
  const shift = !settings.clockRunsWhileClosed && !pausedAt && gap > 2 * 60000 ? gap : 0;
  const all = await chrome.tabs.query({});
  const byUrl = new Map();
  const claimed = new Set(all.filter((t) => old[t.id]?.url === urlOf(t)).map((t) => String(t.id)));
  for (const [id, r] of Object.entries(old)) {
    if (claimed.has(id)) continue;
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    byUrl.get(r.url).push(r.born);
  }
  for (const list of byUrl.values()) list.sort((a, b) => a - b);
  const tabs = {};
  for (const tab of all) {
    const url = urlOf(tab);
    const prev = claimed.has(String(tab.id)) ? old[tab.id].born : byUrl.get(url)?.shift();
    tabs[tab.id] = { born: prev == null ? now : Math.min(prev + shift, now), url };
  }
  await chrome.storage.local.set({ tabs, lastAlive: Date.now() });
}

function addAsh(ashes, tab) {
  const url = urlOf(tab);
  if (!url || url.startsWith('chrome://newtab')) return ashes;
  return [{ url, title: tab.title || url, burnedAt: Date.now() }, ...ashes.filter((a) => a.url !== url)]
    .slice(0, ASHES_MAX);
}

function setBadge(warm, paused) {
  if (paused) {
    chrome.action.setBadgeBackgroundColor({ color: '#3d6f96' });
    chrome.action.setBadgeText({ text: '❄' });
    chrome.action.setTitle({ title: 'Tabfire: holding fire' });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: '#e8481c' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  chrome.action.setBadgeText({ text: warm ? String(warm) : '' });
  chrome.action.setTitle({ title: warm ? `Tabfire: ${warm} tab${warm === 1 ? '' : 's'} about to burn` : 'Tabfire' });
}

function tick() {
  return locked(async () => {
    const { settings: s, tabs, ashes: oldAshes, pausedAt } = await load();
    const all = await chrome.tabs.query({});
    const lifetime = s.lifetimeMinutes * 60000;
    const live = {};
    const burn = [];
    let warm = 0;
    for (const tab of all) {
      const rec = tabs[tab.id] || { born: clock(pausedAt), url: urlOf(tab) };
      live[tab.id] = rec;
      if (isFireproof(tab, s)) continue;
      const left = rec.born + lifetime - clock(pausedAt);
      if (left > Math.max(s.warnMinutes * 60000, 0) && left > 0) continue;
      warm++;
      if (left > 0 || pausedAt) continue;
      if (s.spareAudible && tab.audible) continue; // smoldering until the audio stops
      if (s.spareActive && tab.active) continue; // burns the moment you look away
      burn.push(tab);
    }

    let ashes = oldAshes;
    if (burn.length) {
      // Don't let the fire take the very last window with it.
      const ids = new Set(burn.map((t) => t.id));
      if (!all.some((t) => !ids.has(t.id))) {
        const fresh = await chrome.tabs.create({ windowId: burn[0].windowId, active: true });
        live[fresh.id] = { born: clock(pausedAt), url: '' };
      }
      for (const tab of burn) {
        ashes = addAsh(ashes, tab);
        delete live[tab.id];
      }
    }
    await chrome.storage.local.set({ tabs: live, ashes, lastAlive: Date.now() });
    if (burn.length) await chrome.tabs.remove(burn.map((t) => t.id)).catch(() => {});
    setBadge(warm - burn.length, !!pausedAt);
  });
}

async function douse(tabId) {
  await locked(async () => {
    const { tabs, pausedAt } = await load();
    for (const id of tabId == null ? Object.keys(tabs) : [tabId]) {
      if (tabs[id]) tabs[id].born = clock(pausedAt);
    }
    await chrome.storage.local.set({ tabs });
  });
  if (tabId == null) await pushAll();
  else await sendState(tabId);
  tick();
  return true;
}

async function burnNow(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  await locked(async () => {
    const { tabs, ashes } = await load();
    delete tabs[tabId];
    await chrome.storage.local.set({ tabs, ashes: addAsh(ashes, tab) });
  });
  await chrome.tabs.remove(tabId).catch(() => {});
  tick();
  return true;
}

async function saveSettings(patch) {
  await locked(async () => {
    const { settings, tabs, pausedAt } = await load();
    const next = { ...settings, ...patch };
    // Shortening the fuse keeps each tab's progress, so it never torches everything at once.
    // Lengthening it keeps ignition times, so tabs simply get more time.
    if (next.lifetimeMinutes < settings.lifetimeMinutes) {
      const now = clock(pausedAt);
      const oldL = settings.lifetimeMinutes * 60000;
      const newL = next.lifetimeMinutes * 60000;
      for (const rec of Object.values(tabs)) {
        const p = Math.min(1, Math.max(0, (now - rec.born) / oldL));
        rec.born = now - p * newL;
      }
    }
    await chrome.storage.local.set({ settings: next, tabs });
  });
  await pushAll();
  tick();
  return true;
}

async function setPaused(paused) {
  await locked(async () => {
    const { tabs, pausedAt } = await load();
    if (paused && !pausedAt) {
      await chrome.storage.local.set({ pausedAt: Date.now() });
    } else if (!paused && pausedAt) {
      const frozenFor = Date.now() - pausedAt;
      for (const rec of Object.values(tabs)) rec.born += frozenFor;
      await chrome.storage.local.set({ tabs, pausedAt: null });
    }
  });
  await pushAll();
  tick();
  return true;
}

async function rekindle(url) {
  let found = false;
  await locked(async () => {
    const { ashes } = await load();
    found = ashes.some((a) => a.url === url);
    await chrome.storage.local.set({ ashes: ashes.filter((a) => a.url !== url) });
  });
  if (found) await chrome.tabs.create({ url, active: false });
  return found;
}

async function overview() {
  const { settings, tabs, ashes, pausedAt } = await load();
  const all = await chrome.tabs.query({});
  return {
    settings,
    pausedAt,
    ashes,
    tabs: all.map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || urlOf(tab),
      url: urlOf(tab),
      active: tab.active,
      audible: !!tab.audible,
      pinned: tab.pinned,
      born: tabs[tab.id]?.born ?? clock(pausedAt),
      fireproof: isFireproof(tab, settings),
    })),
  };
}

// The page's own favicon is fetched here (host permissions skip CORS) and handed back as a data URL.
const iconCache = new Map();
function toDataUrl(buf, type) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}
function guessType(href) {
  if (/\.svg(\?|$)/i.test(href)) return 'image/svg+xml';
  if (/\.png(\?|$)/i.test(href)) return 'image/png';
  return 'image/x-icon';
}
async function fetchIcon(hrefs = [], pageUrl) {
  const candidates = [...hrefs];
  try { candidates.push(new URL('/favicon.ico', pageUrl).href); } catch {}
  for (const href of candidates) {
    if (href.startsWith('data:image/')) return href;
    if (!/^https?:/.test(href)) continue;
    if (iconCache.has(href)) return iconCache.get(href);
    try {
      const res = await fetch(href, { credentials: 'omit', signal: AbortSignal.timeout(4000) });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || (type && !type.startsWith('image/') && type !== 'application/octet-stream')) continue;
      const buf = await res.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 300_000) continue;
      const url = toDataUrl(buf, type.startsWith('image/') ? type : guessType(href));
      iconCache.set(href, url);
      return url;
    } catch {}
  }
  return null;
}

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'hello': {
      const tab = sender.tab;
      if (!tab) return null;
      return locked(async () => {
        const { settings, tabs, pausedAt } = await load();
        if (!tabs[tab.id]) {
          tabs[tab.id] = { born: clock(pausedAt), url: urlOf(tab) };
          await chrome.storage.local.set({ tabs });
        }
        return stateFor(tab, tabs[tab.id], settings, pausedAt);
      });
    }
    case 'icon': return fetchIcon(msg.hrefs, sender.tab?.url);
    case 'douse': return douse(msg.tabId ?? sender.tab?.id);
    case 'douseAll': return douse(null);
    case 'burnNow': return burnNow(msg.tabId);
    case 'overview': return overview();
    case 'settings': return saveSettings(msg.patch);
    case 'pause': return setPaused(msg.paused);
    case 'rekindle': return rekindle(msg.url);
    case 'clearAshes':
      await locked(() => chrome.storage.local.set({ ashes: [] }));
      return true;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => {
    console.error('[tabfire]', e);
    reply(null);
  });
  return true;
});

async function ensureAlarm() {
  if (!(await chrome.alarms.get(TICK))) chrome.alarms.create(TICK, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  await ensureAlarm();
  // Light up tabs that were already open before install.
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fire.js', 'content.js'] }).catch(() => {});
  }
  tick();
});

chrome.runtime.onStartup.addListener(() => tick());
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'douse') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) douse(tab.id);
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === TICK) tick(); });
ensureAlarm();

chrome.tabs.onCreated.addListener((tab) => locked(async () => {
  const { tabs, pausedAt } = await load();
  if (tabs[tab.id]) return;
  tabs[tab.id] = { born: clock(pausedAt), url: urlOf(tab) };
  await chrome.storage.local.set({ tabs });
}));

chrome.tabs.onRemoved.addListener((tabId) => locked(async () => {
  const { tabs } = await load();
  if (!tabs[tabId]) return;
  delete tabs[tabId];
  await chrome.storage.local.set({ tabs });
}));

chrome.tabs.onReplaced.addListener((added, removed) => locked(async () => {
  const { tabs } = await load();
  if (!tabs[removed]) return;
  tabs[added] = tabs[removed];
  delete tabs[removed];
  await chrome.storage.local.set({ tabs });
}));

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) {
    locked(async () => {
      const { tabs } = await load();
      if (!tabs[tabId]) return;
      tabs[tabId].url = info.url;
      await chrome.storage.local.set({ tabs });
    }).then(() => sendState(tabId));
  } else if (info.pinned !== undefined) {
    sendState(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  locked(async () => {
    const { settings, tabs, pausedAt } = await load();
    if (!settings.resetOnVisit || !tabs[tabId]) return false;
    tabs[tabId].born = clock(pausedAt);
    await chrome.storage.local.set({ tabs });
    return true;
  }).then((changed) => { if (changed) sendState(tabId); });
});
