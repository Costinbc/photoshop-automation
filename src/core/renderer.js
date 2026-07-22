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

// A template's reflow blocks. Most templates have a single `layout.block`;
// multi-headline templates (e.g. the two-quote card) declare `layout.blocks`.
// Both normalize to an array here so the rest of the code is block-count-agnostic.
function getBlocks(manifest) {
  const L = manifest.layout;
  if (!L) return [];
  if (L.blocks) return L.blocks;
  return L.block ? [L.block] : [];
}

// The font size for one block: a per-field override (`fontSizes[field]`) wins,
// then a shared `fontSize`, then the block's own default. This lets a template
// expose one size (single block) or one per headline (multi-block) uniformly.
function sizeFor(request, block) {
  if (!block) return request.fontSize;
  const per = request.fontSizes && request.fontSizes[block.field];
  if (per != null) return per;
  if (request.fontSize != null) return request.fontSize;
  return block.fontSizeDefault;
}

export async function render(request, { client, env, log = noop, installedFonts } = {}) {
  const manifest = await env.loadManifest(request.template);
  const offsets = request.offsets || {};
  const blocks = getBlocks(manifest);
  const blockByField = new Map(blocks.map((b) => [b.field, b]));
  const block = blocks[0] || null; // legacy single-block references (inline emoji ctx, etc.)

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
  // and the emoji SO is translated onto that gap in applyEmoji. Skipped when
  // the user picks "None" (request.emoji falsy) — the [e] token is stripped
  // below so it doesn't render as literal text.
  const inlineEmoji =
    manifest.emoji && manifest.emoji.follow && request.emoji && block &&
    manifest.emoji.follow.field === block.field
      ? manifest.emoji
      : null;
  let emojiPlace = null;
  let emojiScalePct = 100;
  // Strip any leftover [e] token from a follow-field's text when emoji is off,
  // so the user's inline marker doesn't render as visible text.
  const stripInlineToken = manifest.emoji && manifest.emoji.follow && !request.emoji;

  // Text is applied first, then layout reflow, then images, then overlays.
  const upper = manifest.textTransform === "uppercase";
  for (const [key, layer] of Object.entries(manifest.text || {})) {
    if (request[key] == null) continue;
    let value = upper ? String(request[key]).toUpperCase() : String(request[key]);
    if (stripInlineToken && manifest.emoji.follow.field === key) {
      // Remove the marker plus any surrounding whitespace it left behind.
      value = value.replace(/\s*\[e\]\s*/gi, " ").replace(/\s+/g, " ").trim();
    }
    const fieldBlock = blockByField.get(key);
    if (fieldBlock && inlineEmoji && inlineEmoji.follow.field === key) {
      const size = sizeFor(request, fieldBlock);
      const measure = await env.createMeasurer({ font: fieldBlock.font, fontPx: size });
      const entry = inlineEmoji.layers[request.emoji];
      if (!entry || entry.width == null) {
        throw new Error(`Emoji '${request.emoji}' has no width for inline placement`);
      }
      // Scale the emoji with the text so it reads as part of it: target box =
      // scale * fontSize. Reserve the SCALED width so the gap matches.
      const targetBox = size * (inlineEmoji.follow.scale || 1);
      emojiScalePct = (targetBox / entry.width) * 100;
      const reserveWidth = targetBox + (inlineEmoji.follow.gap || 0);
      const plan = planInlineEmoji({ text: value, measure, maxWidth: fieldBlock.width, reserveWidth });
      value = plan.render;
      emojiPlace = plan.place;
    } else if (fieldBlock && fieldBlock.balance && fieldBlock.width && env.createMeasurer) {
      // Balance line breaks for the block's text field (respecting typed \n).
      const size = sizeFor(request, fieldBlock);
      const measure = await env.createMeasurer({ font: fieldBlock.font, fontPx: size });
      value = balanceText(value, measure, fieldBlock.width);
    }
    await client.setText(layer, value);

    // Non-block text fields (captions and other secondary text) can also carry
    // a per-field font size from `fontSizes[key]`. Block sizes are applied in
    // reflow() alongside leading/anchoring, so skip them here.
    // Also fix leading: auto-leading collapses multi-line caps to a punishing
    // ~0.9× stack, so any caption that wraps reads glued together. Force a
    // sane ratio (manifest override via captionLeadingRatio, else 1.15).
    if (!fieldBlock && request.fontSizes && request.fontSizes[key] != null) {
      const capSize = request.fontSizes[key];
      const capLeadRatio = manifest.captionLeadingRatio || 1.15;
      await client.setFontSize(layer, capSize);
      await client.setLeading(layer, Math.round(capSize * capLeadRatio));
    }
    log(`text '${key}' set`);
  }

  await reflow(request, manifest, client, log);
  await applyImages(request, manifest, offsets, client, env, log);
  await applyCircle(request, manifest, offsets, client, env, log);
  await applyTweet(request, manifest, offsets, client, env, log);
  await applyEmoji(request, manifest, client, log, {
    place: emojiPlace,
    block,
    size: sizeFor(request, block),
    canvas: manifest.canvas,
    scalePct: emojiScalePct,
  });

  await client.activateTemplate();
  const png = await client.exportPNG();
  await client.closeAll(); // leave a clean slate for the next render
  log("exported");
  return png;
}

// For each reflow block: set its size/leading, anchor it, and reposition its
// dependent layers so they keep fixed gaps (quote marks above, bar/caption
// below, etc.). Multi-block templates (e.g. the two-quote card) reflow each
// headline independently.
async function reflow(request, manifest, client, log) {
  const blocks = getBlocks(manifest);
  if (!blocks.length) return;

  const blockOffsets = request.blockOffsets || {};

  for (const L of blocks) {
    const size = sizeFor(request, L);
    if (size) await client.setFontSize(L.text, size);
    const vScale = request.verticalScales?.[L.field] ?? request.verticalScale;
    if (vScale != null && vScale !== 100) await client.setVerticalScale(L.text, vScale);
    const vDelta = (vScale != null && vScale !== 100) ? (vScale - 100) / 100 : 0;
    const vFactor = 1 + vDelta * 0.25;
    if (size && L.leadingRatio) await client.setLeading(L.text, Math.round(size * L.leadingRatio * vFactor));

    // Anchor the re-measured text block: centered on a midline (fills the region)
    // or bottom-anchored (grows upward, e.g. a quote hugging its attribution line).
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

    // Group bottom-anchor: shift the whole reflowed unit (block + above/below)
    // so the LOWEST bottom in the group sits at `groupBottomY`. Solves the
    // "text ends mid-band, empty space below the caption" problem in multi-band
    // templates: manifest declares the band's floor, reflow snaps to it after
    // the dependent captions have been placed.
    if (L.groupBottomY != null) {
      let maxBottom = (await client.bounds(L.text)).b;
      for (const d of L.below || []) {
        const b = await client.bounds(d.layer);
        if (b.b > maxBottom) maxBottom = b.b;
      }
      const dy = L.groupBottomY - maxBottom;
      if (dy) {
        await client.translateLayer(L.text, 0, dy);
        for (const a of L.above || []) await client.translateLayer(a.layer, 0, dy);
        for (const d of L.below || []) await client.translateLayer(d.layer, 0, dy);
      }
    }

    // Per-block nudge from the UI: `blockOffsets[field] = [dx, dy]` shifts the
    // whole group (text + above + below) as one, so users can slide a band up
    // or down to make things fit without editing the manifest.
    const off = blockOffsets[L.field];
    if (off && (off[0] || off[1])) {
      const [dx, dy] = off;
      await client.translateLayer(L.text, dx, dy);
      for (const a of L.above || []) await client.translateLayer(a.layer, dx, dy);
      for (const d of L.below || []) await client.translateLayer(d.layer, dx, dy);
    }
  }
  log("layout reflowed to text height");
}

async function applyImages(request, manifest, offsets, client, env, log) {
  if (!request.mode) return;
  const mode = manifest.imageModes[request.mode];
  if (!mode) throw new Error(`Unknown image mode '${request.mode}' for ${manifest.name}`);

  for (const layer of mode.hide || []) await client.setVisible(layer, false);

  const zooms = request.zoom || {};
  for (const [slotKey, ref] of Object.entries(request.images || {})) {
    const slot = mode.slots[slotKey];
    if (!slot) throw new Error(`Mode '${request.mode}' has no image slot '${slotKey}'`);
    const off = offsets[slotKey] || [0, 0];

    // Two ways a slot clips its photo:
    //  - `target`+`clip`: clip to a PSD layer authored for it (quote/tweet split).
    //  - `synthClip`: no such layer exists (single-image templates) — synthesize a
    //    clip base filling `frame` just above `mode.anchor`, then clip to that. Lets
    //    any single-photo template offer split without per-PSD layer surgery.
    let target = slot.target;
    let clip = !!slot.clip;
    if (slot.synthClip) {
      target = `SPLIT_${slotKey}`;
      await client.fillRect(target, slot.frame, mode.anchor);
      clip = true;
    }

    const imgName = `IMG_${slotKey}`;
    const placeOpts = {
      name: imgName,
      frame: [...slot.frame, off[0], off[1]],
      above: target,
      clip,
      zoom: zooms[slotKey] || 1,
    };

    // Subject-aware effects: for "single" modes only (not split/double/triple),
    // isolate the person and apply overlay effects only to the background,
    // keeping clarity on the whole image. Single-layer approach — no cutout
    // sandwich, no alignment/ghost issues. Skip when no overlay effect is
    // active (the ML work would be invisible).
    const overlayActive = request.effects &&
      Object.keys(request.effects).some((k) => k !== "clarity" && request.effects[k]);
    const useSubjectCut =
      request.subjectCut !== false && request.mode === "single" && env.subjectMask && overlayActive;

    let placedBytes;
    if (useSubjectCut) {
      const raw = await env.loadImage(ref, { maxSize: 2000 });
      let mask = null;
      try {
        mask = await env.subjectMask(raw);
      } catch (err) {
        // Model init/inference can fail on older devices — degrade to a
        // uniform-effects render rather than throw away the card.
        log(`subject mask failed (${err.message}); flat effects`);
      }
      placedBytes = await env.applyEffects(raw, request.effects, { mask });
      log(`image slot '${slotKey}' placed${mask ? " (subject-protected)" : ""}`);
    } else {
      placedBytes = await env.loadImage(ref, { maxSize: 2000, effects: request.effects });
      log(`image slot '${slotKey}' placed`);
    }
    await client.placeImage(placedBytes, placeOpts);
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
      zoom: (request.zoom && request.zoom.circle) || 1,
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
  const zooms = request.zoom || {};
  let bytes = await env.loadImage(request.tweet, { maxSize: 1600, lossless: true });
  const clearRects = request.tweetKeepWatermark ? [] : (t.clear || []);
  if (t.keyBlack || clearRects.length) bytes = await env.keyBlack(bytes, { clear: clearRects, log });
  await client.placeImage(bytes, {
    name: "IMG_tweet",
    frame: [...t.frame, off[0], off[1]],
    above: t.target,
    fit: t.fit || "cover",
    zoom: zooms.tweet || 1,
    hideTarget: true,
  });
  log("tweet placed");
}

// An emoji layer entry is either a bare layer name (fixed-position emoji) or
// { layer, width } (inline emoji whose footprint is reserved in the text).
const emojiLayerName = (entry) => (typeof entry === "string" ? entry : entry.layer);

async function applyEmoji(request, manifest, client, log, ctx = {}) {
  if (!manifest.emoji) return;
  const layers = manifest.emoji.layers;
  // "None" case: user unselected the emoji — hide every emoji layer so the PSD
  // default doesn't leak through, then bail before placement/scaling.
  if (!request.emoji) {
    for (const entry of Object.values(layers)) await client.setVisible(emojiLayerName(entry), false);
    log("emoji hidden (none selected)");
    return;
  }
  const chosen = layers[request.emoji];
  if (!chosen) {
    throw new Error(`Unknown emoji '${request.emoji}' (options: ${Object.keys(layers).join(", ")})`);
  }

  const offsets = request.offsets || {};
  const zooms = request.zoom || {};
  const off = offsets.emoji || [0, 0];
  const zoomFactor = zooms.emoji || 1;

  // Show the chosen emoji, hide the rest.
  for (const [key, entry] of Object.entries(layers)) {
    await client.setVisible(emojiLayerName(entry), key === request.emoji);
  }

  // Inline mode: scale the emoji with the text, then translate it onto the gap.
  const follow = manifest.emoji.follow;
  if (follow && ctx.place) {
    const { place, block, size, canvas } = ctx;
    const totalScale = (ctx.scalePct || 100) * zoomFactor;
    if (Math.abs(totalScale - 100) > 0.5) {
      await client.scaleLayer(emojiLayerName(chosen), totalScale);
    }
    const leading = Math.round(size * (block.leadingRatio || 1));
    const cx = canvas[0] / 2;
    const tb = await client.bounds(block.text);
    const capHeight = tb.h - (place.lineCount - 1) * leading;
    const lineCenterY = tb.t + capHeight / 2 + place.lineIndex * leading;
    const lineLeft = cx - place.lineWidth / 2;
    const targetX = lineLeft + place.beforeWidth + place.fillerWidth / 2 + (follow.dx || 0) + off[0];
    const targetY = lineCenterY + (follow.dy || 0) + off[1];

    const eb = await client.bounds(emojiLayerName(chosen));
    await client.translateLayer(emojiLayerName(chosen), targetX - eb.cx, targetY - eb.cy);
    log(`emoji '${request.emoji}' placed inline on line ${place.lineIndex}`);
  } else {
    // Fixed-position emoji: apply user offset + zoom nudge.
    if (zoomFactor !== 1) await client.scaleLayer(emojiLayerName(chosen), zoomFactor * 100);
    if (off[0] || off[1]) await client.translateLayer(emojiLayerName(chosen), off[0], off[1]);
    log(`emoji '${request.emoji}' selected`);
  }
}
