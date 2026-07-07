// Card Maker — a manifest-driven UI. Picking a template loads its manifest and
// builds exactly the fields that template needs (text + font size, image
// mode/slots, circle, tweet screenshot, emoji picker). The heavy lifting lives
// in the shared core; this file only builds the form and the render request.

import { RenderSession } from "./session.js";
import { balanceText } from "../src/core/textwrap.js";

const BASE = "..";
const TEMPLATES = [
  { id: "quote_big_template", label: "Quote" },
  { id: "double_quote_template", label: "Double" },
  { id: "tweet_big_simple_template", label: "Tweet" },
  { id: "trending_text_simple_template", label: "Trending" },
];

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
  const toggle = el("button", { type: "button", className: "imgpick-toggle", textContent: "🔍 Search the web" });

  const panel = el("div", { className: "search-panel hidden" });
  const q = el("input", { type: "text", placeholder: "Search images…" });
  const go = el("button", { type: "button", className: "search-go", textContent: "Go" });
  const grid = el("div", { className: "search-grid" });
  const msg = el("div", { className: "search-msg" });
  const row = el("div", { className: "search-row" });
  row.append(q, go);
  panel.append(row, grid, msg);

  const chosen = el("div", { className: "imgpick-chosen hidden" });
  const chosenImg = el("img", { alt: "selected web image" });
  const clearBtn = el("button", { type: "button", textContent: "✕ clear" });
  chosen.append(chosenImg, el("span", { textContent: "web image selected" }), clearBtn);

  const deselectGrid = () => { for (const im of grid.children) im.setAttribute("aria-selected", "false"); };

  const useFile = () => {
    if (!file.files[0]) return;
    value = file.files[0];
    chosen.classList.add("hidden");
    deselectGrid();
  };
  const useWebImage = (r, im) => {
    value = `/api/fetch?url=${encodeURIComponent(r.full)}`;
    chosenImg.src = r.thumb;
    chosen.classList.remove("hidden");
    file.value = "";
    for (const x of grid.children) x.setAttribute("aria-selected", String(x === im));
  };
  const clear = () => {
    value = file.files[0] || null;
    chosen.classList.add("hidden");
    deselectGrid();
  };

  file.addEventListener("change", useFile);
  clearBtn.addEventListener("click", clear);
  toggle.addEventListener("click", () => panel.classList.toggle("hidden"));

  const search = async () => {
    const term = q.value.trim();
    if (!term) return;
    msg.textContent = "searching…";
    grid.replaceChildren();
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      // The Function always returns JSON; a non-JSON body means it isn't running
      // (e.g. served by a plain static server, not `wrangler pages dev`).
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`search unavailable (HTTP ${res.status})`);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.results?.length) { msg.textContent = "no results"; return; }
      msg.textContent = "";
      for (const r of data.results) {
        const im = el("img", { src: r.thumb, loading: "lazy", alt: "" });
        im.setAttribute("aria-selected", "false");
        im.addEventListener("click", () => useWebImage(r, im));
        grid.append(im);
      }
    } catch (err) {
      msg.textContent = `search error: ${err.message}`;
    }
  };
  go.addEventListener("click", search);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });

  wrap.append(file, toggle, panel, chosen);
  return { node: wrap, getValue: () => value };
}

const NUDGE_STEP = 40; // px per tap

// Framing nudge for one image slot: arrows move the picked image within its
// crop; the offset is applied at render time (request.offsets[key]).
function nudgeControl(key) {
  controls.offsets[key] = [0, 0];
  const readout = el("span", { className: "pill", textContent: "0, 0" });
  const bump = (dx, dy) => {
    const o = controls.offsets[key];
    o[0] += dx * NUDGE_STEP;
    o[1] += dy * NUDGE_STEP;
    readout.textContent = `${o[0]}, ${o[1]}`;
  };
  const btn = (label, title, onClick) => {
    const b = el("button", { type: "button", className: "nudge-btn", textContent: label, title });
    b.addEventListener("click", onClick);
    return b;
  };
  const wrap = el("div", { className: "nudge" });
  wrap.append(
    el("span", { className: "nudge-label", textContent: "Frame" }),
    btn("◀", "Left", () => bump(-1, 0)),
    btn("▲", "Up", () => bump(0, -1)),
    btn("▼", "Down", () => bump(0, 1)),
    btn("▶", "Right", () => bump(1, 0)),
    btn("⟲", "Re-center", () => { controls.offsets[key] = [0, 0]; readout.textContent = "0, 0"; }),
    readout
  );
  return wrap;
}

async function buildForm() {
  const form = $("form");
  form.replaceChildren();
  controls = { texts: {}, fontSizes: {}, images: {}, offsets: {} };
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
        ? el("textarea", { placeholder: `${humanize(key)}…` })
        : el("input", { type: "text", placeholder: `${humanize(key)}…` });
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
        const rowsOut = el("span", { textContent: "–" });
        controls.rows = rowsOut; controls.rowsBlock = block;
        rowEl.append(wrapPill(rowsOut, " rows"));
        range.addEventListener("input", () => { sizeOut.textContent = range.value; updateEstimate(); });
      } else {
        range.addEventListener("input", () => { sizeOut.textContent = range.value; });
      }
      // Label the slider by field when a template has more than one.
      const label = blocks.length > 1 ? `${humanize(block.field)} size` : "Font size";
      textCard.append(field(label, rowEl));
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
        f.append(nudgeControl(slotKey));
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
    cf.append(nudgeControl("circle"));
    extras.append(cf);
    hasExtras = true;
  }
  if (manifest.tweet) {
    controls.tweet = fileInput();
    extras.append(field("Tweet screenshot (dark mode)", controls.tweet));
    hasExtras = true;
  }
  if (manifest.emoji) {
    const keys = Object.keys(manifest.emoji.layers);
    controls.emoji = keys[0];
    const emojiField = field("Emoji",
      segmented(keys.map((k) => ({ value: k, label: humanize(k) })), controls.emoji, (k) => { controls.emoji = k; }));
    // Inline emoji flows with the text: tell the user how to place it.
    if (manifest.emoji.follow) {
      emojiField.append(el("p", { className: "hint",
        textContent: "Type [e] in the text where the emoji should sit. Omit it to put the emoji at the end." }));
    }
    extras.append(emojiField);
    hasExtras = true;
  }
  if (hasExtras) form.append(extras);

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
  } else if (blocks.length > 1) {
    req.fontSizes = {};
    for (const b of blocks) req.fontSizes[b.field] = Number(controls.fontSizes[b.field].value);
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
  if (controls.emoji) req.emoji = controls.emoji;

  // Framing offsets — only for slots that actually have a picked image.
  const offsets = {};
  const used = [...Object.keys(req.images || {}), ...(req.circle ? ["circle"] : [])];
  for (const key of used) {
    const o = controls.offsets[key];
    if (o && (o[0] || o[1])) offsets[key] = o;
  }
  if (Object.keys(offsets).length) req.offsets = offsets;
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
    setStatus(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(err);
    setStatus(`error: ${err.message}`);
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
  setStatus("loading template…");
  manifest = await session.env.loadManifest(id);
  await buildForm();
  setStatus(session.client ? "ready" : "starting…");
}

// ---- Init -----------------------------------------------------------------

async function init() {
  $("templatePicker").append(
    segmented(TEMPLATES.map((t) => ({ value: t.id, label: t.label })), TEMPLATES[0].id, selectTemplate)
  );
  await selectTemplate(TEMPLATES[0].id);

  await session.ready;
  setStatus("ready");
  $("generate").disabled = false;
}

$("generate").addEventListener("click", generate);
$("download").addEventListener("click", download);
$("share").addEventListener("click", share);

init().catch((err) => { console.error(err); setStatus(`startup error: ${err.message}`); });
