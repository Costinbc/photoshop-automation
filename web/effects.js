// Canvas-based visual effects applied to base images before Photopea placement.
// Runs in the browser via OffscreenCanvas — both the web app and the CLI (which
// drives a real browser) use the same code.

const _overlayCache = new Map();

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Clarity boost ───────────────────────────────────────────────────────────
// Unsharp mask at large radius + subtle contrast bump (Lightroom "Clarity").
function clarity(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const original = ctx.getImageData(0, 0, w, h);

  const blur = new OffscreenCanvas(w, h);
  const bctx = blur.getContext("2d");
  bctx.filter = "blur(20px)";
  bctx.drawImage(canvas, 0, 0);
  const blurred = bctx.getImageData(0, 0, w, h);

  const od = original.data, bd = blurred.data;
  for (let i = 0; i < od.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = od[i + c] + (od[i + c] - bd[i + c]) * 0.5;
      v = 128 + (v - 128) * 1.1;
      od[i + c] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    }
  }
  ctx.putImageData(original, 0, 0);
}

// ── Edge glow ───────────────────────────────────────────────────────────────
// Screen-blended colored gradient from one edge — simulates rim light.
function edgeGlow(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");

  const grad = tctx.createLinearGradient(w * 0.72, 0, w, 0);
  grad.addColorStop(0, "transparent");
  grad.addColorStop(1, "rgb(255,140,40)");
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  tctx.globalCompositeOperation = "destination-in";
  const v = tctx.createLinearGradient(0, 0, 0, h);
  v.addColorStop(0, "rgba(255,255,255,0)");
  v.addColorStop(0.15, "white");
  v.addColorStop(0.85, "white");
  v.addColorStop(1, "rgba(255,255,255,0)");
  tctx.fillStyle = v;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.22;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Halftone light ──────────────────────────────────────────────────────────
// Subtle white halftone dot overlay. Dot size varies with local brightness.
function halftoneLight(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const spacing = 14, maxDot = 5, opacity = 0.06;
  const src = ctx.getImageData(0, 0, w, h);

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");
  tctx.fillStyle = `rgba(255,255,255,${opacity})`;

  for (let row = 0; row <= h / spacing; row++) {
    for (let col = 0; col <= w / spacing; col++) {
      const x = col * spacing + (row & 1 ? spacing / 2 : 0);
      const y = row * spacing;
      if (x >= w || y >= h) continue;
      const pi = ((y | 0) * w + (x | 0)) * 4;
      const lum = (src.data[pi] * 0.299 + src.data[pi + 1] * 0.587 + src.data[pi + 2] * 0.114) / 255;
      const r = maxDot * (1 - lum * 0.5) / 2;
      tctx.beginPath();
      tctx.arc(x, y, r, 0, Math.PI * 2);
      tctx.fill();
    }
  }
  ctx.drawImage(temp, 0, 0);
}

// ── Grit light ──────────────────────────────────────────────────────────────
// Halftone dots + light vignette + overlay noise + contrast.
function gritLight(canvas, ctx) {
  const w = canvas.width, h = canvas.height;

  halftoneLight(canvas, ctx);

  // Vignette
  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");
  const vg = tctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
  vg.addColorStop(0, "transparent");
  vg.addColorStop(1, "rgba(0,0,0,0.25)");
  tctx.fillStyle = vg;
  tctx.fillRect(0, 0, w, h);
  ctx.drawImage(temp, 0, 0);

  // Noise + contrast
  const d = ctx.getImageData(0, 0, w, h);
  const px = d.data;
  const rng = mulberry32(7);
  for (let i = 0; i < px.length; i += 4) {
    const n = (rng() - 0.5) * 20;
    for (let c = 0; c < 3; c++) {
      let v = px[i + c] + n;
      v = 128 + (v - 128) * 1.08;
      px[i + c] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    }
  }
  ctx.putImageData(d, 0, 0);
}

// ── Condensation / wet glass ────────────────────────────────────────────────
// Water droplet overlay + slight blur simulating frosted glass.
async function condensationGlass(canvas, ctx, base) {
  const w = canvas.width, h = canvas.height;

  // 40% blur blend
  const blur = new OffscreenCanvas(w, h);
  blur.getContext("2d").filter = "blur(2px)";
  blur.getContext("2d").drawImage(canvas, 0, 0);
  ctx.globalAlpha = 0.4;
  ctx.drawImage(blur, 0, 0);
  ctx.globalAlpha = 1;

  // Water drops overlay
  const url = `${base}/assets/overlays/water_drops.png`;
  if (!_overlayCache.has(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`condensation overlay: HTTP ${res.status}`);
    _overlayCache.set(url, await createImageBitmap(await res.blob()));
  }
  const drops = _overlayCache.get(url);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.12;
  ctx.drawImage(drops, 0, 0, w, h);
  ctx.restore();

  // Subtle glass tint
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = "rgb(200,210,225)";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ── Topographic contour lines ───────────────────────────────────────────────
// Procedural contour lines from multi-scale noise, drawn via marching squares.
function topographicLines(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const numLines = 18, opacity = 0.08;

  // Work at 1/4 resolution for speed
  const ds = 4;
  const sw = Math.ceil(w / ds), sh = Math.ceil(h / ds);
  const field = new Float32Array(sw * sh);
  const rng = mulberry32(42);

  for (const [ns, wt] of [[15, 0.6], [30, 0.3], [50, 0.1]]) {
    const nw = Math.max(2, Math.ceil(sw / ns));
    const nh = Math.max(2, Math.ceil(sh / ns));
    const noise = new Float32Array(nw * nh);
    for (let i = 0; i < noise.length; i++) noise[i] = (rng() - 0.5) * 2;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const fx = (x / sw) * (nw - 1), fy = (y / sh) * (nh - 1);
        const ix = fx | 0, iy = fy | 0;
        const dx = fx - ix, dy = fy - iy;
        const ix1 = Math.min(ix + 1, nw - 1), iy1 = Math.min(iy + 1, nh - 1);
        field[y * sw + x] += wt * (
          noise[iy * nw + ix] * (1 - dx) * (1 - dy) +
          noise[iy * nw + ix1] * dx * (1 - dy) +
          noise[iy1 * nw + ix] * (1 - dx) * dy +
          noise[iy1 * nw + ix1] * dx * dy
        );
      }
    }
  }

  let fmin = Infinity, fmax = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < fmin) fmin = field[i];
    if (field[i] > fmax) fmax = field[i];
  }
  const fr = fmax - fmin || 1;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - fmin) / fr;

  const sx = w / sw, sy = h / sh;
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${opacity})`;
  ctx.lineWidth = 1.2;

  for (let ln = 0; ln < numLines; ln++) {
    const thr = (ln + 0.5) / numLines;
    ctx.beginPath();
    for (let y = 0; y < sh - 1; y++) {
      for (let x = 0; x < sw - 1; x++) {
        const tl = field[y * sw + x], tr = field[y * sw + x + 1];
        const bl = field[(y + 1) * sw + x], br = field[(y + 1) * sw + x + 1];
        let ci = 0;
        if (tl >= thr) ci |= 1;
        if (tr >= thr) ci |= 2;
        if (br >= thr) ci |= 4;
        if (bl >= thr) ci |= 8;
        if (ci === 0 || ci === 15) continue;

        const lp = (v1, v2, ax, ay, bx, by) => {
          const t = Math.abs(v2 - v1) < 1e-7 ? 0.5 : (thr - v1) / (v2 - v1);
          return [(ax + (bx - ax) * t) * sx, (ay + (by - ay) * t) * sy];
        };
        const tp = lp(tl, tr, x, y, x + 1, y);
        const rt = lp(tr, br, x + 1, y, x + 1, y + 1);
        const bt = lp(bl, br, x, y + 1, x + 1, y + 1);
        const lt = lp(tl, bl, x, y, x, y + 1);

        const sg = (a, b) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
        switch (ci) {
          case 1: case 14: sg(tp, lt); break;
          case 2: case 13: sg(tp, rt); break;
          case 3: case 12: sg(lt, rt); break;
          case 4: case 11: sg(rt, bt); break;
          case 5: sg(tp, rt); sg(bt, lt); break;
          case 6: case 9: sg(tp, bt); break;
          case 7: case 8: sg(lt, bt); break;
          case 10: sg(tp, lt); sg(rt, bt); break;
        }
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ── Light leak ──────────────────────────────────────────────────────────────
// Diagonal gradient wash (warm-to-cool), screen-blended. Stronger at edges,
// weaker near center.
function lightLeak(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");

  const grad = tctx.createLinearGradient(0, h, w, 0);
  grad.addColorStop(0, "rgb(255,160,60)");
  grad.addColorStop(1, "rgb(255,80,120)");
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  tctx.globalCompositeOperation = "destination-in";
  const rg = tctx.createRadialGradient(w * 0.65, h * 0.3, 0, w * 0.65, h * 0.3, Math.max(w, h) * 0.7);
  rg.addColorStop(0, "rgba(255,255,255,0)");
  rg.addColorStop(0.4, "rgba(255,255,255,0.4)");
  rg.addColorStop(1, "white");
  tctx.fillStyle = rg;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.20;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Geometric triangles ─────────────────────────────────────────────────────
// Subtle triangle grid overlay at low opacity.
function geometricTriangles(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const size = 80, opacity = 0.07;
  const rowH = size * 0.866;

  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${opacity})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let row = 0; row <= h / rowH + 1; row++) {
    for (let col = 0; col <= w / size + 1; col++) {
      const x0 = col * size + (row & 1 ? size / 2 : 0);
      const y0 = row * rowH;
      ctx.moveTo(x0, y0 + rowH);
      ctx.lineTo(x0 + size, y0 + rowH);
      ctx.lineTo(x0 + size / 2, y0);
      ctx.closePath();
    }
  }
  ctx.stroke();
  ctx.restore();
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const EFFECTS = {
  clarity,
  edgeGlow,
  halftone: halftoneLight,
  grit: gritLight,
  condensation: condensationGlass,
  topographic: topographicLines,
  lightLeak,
  triangles: geometricTriangles,
};

export async function applyEffects(bytes, effects, base = "") {
  if (!effects) return bytes;
  const keys = Object.keys(effects).filter((k) => effects[k] && EFFECTS[k]);
  if (!keys.length) return bytes;

  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);

  for (const key of keys) {
    const fn = EFFECTS[key];
    if (fn.length > 2) await fn(canvas, ctx, base);
    else fn(canvas, ctx);
  }

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}
