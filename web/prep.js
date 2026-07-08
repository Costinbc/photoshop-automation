// Upload & prep — turn a raw PSD into a working template without Photoshop, via a
// familiar Photoshop-like editor: a rendered preview up top, a live status
// checklist, and a layers panel where each layer is a row you open and assign a
// role to (replaceable · static · optional · delete). Machine proposes (the
// analyzer suggests a role per layer), human ratifies.
//
// On Finish it builds the manifest from the assignments, drives Photopea to
// rename the fragile layer(s) to stable IDs and delete any dropped layers, exports
// a clean PSD, makes a thumbnail, saves via the storage seam, and offers a
// download bundle to commit. ag-psd (the browser PSD parser) is loaded lazily
// from a CDN — it's only needed on this page and the app has no build step.

import { analyze } from "./prep-analyze.js";
import { mountNav } from "./ui/nav.js";
import { saveTemplate } from "./storage.js";
import { PhotopeaClient } from "../src/core/photopea-client.js";
import { IframeTransport } from "./iframe-transport.js";
import { PRELUDE } from "../src/core/prelude.js";

const AG_PSD_URL = "https://esm.sh/ag-psd@22";
const PHOTOPEA_CONFIG = encodeURIComponent(JSON.stringify({ environment: { vmode: 1, intro: false } }));

// ---- tiny DOM helpers ----
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "dataset") Object.assign(n.dataset, v);
    else if (k === "class") n.className = v;
    else if (k in n) n[k] = v; else n.setAttribute(k, v);
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};
const field = (labelText, control) => el("div", { class: "field" }, el("label", { textContent: labelText }), control);
const num = (value) => el("input", { type: "number", value: String(value) });
const text = (value) => el("input", { type: "text", value: String(value ?? "") });
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Roles the UI understands. `replaceable` groups the type-specific swap roles for
// chip styling; the render engine gets a concrete kind (photo/text/circle/emoji).
const ROLE_LABEL = {
  text: "Replaceable text", photo: "Replaceable photo", emoji: "Reaction emoji",
  circle: "Circle photo", static: "Static", optional: "Optional (off by default)", delete: "Delete",
};
const CHIP = {
  text: { label: "Text", cls: "replaceable" }, photo: { label: "Photo", cls: "replaceable" },
  emoji: { label: "Emoji", cls: "replaceable" }, circle: { label: "Circle", cls: "replaceable" },
  static: { label: "Static", cls: "static" }, optional: { label: "Optional", cls: "static" },
  delete: { label: "Delete", cls: "delete" },
};
// Which roles a layer may take, given its kind and the analyzer's suggestion.
function rolesFor(a) {
  if (a.isGroup) return [];
  if (a.suggestedRole === "circle") return ["circle", "photo", "static", "delete"];
  switch (a.kind) {
    case "text": return ["text", "static", "optional", "delete"];
    case "emoji": return ["emoji", "static", "optional", "delete"];
    case "shape": return ["static", "optional", "delete"];
    default: return ["photo", "static", "optional", "delete"]; // image / other
  }
}

// ---- module state ----
let agReadPsd = null;
let fontFiles = [];
let psdBytes = null, psdName = "";
let canvasWH = [0, 0];
let analysis = null;      // full analyzer result
let assignments = [];     // per-layer: { ...layer, role, params }
let meta = null;          // { id, label, category, upper } input elements
let ppClient = null;

const setStatus = (m) => { const s = $("prepStatus"); if (s) s.textContent = m; };
const onFile = (f) => handleFile(f).catch((err) => { console.error(err); setStatus(`error: ${err.message}`); });

// ---- 1. Load & analyze ----------------------------------------------------

async function handleFile(file) {
  psdName = file.name;
  psdBytes = new Uint8Array(await file.arrayBuffer());
  setStatus("reading PSD…");
  if (!agReadPsd) ({ readPsd: agReadPsd } = await import(AG_PSD_URL));
  if (!fontFiles.length) fontFiles = (await (await fetch("/configs/fonts.index.json")).json()).fonts;

  // Full read (with image data) so we can show the composite preview + per-layer
  // thumbnails. Analysis itself only needs structure.
  const psd = agReadPsd(psdBytes, {});
  analysis = analyze(psd, fontFiles);
  canvasWH = analysis.canvas;
  assignments = analysis.layers.map((l) => {
    // Seed params from the suggested role's params, or (for a text layer we
    // suggested as static) its text params, so switching to "text" later works.
    const s = l.suggestion;
    const seed = s.params && Object.keys(s.params).length ? s.params : (s.textParams || {});
    // Bake a small thumbnail NOW and drop the full-res layer canvas — ag-psd
    // holds one canvas per layer, so keeping them alive would pin many MB.
    return { name: l.name, kind: l.kind, depth: l.depth, isGroup: l.isGroup, hidden: l.hidden,
             role: s.role, suggestedRole: s.role, params: structuredClone(seed), thumb: thumbFor(l._layer) };
  });
  const previewThumb = downscaleCanvas(psd.canvas, 360);
  for (const l of analysis.layers) delete l._layer; // release full-res layer canvases
  setStatus("");
  renderEditor(previewThumb);
}

// ---- 2. Render the editor -------------------------------------------------

// Draw a (possibly large) source canvas into a fresh, small one so we don't keep
// the full-resolution canvas around. Returns null if there's no source.
function downscaleCanvas(src, maxW) {
  if (!src || !src.width) return null;
  const scale = Math.min(1, maxW / src.width);
  const c = el("canvas", { width: Math.round(src.width * scale), height: Math.round(src.height * scale) });
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function renderEditor(previewCanvas) {
  $("editor").classList.remove("hidden");
  const box = $("previewBox");
  box.replaceChildren(el("h2", { textContent: "Preview" }));
  if (previewCanvas) box.append(previewCanvas);
  renderMetaAndStatus();
  renderLayers();
}

function renderMetaAndStatus() {
  const host = $("statusCard");
  host.replaceChildren();

  // Template meta (required decisions live with the status).
  const id = text(slug(psdName.replace(/\.psd$/i, "")));
  const label = text("");
  const category = text("");
  const upper = el("input", { type: "checkbox", checked: true });
  meta = { id, label, category, upper };
  id.addEventListener("input", updateStatus);
  host.append(
    el("h2", { textContent: "Template" }),
    field("ID (stable, used in URLs & filenames)", id),
    el("div", { class: "two" }, field("Label", label), field("Category", category)),
    el("label", { class: "check", style: "display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:6px" },
      upper, el("span", { textContent: "Force UPPERCASE text" })),
    el("h2", { textContent: "Status", style: "margin-top:14px" }),
    el("ul", { id: "checklist" }),
    el("div", { class: "finish-row" },
      el("button", { class: "primary", id: "finishBtn", textContent: "Finish template", onclick: finish }),
      el("span", { id: "finishStatus" })),
    el("div", { id: "result" }),
  );
  updateStatus();
}

// Live checklist derived from the current assignments + meta.
function updateStatus() {
  const list = $("checklist");
  if (!list) return;
  const items = [];
  const push = (state, txt) => items.push({ state, txt });
  const count = (role) => assignments.filter((a) => a.role === role).length;

  push("ok", `Canvas ${canvasWH[0]} × ${canvasWH[1]}`);
  if (analysis.fontsUnmatched.length) push("todo", `${analysis.fontsUnmatched.length} font(s) without a .ttf match: ${analysis.fontsUnmatched.join(", ")}`);
  else if (analysis.fonts.length) push("ok", `${analysis.fonts.length} font(s) matched`);

  const replaceable = assignments.filter((a) => ["text", "photo", "circle", "emoji"].includes(a.role)).length;
  push("info", `${replaceable} replaceable · ${count("static")} static · ${count("optional")} optional · ${count("delete")} to delete`);

  const hasHeadline = assignments.some((a) => a.role === "text" && a.params.isHeadline);
  if (hasHeadline) push("ok", "Auto-fit headline set");
  else push("info", "No auto-fit headline (optional)");

  const emojiNoHeadline = count("emoji") > 0 && !hasHeadline;
  if (emojiNoHeadline) push("todo", "Reaction emoji needs an auto-fit headline to follow");

  const idOk = !!slug(meta.id.value);
  if (!idOk) push("todo", "Give the template an ID");

  list.replaceChildren(...items.map(({ state, txt }) =>
    el("li", { class: state }, el("span", { class: "mark", textContent: state === "ok" ? "✓" : state === "todo" ? "•" : "·" }),
      el("span", { textContent: txt }))));

  const ready = idOk && !emojiNoHeadline;
  const btn = $("finishBtn");
  if (btn) btn.disabled = !ready;
}

// ---- Layers panel ----

function thumbFor(layer) {
  const c = layer.canvas;
  if (!c || !c.width) return null;
  const s = Math.min(40 / c.width, 40 / c.height);
  const w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
  const off = document.createElement("canvas"); off.width = w; off.height = h;
  off.getContext("2d").drawImage(c, 0, 0, w, h);
  try { return off.toDataURL(); } catch { return null; }
}

function renderLayers() {
  const host = $("layers");
  host.replaceChildren();
  assignments.forEach((a, i) => host.append(a.isGroup ? groupRow(a) : layerRow(a, i)));
}

function groupRow(a) {
  return el("div", { class: `group-row depth-${a.depth}` }, el("span", { textContent: "▸ " + a.name }));
}

function chip(role) {
  const c = CHIP[role] || CHIP.static;
  return el("span", { class: `chip ${c.cls}`, textContent: c.label });
}

function layerRow(a, i) {
  const wrap = el("div", { class: `layer role-${a.role} depth-${a.depth}` });
  const thumb = a.thumb;
  const eye = el("span", { class: "layer-eye", textContent: a.hidden ? "◌" : "👁" });
  const nameEl = el("div", { class: "layer-name" },
    el("span", { textContent: a.name.length > 34 ? a.name.slice(0, 32) + "…" : a.name }),
    el("div", { class: "sub", textContent: a.kind }));
  let chipEl = chip(a.role);
  const caret = el("span", { class: "caret", textContent: "▸" });
  const head = el("div", { class: "layer-head" },
    eye,
    el("div", { class: "layer-thumb", style: thumb ? `background-image:url(${thumb})` : "" }),
    nameEl, chipEl, caret);
  const body = el("div", { class: "layer-body" });
  head.addEventListener("click", () => wrap.classList.toggle("open"));

  // Role picker + params, rebuilt whenever the role changes.
  const rebuild = () => {
    body.replaceChildren();
    const roles = rolesFor(a);
    const picker = el("div", { class: "role-picker" });
    for (const r of roles) {
      const b = el("button", { class: "role-btn", type: "button", textContent: ROLE_LABEL[r] });
      b.setAttribute("aria-pressed", String(r === a.role));
      b.addEventListener("click", () => {
        a.role = r;
        wrap.className = `layer role-${r} depth-${a.depth} open`;
        const next = chip(r); chipEl.replaceWith(next); chipEl = next; // keep ref current
        rebuild(); updateStatus();
      });
      picker.append(b);
    }
    body.append(picker, paramsFor(a));
  };
  rebuild();
  wrap.append(head, body);
  return wrap;
}

// Role-specific parameter editors, each bound to a.params.
function paramsFor(a) {
  const p = a.params;
  const box = el("div", { class: "params" });
  const bindNum = (key) => { const inp = num(p[key]); inp.addEventListener("input", () => { p[key] = Number(inp.value); }); return inp; };
  const bindText = (key, def) => { const inp = text(p[key] ?? def); inp.addEventListener("input", () => { p[key] = inp.value; }); return inp; };

  if (a.role === "photo") {
    p.frame = p.frame || [0, 0, canvasWH[0], canvasWH[1]];
    const f = p.frame.map((v, idx) => { const inp = num(v); inp.addEventListener("input", () => { p.frame[idx] = Number(inp.value); }); return inp; });
    box.append(field("Field key (what the form calls it)", bindText("key", "main")),
      el("label", { textContent: "Crop frame (x, y, width, height)" }),
      el("div", { class: "two", style: "margin-bottom:8px" }, f[0], f[1]),
      el("div", { class: "two" }, f[2], f[3]),
      el("div", { class: "hint", textContent: "Auto-filled from the layer; adjust if the crop is off." }));
  } else if (a.role === "circle") {
    p.frame = p.frame || [0, 0, 200, 200];
    const fx = num(p.frame[0]), fy = num(p.frame[1]), fs = num(p.frame[2]);
    fx.addEventListener("input", () => { p.frame[0] = Number(fx.value); });
    fy.addEventListener("input", () => { p.frame[1] = Number(fy.value); });
    fs.addEventListener("input", () => { p.frame[2] = p.frame[3] = Number(fs.value); });
    box.append(el("label", { textContent: "Circle frame (x, y, size)" }),
      el("div", { class: "three" }, fx, fy, fs),
      el("div", { class: "hint", textContent: `Clipped onto “${p.base}”, which hides when no photo is supplied.` }));
  } else if (a.role === "text") {
    box.append(field("Field key", bindText("key", "text")));
    if (p.isHeadline) {
      if (p.anchorVal == null) p.anchorVal = p[p.anchorKind]; // seed from the detected anchor
      const anchorVal = num(p.anchorVal);
      anchorVal.addEventListener("input", () => { p.anchorVal = Number(anchorVal.value); });
      const anchor = el("select");
      for (const k of ["bottomY", "centerY"]) anchor.append(el("option", { value: k, textContent: k, selected: k === p.anchorKind }));
      anchor.addEventListener("change", () => { p.anchorKind = anchor.value; p.anchorVal = p[anchor.value]; anchorVal.value = String(p.anchorVal); });
      const adv = el("details", {},
        el("summary", { textContent: "Auto-fit sizing (advanced)", style: "cursor:pointer;font-size:12px;color:var(--muted)" }),
        el("div", { class: "two", style: "margin-top:8px" }, field("Anchor", anchor), field("Anchor Y", anchorVal)),
        el("div", { class: "three" }, field("Width", bindNum("width")), field("Leading", bindNum("leading")), field("Default size", bindNum("size"))));
      box.append(el("div", { class: "hint", textContent: "This text auto-fits & reflows (it's the biggest text)." }), adv);
    } else {
      box.append(el("div", { class: "hint", textContent: "Editable text — the user retypes the words; size & position stay." }));
    }
  } else if (a.role === "emoji") {
    box.append(field("Choice key", bindText("key", "emoji")), field("Native width (px)", bindNum("width")),
      el("div", { class: "hint", textContent: "Each emoji layer becomes one swappable reaction choice." }));
  } else if (a.role === "optional") {
    box.append(el("div", { class: "hint", textContent: "Hidden by default in the output. (A show/hide toggle on the create form is a planned follow-up.)" }));
  } else if (a.role === "delete") {
    box.append(el("div", { class: "hint", textContent: "Removed from the template entirely." }));
  } else {
    box.append(el("div", { class: "hint", textContent: "Kept exactly as-is (baked into the template)." }));
  }
  return box;
}

// ---- 3. Build manifest from assignments -----------------------------------

function buildManifest() {
  const id = slug(meta.id.value) || "template";
  const [W, H] = canvasWH;
  const m = { name: id, file: `templates/${id}.psd`, canvas: [W, H] };
  const fonts = new Set(analysis.fonts); // every font the PSD's text uses
  const renames = [], deletes = [];
  let headlineField = null;
  const slots = {}, hide = [], emojiLayers = {};

  if (meta.upper.checked) m.textTransform = "uppercase";

  for (const a of assignments) {
    const p = a.params;
    if (a.role === "text") {
      const key = slug(p.key) || "text";
      renames.push({ old: a.name, new: key });
      m.text = m.text || {};
      m.text[key] = key;
      if (p.font) fonts.add(p.font);
      if (p.isHeadline) {
        headlineField = key;
        const block = { text: key, field: key, font: p.font, balance: true,
          width: Number(p.width), fontSizeDefault: Number(p.size), leadingRatio: Number(p.leading) };
        block[p.anchorKind] = Number(p.anchorVal ?? p[p.anchorKind]);
        m.layout = { block };
      }
    } else if (a.role === "photo") {
      slots[slug(p.key) || "main"] = { target: a.name, frame: p.frame.map(Number) };
    } else if (a.role === "circle") {
      m.circle = { target: a.name, frame: p.frame.map(Number), clip: true, hideWhenEmpty: [p.base] };
    } else if (a.role === "emoji") {
      emojiLayers[slug(p.key) || a.name.slice(0, 6)] = { layer: a.name, width: Number(p.width) };
    } else if (a.role === "optional") {
      hide.push(a.name);
    } else if (a.role === "delete") {
      deletes.push(a.name);
    }
  }

  if (Object.keys(slots).length || hide.length) m.imageModes = { single: { hide, slots } };
  if (Object.keys(emojiLayers).length) {
    m.emoji = { follow: { field: headlineField || "headline", gap: 10, dx: 0, dy: 0, scale: 1.15 }, layers: emojiLayers };
  }
  m.fonts = [...fonts];
  return { manifest: m, renames, deletes };
}

// ---- 4. Photopea cleanup (rename + delete + export), thumbnail, save -------

async function bootPhotopea() {
  if (ppClient) return ppClient;
  const iframe = el("iframe");
  iframe.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;border:0";
  iframe.src = `https://www.photopea.com#${PHOTOPEA_CONFIG}`;
  document.body.appendChild(iframe);
  ppClient = new PhotopeaClient(new IframeTransport(iframe));
  await ppClient.ready();
  return ppClient;
}

async function cleanupAndExport(renames, deletes) {
  const c = await bootPhotopea();
  await c.openDocument(psdBytes);
  await c.tagTemplate();
  for (const r of renames) {
    if (r.old === r.new) continue;
    await c.runScript(`${PRELUDE}\nfindLayer(window._tpl, ${JSON.stringify(r.old)}).name = ${JSON.stringify(r.new)};`);
  }
  for (const name of deletes) {
    await c.runScript(`${PRELUDE}\nfindLayer(window._tpl, ${JSON.stringify(name)}).remove();`);
  }
  await c.activateTemplate();
  const before = await c.t.binaryCount();
  await c.runScript(`app.activeDocument.saveToOE("psd");`);
  await c._waitFor(async () => (await c.t.binaryCount()) > before);
  const bytes = await c.t.readLastBinary();
  await c.closeAll();
  return bytes;
}

async function makeThumbnail() {
  const psd = agReadPsd(psdBytes, { skipLayerImageData: true, skipThumbnail: true });
  const src = psd.canvas;
  if (!src) return null;
  const scale = Math.min(1, 400 / src.width);
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(src, 0, 0, w, h);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

function downloadLink(bytes, filename, mime, label) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return el("a", { href: url, download: filename, textContent: label });
}

async function finish() {
  const btn = $("finishBtn");
  const fs = $("finishStatus");
  btn.disabled = true;
  const out = $("result"); out.replaceChildren();
  const say = (m) => { fs.textContent = m; };
  try {
    const { manifest, renames, deletes } = buildManifest();
    say("cleaning PSD in Photopea…");
    const cleanedPsd = await cleanupAndExport(renames, deletes);
    say("rendering thumbnail…");
    let thumb = null;
    try { thumb = await makeThumbnail(); } catch (e) { console.warn("thumbnail failed", e); }
    say("saving…");
    await saveTemplate({ id: manifest.name, label: meta.label.value || manifest.name,
      category: meta.category.value || null, manifest, psdBytes: cleanedPsd, thumbBytes: thumb });

    const json = JSON.stringify(manifest, null, 2);
    out.append(
      el("h2", { textContent: "Ready ✓", style: "margin-top:14px" }),
      el("div", { class: "hint", textContent:
        "Saved to this browser. To publish for everyone, download the bundle and commit it (PSD → templates/, manifest → configs/), then add an entry to configs/templates.index.json." }),
      el("pre", { class: "manifest", textContent: json }),
      el("div", { class: "result-links" },
        downloadLink(new TextEncoder().encode(json), `${manifest.name}.manifest.json`, "application/json", "⬇ manifest.json"),
        downloadLink(cleanedPsd, `${manifest.name}.psd`, "image/vnd.adobe.photoshop", "⬇ cleaned PSD"),
        ...(thumb ? [downloadLink(thumb, `${manifest.name}.png`, "image/png", "⬇ thumbnail")] : [])));
    say("done");
  } catch (err) {
    console.error(err);
    say(`error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---- init -----------------------------------------------------------------

function init() {
  mountNav("prep");
  const drop = $("drop"), file = $("file");
  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => { if (file.files[0]) onFile(file.files[0]); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f) onFile(f); });
}

init();
