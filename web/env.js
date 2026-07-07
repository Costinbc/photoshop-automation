// Browser IO environment for the renderer: fetches static assets (manifests,
// PSD, fonts) over HTTP, keys black via canvas, and accepts picked images as
// Blobs/bytes. Fetched bytes are cached in-memory so repeated renders don't
// re-download the (large) PSD and fonts.

import { keyBlackCanvas } from "./keyblack-web.js";

// Downscale a picked image so it's no larger than `maxSize` on its longest side
// before it goes to Photopea. Phone photos are many MB / 12MP; pasting those
// (twice, for a split) blows Photopea's time budget. `lossless` keeps PNG (for
// tweet screenshots whose black must stay pure); otherwise JPEG for photos.
async function downscale(bytes, { maxSize, lossless = false } = {}) {
  if (!maxSize) return bytes;
  const bmp = await createImageBitmap(new Blob([bytes]));
  const longest = Math.max(bmp.width, bmp.height);
  if (longest <= maxSize) return bytes;
  const scale = maxSize / longest;
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob(
    lossless ? { type: "image/png" } : { type: "image/jpeg", quality: 0.9 }
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// Load a font file as a FontFace under a stable family name (once per file).
const fontFamilies = new Map();
async function ensureFamily(base, file) {
  if (!fontFamilies.has(file)) {
    const family = `measure_${file.replace(/[^a-z0-9]/gi, "_")}`;
    const face = new FontFace(family, `url(${base}/fonts/${encodeURIComponent(file)})`);
    fontFamilies.set(file, face.load().then((f) => { document.fonts.add(f); return family; }));
  }
  return fontFamilies.get(file);
}

export function createWebEnv({ base = "" } = {}) {
  const cache = new Map();
  const measureCtx = document.createElement("canvas").getContext("2d");
  const fetchBytes = async (url) => {
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    cache.set(url, bytes);
    return bytes;
  };

  return {
    // Sync measurer: measure(text) -> px width at fontPx, using the real font
    // via canvas. Same contract as the Node env, so wrapping is identical.
    async createMeasurer({ font, fontPx }) {
      const family = await ensureFamily(base, font);
      return (text) => {
        measureCtx.font = `${fontPx}px "${family}"`;
        return measureCtx.measureText(text).width;
      };
    },

    async loadManifest(name) {
      const res = await fetch(`${base}/configs/${name}.manifest.json`);
      if (!res.ok) throw new Error(`manifest ${name} -> ${res.status}`);
      return res.json();
    },

    loadFonts(manifest) {
      return Promise.all((manifest.fonts || []).map((f) => fetchBytes(`${base}/fonts/${encodeURIComponent(f)}`)));
    },

    loadTemplate(manifest) {
      return fetchBytes(`${base}/${manifest.file}`);
    },

    // ref: a picked image (Blob/File or raw bytes), a repo-relative path, or an
    // absolute URL — including the "/api/fetch?url=…" image proxy behind which a
    // web-search result lives. opts { maxSize, lossless } downscale large images.
    async loadImage(ref, opts = {}) {
      let bytes;
      if (ref instanceof Uint8Array) bytes = ref;
      else if (ref instanceof Blob) bytes = new Uint8Array(await ref.arrayBuffer());
      else if (typeof ref === "string" && /^(https?:\/\/|\/)/.test(ref))
        bytes = await fetchBytes(ref); // absolute URL / proxied web image — fetch as-is
      else return fetchBytes(`${base}/${ref}`); // repo asset (already sized)
      return downscale(bytes, opts);
    },

    keyBlack(bytes, opts = {}) {
      return keyBlackCanvas(bytes, opts);
    },
  };
}
