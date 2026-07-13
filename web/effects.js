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

  const grad = tctx.createLinearGradient(w * 0.55, 0, w, 0);
  grad.addColorStop(0, "transparent");
  grad.addColorStop(1, "rgb(255,140,40)");
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  tctx.globalCompositeOperation = "destination-in";
  const v = tctx.createLinearGradient(0, 0, 0, h);
  v.addColorStop(0, "rgba(255,255,255,0.1)");
  v.addColorStop(0.2, "white");
  v.addColorStop(0.8, "white");
  v.addColorStop(1, "rgba(255,255,255,0.1)");
  tctx.fillStyle = v;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.35;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Halftone light ──────────────────────────────────────────────────────────
// Subtle white halftone dot overlay. Dot size varies with local brightness.
function halftoneLight(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const spacing = 14, maxDot = 5;
  const src = ctx.getImageData(0, 0, w, h);

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");
  tctx.fillStyle = "rgba(255,255,255,0.15)";

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
  const bctx = blur.getContext("2d");
  bctx.filter = "blur(2px)";
  bctx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.drawImage(blur, 0, 0);
  ctx.restore();

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
  ctx.globalAlpha = 0.18;
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
  const numLines = 18;

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
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1.5;

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
// Diagonal gradient wash (warm-to-pink), screen-blended. Visible across the
// whole image with a soft falloff — not masked out in the center.
function lightLeak(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");

  // Full diagonal gradient — no radial mask punching a hole in the middle
  const grad = tctx.createLinearGradient(0, h, w, 0);
  grad.addColorStop(0, "rgb(255,160,60)");
  grad.addColorStop(0.5, "rgb(255,100,90)");
  grad.addColorStop(1, "rgb(255,80,180)");
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.32;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Brush strokes ───────────────────────────────────────────────────────────
// Bold sweeping calligraphic ink strokes. Each stroke is a wobbly bezier drawn
// as a wide stack of stroked bristle paths, tapered at the ends, with a
// trailing splatter cloud.
function brushStrokes(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const rng = mulberry32(19);
  const strokes = 3;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.9;

  for (let s = 0; s < strokes; s++) {
    // Full-width sweeps — start off-canvas left, end off-canvas right
    const y0 = h * (0.12 + s * 0.28 + (rng() - 0.5) * 0.1);
    const y1 = h * (0.15 + s * 0.28 + (rng() - 0.5) * 0.2);
    const cx1 = w * (0.15 + rng() * 0.2);
    const cx2 = w * (0.6 + rng() * 0.2);
    const cy1 = y0 + (rng() - 0.5) * h * 0.15;
    const cy2 = y1 + (rng() - 0.5) * h * 0.15;
    const thick = 55 + rng() * 35;
    const bands = 14;
    const steps = 140;

    for (let band = 0; band < bands; band++) {
      const bandT = band / (bands - 1);
      const off = (bandT - 0.5) * thick;
      // Central bristles opaque, edge bristles faint — feathers the edges
      const bandFall = 1 - Math.pow(Math.abs(bandT - 0.5) * 2, 1.5);
      ctx.strokeStyle = `rgba(255,255,255,${0.28 * bandFall + 0.05})`;
      ctx.lineWidth = 2 + rng() * 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      let inPath = false;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const bx = 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * w;
        const by = mt * mt * mt * y0 + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y1;
        const dx = 3 * mt * mt * cx1 + 6 * mt * t * (cx2 - cx1) + 3 * t * t * (w - cx2);
        const dy = 3 * mt * mt * (cy1 - y0) + 6 * mt * t * (cy2 - cy1) + 3 * t * t * (y1 - cy2);
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const taper = Math.pow(Math.sin(t * Math.PI), 0.5);
        const px = bx + nx * off * taper + (rng() - 0.5) * 2;
        const py = by + ny * off * taper + (rng() - 0.5) * 2;
        if (!inPath) { ctx.moveTo(px, py); inPath = true; }
        else ctx.lineTo(px, py);
        // Dry-brush breaks — more common on outer bristles
        if (rng() > 0.96 - Math.abs(bandT - 0.5) * 0.1) {
          ctx.stroke();
          ctx.beginPath();
          inPath = false;
        }
      }
      ctx.stroke();
    }

    // Trailing splatter cloud past the end of the stroke
    for (let d = 0; d < 30; d++) {
      const r = 1 + rng() * 5;
      const dx = rng() * 120 - 20;
      const dy = (rng() - 0.5) * 90;
      ctx.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.3})`;
      ctx.beginPath();
      ctx.arc(Math.min(w - 5, w - 40 + dx), y1 + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ── Ink spatter ─────────────────────────────────────────────────────────────
// Clustered ink dots + a few larger blobs, radiating from the two side edges.
// Screen-blended so it lifts on dark backgrounds and stays subtle on light.
function inkSpatter(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const rng = mulberry32(31);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.95;

  // Four cluster centers spread across the frame — corners + edges
  const spread = Math.min(w, h) * 0.5;
  const centers = [
    { cx: w * 0.05, cy: h * (0.1 + rng() * 0.2), spread },
    { cx: w * 0.95, cy: h * (0.15 + rng() * 0.25), spread },
    { cx: w * 0.1, cy: h * (0.6 + rng() * 0.2), spread: spread * 0.8 },
    { cx: w * 0.9, cy: h * (0.65 + rng() * 0.2), spread: spread * 0.8 },
  ];

  for (const { cx, cy, spread: sp } of centers) {
    // Fine spatter (many tiny dots)
    for (let i = 0; i < 380; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = Math.pow(rng(), 1.6) * sp;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const r = 0.6 + rng() * 3;
      const a = 0.35 + rng() * 0.5;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Medium blobs
    for (let i = 0; i < 24; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = Math.pow(rng(), 1.3) * sp * 0.65;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ctx.fillStyle = `rgba(255,255,255,${0.5 + rng() * 0.3})`;
      ctx.beginPath();
      const pts = 10;
      const rBase = 5 + rng() * 12;
      for (let p = 0; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        const rr = rBase * (0.55 + rng() * 0.7);
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    // A few big splat blobs
    for (let i = 0; i < 3; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = rng() * sp * 0.35;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ctx.fillStyle = `rgba(255,255,255,${0.55 + rng() * 0.25})`;
      ctx.beginPath();
      const pts = 14;
      const rBase = 18 + rng() * 22;
      for (let p = 0; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        const rr = rBase * (0.5 + rng() * 0.9);
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

// ── Smoke plumes ────────────────────────────────────────────────────────────
// Soft wispy plumes rising from the bottom, built out of stacked semi-transparent
// radial gradients with vertical stretch. Reads as atmospheric haze.
function smokePlumes(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const rng = mulberry32(53);

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");

  const plumes = 5;
  for (let p = 0; p < plumes; p++) {
    const cx = w * (0.12 + p * (0.76 / (plumes - 1)) + (rng() - 0.5) * 0.06);
    const baseY = h * (0.95 + rng() * 0.05);
    const puffs = 26;
    for (let i = 0; i < puffs; i++) {
      const t = i / (puffs - 1);
      const y = baseY - t * h * 0.85 * (0.7 + rng() * 0.4);
      const drift = Math.sin(t * Math.PI * 1.6 + p * 1.3) * w * 0.09;
      const x = cx + drift + (rng() - 0.5) * w * 0.04;
      // Puffs grow substantially as they rise, and each puff is much bigger
      const radius = 90 + t * 180 + rng() * 60;
      const alpha = (1 - t * 0.5) * (0.30 + rng() * 0.12);
      const grad = tctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, `rgba(245,245,250,${alpha})`);
      grad.addColorStop(0.5, `rgba(225,225,235,${alpha * 0.55})`);
      grad.addColorStop(1, "rgba(220,220,230,0)");
      tctx.fillStyle = grad;
      tctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }

  // Bottom base haze — grounds the plumes so they don't look like floating
  // blobs. Semi-opaque band that dissipates upward.
  const baseGrad = tctx.createLinearGradient(0, h, 0, h * 0.6);
  baseGrad.addColorStop(0, "rgba(235,235,240,0.35)");
  baseGrad.addColorStop(1, "rgba(235,235,240,0)");
  tctx.fillStyle = baseGrad;
  tctx.fillRect(0, h * 0.6, w, h * 0.4);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 1.0;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Geometric triangles ─────────────────────────────────────────────────────
// Subtle triangle grid overlay at low opacity.
function geometricTriangles(canvas, ctx) {
  const w = canvas.width, h = canvas.height;
  const size = 80;
  const rowH = size * 0.866;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1.2;
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
  brush: brushStrokes,
  spatter: inkSpatter,
  smoke: smokePlumes,
};

export async function applyEffects(bytes, effects, base = "", { output = "jpeg", mask = null } = {}) {
  if (!effects) return bytes;
  const keys = Object.keys(effects).filter((k) => effects[k] && EFFECTS[k]);
  if (!keys.length) return bytes;

  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);

  // Split into clarity (applies to whole image) and overlays (masked to
  // background when a subject mask is provided). Clarity is a per-pixel
  // sharpen/contrast bump that reads correctly on skin/jersey; overlays are
  // decorative and should sit behind the subject.
  const clarityKeys = keys.filter((k) => k === "clarity");
  const overlayKeys = keys.filter((k) => k !== "clarity");

  for (const key of clarityKeys) EFFECTS[key](canvas, ctx);

  if (mask && overlayKeys.length) {
    // Snapshot the clarity-only pixels — this is what should show through in
    // the subject area after overlays are applied and composited back.
    const subjectSnap = new OffscreenCanvas(bmp.width, bmp.height);
    subjectSnap.getContext("2d").drawImage(canvas, 0, 0);

    for (const key of overlayKeys) {
      const fn = EFFECTS[key];
      if (fn.length > 2) await fn(canvas, ctx, base);
      else fn(canvas, ctx);
    }

    // Compose the subject snapshot back on top, alpha-masked. Result: overlays
    // exist only where mask is 0 (background); the subject shows its
    // clarity-only pixels untouched. Any mask imperfection reveals original
    // subject pixels — indistinguishable from the surrounding subject.
    const maskBmp = await createImageBitmap(new Blob([mask]));
    const cutoutCanvas = new OffscreenCanvas(bmp.width, bmp.height);
    const cctx = cutoutCanvas.getContext("2d");
    cctx.drawImage(subjectSnap, 0, 0);
    cctx.globalCompositeOperation = "destination-in";
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = "high";
    cctx.drawImage(maskBmp, 0, 0, bmp.width, bmp.height);
    ctx.drawImage(cutoutCanvas, 0, 0);
  } else {
    for (const key of overlayKeys) {
      const fn = EFFECTS[key];
      if (fn.length > 2) await fn(canvas, ctx, base);
      else fn(canvas, ctx);
    }
  }

  const blob = await canvas.convertToBlob(
    output === "png" ? { type: "image/png" } : { type: "image/jpeg", quality: 0.92 }
  );
  return new Uint8Array(await blob.arrayBuffer());
}
