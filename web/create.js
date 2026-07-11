// Create-a-post — a manifest-driven card maker. Picking a template loads its
// manifest and builds exactly the fields that template needs (text + font size,
// image mode/slots, circle, tweet screenshot, emoji picker). The heavy lifting
// lives in the shared core; this file only builds the form and the render
// request. The list of templates comes from registry.js (not hard-coded), and
// `?template=<id>` deep-links a starting template (used by the gallery's "Use").

import { RenderSession } from "./session.js";
import { balanceText } from "../src/core/textwrap.js";
import { listTemplates } from "./registry.js";
import { mountNav } from "./ui/nav.js";

const BASE = "..";
let TEMPLATES = [];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "dataset") Object.assign(node.dataset, v);
    else node[k] = v;
  }
  return node;
};
const humanize = (s) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const setStatus = (m) => { $("status").textContent = m; };

const session = new RenderSession({ base: BASE });

// A template's reflow blocks — a single `layout.block` or a `layout.blocks`
// array (multi-headline templates like the two-quote card). Mirrors getBlocks
// in the renderer so the form and the render request stay in sync.
const layoutBlocks = (m) => m.layout?.blocks || (m.layout?.block ? [m.layout.block] : []);

// Per-render UI state, rebuilt on template change.
let manifest = null;
let controls = {};        // { texts:{key:el}, fontSizes:{field:el}, rows, rowsBlock, mode, images:{slot}, circle, tweet, emoji }
let measurer = null, measurerSize = null;
let lastPng = null;

// ---- Form building -------------------------------------------------------

function card(...children) {
  const c = el("div", { className: "card" });
  c.append(...children);
  return c;
}
function field(labelText, control) {
  const f = el("div", { className: "field" });
  f.append(el("label", { textContent: labelText }), control);
  return f;
}
function segmented(items, selected, onSelect) {
  const seg = el("div", { className: "seg", role: "group" });
  for (const it of items) {
    const b = el("button", { type: "button", textContent: it.label });
    b.dataset.value = it.value;
    b.setAttribute("aria-pressed", String(it.value === selected));
    b.addEventListener("click", () => {
      for (const x of seg.children) x.setAttribute("aria-pressed", String(x === b));
      onSelect(it.value);
    });
    seg.append(b);
  }
  return seg;
}
function fileInput() {
  return el("input", { type: "file", accept: "image/*" });
}

// An image source for one slot: upload a file OR search the web and tap a result.
// The two are mutually exclusive — the most recent choice wins. `getValue()`
// returns a File, a proxied-URL string ("/api/fetch?url=…"), or null (keep the
// template default). The proxied string flows through env.loadImage unchanged,
// so the render path is identical to an uploaded photo.
function imagePicker() {
  let value = null;
  const wrap = el("div", { className: "imgpick" });
  const file = fileInput();
  const toggle = el("button", { type: "button", className: "imgpick-toggle", textContent: "Search the web" });

  const panel = el("div", { className: "search-panel hidden" });
  const q = el("input", { type: "text", placeholder: "Search images" });
  const go = el("button", { type: "button", className: "search-go", textContent: "Go" });
  const row = el("div", { className: "search-row" });
  row.append(q, go);

  // Two counts only: Serper charges a higher tier above 10 results (and rounds
  // any 11–100 up to 100), so an in-between value costs the same as 100 for fewer
  // images. The 100 set comes back in one call and is paged locally (below).
  const count = el("select", { className: "search-count" });
  count.append(
    el("option", { value: "10", textContent: "10 results" }),
    el("option", { value: "100", textContent: "100 results" })
  );
  // "High quality" prefers large (≥4-megapixel) images so they fill the template
  // without upscaling. On by default; falls back to all results if too few pass.
  const hq = el("input", { type: "checkbox", id: `hq-${Math.random().toString(36).slice(2)}`, checked: true });
  const hqLabel = el("label", { className: "search-opt", htmlFor: hq.id, textContent: " High quality (large images)" });
  hqLabel.prepend(hq);
  const opts = el("div", { className: "search-opts" });
  opts.append(count, hqLabel);

  const grid = el("div", { className: "search-grid" });
  const pager = el("div", { className: "search-pager hidden" });
  const prev = el("button", { type: "button", className: "pager-btn", textContent: "Prev" });
  const next = el("button", { type: "button", className: "pager-btn", textContent: "Next" });
  const pageLabel = el("span", { className: "pager-label" });
  pager.append(prev, pageLabel, next);
  const msg = el("div", { className: "search-msg" });
  panel.append(row, opts, grid, pager, msg);

  const chosen = el("div", { className: "imgpick-chosen hidden" });
  const chosenImg = el("img", { alt: "selected web image" });
  const clearBtn = el("button", { type: "button", textContent: "Clear" });
  chosen.append(chosenImg, el("span", { textContent: "Web image selected" }), clearBtn);

  // Paged display of a single search's results: one fetch fills `results`, and
  // paging just slices it — moving between pages makes no further API calls.
  const PAGE_SIZE = 12;
  let results = [];
  let page = 0;
  let selectedFull = null; // track the chosen image so it stays highlighted across pages

  const markSelection = () => {
    for (const im of grid.children)
      im.setAttribute("aria-selected", String(selectedFull != null && im.dataset.full === selectedFull));
  };
  const renderPage = () => {
    grid.replaceChildren();
    const start = page * PAGE_SIZE;
    for (const r of results.slice(start, start + PAGE_SIZE)) {
      const im = el("img", { src: r.thumb, loading: "lazy", alt: "", dataset: { full: r.full } });
      // Show each result at its true aspect ratio (like Google Images). Setting it
      // from the known dimensions also reserves the right height before load.
      if (r.w && r.h) im.style.aspectRatio = `${r.w} / ${r.h}`;
      im.addEventListener("click", () => useWebImage(r));
      grid.append(im);
    }
    markSelection();
    const pages = Math.ceil(results.length / PAGE_SIZE);
    pager.classList.toggle("hidden", pages <= 1);
    pageLabel.textContent = `${page + 1} / ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  };

  const useFile = () => {
    if (!file.files[0]) return;
    value = file.files[0];
    chosen.classList.add("hidden");
    selectedFull = null; markSelection();
  };
  const useWebImage = (r) => {
    value = `/api/fetch?url=${encodeURIComponent(r.full)}`;
    chosenImg.src = r.thumb;
    chosen.classList.remove("hidden");
    file.value = "";
    selectedFull = r.full; markSelection();
  };
  const clear = () => {
    value = file.files[0] || null;
    chosen.classList.add("hidden");
    selectedFull = null; markSelection();
  };

  file.addEventListener("change", useFile);
  clearBtn.addEventListener("click", clear);
  toggle.addEventListener("click", () => panel.classList.toggle("hidden"));
  prev.addEventListener("click", () => { if (page > 0) { page--; renderPage(); } });
  next.addEventListener("click", () => { if ((page + 1) * PAGE_SIZE < results.length) { page++; renderPage(); } });
  // hq re-filters live (same result count, just a filter tweak). count is NOT
  // live — it's applied on the next Go, so picking a bigger result set never
  // fires a search on its own.
  hq.addEventListener("change", () => { if (q.value.trim()) search(); });

  const search = async () => {
    const term = q.value.trim();
    if (!term) return;
    msg.textContent = "Searching";
    grid.replaceChildren();
    pager.classList.add("hidden");
    results = []; page = 0;
    try {
      const params = new URLSearchParams({ q: term, count: count.value });
      if (hq.checked) params.set("hq", "1");
      const res = await fetch(`/api/search?${params}`);
      // The Function always returns JSON; a non-JSON body means it isn't running
      // (e.g. served by a plain static server, not `wrangler pages dev`).
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`search unavailable (HTTP ${res.status})`);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.results?.length) { msg.textContent = "No results"; return; }
      msg.textContent = "";
      results = data.results;
      renderPage();
    } catch (err) {
      msg.textContent = `search error: ${err.message}`;
    }
  };
  go.addEventListener("click", search);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });

  wrap.append(file, toggle, panel, chosen);
  return { node: wrap, getValue: () => value };
}

const NUDGE_STEP = 40; //   px per tap (move)
const ZOOM_STEP = 0.1; //   factor per tap (zoom)
const ZOOM_MIN = 0.5, ZOOM_MAX = 3; // clamp: 0.5x reveals more, 3x crops in

// Framing control for one image slot: arrows move the picked image within its
// crop and -/+ zoom it. Applied at render time (request.offsets[key] +
// request.zoom[key]).
function frameControl(key) {
  controls.offsets[key] = [0, 0];
  controls.zoom[key] = 1;
  const readout = el("span", { className: "pill", textContent: "0, 0" });
  const zoomOut = el("span", { className: "pill", textContent: "100%" });
  const update = () => {
    const o = controls.offsets[key];
    readout.textContent = `${o[0]}, ${o[1]}`;
    zoomOut.textContent = `${Math.round(controls.zoom[key] * 100)}%`;
  };
  const bump = (dx, dy) => {
    const o = controls.offsets[key];
    o[0] += dx * NUDGE_STEP;
    o[1] += dy * NUDGE_STEP;
    update();
  };
  const zoomBy = (d) => {
    controls.zoom[key] = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(controls.zoom[key] + d).toFixed(2)));
    update();
  };
  // Arrow buttons use a CSS triangle (no glyph); zoom + re-center are text buttons.
  const triBtn = (triClass, title, onClick) => {
    const b = el("button", { type: "button", className: "nudge-btn", title });
    b.append(el("span", { className: `tri ${triClass}` }));
    b.addEventListener("click", onClick);
    return b;
  };
  const textBtn = (label, title, onClick) => {
    const b = el("button", { type: "button", className: "nudge-btn", textContent: label, title });
    b.addEventListener("click", onClick);
    return b;
  };
  const wrap = el("div", { className: "nudge" });
  wrap.append(
    el("span", { className: "nudge-label", textContent: "Frame" }),
    triBtn("tri-left", "Left", () => bump(-1, 0)),
    triBtn("tri-up", "Up", () => bump(0, -1)),
    triBtn("tri-down", "Down", () => bump(0, 1)),
    triBtn("tri-right", "Right", () => bump(1, 0)),
    el("span", { className: "nudge-label", textContent: "Zoom" }),
    textBtn("-", "Zoom out", () => zoomBy(-ZOOM_STEP)),
    textBtn("+", "Zoom in", () => zoomBy(ZOOM_STEP)),
    textBtn("Reset", "Re-center and reset zoom", () => {
      controls.offsets[key] = [0, 0];
      controls.zoom[key] = 1;
      update();
    }),
    readout,
    zoomOut
  );
  return wrap;
}

async function buildForm() {
  const form = $("form");
  form.replaceChildren();
  controls = { texts: {}, fontSizes: {}, verticalScales: {}, images: {}, offsets: {}, zoom: {}, effects: {} };
  measurer = null; measurerSize = null;

  const blocks = layoutBlocks(manifest);
  const blockFields = new Set(blocks.map((b) => b.field));
  const balanceFields = new Set(blocks.filter((b) => b.balance).map((b) => b.field));

  // Text fields (+ a font-size slider per reflow block).
  const textKeys = Object.keys(manifest.text || {});
  if (textKeys.length) {
    const textCard = card();
    for (const key of textKeys) {
      // Multi-line textarea for reflow-block fields (the headlines) and single-
      // field templates; single-line input for short fields like captions.
      const multiline = blockFields.has(key) || textKeys.length === 1;
      const input = multiline
        ? el("textarea", { placeholder: humanize(key) })
        : el("input", { type: "text", placeholder: humanize(key) });
      controls.texts[key] = input;
      textCard.append(field(multiline ? `${humanize(key)} (Enter forces a line break)` : humanize(key), input));
      if (balanceFields.has(key)) input.addEventListener("input", updateEstimate);
    }
    // One size slider per block. A balancing (point-text) block also shows a live
    // row-count estimate; area-text blocks (fixed-width boxes) just show px.
    for (const block of blocks) {
      const range = el("input", { type: "range", min: 48, max: 160, step: 1, value: block.fontSizeDefault || 100 });
      const sizeOut = el("span", { textContent: range.value });
      controls.fontSizes[block.field] = range;
      const rowEl = el("div", { className: "row" });
      rowEl.append(range, wrapPill(sizeOut, " px"));
      if (block.balance) {
        const rowsOut = el("span", { textContent: "-" });
        controls.rows = rowsOut; controls.rowsBlock = block;
        rowEl.append(wrapPill(rowsOut, " rows"));
        range.addEventListener("input", () => { sizeOut.textContent = range.value; updateEstimate(); });
      } else {
        range.addEventListener("input", () => { sizeOut.textContent = range.value; });
      }
      // Label the slider by field when a template has more than one.
      const sizeLabel = blocks.length > 1 ? `${humanize(block.field)} size` : "Font size";
      textCard.append(field(sizeLabel, rowEl));

      // Vertical scale slider (text height without affecting width).
      const vsRange = el("input", { type: "range", min: 50, max: 200, step: 1, value: 100 });
      const vsOut = el("span", { textContent: "100" });
      controls.verticalScales[block.field] = vsRange;
      const vsRow = el("div", { className: "row" });
      vsRow.append(vsRange, wrapPill(vsOut, "%"));
      vsRange.addEventListener("input", () => { vsOut.textContent = vsRange.value; });
      const vsLabel = blocks.length > 1 ? `${humanize(block.field)} height` : "Text height";
      textCard.append(field(vsLabel, vsRow));
    }
    form.append(textCard);
  }

  // Image mode + slots.
  if (manifest.imageModes) {
    const imgCard = card();
    const modes = Object.keys(manifest.imageModes);
    controls.mode = modes[0];
    const slotsHost = el("div");
    const renderSlots = () => {
      slotsHost.replaceChildren();
      controls.images = {};
      for (const slotKey of Object.keys(manifest.imageModes[controls.mode].slots)) {
        const picker = imagePicker();
        controls.images[slotKey] = picker;
        const f = field(humanize(slotKey), picker.node);
        f.append(frameControl(slotKey));
        slotsHost.append(f);
      }
    };
    if (modes.length > 1) {
      imgCard.append(field("Background",
        segmented(modes.map((m) => ({ value: m, label: humanize(m) })), controls.mode, (m) => { controls.mode = m; renderSlots(); })));
    }
    renderSlots();
    imgCard.append(slotsHost);
    form.append(imgCard);
  }

  // Overlays: circle, tweet, emoji.
  const extras = card();
  let hasExtras = false;
  if (manifest.circle) {
    controls.circle = imagePicker();
    const cf = field("Circle inset (optional)", controls.circle.node);
    cf.append(frameControl("circle"));
    extras.append(cf);
    hasExtras = true;
  }
  if (manifest.tweet) {
    controls.tweet = fileInput();
    const tf = field("Tweet screenshot (dark mode)", controls.tweet);
    tf.append(frameControl("tweet"));
    if (manifest.tweet.clear?.length) {
      const wmId = `wm-${Math.random().toString(36).slice(2)}`;
      const wmCb = el("input", { type: "checkbox", id: wmId, checked: true });
      const wmLbl = el("label", { className: "search-opt", htmlFor: wmId, textContent: " Remove watermark" });
      wmLbl.prepend(wmCb);
      controls.tweetClearWm = wmCb;
      tf.append(wmLbl);
    }
    extras.append(tf);
    hasExtras = true;
  }
  if (manifest.emoji) {
    const keys = Object.keys(manifest.emoji.layers);
    controls.emoji = keys[0];
    const emojiField = field("Emoji",
      segmented(keys.map((k) => ({ value: k, label: humanize(k) })), controls.emoji, (k) => { controls.emoji = k; }));
    emojiField.append(frameControl("emoji"));
    if (manifest.emoji.follow) {
      emojiField.append(el("p", { className: "hint",
        textContent: "Type [e] in the text where the emoji should sit. Omit it to put the emoji at the end." }));
    }
    extras.append(emojiField);
    hasExtras = true;
  }
  if (hasExtras) form.append(extras);

  // Photo effects toggles — applied to base images before placement.
  if (manifest.imageModes) {
    const FX = [
      { key: "clarity", label: "Clarity boost" },
      { key: "edgeGlow", label: "Edge glow" },
      { key: "halftone", label: "Halftone light" },
      { key: "grit", label: "Grit light" },
      { key: "condensation", label: "Condensation" },
      { key: "topographic", label: "Topo lines" },
      { key: "lightLeak", label: "Light leak" },
      { key: "triangles", label: "Triangles" },
    ];
    const fxCard = card();
    const fxGrid = el("div", { className: "fx-grid" });
    for (const fx of FX) {
      const id = `fx-${fx.key}`;
      const cb = el("input", { type: "checkbox", id });
      const lbl = el("label", { className: "fx-toggle", htmlFor: id });
      lbl.append(cb, document.createTextNode(fx.label));
      controls.effects[fx.key] = cb;
      fxGrid.append(lbl);
    }
    fxCard.append(el("label", { textContent: "Photo effects" }), fxGrid);
    form.append(fxCard);
  }

  await updateEstimate();
}

function wrapPill(span, suffix) {
  const p = el("span", { className: "pill" });
  p.append(span, document.createTextNode(suffix));
  return p;
}

// ---- Live row estimate (same balanced wrap the render uses) ---------------

async function updateEstimate() {
  const block = controls.rowsBlock;
  if (!block || !controls.rows) return;
  const size = Number(controls.fontSizes[block.field].value);
  if (measurerSize !== size) {
    measurer = await session.env.createMeasurer({ font: block.font, fontPx: size });
    measurerSize = size;
  }
  const upper = manifest.textTransform === "uppercase";
  const raw = controls.texts[block.field]?.value || " ";
  const text = upper ? raw.toUpperCase() : raw;
  controls.rows.textContent = balanceText(text, measurer, block.width).split("\n").length;
}

// ---- Request + render -----------------------------------------------------

function buildRequest() {
  const req = { template: manifest.name };
  for (const [key, input] of Object.entries(controls.texts)) req[key] = input.value;
  // One block -> a single `fontSize`; multiple -> a per-field `fontSizes` map.
  const blocks = layoutBlocks(manifest);
  if (blocks.length === 1) {
    req.fontSize = Number(controls.fontSizes[blocks[0].field].value);
    const vs = Number(controls.verticalScales[blocks[0].field]?.value);
    if (vs && vs !== 100) req.verticalScale = vs;
  } else if (blocks.length > 1) {
    req.fontSizes = {};
    const verticalScales = {};
    for (const b of blocks) {
      req.fontSizes[b.field] = Number(controls.fontSizes[b.field].value);
      const vs = Number(controls.verticalScales[b.field]?.value);
      if (vs && vs !== 100) verticalScales[b.field] = vs;
    }
    if (Object.keys(verticalScales).length) req.verticalScales = verticalScales;
  }
  if (controls.mode) {
    req.mode = controls.mode;
    req.images = {};
    for (const [slot, picker] of Object.entries(controls.images)) {
      const v = picker.getValue();
      if (v) req.images[slot] = v;
    }
  }
  if (controls.circle) {
    const v = controls.circle.getValue();
    if (v) req.circle = v;
  }
  if (controls.tweet?.files[0]) req.tweet = controls.tweet.files[0];
  if (controls.tweetClearWm && !controls.tweetClearWm.checked) req.tweetKeepWatermark = true;
  if (controls.emoji) req.emoji = controls.emoji;

  // Framing offsets + zoom — all layers that have a frame control.
  const offsets = {};
  const zoom = {};
  const used = [
    ...Object.keys(req.images || {}),
    ...(req.circle ? ["circle"] : []),
    ...(req.tweet ? ["tweet"] : []),
    ...(req.emoji ? ["emoji"] : []),
  ];
  for (const key of used) {
    const o = controls.offsets[key];
    if (o && (o[0] || o[1])) offsets[key] = o;
    const z = controls.zoom[key];
    if (z && z !== 1) zoom[key] = z;
  }
  if (Object.keys(offsets).length) req.offsets = offsets;
  if (Object.keys(zoom).length) req.zoom = zoom;

  const effects = {};
  for (const [key, cb] of Object.entries(controls.effects || {})) {
    if (cb.checked) effects[key] = true;
  }
  if (Object.keys(effects).length) req.effects = effects;

  return req;
}

async function generate() {
  $("generate").disabled = true;
  const t0 = performance.now();
  try {
    const png = await session.render(buildRequest(), setStatus);
    lastPng = new Blob([png], { type: "image/png" });
    const img = $("preview");
    img.src = URL.createObjectURL(lastPng);
    img.style.display = "block";
    $("download").classList.remove("hidden");
    if (navigator.canShare) $("share").classList.remove("hidden");
    setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  } finally {
    $("generate").disabled = false;
  }
}

function download() {
  if (!lastPng) return;
  const a = el("a", { href: URL.createObjectURL(lastPng), download: `${manifest.name}.png` });
  a.click();
}
async function share() {
  if (!lastPng) return;
  const file = new File([lastPng], `${manifest.name}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* cancelled */ }
  } else download();
}

async function selectTemplate(id) {
  setStatus("Loading template");
  manifest = await session.env.loadManifest(id);
  await buildForm();
  setStatus(session.client ? "Ready" : "Starting");
}

// ---- Init -----------------------------------------------------------------

async function init() {
  mountNav("create");
  TEMPLATES = await listTemplates();
  // Deep link: ?template=<id> (from the gallery's "Use") picks the start template.
  const wanted = new URLSearchParams(location.search).get("template");
  const start = TEMPLATES.find((t) => t.id === wanted)?.id || TEMPLATES[0].id;

  // Full-name dropdown (templates have descriptive names now, too long for a
  // segmented row).
  const picker = $("templatePicker");
  picker.replaceChildren(
    ...TEMPLATES.map((t) => el("option", { value: t.id, textContent: t.label, selected: t.id === start }))
  );
  picker.addEventListener("change", () => selectTemplate(picker.value));
  await selectTemplate(start);

  await session.ready;
  setStatus("Ready");
  $("generate").disabled = false;
}

$("generate").addEventListener("click", generate);
$("download").addEventListener("click", download);
$("share").addEventListener("click", share);

init().catch((err) => { console.error(err); setStatus(`Startup error: ${err.message}`); });
