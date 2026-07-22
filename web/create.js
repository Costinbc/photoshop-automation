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
const setStatus = (m, { error = false, retry = false } = {}) => {
  $("status").textContent = m;
  $("statusBar").classList.toggle("status-error", !!error);
  $("retry").classList.toggle("hidden", !retry);
};

const session = new RenderSession({ base: BASE });

// A template's reflow blocks — a single `layout.block` or a `layout.blocks`
// array (multi-headline templates like the two-quote card). Mirrors getBlocks
// in the renderer so the form and the render request stay in sync.
const layoutBlocks = (m) => m.layout?.blocks || (m.layout?.block ? [m.layout.block] : []);

// Per-effect tuneable params. Defaults MUST match the fallback constants
// baked into each effect fn in `web/effects.js` — a knob at its default value
// is dropped from the request so `effects: true` still works.
//   type: undefined = range; "color" = #hex picker; "select" = enum dropdown
//   min/max/step apply to ranges only. `suffix` (e.g. "°", "%") is display-only.
function buildFxDefs() {
  const R = (label, key, min, max, def, opts = {}) =>
    ({ key, label, min, max, default: def, step: opts.step, suffix: opts.suffix, full: opts.full });
  const C = (label, key, def, opts = {}) =>
    ({ key, label, type: "color", default: def, full: opts.full });
  const S = (label, key, options, def) =>
    ({ key, label, type: "select", options, default: def });
  return [
    { key: "clarity", label: "Clarity boost", params: [
      R("Intensity", "intensity", 0, 100, 50, { suffix: "%" }),
      R("Radius",    "radius",    5, 60, 20, { suffix: "px" }),
    ]},
    { key: "edgeGlow", label: "Edge glow", params: [
      R("Intensity", "intensity", 0, 100, 35, { suffix: "%" }),
      R("Width",     "width",     10, 100, 45, { suffix: "%" }),
      S("Side",      "side",      ["right", "left", "top", "bottom"], "right"),
      C("Color",     "color",     "#ff8c28"),
    ]},
    { key: "halftone", label: "Halftone light", params: [
      R("Intensity", "intensity", 0, 100, 15, { suffix: "%" }),
      R("Spacing",   "spacing",   6, 40, 14, { suffix: "px" }),
      C("Color",     "color",     "#ffffff", { full: true }),
    ]},
    { key: "grit", label: "Grit", params: [
      R("Intensity", "intensity", 0, 100, 50, { suffix: "%" }),
      R("Vignette",  "vignette",  0, 100, 25, { suffix: "%" }),
    ]},
    { key: "condensation", label: "Condensation", params: [
      R("Intensity", "intensity", 0, 100, 18, { suffix: "%" }),
      R("Blur",      "blur",      0, 8, 2, { step: 0.5, suffix: "px" }),
    ]},
    { key: "topographic", label: "Topo lines", params: [
      R("Intensity", "intensity", 0, 100, 14, { suffix: "%" }),
      R("Line count","count",     5, 40, 18),
      C("Color",     "color",     "#ffffff", { full: true }),
    ]},
    { key: "lightLeak", label: "Light leak", params: [
      R("Intensity", "intensity", 0, 100, 32, { suffix: "%" }),
      R("Angle",     "angle",     0, 360, 45, { suffix: "°" }),
      C("Color 1",   "color1",    "#ffa03c"),
      C("Color 2",   "color2",    "#ff64b4"),
    ]},
    { key: "triangles", label: "Triangles", params: [
      R("Intensity", "intensity", 0, 100, 12, { suffix: "%" }),
      R("Size",      "size",      30, 200, 80, { suffix: "px" }),
      C("Color",     "color",     "#ffffff", { full: true }),
    ]},
    { key: "brush", label: "Brush strokes", params: [
      R("Intensity", "intensity", 0, 100, 90, { suffix: "%" }),
      R("Strokes",   "count",     1, 6, 3),
      R("Angle",     "angle",     -45, 45, 0, { suffix: "°" }),
      C("Color",     "color",     "#ffffff"),
    ]},
    { key: "spatter", label: "Ink spatter", params: [
      R("Intensity", "intensity", 0, 100, 95, { suffix: "%" }),
      R("Density",   "density",   20, 200, 100, { suffix: "%" }),
      C("Color",     "color",     "#ffffff", { full: true }),
    ]},
    { key: "smoke", label: "Smoke", params: [
      R("Intensity", "intensity", 0, 100, 100, { suffix: "%" }),
      R("Angle",     "angle",     -45, 45, 0, { suffix: "°" }),
      C("Color",     "color",     "#f5f5fa", { full: true }),
    ]},
    { key: "spotlight", label: "Spotlight", params: [
      R("Darkness",  "darkness",  0, 100, 75, { suffix: "%" }),
      R("Halo size", "scale",     30, 200, 100, { suffix: "%" }),
      R("Nudge X",   "dx",        -50, 50, 0, { suffix: "%" }),
      R("Nudge Y",   "dy",        -50, 50, 0, { suffix: "%" }),
      C("Light tint","tint",      "#ffffff", { full: true }),
    ]},
  ];
}

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
  // Search fires ONLY on the Go button. Changing the query, result count, or
  // the HQ toggle updates state but does not trigger a fetch — that avoids
  // burning credits on every keystroke or option flip.
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
  // Prevent implicit form submit on Enter, but do NOT trigger a search —
  // per user requirement, Go is the only trigger.
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });

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

  const offX = el("input", { type: "number", className: "nudge-input", value: "0", title: "X offset (px)" });
  const offY = el("input", { type: "number", className: "nudge-input", value: "0", title: "Y offset (px)" });
  const zoomIn = el("input", { type: "number", className: "nudge-input nudge-input-zoom", value: "100", title: "Zoom (%)", min: Math.round(ZOOM_MIN * 100), max: Math.round(ZOOM_MAX * 100), step: "10" });

  const update = () => {
    const o = controls.offsets[key];
    offX.value = o[0];
    offY.value = o[1];
    zoomIn.value = Math.round(controls.zoom[key] * 100);
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

  offX.addEventListener("change", () => { controls.offsets[key][0] = parseInt(offX.value, 10) || 0; });
  offY.addEventListener("change", () => { controls.offsets[key][1] = parseInt(offY.value, 10) || 0; });
  zoomIn.addEventListener("change", () => {
    const v = parseInt(zoomIn.value, 10) || 100;
    controls.zoom[key] = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v / 100));
    update();
  });

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
    offX, offY,
    el("span", { className: "nudge-label", textContent: "Zoom" }),
    textBtn("-", "Zoom out", () => zoomBy(-ZOOM_STEP)),
    textBtn("+", "Zoom in", () => zoomBy(ZOOM_STEP)),
    zoomIn,
    textBtn("Reset", "Re-center and reset zoom", () => {
      controls.offsets[key] = [0, 0];
      controls.zoom[key] = 1;
      update();
    }),
  );
  return wrap;
}

// Per-block vertical nudge: shift a whole quote+caption band up or down.
// Default position is set by the manifest (bottom of each band); this lets the
// user move the group to make everything fit without editing the template.
function blockNudge(field) {
  controls.blockOffsets[field] = [0, 0];
  const NUDGE = 20; // px per tap — text bands are finer than image slots

  const nY = el("input", { type: "number", className: "nudge-input", value: "0", title: "Vertical offset (px)" });
  const update = () => { nY.value = controls.blockOffsets[field][1]; };
  const bump = (dy) => { controls.blockOffsets[field][1] += dy * NUDGE; update(); };
  nY.addEventListener("change", () => { controls.blockOffsets[field][1] = parseInt(nY.value, 10) || 0; });

  const triBtn = (triClass, title, onClick) => {
    const b = el("button", { type: "button", className: "nudge-btn", title });
    b.append(el("span", { className: `tri ${triClass}` }));
    b.addEventListener("click", onClick);
    return b;
  };
  const wrap = el("div", { className: "nudge" });
  wrap.append(
    el("span", { className: "nudge-label", textContent: "Move" }),
    triBtn("tri-up", "Up", () => bump(-1)),
    triBtn("tri-down", "Down", () => bump(1)),
    nY,
    el("button", {
      type: "button", className: "nudge-btn", textContent: "Reset", title: "Back to default position",
      onclick: () => { controls.blockOffsets[field] = [0, 0]; update(); },
    }),
  );
  return wrap;
}

async function buildForm() {
  const form = $("form");
  form.replaceChildren();
  controls = { texts: {}, fontSizes: {}, verticalScales: {}, blockOffsets: {}, images: {}, offsets: {}, zoom: {}, effects: {} };
  measurer = null; measurerSize = null;

  const blocks = layoutBlocks(manifest);
  const blockFields = new Set(blocks.map((b) => b.field));
  const balanceFields = new Set(blocks.filter((b) => b.balance).map((b) => b.field));

  // Text fields (textarea each — Enter inserts a real newline in every field,
  // captions included). Each field gets a size slider: reflow blocks use their
  // block default + wide range, other fields (captions) use a caption-sized
  // default. Reflow blocks additionally get a height (vertical-scale) slider.
  const textKeys = Object.keys(manifest.text || {});
  const CAPTION_DEFAULT = 40;
  if (textKeys.length) {
    const textCard = card();
    for (const key of textKeys) {
      const block = blocks.find((b) => b.field === key);
      const input = el("textarea", { placeholder: humanize(key) });
      controls.texts[key] = input;
      textCard.append(field(`${humanize(key)} (Enter forces a line break)`, input));
      if (balanceFields.has(key)) input.addEventListener("input", updateEstimate);

      const isBlock = !!block;
      const defaultSize = isBlock ? (block.fontSizeDefault || 100) : (manifest.captionSizes?.[key] || CAPTION_DEFAULT);
      const range = el("input", {
        type: "range",
        min: isBlock ? 48 : 16,
        max: isBlock ? 160 : 120,
        step: 1,
        value: defaultSize,
      });
      const sizeOut = el("span", { textContent: range.value });
      controls.fontSizes[key] = range;
      const rowEl = el("div", { className: "row" });
      rowEl.append(range, wrapPill(sizeOut, " px"));
      if (block?.balance) {
        const rowsOut = el("span", { textContent: "-" });
        controls.rows = rowsOut; controls.rowsBlock = block;
        rowEl.append(wrapPill(rowsOut, " rows"));
        range.addEventListener("input", () => { sizeOut.textContent = range.value; updateEstimate(); });
      } else {
        range.addEventListener("input", () => { sizeOut.textContent = range.value; });
      }
      // Label by field when multiple text fields exist (so "Caption size" vs
      // "Quote size" is unambiguous).
      const sizeLabel = textKeys.length > 1 ? `${humanize(key)} size` : "Font size";
      textCard.append(field(sizeLabel, rowEl));

      // Vertical scale (text height without affecting width) — reflow blocks only.
      if (isBlock) {
        const vsRange = el("input", { type: "range", min: 50, max: 200, step: 1, value: 100 });
        const vsOut = el("span", { textContent: "100" });
        controls.verticalScales[key] = vsRange;
        const vsRow = el("div", { className: "row" });
        vsRow.append(vsRange, wrapPill(vsOut, "%"));
        vsRange.addEventListener("input", () => { vsOut.textContent = vsRange.value; });
        const vsLabel = blocks.length > 1 ? `${humanize(key)} height` : "Text height";
        textCard.append(field(vsLabel, vsRow));

        // Nudge the whole quote+caption band up or down — the manifest picks a
        // default anchor (bottom of the band for multi-band templates); this
        // lets the user reposition to make everything fit.
        const nudgeLabel = blocks.length > 1 ? `${humanize(key)} position` : "Text position";
        textCard.append(field(nudgeLabel, blockNudge(key)));
      }
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
      // Subject cut only makes sense on single-photo modes (one hero subject).
      // Split/double/triple modes have multiple photo halves — the toggle is
      // hidden there.
      if (controls.subjectCutWrap) {
        controls.subjectCutWrap.classList.toggle("hidden", controls.mode !== "single");
      }
    };
    if (modes.length > 1) {
      imgCard.append(field("Background",
        segmented(modes.map((m) => ({ value: m, label: humanize(m) })), controls.mode, (m) => { controls.mode = m; renderSlots(); })));
    }
    renderSlots();
    imgCard.append(slotsHost);

    // Subject cut toggle — placed with the image controls since that's what it
    // affects. Defaults to on for single mode; hidden for split/double/triple.
    const scId = `sc-${Math.random().toString(36).slice(2)}`;
    const scCb = el("input", { type: "checkbox", id: scId, checked: true });
    const scLbl = el("label", { className: "fx-toggle", htmlFor: scId, textContent: " Subject cut (effects sit behind the person)" });
    scLbl.prepend(scCb);
    const scHint = el("p", { className: "hint", textContent: "Isolates the person so overlay effects (edge glow, triangles, halftone…) render behind them. First render downloads a ~9 MB model." });
    const scWrap = el("div");
    scWrap.append(scLbl, scHint);
    controls.subjectCut = scCb;
    controls.subjectCutWrap = scWrap;
    imgCard.append(scWrap);
    if (controls.mode !== "single") scWrap.classList.add("hidden");

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
    // "None" as the leading choice — every template ships with an emoji
    // enabled by default in the PSD; picking None hides all of them and, for
    // inline-follow templates, strips any [e] token from the text. Value ""
    // (falsy) so the existing `if (controls.emoji) req.emoji = …` skip works.
    const emojiKeys = ["", ...keys];
    controls.emoji = keys[0];
    const emojiField = field("Emoji",
      segmented(
        emojiKeys.map((k) => ({ value: k, label: k === "" ? "None" : humanize(k) })),
        controls.emoji,
        (k) => { controls.emoji = k; },
      ));
    emojiField.append(frameControl("emoji"));
    if (manifest.emoji.follow) {
      emojiField.append(el("p", { className: "hint",
        textContent: "Type [e] in the text where the emoji should sit. Omit it to put the emoji at the end." }));
    }
    extras.append(emojiField);
    hasExtras = true;
  }
  if (hasExtras) form.append(extras);

  // Photo effects — collapsible section with per-effect config accordion.
  // Each row: checkbox + label. Clicking the row (not the checkbox) opens a
  // per-effect config panel with tuneable knobs (intensity, colors, position).
  // Request shape: unchecked → omitted; checked with all defaults → `true`;
  // any knob changed → { param: value, ... } object.
  if (manifest.imageModes) {
    const FX_DEFS = buildFxDefs();
    const fxCard = card();
    fxCard.classList.add("fx-card");

    const header = el("div", { className: "fx-header" });
    const chev = el("span", { className: "fx-chev", textContent: "▶" });
    header.append(el("label", { textContent: "Photo effects" }), chev);
    header.addEventListener("click", () => fxCard.classList.toggle("fx-open"));

    const body = el("div", { className: "fx-body" });
    const list = el("div", { className: "fx-list" });

    for (const fx of FX_DEFS) {
      const row = el("div", { className: "fx-row" });
      const rowHead = el("div", { className: "fx-row-head" });
      const cbId = `fx-${fx.key}`;
      const cb = el("input", { type: "checkbox", id: cbId });
      // Stop label-click from bubbling to the row (which would collapse it).
      cb.addEventListener("click", (e) => e.stopPropagation());
      const name = el("span", { className: "fx-name", textContent: fx.label });
      const rowChev = el("span", { className: "fx-chev", textContent: "▶" });
      rowHead.append(cb, name, rowChev);
      rowHead.addEventListener("click", (e) => {
        if (e.target === cb) return;
        row.classList.toggle("fx-open");
      });

      const rowBody = el("div", { className: "fx-row-body" });
      const params = el("div", { className: "fx-params" });
      const state = {}; // param key → current value
      const defaults = {};
      const setters = {}; // param key → (value) → sync UI + state

      for (const p of fx.params) {
        defaults[p.key] = p.default;
        state[p.key] = p.default;
        const wrap = el("div", { className: "fx-param" + (p.full ? " fx-full" : "") });
        const lbl = el("label");
        const nameSpan = el("span", { textContent: p.label });
        const valSpan = el("span", { className: "fx-val" });
        lbl.append(nameSpan, valSpan);
        wrap.append(lbl);

        let input;
        if (p.type === "color") {
          input = el("input", { type: "color", value: p.default });
          input.addEventListener("input", () => { state[p.key] = input.value; valSpan.textContent = input.value; });
          valSpan.textContent = p.default;
          setters[p.key] = (v) => { input.value = v; state[p.key] = v; valSpan.textContent = v; };
        } else if (p.type === "select") {
          input = el("select");
          for (const opt of p.options) input.append(el("option", { value: opt, textContent: opt }));
          input.value = p.default;
          input.addEventListener("input", () => { state[p.key] = input.value; valSpan.textContent = input.value; });
          valSpan.textContent = p.default;
          setters[p.key] = (v) => { input.value = v; state[p.key] = v; valSpan.textContent = v; };
        } else {
          input = el("input", {
            type: "range",
            min: p.min, max: p.max, step: p.step || 1, value: p.default,
          });
          input.addEventListener("input", () => {
            const n = Number(input.value);
            state[p.key] = n;
            valSpan.textContent = p.suffix ? `${n}${p.suffix}` : n;
          });
          valSpan.textContent = p.suffix ? `${p.default}${p.suffix}` : p.default;
          setters[p.key] = (v) => {
            input.value = v; state[p.key] = v;
            valSpan.textContent = p.suffix ? `${v}${p.suffix}` : v;
          };
        }
        wrap.append(input);
        params.append(wrap);
      }

      const reset = el("button", { type: "button", className: "fx-reset", textContent: "Reset to defaults" });
      reset.addEventListener("click", () => {
        for (const [k, v] of Object.entries(defaults)) setters[k](v);
      });

      rowBody.append(params, reset);
      row.append(rowHead, rowBody);
      list.append(row);

      controls.effects[fx.key] = { enabled: cb, state, defaults };
    }

    body.append(list);
    fxCard.append(header, body);
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
  // Every text field now has a size slider (blocks + captions). Send a
  // per-field `fontSizes` map — the renderer applies non-block sizes directly
  // via setFontSize and reflow blocks pick their size up through sizeFor.
  req.fontSizes = {};
  for (const key of Object.keys(controls.fontSizes)) {
    req.fontSizes[key] = Number(controls.fontSizes[key].value);
  }
  const verticalScales = {};
  for (const [key, ctrl] of Object.entries(controls.verticalScales)) {
    const vs = Number(ctrl.value);
    if (vs && vs !== 100) verticalScales[key] = vs;
  }
  if (Object.keys(verticalScales).length) req.verticalScales = verticalScales;
  const blockOffsets = {};
  for (const [field, off] of Object.entries(controls.blockOffsets || {})) {
    if (off && (off[0] || off[1])) blockOffsets[field] = off;
  }
  if (Object.keys(blockOffsets).length) req.blockOffsets = blockOffsets;
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

  // Effects: unchecked → omitted; checked with unchanged knobs → `true`;
  // any knob differs from its default → { paramKey: value, ... } overrides.
  const effects = {};
  for (const [key, ctrl] of Object.entries(controls.effects || {})) {
    if (!ctrl.enabled.checked) continue;
    const overrides = {};
    for (const [pk, v] of Object.entries(ctrl.state)) {
      if (v !== ctrl.defaults[pk]) overrides[pk] = v;
    }
    effects[key] = Object.keys(overrides).length ? overrides : true;
  }
  if (Object.keys(effects).length) req.effects = effects;

  // Subject cut is only relevant to single-photo modes; unchecked → skip cut.
  if (controls.subjectCut && controls.mode === "single" && !controls.subjectCut.checked) {
    req.subjectCut = false;
  }

  return req;
}

// Render state machine. All UI transitions go through setState so the button
// label, disabled flag, and retry visibility are always consistent — no
// half-updated combos like "Cancel button visible after we already rebooted".
//
//   starting  – Photopea booting; button disabled
//   ready     – idle; button "Generate", enabled
//   rendering – render in flight; button "Cancel", enabled
//   resetting – iframe rebooting after cancel/error; button disabled to block
//               spam clicks that would race the reboot
//   error     – hard failure (initial boot or session lost); "Generate" enabled
//               (rebooted already) + Retry button visible
let state = "starting";
// Monotonic id: every cancel/reboot/retry bumps it. Async callbacks (render
// resolves, status logs, ready.then waiters) check their captured token — if
// it no longer matches, they were superseded and quietly bail out.
let renderToken = 0;

function setState(next, statusText, opts = {}) {
  state = next;
  const btn = $("generate");
  const isRendering = next === "rendering";
  btn.textContent = isRendering ? "Cancel" : "Generate";
  btn.classList.toggle("cancel", isRendering);
  btn.disabled = next === "starting" || next === "resetting";
  $("statusBar").classList.toggle("status-error", next === "error");
  $("retry").classList.toggle("hidden", next !== "error");
  if (isRendering) {
    $("download").classList.add("hidden");
    $("share").classList.add("hidden");
  }
  if (statusText != null) $("status").textContent = statusText;
  if (opts.status != null) $("status").textContent = opts.status;
}

// Wait for the session's current iframe to be usable. Wraps rejections so
// callers get a friendly Error and no unhandled promise rejection ever leaks.
// A rejection here means Photopea itself didn't come up (network blocked, 90s
// timeout on the initial "done") — surfaced as an "error" state so the user
// can click Retry to try loading it again.
async function waitReady(token) {
  try {
    await session.ready;
    return true;
  } catch (err) {
    if (token === renderToken) {
      setState("error", `Photopea failed to load: ${err.message}`);
    }
    return false;
  }
}

async function generate() {
  const myToken = ++renderToken;
  setState("rendering", "Waiting for Photopea");
  const t0 = performance.now();
  // Capture the promise before we await — if the user cancels mid-await, cancel()
  // will bump renderToken and swap session.ready; our old awaited promise may
  // reject with "cancelled", which we treat as a superseded no-op, not an error.
  if (!(await waitReady(myToken))) return;
  if (myToken !== renderToken) return;
  setState("rendering", "Starting render");
  try {
    const png = await session.render(buildRequest(), (m) => {
      if (myToken === renderToken) $("status").textContent = m;
    });
    if (myToken !== renderToken) return; // cancelled/reset while rendering
    lastPng = new Blob([png], { type: "image/png" });
    const img = $("preview");
    img.src = URL.createObjectURL(lastPng);
    img.style.display = "block";
    $("download").classList.remove("hidden");
    if (navigator.canShare) $("share").classList.remove("hidden");
    setState("ready", `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (myToken !== renderToken) return; // superseded — cancel already handled UI
    console.error(err);
    // Photopea can wedge on a bad script (empty done, timeout). Rebuild the
    // iframe so the next Generate isn't fighting the corpse of the last one.
    // The form inputs stay put — only the render engine is reset.
    const msg = err && err.message ? err.message : String(err);
    resetSession(`Error: ${msg}. Resetting engine.`, "error");
  }
}

// Kick off a reboot and transition to `resetting` (button disabled) until the
// new iframe is ready. On success, land in `finalState` with a friendly status;
// on failure (Photopea won't load at all), land in `error`.
function resetSession(nowMsg, finalState) {
  const myToken = ++renderToken; // invalidate every pending render/callback
  session.reboot();
  setState("resetting", nowMsg);
  waitReady(myToken).then((ok) => {
    if (myToken !== renderToken) return; // user acted again before reboot finished
    if (!ok) return; // waitReady already set the error state
    setState(finalState, finalState === "error"
      ? "Ready — press Generate to retry"
      : "Ready");
  });
}

function cancel() {
  // Same reset path as an error, but land in `ready` (not `error`) — a user-
  // initiated cancel isn't a failure, so no Retry chip.
  resetSession("Cancelled — resetting engine", "ready");
}

function onGenerateClick() {
  if (state === "rendering") cancel();
  else if (state === "ready" || state === "error") generate();
  // starting / resetting → button is disabled; this callback shouldn't fire.
}

function retry() {
  if (state !== "error") return;
  // Reboot, then auto-generate — but only if the user hasn't done anything else
  // (checked via renderToken inside resetSession's waitReady).
  const myToken = ++renderToken;
  session.reboot();
  setState("resetting", "Resetting engine");
  waitReady(myToken).then((ok) => {
    if (myToken !== renderToken || !ok) return;
    setState("ready", "Ready");
    generate();
  });
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
  // Don't clobber the state machine — status text only; the enabled button
  // stays consistent with `state`.
  $("status").textContent = "Loading template";
  manifest = await session.env.loadManifest(id);
  await buildForm();
  if (state === "ready" || state === "starting") $("status").textContent = state === "ready" ? "Ready" : "Starting";
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

  // Route the initial boot through the state machine so a Photopea load failure
  // shows Retry + a clear message instead of a permanently-disabled button.
  const bootToken = ++renderToken;
  if (await waitReady(bootToken)) {
    if (bootToken === renderToken) setState("ready", "Ready");
  }
}

$("generate").addEventListener("click", onGenerateClick);
$("download").addEventListener("click", download);
$("share").addEventListener("click", share);
$("retry").addEventListener("click", retry);

init().catch((err) => {
  console.error(err);
  setState("error", `Startup error: ${err.message}`);
});
