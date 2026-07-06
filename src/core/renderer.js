// Manifest-driven render orchestration, shared by the CLI and the web app.
//
// It is environment-agnostic: all IO is delegated to `env`, and all Photopea
// communication to `client` (a PhotopeaClient). The caller wires up which
// transport/IO to use, so this file never imports fs, fetch, canvas, etc.
//
// env must provide (all async, all returning bytes as Uint8Array where noted):
//   loadManifest(templateName) -> manifest object
//   loadFonts(manifest)        -> Uint8Array[]   (only the template's fonts)
//   loadTemplate(manifest)     -> Uint8Array     (the PSD)
//   loadImage(ref)             -> Uint8Array     (ref: path | bytes | Blob)
//   keyBlack(bytes)            -> Uint8Array      (near-black -> transparent)
//
// `installedFonts` (optional Set) lets a long-lived session install each font
// only once across many renders (fonts persist in Photopea) — a real perf win
// for the web app. Omit it for one-shot CLI renders.
//
// Returns the finished PNG as a Uint8Array.

import { balanceText } from "./textwrap.js";
import { planInlineEmoji } from "./inline-emoji.js";

const noop = () => {};

export async function render(request, { client, env, log = noop, installedFonts } = {}) {
  const manifest = await env.loadManifest(request.template);
  const offsets = request.offsets || {};
  const block = manifest.layout && manifest.layout.block;

  // Install this template's fonts (skipping any already installed this session).
  const fontFiles = manifest.fonts || [];
  const fontBytes = await env.loadFonts(manifest);
  for (let i = 0; i < fontBytes.length; i++) {
    const key = fontFiles[i];
    if (installedFonts && installedFonts.has(key)) continue;
    await client.installFont(fontBytes[i]);
    if (installedFonts) installedFonts.add(key);
  }
  log("fonts ready");

  // Open a pristine copy of the template for this render.
  await client.openDocument(await env.loadTemplate(manifest));
  await client.tagTemplate();
  log("template opened");

  // Inline emoji flows with the block text (see inline-emoji.js): when
  // configured, the token in the headline is replaced by a reserved gap here,
  // and the emoji SO is translated onto that gap in applyEmoji.
  const inlineEmoji =
    manifest.emoji && manifest.emoji.follow && request.emoji && block &&
    manifest.emoji.follow.field === block.field
      ? manifest.emoji
      : null;
  let emojiPlace = null;
  let emojiScalePct = 100;

  // Text is applied first, then layout reflow, then images, then overlays.
  const upper = manifest.textTransform === "uppercase";
  for (const [key, layer] of Object.entries(manifest.text || {})) {
    if (request[key] == null) continue;
    let value = upper ? String(request[key]).toUpperCase() : String(request[key]);
    const isBlock = block && block.field === key;
    if (isBlock && inlineEmoji) {
      const size = request.fontSize || block.fontSizeDefault;
      const measure = await env.createMeasurer({ font: block.font, fontPx: size });
      const entry = inlineEmoji.layers[request.emoji];
      if (!entry || entry.width == null) {
        throw new Error(`Emoji '${request.emoji}' has no width for inline placement`);
      }
      // Scale the emoji with the text so it reads as part of it: target box =
      // scale * fontSize. Reserve the SCALED width so the gap matches.
      const targetBox = size * (inlineEmoji.follow.scale || 1);
      emojiScalePct = (targetBox / entry.width) * 100;
      const reserveWidth = targetBox + (inlineEmoji.follow.gap || 0);
      const plan = planInlineEmoji({ text: value, measure, maxWidth: block.width, reserveWidth });
      value = plan.render;
      emojiPlace = plan.place;
    } else if (isBlock && block.balance && block.width && env.createMeasurer) {
      // Balance line breaks for the block's text field (respecting typed \n).
      const size = request.fontSize || block.fontSizeDefault;
      const measure = await env.createMeasurer({ font: block.font, fontPx: size });
      value = balanceText(value, measure, block.width);
    }
    await client.setText(layer, value);
    log(`text '${key}' set`);
  }

  await reflow(request, manifest, client, log);
  await applyImages(request, manifest, offsets, client, env, log);
  await applyCircle(request, manifest, offsets, client, env, log);
  await applyTweet(request, manifest, offsets, client, env, log);
  await applyEmoji(request, manifest, client, log, {
    place: emojiPlace,
    block,
    size: request.fontSize || (block && block.fontSizeDefault),
    canvas: manifest.canvas,
    scalePct: emojiScalePct,
  });

  await client.activateTemplate();
  const png = await client.exportPNG();
  await client.closeAll(); // leave a clean slate for the next render
  log("exported");
  return png;
}

// Measure the text block's real height and reposition dependent layers so they
// keep fixed gaps (quote marks above, bar/caption below, etc.).
async function reflow(request, manifest, client, log) {
  const L = manifest.layout && manifest.layout.block;
  if (!L) return;

  const size = request.fontSize || L.fontSizeDefault;
  if (size) await client.setFontSize(L.text, size);
  // Tight, size-relative line spacing so multi-line text uses the space.
  if (size && L.leadingRatio) await client.setLeading(L.text, Math.round(size * L.leadingRatio));

  // Anchor the re-measured text block: centered on a midline (fills the region)
  // or bottom-anchored (grows upward).
  if (L.centerY != null) {
    const tb = await client.bounds(L.text);
    await client.translateLayer(L.text, 0, L.centerY - tb.cy);
  } else if (L.bottomY != null) {
    const tb = await client.bounds(L.text);
    await client.translateLayer(L.text, 0, L.bottomY - tb.b);
  }

  const tb = await client.bounds(L.text);
  for (const a of L.above || []) {
    const b = await client.bounds(a.layer);
    await client.translateLayer(a.layer, 0, tb.t - a.gap - b.b); // bottom -> gap above text top
  }
  for (const d of L.below || []) {
    const b = await client.bounds(d.layer);
    await client.translateLayer(d.layer, 0, tb.b + d.gap - b.t); // top -> gap below text bottom
  }
  log("layout reflowed to text height");
}

async function applyImages(request, manifest, offsets, client, env, log) {
  if (!request.mode) return;
  const mode = manifest.imageModes[request.mode];
  if (!mode) throw new Error(`Unknown image mode '${request.mode}' for ${manifest.name}`);

  for (const layer of mode.hide || []) await client.setVisible(layer, false);

  for (const [slotKey, ref] of Object.entries(request.images || {})) {
    const slot = mode.slots[slotKey];
    if (!slot) throw new Error(`Mode '${request.mode}' has no image slot '${slotKey}'`);
    const off = offsets[slotKey] || [0, 0];
    // Photos only need to cover ~1080px; downscaling keeps Photopea fast.
    await client.placeImage(await env.loadImage(ref, { maxSize: 2000 }), {
      name: `IMG_${slotKey}`,
      frame: [...slot.frame, off[0], off[1]],
      above: slot.target,
      clip: !!slot.clip,
    });
    log(`image slot '${slotKey}' placed`);
  }
}

// Circle inset: place the image if given; otherwise hide the circle entirely
// (so no default sample shows) via the manifest's hideWhenEmpty layers.
async function applyCircle(request, manifest, offsets, client, env, log) {
  const c = manifest.circle;
  if (!c) return;
  if (request.circle) {
    const off = offsets.circle || [0, 0];
    await client.placeImage(await env.loadImage(request.circle, { maxSize: 1200 }), {
      name: "IMG_circle",
      frame: [...c.frame, off[0], off[1]],
      above: c.target,
      clip: !!c.clip,
    });
    log("circle image placed");
  } else if (c.hideWhenEmpty) {
    for (const layer of c.hideWhenEmpty) await client.setVisible(layer, false);
    log("circle hidden (no image)");
  }
}

async function applyTweet(request, manifest, offsets, client, env, log) {
  if (!(request.tweet && manifest.tweet)) return;
  const t = manifest.tweet;
  const off = offsets.tweet || [0, 0];
  // Keep the tweet lossless (PNG) so the black-key stays clean (JPEG artifacts
  // would lift the pure-black background and fringe the edges).
  let bytes = await env.loadImage(request.tweet, { maxSize: 1600, lossless: true });
  // keyBlack removes the dark background; `clear` erases the tweet UI buttons
  // (X / ... / Grok) in the top-right corner (rects in image-width fractions).
  if (t.keyBlack || t.clear) bytes = await env.keyBlack(bytes, { clear: t.clear || [] });
  await client.placeImage(bytes, {
    name: "IMG_tweet",
    frame: [...t.frame, off[0], off[1]],
    above: t.target,
    fit: t.fit || "cover",
    hideTarget: true,
  });
  log("tweet placed");
}

// An emoji layer entry is either a bare layer name (fixed-position emoji) or
// { layer, width } (inline emoji whose footprint is reserved in the text).
const emojiLayerName = (entry) => (typeof entry === "string" ? entry : entry.layer);

async function applyEmoji(request, manifest, client, log, ctx = {}) {
  if (!(request.emoji && manifest.emoji)) return;
  const layers = manifest.emoji.layers;
  const chosen = layers[request.emoji];
  if (!chosen) {
    throw new Error(`Unknown emoji '${request.emoji}' (options: ${Object.keys(layers).join(", ")})`);
  }

  // Show the chosen emoji, hide the rest.
  for (const [key, entry] of Object.entries(layers)) {
    await client.setVisible(emojiLayerName(entry), key === request.emoji);
  }

  // Inline mode: scale the emoji with the text, then translate it onto the gap.
  const follow = manifest.emoji.follow;
  if (follow && ctx.place) {
    const { place, block, size, canvas } = ctx;
    if (ctx.scalePct && Math.abs(ctx.scalePct - 100) > 0.5) {
      await client.scaleLayer(emojiLayerName(chosen), ctx.scalePct);
    }
    const leading = Math.round(size * (block.leadingRatio || 1));
    // The headline is center-justified on the canvas center, so every line is
    // centered on that x (ink bounds can't give it — a line ending in the blank
    // NBSP filler has no ink there; textItem.position is in ruler units, not px).
    // Vertical extent DOES come from ink bounds (every line has ink -> safe).
    const cx = canvas[0] / 2;
    const tb = await client.bounds(block.text);
    const capHeight = tb.h - (place.lineCount - 1) * leading;
    const lineCenterY = tb.t + capHeight / 2 + place.lineIndex * leading;
    const lineLeft = cx - place.lineWidth / 2;
    const targetX = lineLeft + place.beforeWidth + place.fillerWidth / 2 + (follow.dx || 0);
    const targetY = lineCenterY + (follow.dy || 0);

    const eb = await client.bounds(emojiLayerName(chosen));
    await client.translateLayer(emojiLayerName(chosen), targetX - eb.cx, targetY - eb.cy);
    log(`emoji '${request.emoji}' placed inline on line ${place.lineIndex}`);
  } else {
    log(`emoji '${request.emoji}' selected`);
  }
}
