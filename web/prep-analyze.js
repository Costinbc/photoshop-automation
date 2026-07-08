// Template-prep analyzer (pure) — the browser port of experiments/template_prep.py.
//
// Given a PSD parsed by ag-psd, it derives everything the render pipeline can
// figure out on its own and emits, for EVERY layer (top-to-bottom, like the
// Photoshop layers panel), a suggested role plus pre-filled parameters. The prep
// UI (prep.js) renders that list and lets the user accept or change each role —
// machine proposes, human ratifies.
//
// Kept pure (no DOM, no I/O) so the heuristics stay testable and mirror the
// Python prototype. ag-psd field mapping (verified against the MARE test PSD):
// l.clipping, l.hidden, l.text.style.font.name / .fontSize, l.text.shapeType
// ("point"|"box"), l.placedLayer (smart-object marker), l.left/top/right/bottom.
// children[] is bottom-to-top, so a clipping layer's base is its PREVIOUS sibling
// and Photoshop's top-to-bottom order is the reverse of each children[] array.

const EMOJI_RE = /_1f[0-9a-f]{3}|face|emoji/i;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Best-effort match a PostScript font name (e.g. "FranklinGothic-Heavy") to an
// available .ttf filename. Same first-6-chars heuristic as the Python version.
export function mapFont(psName, fontFiles) {
  const n = norm(psName);
  for (const f of fontFiles) {
    const fn = norm(f.replace(/\.[^.]+$/, ""));
    if (fn.startsWith(n.slice(0, 6)) || n.startsWith(fn.slice(0, 6))) return f;
  }
  return null;
}

const bbox = (l) => [l.left | 0, l.top | 0, l.right | 0, l.bottom | 0];
const areaOf = (b) => (b[2] - b[0]) * (b[3] - b[1]);

// Flatten to a list tagging each layer with its clip base (the sibling directly
// below it) when it's a clipping layer. Recurses into groups.
function flatten(children, out = []) {
  let prev = null;
  for (const l of children || []) {
    out.push({ layer: l, clipBase: l.clipping && prev ? prev.name : null });
    if (l.children) flatten(l.children, out);
    prev = l;
  }
  return out;
}

function fontsOf(textLayer) {
  const used = new Set();
  const add = (st) => { const n = st?.font?.name; if (n) used.add(n); };
  add(textLayer.style);
  for (const run of textLayer.styleRuns || []) add(run.style);
  return [...used];
}

const kindOf = (l) => {
  if (l.children) return "group";
  if (l.text) return "text";
  if (l.placedLayer && EMOJI_RE.test(l.name)) return "emoji";
  if (l.placedLayer) return "image";
  if (/ellipse|circle/i.test(l.name)) return "shape";
  return "image"; // raster; may be a photo slot or just static art — role decides
};

// Analyze a parsed PSD against the available fonts. Returns:
//   { canvas:[W,H], fonts:[ttf], fontsUnmatched:[psName], facts:[str],
//     layers:[ { name, kind, depth, isGroup, hidden, suggestion:{role,params}, _layer } ] }
// where `layers` is top-to-bottom (Photoshop order) and `_layer` is the ag-psd
// layer object (kept for the UI to read per-layer thumbnails; never serialized).
export function analyze(psd, fontFiles) {
  const W = psd.width, H = psd.height;
  const flat = flatten(psd.children);

  const facts = [`Canvas ${W} x ${H}`];
  const fontsUsed = new Map(); // psName -> ttf | null

  const texts = [];  // { layer, size, area }
  const images = [];  // { layer, frac, clipBase, bbox }
  const emojis = [];  // layer
  let ellipse = null;

  for (const { layer: l, clipBase } of flat) {
    if (l.children) continue;
    const k = kindOf(l);
    if (k === "text") {
      for (const f of fontsOf(l.text)) if (!fontsUsed.has(f)) fontsUsed.set(f, mapFont(f, fontFiles));
      texts.push({ layer: l, size: l.text.style?.fontSize ? Math.round(l.text.style.fontSize) : null, area: l.text.shapeType === "box" });
    } else if (k === "emoji") {
      emojis.push(l);
    } else if (k === "shape") {
      ellipse = l;
    } else if (k === "image") {
      const b = bbox(l);
      images.push({ layer: l, frac: areaOf(b) / (W * H), clipBase, bbox: b });
    }
  }

  // Headline = largest visible text; circle = ellipse + the image clipped onto it.
  const headline = texts.filter((t) => !t.layer.hidden)
    .reduce((best, t) => (!best || (t.size || 0) > (best.size || 0) ? t : best), null)?.layer || null;
  const circleImg = ellipse ? (images.find((im) => im.clipBase === ellipse.name)?.layer || null) : null;

  // Photo slots: big rasters/SOs that aren't the circle image and either are
  // placed (smart object) or spill past the canvas edges (scaled to cover).
  const extendsBeyond = (b) => b[0] < 0 || b[1] < 0 || b[2] > W || b[3] > H;
  const slotSet = new Set(images
    .filter((im) => im.layer !== circleImg && im.frac >= 0.3 && norm(im.layer.name) !== "background" &&
                    (!!im.layer.placedLayer || extendsBeyond(im.bbox)))
    .sort((a, b) => b.frac - a.frac)
    .map((im) => im.layer));
  const primarySlot = [...slotSet][0] || null;

  // ---- Per-role suggested params ----
  const clampFrame = (b) => {
    const x = Math.max(0, b[0]), y = Math.max(0, b[1]);
    return [x, y, Math.min(W, b[2]) - x, Math.min(H, b[3]) - y];
  };
  const photoFrame = (im) => (extendsBeyond(im.bbox) ? [0, 0, W, H] : clampFrame(im.bbox));
  const emojiKey = (name) => slug(name.match(/^[a-z0-9]+/i)?.[0] || name.slice(0, 6));

  const textParams = (t) => {
    const psList = [...fontsOf(t.layer.text)];
    const ttf = psList.map((f) => fontsUsed.get(f)).find(Boolean) || null;
    const b = bbox(t.layer);
    return {
      key: t.layer === headline ? "headline" : slug(t.layer.name).slice(0, 20) || "text",
      isHeadline: t.layer === headline, font: ttf, fontPs: psList[0] || null, size: t.size || 100,
      anchorKind: t.area ? "centerY" : "bottomY", bottomY: b[3], centerY: Math.round((b[1] + b[3]) / 2),
      width: W - 120, leading: 1.1,
    };
  };

  const suggestionFor = (l) => {
    if (l.children) return { role: "static", params: {} }; // groups are containers
    if (l === headline) return { role: "text", params: textParams(texts.find((t) => t.layer === l)) };
    if (slotSet.has(l)) {
      const im = images.find((i) => i.layer === l);
      return { role: "photo", params: { key: l === primarySlot ? "main" : slug(l.name), frame: photoFrame(im) } };
    }
    if (l === circleImg) {
      const b = bbox(ellipse);
      return { role: "circle", params: { frame: [b[0], b[1], b[2] - b[0], b[3] - b[1]], base: ellipse.name } };
    }
    if (l.placedLayer && EMOJI_RE.test(l.name)) return { role: "emoji", params: { key: emojiKey(l.name), width: Math.round(l.right - l.left) } };
    if (l.text) return { role: "static", params: {}, textParams: textParams(texts.find((t) => t.layer === l)) }; // static, but "text" is offered
    return { role: "static", params: {} };
  };

  // ---- Build the top-to-bottom layer list (reverse each children[] level) ----
  const layers = [];
  const walk = (children, depth) => {
    for (const l of [...(children || [])].reverse()) {
      layers.push({ name: l.name, kind: kindOf(l), depth, isGroup: !!l.children, hidden: !!l.hidden,
                    suggestion: suggestionFor(l), _layer: l });
      if (l.children) walk(l.children, depth + 1);
    }
  };
  walk(psd.children, 0);

  // ---- AUTO facts (for the status panel) ----
  if (circleImg && ellipse) facts.push(`Circle inset detected ('${ellipse.name}')`);
  const mapped = [...new Set([...fontsUsed.values()].filter(Boolean))];
  const unmatched = [...fontsUsed.entries()].filter(([, v]) => !v).map(([k]) => k);
  if (mapped.length) facts.push(`${mapped.length} font${mapped.length > 1 ? "s" : ""} matched`);

  return { canvas: [W, H], fonts: mapped, fontsUnmatched: unmatched, facts, layers };
}
