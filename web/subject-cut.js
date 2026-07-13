// Client-side subject isolation via MediaPipe Selfie Segmenter.
//
// Given raw image bytes of a person photo, returns a masked PNG whose subject
// is opaque and whose background is transparent — for compositing behind
// visual effects. The renderer pairs this with an unmodified background copy:
// background → all effects; subject → clarity only, placed on top.
//
// The MediaPipe model + TFLite runtime (~9.5 MB total) is loaded on first call
// from CDN then cached by the browser. The segmenter is created once per
// session and reused across renders.
//
// The raw MediaPipe mask can include incidental background people (e.g. a
// second player crouched behind the hero). `keepLargestComponent` isolates the
// largest connected blob so we get a clean single-subject cutout by default.

let segmenterPromise = null;

async function initSegmenter() {
  const { ImageSegmenter, FilesetResolver } = await import(
    "https://esm.sh/@mediapipe/tasks-vision@0.10.15"
  );
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.15/wasm"
  );
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
      delegate: "GPU",
    },
    outputCategoryMask: true,
    outputConfidenceMasks: false,
    runningMode: "IMAGE",
  });
}

function getSegmenter() {
  if (!segmenterPromise) segmenterPromise = initSegmenter();
  return segmenterPromise;
}

// Grow the foreground region by N pixels (4-connected). Runs at the mask's
// native 256×256 resolution, so each iteration ≈ (source_width/256) source
// pixels of dilation — 2 iterations on a 2000-wide source gives ~16 px of
// margin. Prevents the background layer's subject edges from peeking around
// the cutout (a slightly-larger cutout fully covers the underlying subject).
function dilate(fg, w, h, iterations) {
  let src = fg;
  let dst = new Uint8Array(w * h);
  for (let it = 0; it < iterations; it++) {
    dst.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (src[i]) { dst[i] = 1; continue; }
        if ((x > 0     && src[i - 1]) ||
            (x < w - 1 && src[i + 1]) ||
            (y > 0     && src[i - w]) ||
            (y < h - 1 && src[i + w])) {
          dst[i] = 1;
        }
      }
    }
    const tmp = src; src = dst; dst = tmp;
  }
  if (src !== fg) fg.set(src);
}

// Iterative flood-fill: label each foreground pixel with its component id,
// then zero out everything not in the largest component. 4-connected, in place.
function keepLargestComponent(fg, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const counts = [0];
  let nextId = 1;
  for (let i = 0; i < fg.length; i++) {
    if (fg[i] === 0 || label[i] !== 0) continue;
    let top = 0;
    stack[top++] = i;
    label[i] = nextId;
    let count = 0;
    while (top > 0) {
      const p = stack[--top];
      count++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0)     { const q = p - 1; if (fg[q] && !label[q]) { label[q] = nextId; stack[top++] = q; } }
      if (x < w - 1) { const q = p + 1; if (fg[q] && !label[q]) { label[q] = nextId; stack[top++] = q; } }
      if (y > 0)     { const q = p - w; if (fg[q] && !label[q]) { label[q] = nextId; stack[top++] = q; } }
      if (y < h - 1) { const q = p + w; if (fg[q] && !label[q]) { label[q] = nextId; stack[top++] = q; } }
    }
    counts.push(count);
    nextId++;
  }
  let bestId = 1, bestCount = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > bestCount) { bestCount = counts[i]; bestId = i; }
  }
  for (let i = 0; i < fg.length; i++) if (label[i] !== bestId) fg[i] = 0;
}

// Given image bytes, return PNG bytes of a subject mask — a small (native
// MediaPipe resolution) PNG whose alpha is 255 over the subject and 0 over
// the background. `applyEffects` upsamples and composites this against a
// snapshot of the pre-overlay image so overlay effects only touch background
// pixels while clarity still applies everywhere.
//
// A small dilation compensates for MediaPipe's slightly conservative
// silhouette; because we're now protecting the subject on a single layer
// (not compositing a cutout on top), a light dilation is enough — any pixels
// the mask under-covers just show up as the original subject rather than
// the effect-affected variant, so there is no visible seam.
export async function subjectMask(bytes) {
  const seg = await getSegmenter();
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const iw = bitmap.width, ih = bitmap.height;

  const result = seg.segment(bitmap);
  const mask = result.categoryMask;
  const mw = mask.width, mh = mask.height;
  const maskArr = mask.getAsUint8Array();
  mask.close();

  const fg = new Uint8Array(mw * mh);
  for (let i = 0; i < maskArr.length; i++) fg[i] = maskArr[i] === 0 ? 1 : 0;
  keepLargestComponent(fg, mw, mh);

  // No dilation — MediaPipe's silhouette is slightly conservative but the
  // feather below covers the difference AND the single-layer approach means
  // any under-covered pixels just show the ORIGINAL image (which is fine —
  // they blend with the surrounding untouched subject).
  //
  // Feather: blur the mask alpha before returning so the composite gets a
  // soft alpha ramp instead of a hard edge. Prevents the "ring of untouched
  // background" halo that a hard-edged dilated mask produces on high-contrast
  // silhouettes. Rendered at the source-image resolution so the blur is
  // proportional to what the viewer sees, not the tiny 256×256 mask.

  const maskCanvas = new OffscreenCanvas(mw, mh);
  const mctx = maskCanvas.getContext("2d");
  const maskImg = mctx.createImageData(mw, mh);
  const md = maskImg.data;
  for (let i = 0; i < fg.length; i++) md[i * 4 + 3] = fg[i] ? 255 : 0;
  mctx.putImageData(maskImg, 0, 0);

  // Upsample to source resolution and feather. Blur radius is in source px so
  // the softness reads consistent regardless of input photo size.
  const featherPx = 8;
  const out = new OffscreenCanvas(iw, ih);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.filter = `blur(${featherPx}px)`;
  octx.drawImage(maskCanvas, 0, 0, iw, ih);

  const blob = await out.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
