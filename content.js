// Tabfire page side: sets the tab's icon on fire and, near the end, warms up the page itself.
(() => {
  if (window.__tabfire) return;
  window.__tabfire = true;

  const { paint, sparks, FIRE, ICE } = globalThis.TabfireFire;
  const S = 32;
  const IGNITE = 0.03; // a tab looks normal for its first few percent
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let state = null;
  let steamUntil = 0;
  let timer = 0;
  let dead = false;
  let lastFrame = '';

  const now = () => state.pausedAt || Date.now();
  const progress = () => Math.min(1, Math.max(0, (now() - state.born) / state.lifetimeMs));
  const timeLeft = () => state.born + state.lifetimeMs - now();
  const clockT = () => (now() % 1e7) / 1000;

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      shutdown(); // the extension was reloaded or removed
      return Promise.resolve(null);
    }
  }

  // ---------- tab icon ----------

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const fireCanvas = document.createElement('canvas');
  fireCanvas.width = fireCanvas.height = S;
  const fctx = fireCanvas.getContext('2d');
  const fireImg = fctx.createImageData(S, S);

  let base = null;
  let baseKey = null;
  let ownLink = null;
  const muted = new Map(); // the page's icon links we switched off -> their original rel

  const iconSelector = 'link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]';

  function pageIconHrefs() {
    const live = [...document.querySelectorAll(iconSelector)].filter((l) => l !== ownLink);
    const all = [...live, ...muted.keys()].filter((l) => l.isConnected && l.href);
    const score = (l) => (/svg/i.test(l.type) || /\.svg/i.test(l.href) ? 3 : 0) +
      (/(^|\s)(32x32|48x48|64x64|any)/.test(l.sizes?.value || '') ? 2 : 0) +
      (/apple-touch/i.test(muted.get(l) ?? l.rel) ? -1 : 0);
    return [...new Set(all.sort((a, b) => score(b) - score(a)).map((l) => l.href))];
  }

  async function refreshBase() {
    const hrefs = pageIconHrefs();
    const key = hrefs.join('|') || location.origin;
    if (key === baseKey) return;
    baseKey = key;
    const data = await send({ type: 'icon', hrefs });
    if (key !== baseKey) return;
    if (!data) {
      base = null;
      return;
    }
    const img = new Image();
    img.onload = () => { if (key === baseKey) base = img; };
    img.onerror = () => { if (key === baseKey) base = null; };
    img.src = data;
  }

  function drawFallback() {
    const host = location.hostname.replace(/^www\./, '');
    ctx.fillStyle = '#2b2420';
    ctx.beginPath();
    ctx.roundRect(1, 1, S - 2, S - 2, 8);
    ctx.fill();
    ctx.fillStyle = '#f4e8dc';
    ctx.font = '600 19px ui-rounded, -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((host[0] || '•').toUpperCase(), S / 2, S / 2 + 1);
  }

  function drawBase(p, charred) {
    ctx.save();
    if (charred) ctx.filter = `grayscale(${p * 0.85}) sepia(${p * 0.35}) brightness(${1 - p * 0.5})`;
    if (base) ctx.drawImage(base, 0, 0, S, S);
    else drawFallback();
    ctx.restore();
  }

  function renderIcon(p, steam) {
    ctx.clearRect(0, 0, S, S);
    if (steam > 0) {
      // Doused: the icon comes back with a few puffs of steam.
      const k = 1 - steam;
      drawBase(p * steam, true);
      for (let i = 0; i < 5; i++) {
        const kk = Math.min(1, Math.max(0, k * 1.3 - i * 0.06));
        ctx.fillStyle = `rgba(232,238,244,${(1 - kk) * 0.75})`;
        ctx.beginPath();
        ctx.arc(S * (0.18 + i * 0.16), S + 2 - kk * S * 1.1 - (i % 2) * 4, 3 + kk * 6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const frozen = !!state.pausedAt;
      const t = clockT();
      drawBase(p, true);
      paint(fireImg, p, t, frozen ? ICE : FIRE);
      fctx.putImageData(fireImg, 0, 0);
      ctx.drawImage(fireCanvas, 0, 0);
      if (!frozen && p > 0.12) {
        for (const [x, y, a] of sparks(S, S, p, t, 3)) {
          ctx.fillStyle = `rgba(255,${170 + a * 60},80,${a})`;
          ctx.fillRect(x, y, 2, 2);
        }
      }
    }
    return canvas.toDataURL('image/png');
  }

  function muteLink(l) {
    if (l === ownLink || muted.has(l)) return;
    muted.set(l, l.getAttribute('rel'));
    l.setAttribute('rel', 'tabfire-off');
  }

  function showIcon(url) {
    if (!ownLink || !ownLink.isConnected) {
      ownLink = document.createElement('link');
      ownLink.rel = 'icon';
      ownLink.type = 'image/png';
      ownLink.dataset.tabfire = '';
      (document.head || document.documentElement).appendChild(ownLink);
    }
    document.querySelectorAll(iconSelector).forEach(muteLink);
    if (url !== lastFrame) ownLink.href = lastFrame = url;
    observer.takeRecords();
  }

  function restoreIcon() {
    if (!ownLink && !muted.size) return;
    for (const [l, rel] of muted) l.setAttribute('rel', rel);
    muted.clear();
    ownLink?.remove();
    ownLink = null;
    lastFrame = '';
    observer.takeRecords();
  }

  // Sites that swap their own favicon (unread counts and such) keep working underneath the fire.
  let refreshTimer = 0;
  const observer = new MutationObserver((records) => {
    const touched = records.some((r) =>
      [r.target, ...r.addedNodes].some((n) => n.nodeName === 'LINK' && n !== ownLink));
    if (!touched) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshBase();
      if (ownLink) document.querySelectorAll(iconSelector).forEach(muteLink);
      observer.takeRecords();
    }, 250);
  });

  // ---------- titles ----------

  const FLAME_PREFIX = /^(🔥)+ /;
  function setTitleLevel(level) {
    const title = document.title;
    if (!level && !FLAME_PREFIX.test(title)) return;
    const next = (level >= 2 ? '🔥🔥 ' : level ? '🔥 ' : '') + title.replace(FLAME_PREFIX, '');
    if (next !== title) document.title = next;
  }

  // ---------- in-page warmth ----------

  let host = null;
  let ui = null;
  let toastDismissed = false;
  let dousedUntil = 0;
  let stripRaf = 0;
  let stripLevel = 0;

  const ICONS = {
    drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7c-3.3 4.1-6 7.6-6 11.1A6 6 0 0 0 18 13.8c0-3.5-2.7-7-6-11.1Z"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .glow {
      position: fixed; left: 0; right: 0; bottom: 0; height: 84px; opacity: 0;
      transform: scaleY(.2); transform-origin: bottom;
      background: linear-gradient(to top, rgba(255,96,24,.55), rgba(255,64,12,.2) 45%, rgba(255,40,0,0));
      transition: transform 1.2s cubic-bezier(.23,1,.32,1), opacity 1.2s ease;
    }
    .glow::after {
      content: ""; position: absolute; inset: 0;
      background: radial-gradient(60% 120% at 30% 100%, rgba(255,170,60,.35), transparent 70%),
                  radial-gradient(50% 100% at 75% 100%, rgba(255,120,30,.3), transparent 70%);
      animation: flicker 2.6s ease-in-out infinite alternate;
    }
    @keyframes flicker {
      0% { opacity: .55; transform: translateX(-2%); }
      40% { opacity: 1; }
      100% { opacity: .7; transform: translateX(2%); }
    }
    canvas.strip {
      position: fixed; left: 0; bottom: 0; width: 100vw; height: 0;
      opacity: 0; transition: opacity 1s ease; filter: blur(1.5px) saturate(1.15);
      mix-blend-mode: normal;
    }
    .toast {
      position: fixed; isolation: isolate; right: 18px; bottom: 18px; pointer-events: auto;
      display: flex; align-items: center; gap: 12px;
      padding: 10px 10px 10px 12px; border-radius: 16px;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      color: #fbefe4;
      background: linear-gradient(180deg, rgba(40,26,20,.94), rgba(22,15,12,.96));
      border: 1px solid rgba(255,140,70,.22);
      box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 12px 40px -8px rgba(255,80,20,.35), 0 4px 16px rgba(0,0,0,.4);
      backdrop-filter: blur(14px);
      transform: translateY(12px) scale(.97); opacity: 0;
      transition: transform 200ms ease-out, opacity 200ms ease-out, border-color 300ms ease, box-shadow 300ms ease;
    }
    .toast.on {
      transform: none; opacity: 1;
      transition: transform 420ms cubic-bezier(.23,1,.32,1), opacity 300ms ease-out, border-color 300ms ease, box-shadow 300ms ease;
    }
    .toast::before {
      content: ""; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
      box-shadow: 0 12px 48px -4px rgba(255,90,20,.75); opacity: 0;
    }
    .toast.urgent::before { animation: pulse 1.1s ease-in-out infinite alternate; }
    @keyframes pulse { to { opacity: 1; } }
    .icon { width: 28px; height: 28px; border-radius: 7px; image-rendering: pixelated; flex: none; }
    .txt { display: flex; flex-direction: column; min-width: 150px; }
    .txt b { font-weight: 600; letter-spacing: -.01em; }
    .time { color: #ffb37a; font-variant-numeric: tabular-nums; font-size: 12px; }
    button {
      all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      border-radius: 10px; font: 600 12.5px/1 inherit; font-family: inherit;
    }
    button svg { width: 15px; height: 15px; }
    .douse {
      padding: 8px 12px 8px 10px; color: #e9f6ff;
      background: linear-gradient(180deg, #4a9be0, #2c6fb5);
      box-shadow: 0 1px 0 rgba(255,255,255,.25) inset, 0 4px 14px -4px rgba(60,150,240,.7);
      transition: transform 160ms ease-out, filter 150ms ease;
    }
    .douse:active { transform: scale(.97); }
    .close { padding: 6px; color: rgba(251,239,228,.5); transition: color 150ms ease, background 150ms ease; }
    @media (hover: hover) and (pointer: fine) {
      .douse:hover { filter: brightness(1.1); }
      .close:hover { color: #fbefe4; background: rgba(255,255,255,.08); }
    }
    button:focus-visible { outline: 2px solid #ffb37a; outline-offset: 2px; }
    .toast.doused { border-color: rgba(120,190,255,.35); box-shadow: 0 12px 40px -8px rgba(60,150,240,.45), 0 4px 16px rgba(0,0,0,.4); }
    .toast.doused .time { color: #9fd2ff; }
    @media (prefers-reduced-motion: reduce) {
      .glow::after, .toast.urgent::before { animation: none; }
      .toast, .toast.on { transform: none; transition: opacity .2s ease; }
      .glow { transform: none; transition: opacity 1.2s ease; }
    }
  `;

  function ensureUi() {
    if (host?.isConnected) return;
    host = document.createElement('tabfire-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="glow"></div>
      <canvas class="strip"></canvas>
      <div class="toast" role="status" aria-live="polite" hidden>
        <img class="icon" alt="">
        <div class="txt"><b class="headline"></b><span class="time"></span></div>
        <button class="douse" type="button">${ICONS.drop}<span>Douse</span></button>
        <button class="close" type="button" aria-label="Dismiss">${ICONS.x}</button>
      </div>`;
    ui = {
      glow: root.querySelector('.glow'),
      strip: root.querySelector('.strip'),
      toast: root.querySelector('.toast'),
      icon: root.querySelector('.icon'),
      headline: root.querySelector('.headline'),
      time: root.querySelector('.time'),
      douse: root.querySelector('.douse'),
    };
    ui.stripCtx = ui.strip.getContext('2d');
    ui.douse.addEventListener('click', () => send({ type: 'douse' }));
    root.querySelector('.close').addEventListener('click', () => {
      toastDismissed = true;
      setToast(false);
    });
    document.documentElement.appendChild(host);
  }

  function removeUi() {
    cancelAnimationFrame(stripRaf);
    stripRaf = 0;
    host?.remove();
    host = ui = null;
  }

  function setToast(on) {
    if (!ui) return;
    if (on) {
      ui.toast.hidden = false;
      requestAnimationFrame(() => ui?.toast.classList.add('on'));
    } else {
      ui.toast.classList.remove('on', 'urgent');
      setTimeout(() => { if (ui && !ui.toast.classList.contains('on')) ui.toast.hidden = true; }, 400);
    }
  }

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${m}m`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function runStrip() {
    if (stripRaf || reduceMotion) return;
    let last = 0;
    let img = null;
    const loop = (ts) => {
      stripRaf = 0;
      if (!ui || stripLevel <= 0 || document.hidden) return;
      stripRaf = requestAnimationFrame(loop);
      if (ts - last < 33) return;
      last = ts;
      const cell = 5;
      const cssH = Math.round(innerHeight * (0.05 + stripLevel * 0.2));
      const w = Math.ceil(innerWidth / cell), h = Math.max(4, Math.ceil(cssH / cell));
      if (ui.strip.width !== w || ui.strip.height !== h) {
        ui.strip.width = w;
        ui.strip.height = h;
        img = null;
      }
      ui.strip.style.height = `${h * cell}px`;
      img ??= ui.stripCtx.createImageData(w, h);
      paint(img, 0.42 + stripLevel * 0.35, ts / 1000, state.pausedAt ? ICE : FIRE);
      ui.stripCtx.putImageData(img, 0, 0);
    };
    stripRaf = requestAnimationFrame(loop);
  }

  function updatePage(p, iconUrl) {
    const effects = state.lit ? state.effects : 'off';
    const left = timeLeft();
    const warnMs = Math.max(state.warnMs, 1);
    const warming = left <= warnMs;
    const w = warming ? Math.min(1, 1 - left / warnMs) : 0;
    const doused = Date.now() < dousedUntil;

    if (effects === 'off' || (!warming && !doused && !(effects === 'dramatic' && p > 0.75))) {
      if (host) {
        setToast(false);
        ui.glow.style.opacity = '0';
        ui.strip.style.opacity = '0';
        stripLevel = 0;
        if (effects === 'off') removeUi();
        else setTimeout(() => { if (ui && ui.glow.style.opacity === '0' && ui.toast.hidden) removeUi(); }, 1500);
      }
      return;
    }
    ensureUi();

    // Embers along the bottom of the page.
    const glowLevel = warming ? 0.35 + w * 0.65 : effects === 'dramatic' ? (p - 0.75) * 1.2 : 0;
    ui.glow.style.transform = `scaleY(${(0.17 + glowLevel * 0.83).toFixed(3)})`;
    ui.glow.style.opacity = doused ? '0' : String(Math.min(1, glowLevel));
    if (state.pausedAt) ui.glow.style.filter = 'hue-rotate(185deg) saturate(.8)';
    else ui.glow.style.filter = '';

    // Real flames climbing the page, inferno mode only.
    stripLevel = effects === 'dramatic' && warming && !doused ? w : 0;
    ui.strip.style.opacity = stripLevel > 0 ? '0.9' : '0';
    if (stripLevel > 0) runStrip();

    // The countdown card.
    if (doused) {
      ui.toast.classList.add('doused');
      ui.toast.classList.remove('urgent');
      ui.headline.textContent = 'Doused';
      ui.time.textContent = `Fresh fuse: ${fmt(state.lifetimeMs)}`;
      ui.douse.hidden = true;
      if (iconUrl) ui.icon.src = iconUrl;
      setToast(true);
      return;
    }
    ui.toast.classList.remove('doused');
    ui.douse.hidden = false;
    if (!warming || toastDismissed) {
      setToast(false);
      return;
    }
    if (iconUrl) ui.icon.src = iconUrl;
    if (state.pausedAt) {
      ui.headline.textContent = 'Fire on hold';
      ui.time.textContent = `${fmt(left)} left when it resumes`;
    } else if (left > 0) {
      ui.headline.textContent = 'This tab is on fire';
      ui.time.textContent = `Burns away in ${fmt(left)}`;
    } else {
      ui.headline.textContent = 'Out of time';
      ui.time.textContent = state.spareActive ? 'Burns the moment you look away' : 'Burning now';
    }
    ui.toast.classList.toggle('urgent', !state.pausedAt && left < 60000);
    setToast(true);
  }

  // ---------- loop ----------

  function frame() {
    clearTimeout(timer);
    if (dead || !state) return;
    const p = progress();
    const steam = Math.max(0, (steamUntil - Date.now()) / 1600);
    const burning = state.lit && p >= IGNITE;
    let iconUrl = null;

    if (burning || steam > 0) {
      iconUrl = renderIcon(p, steam);
      showIcon(iconUrl);
    } else {
      restoreIcon();
    }
    const left = timeLeft();
    setTitleLevel(state.lit && state.flameTitles ? (left <= state.warnMs ? 2 : p >= 0.5 ? 1 : 0) : 0);
    updatePage(p, document.hidden ? null : iconUrl);

    const animated = (burning && !state.pausedAt) || steam > 0;
    const delay = !animated ? 15000 : document.hidden ? 1000 : reduceMotion ? 1000 : 110;
    // Keep the countdown ticking every second when it's on screen.
    timer = setTimeout(frame, host && !document.hidden ? Math.min(delay, 1000) : delay);
  }

  function apply(next) {
    if (!next) return;
    const wasP = state ? progress() : 0;
    state = next;
    const p = progress();
    if (wasP >= IGNITE && p < wasP - 0.02) {
      steamUntil = Date.now() + 1600;
      if (timeLeft() > 0 && host) dousedUntil = Date.now() + 1800;
      toastDismissed = false;
    }
    frame();
  }

  function shutdown() {
    if (dead) return;
    dead = true;
    clearTimeout(timer);
    observer.disconnect();
    restoreIcon();
    removeUi();
    setTitleLevel(0);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'state') apply(msg.state);
  });
  document.addEventListener('visibilitychange', () => frame());
  addEventListener('pageshow', (e) => { if (e.persisted) send({ type: 'hello' }).then(apply); });

  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'rel'],
  });
  refreshBase();
  send({ type: 'hello' }).then(apply);
})();
