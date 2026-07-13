// Canvas-based visual effects applied to base images before Photopea placement.
// Runs in the browser via OffscreenCanvas — both the web app and the CLI (which
// drives a real browser) use the same code.
//
// Effect signature: fn(canvas, ctx, { params, base, center } = {})
//   params: per-effect knob bag; every knob has a default matching the
//           pre-parameterized output. Passing `true` in request.effects uses
//           all defaults; passing an object overrides knobs.
//   base:   URL prefix for fetching overlay assets (condensation drops PNG).
//   center: subject centroid { cx, cy, radius } from the mask; only needed by
//           the spotlight effect.

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

function hexToRgb(hex) {
  const h = (hex || "#ffffff").replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Clarity boost ───────────────────────────────────────────────────────────
function clarity(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const amount = (params.intensity ?? 50) / 100;
  const radius = params.radius ?? 20;

  const original = ctx.getImageData(0, 0, w, h);
  const blur = new OffscreenCanvas(w, h);
  const bctx = blur.getContext("2d");
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(canvas, 0, 0);
  const blurred = bctx.getImageData(0, 0, w, h);

  const od = original.data, bd = blurred.data;
  const contrast = 1 + 0.2 * amount;
  for (let i = 0; i < od.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = od[i + c] + (od[i + c] - bd[i + c]) * amount;
      v = 128 + (v - 128) * contrast;
      od[i + c] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    }
  }
  ctx.putImageData(original, 0, 0);
}

// ── Edge glow ───────────────────────────────────────────────────────────────
function edgeGlow(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const alpha = (params.intensity ?? 35) / 100;
  const color = params.color ?? "#ff8c28";
  const side = params.side ?? "right";
  const width = (params.width ?? 45) / 100;

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");

  let grad;
  const horiz = side === "left" || side === "right";
  if (side === "right") grad = tctx.createLinearGradient(w * (1 - width), 0, w, 0);
  else if (side === "left") grad = tctx.createLinearGradient(w * width, 0, 0, 0);
  else if (side === "top") grad = tctx.createLinearGradient(0, h * width, 0, 0);
  else grad = tctx.createLinearGradient(0, h * (1 - width), 0, h); // bottom
  grad.addColorStop(0, "transparent");
  grad.addColorStop(1, color);
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  // Falloff on the perpendicular axis so the glow doesn't touch the far corners
  tctx.globalCompositeOperation = "destination-in";
  const fall = horiz
    ? tctx.createLinearGradient(0, 0, 0, h)
    : tctx.createLinearGradient(0, 0, w, 0);
  fall.addColorStop(0, "rgba(255,255,255,0.1)");
  fall.addColorStop(0.2, "white");
  fall.addColorStop(0.8, "white");
  fall.addColorStop(1, "rgba(255,255,255,0.1)");
  tctx.fillStyle = fall;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = alpha;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Halftone light ──────────────────────────────────────────────────────────
function halftoneLight(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const spacing = params.spacing ?? 14;
  const alpha = (params.intensity ?? 15) / 100;
  const color = params.color ?? "#ffffff";
  const maxDot = spacing * 0.36;
  const src = ctx.getImageData(0, 0, w, h);

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");
  tctx.fillStyle = rgba(color, alpha);

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
function gritLight(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const intensity = (params.intensity ?? 50) / 100;
  const vignette = (params.vignette ?? 25) / 100;

  halftoneLight(canvas, ctx, { params: { intensity: 30 * intensity, spacing: 14 } });

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");
  const vg = tctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
  vg.addColorStop(0, "transparent");
  vg.addColorStop(1, `rgba(0,0,0,${vignette})`);
  tctx.fillStyle = vg;
  tctx.fillRect(0, 0, w, h);
  ctx.drawImage(temp, 0, 0);

  const d = ctx.getImageData(0, 0, w, h);
  const px = d.data;
  const rng = mulberry32(7);
  const noiseAmp = 20 * intensity;
  const contrast = 1 + 0.08 * intensity;
  for (let i = 0; i < px.length; i += 4) {
    const n = (rng() - 0.5) * noiseAmp;
    for (let c = 0; c < 3; c++) {
      let v = px[i + c] + n;
      v = 128 + (v - 128) * contrast;
      px[i + c] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    }
  }
  ctx.putImageData(d, 0, 0);
}

// ── Condensation / wet glass ────────────────────────────────────────────────
async function condensationGlass(canvas, ctx, { params = {}, base } = {}) {
  const w = canvas.width, h = canvas.height;
  const alpha = (params.intensity ?? 18) / 100;
  const blurPx = params.blur ?? 2;

  if (blurPx > 0) {
    const blur = new OffscreenCanvas(w, h);
    const bctx = blur.getContext("2d");
    bctx.filter = `blur(${blurPx}px)`;
    bctx.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.drawImage(blur, 0, 0);
    ctx.restore();
  }

  const url = `${base}/assets/overlays/water_drops.png`;
  if (!_overlayCache.has(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`condensation overlay: HTTP ${res.status}`);
    _overlayCache.set(url, await createImageBitmap(await res.blob()));
  }
  const drops = _overlayCache.get(url);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = alpha;
  ctx.drawImage(drops, 0, 0, w, h);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = "rgb(200,210,225)";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ── Topographic contour lines ───────────────────────────────────────────────
function topographicLines(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const numLines = params.count ?? 18;
  const alpha = (params.intensity ?? 14) / 100;
  const color = params.color ?? "#ffffff";

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
  ctx.strokeStyle = rgba(color, alpha);
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
function lightLeak(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const alpha = (params.intensity ?? 32) / 100;
  const color1 = params.color1 ?? "#ffa03c";
  const color2 = params.color2 ?? "#ff64b4";
  const angleDeg = params.angle ?? 45;

  const angle = (angleDeg * Math.PI) / 180;
  const cx = w / 2, cy = h / 2;
  const half = Math.hypot(w / 2, h / 2);
  const gx0 = cx - Math.cos(angle) * half;
  const gy0 = cy - Math.sin(angle) * half;
  const gx1 = cx + Math.cos(angle) * half;
  const gy1 = cy + Math.sin(angle) * half;

  const temp = new OffscreenCanvas(w, h);
  const tctx = temp.getContext("2d");
  const grad = tctx.createLinearGradient(gx0, gy0, gx1, gy1);
  grad.addColorStop(0, color1);
  grad.addColorStop(1, color2);
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = alpha;
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Geometric triangles ─────────────────────────────────────────────────────
function geometricTriangles(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const size = params.size ?? 80;
  const alpha = (params.intensity ?? 12) / 100;
  const color = params.color ?? "#ffffff";
  const rowH = size * 0.866;

  ctx.save();
  ctx.strokeStyle = rgba(color, alpha);
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

// ── Brush strokes ───────────────────────────────────────────────────────────
function brushStrokes(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const rng = mulberry32(19);
  const strokes = params.count ?? 3;
  const alpha = (params.intensity ?? 90) / 100;
  const color = params.color ?? "#ffffff";
  const angleDeg = params.angle ?? 0;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = alpha;
  // Rotate around center so tilted strokes cross the frame nicely.
  ctx.translate(w / 2, h / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);

  for (let s = 0; s < strokes; s++) {
    const y0 = h * (0.12 + s * (0.85 / Math.max(1, strokes)) + (rng() - 0.5) * 0.1);
    const y1 = h * (0.15 + s * (0.85 / Math.max(1, strokes)) + (rng() - 0.5) * 0.2);
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
      const bandFall = 1 - Math.pow(Math.abs(bandT - 0.5) * 2, 1.5);
      ctx.strokeStyle = rgba(color, 0.28 * bandFall + 0.05);
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
        if (rng() > 0.96 - Math.abs(bandT - 0.5) * 0.1) {
          ctx.stroke();
          ctx.beginPath();
          inPath = false;
        }
      }
      ctx.stroke();
    }

    for (let d = 0; d < 30; d++) {
      const r = 1 + rng() * 5;
      const dx = rng() * 120 - 20;
      const dy = (rng() - 0.5) * 90;
      ctx.fillStyle = rgba(color, 0.2 + rng() * 0.3);
      ctx.beginPath();
      ctx.arc(Math.min(w - 5, w - 40 + dx), y1 + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ── Ink spatter ─────────────────────────────────────────────────────────────
function inkSpatter(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const rng = mulberry32(31);
  const alpha = (params.intensity ?? 95) / 100;
  const densityMult = (params.density ?? 100) / 100;
  const color = params.color ?? "#ffffff";

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = alpha;

  const spread = Math.min(w, h) * 0.5;
  const centers = [
    { cx: w * 0.05, cy: h * (0.1 + rng() * 0.2), spread },
    { cx: w * 0.95, cy: h * (0.15 + rng() * 0.25), spread },
    { cx: w * 0.1, cy: h * (0.6 + rng() * 0.2), spread: spread * 0.8 },
    { cx: w * 0.9, cy: h * (0.65 + rng() * 0.2), spread: spread * 0.8 },
  ];

  const fineCount = Math.round(380 * densityMult);
  const blobCount = Math.round(24 * densityMult);
  const bigCount = Math.max(1, Math.round(3 * densityMult));

  for (const { cx, cy, spread: sp } of centers) {
    for (let i = 0; i < fineCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = Math.pow(rng(), 1.6) * sp;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const r = 0.6 + rng() * 3;
      const a = 0.35 + rng() * 0.5;
      ctx.fillStyle = rgba(color, a);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < blobCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = Math.pow(rng(), 1.3) * sp * 0.65;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ctx.fillStyle = rgba(color, 0.5 + rng() * 0.3);
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
    for (let i = 0; i < bigCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = rng() * sp * 0.35;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ctx.fillStyle = rgba(color, 0.55 + rng() * 0.25);
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
function smokePlumes(canvas, ctx, { params = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const rng = mulberry32(53);
  const alpha = (params.intensity ?? 100) / 100;
  const color = params.color ?? "#f5f5fa";
  const angleDeg = params.angle ?? 0;
  const [cr, cg, cb] = hexToRgb(color);

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
      const radius = 90 + t * 180 + rng() * 60;
      const a = (1 - t * 0.5) * (0.30 + rng() * 0.12);
      const grad = tctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      grad.addColorStop(0.5, `rgba(${Math.max(0, cr - 20)},${Math.max(0, cg - 20)},${Math.max(0, cb - 15)},${a * 0.55})`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      tctx.fillStyle = grad;
      tctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }

  const baseGrad = tctx.createLinearGradient(0, h, 0, h * 0.6);
  baseGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.35)`);
  baseGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  tctx.fillStyle = baseGrad;
  tctx.fillRect(0, h * 0.6, w, h * 0.4);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = alpha;
  if (angleDeg) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

// ── Spotlight ───────────────────────────────────────────────────────────────
function spotlight(canvas, ctx, { params = {}, center } = {}) {
  const w = canvas.width, h = canvas.height;
  const darkness = (params.darkness ?? 75) / 100;
  const scaleMul = (params.scale ?? 100) / 100;
  const dxPct = (params.dx ?? 0) / 100;
  const dyPct = (params.dy ?? 0) / 100;
  const tint = params.tint ?? "#ffffff";
  const [tr, tg, tb] = hexToRgb(tint);

  const cxBase = center?.cx ?? w / 2;
  const cyBase = center?.cy ?? h / 2;
  const cx = cxBase + w * dxPct;
  const cy = cyBase + h * dyPct;

  const baseRadius = center?.radius ?? Math.min(w, h) * 0.25;
  const innerR = baseRadius * scaleMul;
  const outerR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));

  // Optional warm light tint at center (screen-blended, subtle)
  if (tint.toLowerCase() !== "#ffffff") {
    const lightGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerR);
    lightGrad.addColorStop(0, `rgba(${tr},${tg},${tb},0.25)`);
    lightGrad.addColorStop(1, `rgba(${tr},${tg},${tb},0)`);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = lightGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Radial darkening
  const grad = ctx.createRadialGradient(cx, cy, innerR * 0.5, cx, cy, outerR);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.35, `rgba(0,0,0,${darkness * 0.47})`);
  grad.addColorStop(1, `rgba(0,0,0,${darkness})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
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
  spotlight,
};

async function computeSubjectCenter(maskBytes, targetW, targetH) {
  const bmp = await createImageBitmap(new Blob([maskBytes]));
  const scale = 128 / Math.max(bmp.width, bmp.height);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext("2d");
  cx.drawImage(bmp, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;
  let sumX = 0, sumY = 0, sumW = 0;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a < 32) continue;
      sumX += x * a; sumY += y * a; sumW += a;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (sumW === 0) return null;
  const scaleX = targetW / w, scaleY = targetH / h;
  const bboxW = (maxX - minX) * scaleX;
  const bboxH = (maxY - minY) * scaleY;
  return {
    cx: (sumX / sumW) * scaleX,
    cy: (sumY / sumW) * scaleY,
    radius: Math.max(bboxW, bboxH) * 0.65,
  };
}

// Effects entry point. `effects` is a map of enabled effects — each value is
// either `true` (use defaults) or an object of param overrides.
export async function applyEffects(bytes, effects, base = "", { output = "jpeg", mask = null } = {}) {
  if (!effects) return bytes;
  const keys = Object.keys(effects).filter((k) => effects[k] && EFFECTS[k]);
  if (!keys.length) return bytes;

  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);

  const paramsFor = (k) => (typeof effects[k] === "object" ? effects[k] : {});
  const clarityKeys = keys.filter((k) => k === "clarity");
  const overlayKeys = keys.filter((k) => k !== "clarity");

  for (const key of clarityKeys) {
    await EFFECTS[key](canvas, ctx, { params: paramsFor(key), base });
  }

  if (mask && overlayKeys.length) {
    const subjectSnap = new OffscreenCanvas(bmp.width, bmp.height);
    subjectSnap.getContext("2d").drawImage(canvas, 0, 0);

    const center = overlayKeys.includes("spotlight")
      ? await computeSubjectCenter(mask, bmp.width, bmp.height)
      : null;

    for (const key of overlayKeys) {
      await EFFECTS[key](canvas, ctx, { params: paramsFor(key), base, center });
    }

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
      await EFFECTS[key](canvas, ctx, { params: paramsFor(key), base, center: null });
    }
  }

  const blob = await canvas.convertToBlob(
    output === "png" ? { type: "image/png" } : { type: "image/jpeg", quality: 0.92 }
  );
  return new Uint8Array(await blob.arrayBuffer());
}
