// Shared flame renderer, used by the tab icons, the in-page flames and the popup header.
globalThis.TabfireFire ??= (() => {
  function hash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  const fbm = (x, y) => noise(x, y) * 0.6 + noise(x * 2.1 + 17, y * 2.1 + 9) * 0.3 + noise(x * 4.3 + 3, y * 4.3 + 29) * 0.1;

  function palette(stops) {
    const out = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const h = i / 255;
      let j = 0;
      while (j < stops.length - 2 && h > stops[j + 1][0]) j++;
      const [h0, ...c0] = stops[j];
      const [h1, ...c1] = stops[j + 1];
      const f = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
      for (let k = 0; k < 4; k++) out[i * 4 + k] = c0[k] + (c1[k] - c0[k]) * f;
    }
    return out;
  }

  // [heat, r, g, b, a]
  const FIRE = palette([
    [0, 90, 8, 4, 0], [0.12, 150, 18, 6, 160], [0.3, 216, 42, 10, 238], [0.5, 255, 106, 18, 255],
    [0.72, 255, 178, 50, 255], [0.9, 255, 228, 134, 255], [1, 255, 249, 218, 255],
  ]);
  const ICE = palette([
    [0, 20, 40, 90, 0], [0.12, 34, 74, 146, 160], [0.35, 64, 134, 214, 232], [0.6, 124, 194, 255, 255],
    [0.85, 194, 232, 255, 255], [1, 242, 250, 255, 255],
  ]);

  // Paints flames into an ImageData. p (0..1) is how far up they reach; t is time in seconds.
  function paint(img, p, t, pal = FIRE) {
    const { width: w, height: h, data: d } = img;
    const unit = h / 32;
    const fill = h * (0.04 + p * 1.16);
    const k = Math.max(3 * unit, fill * 0.85);
    const tongue = h * 0.22 * Math.min(1, 0.35 + p * 2);
    for (let x = 0; x < w; x++) {
      const ux = x / unit;
      const top = fill + (fbm(ux * 0.11 + 5, t * 0.9) - 0.5) * 2 * tongue;
      for (let y = 0; y < h; y++) {
        const yb = h - y - 0.5;
        const i = (y * w + x) * 4;
        const heat = (top - yb) / k + (fbm(ux * 0.17, yb / unit * 0.13 - t * 2.2) - 0.5) * 0.7;
        if (heat <= 0) {
          d[i + 3] = 0;
          continue;
        }
        const li = Math.min(255, (heat * 255) | 0) * 4;
        d[i] = pal[li];
        d[i + 1] = pal[li + 1];
        d[i + 2] = pal[li + 2];
        d[i + 3] = pal[li + 3];
      }
    }
  }

  // Rising sparks above the flames, as [x, y, alpha] in pixel coordinates.
  function sparks(w, h, p, t, count) {
    const out = [];
    const fill = h * (0.04 + p * 1.16);
    for (let i = 0; i < count; i++) {
      const run = t * 0.7 + i * 0.37;
      const phase = run % 1;
      const x = hash(i, Math.floor(run)) * w + Math.sin(phase * 6 + i) * (h / 24);
      const y = h - (fill * 0.55 + phase * h * 0.6);
      if (y > 0) out.push([x, y, 1 - phase]);
    }
    return out;
  }

  return { paint, sparks, FIRE, ICE, hash };
})();
