// Browser black-key: near-black -> transparent, matching src/keyblack.py so the
// web app and the Node engine produce identical results. Keys on brightness
// (max RGB channel) with a smooth ramp so anti-aliased edges stay clean.
//
// Beyond keying, this step also:
//   - `clear`s rectangles to transparency (drops the tweet UI: X.com watermark /
//     ... / Grok, top-right). Rects are [x, y, w, h] in fractions of image WIDTH
//     on both axes (X's layout scales with width), matching keyblack.py.
//   - runs a WATERMARK CHECK: reports (via `log`) whether each clear rect
//     actually covered ink and whether any leaked just outside it, so a
//     half-removed watermark is visible instead of silently shipped.
//   - CROPS to the content bounding box (+ a little padding) so the returned
//     image is exactly the tweet — avatar/name/text/photo — with the empty black
//     margins trimmed. This normalizes screenshots of different sizes: the crop
//     starts slightly above the first ink and ends slightly below the last, so
//     placement (fixed width, bottom-anchored) behaves the same for every input.

const OPAQUE = 24; // alpha above this counts as ink (post-ramp)

export async function keyBlackCanvas(bytes, { lo = 16, hi = 64, clear = [], pad = 0.02, log } = {}) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);

  const image = ctx.getImageData(0, 0, W, H);
  const d = image.data;
  const span = hi - lo;
  for (let i = 0; i < d.length; i += 4) {
    const val = Math.max(d[i], d[i + 1], d[i + 2]);
    const a = Math.min(1, Math.max(0, (val - lo) / span));
    d[i + 3] = Math.round(a * 255);
  }

  const clampX = (v) => Math.max(0, Math.min(W, Math.round(v)));
  const clampY = (v) => Math.max(0, Math.min(H, Math.round(v)));
  const alphaAt = (px, py) => d[(py * W + px) * 4 + 3];

  // Watermark check — run BEFORE erasing so we can see what was there. For each
  // clear rect count the ink INSIDE it (what we mean to remove) and the ink
  // LEAKING in a thin band hugging its left + bottom edges (a too-small rect
  // leaves the edge of "X.com"). The leak band is limited to the right half of
  // the rect's x-range so real tweet text (which ends well left of the
  // watermark) isn't mistaken for leakage.
  for (const [x, y, rw, rh] of clear) {
    const x0 = clampX(x * W), x1 = clampX((x + rw) * W);
    const y0 = clampY(y * W), y1 = clampY((y + rh) * W); // y/h scale with WIDTH too
    let inside = 0;
    for (let py = y0; py < y1; py++)
      for (let px = x0; px < x1; px++) if (alphaAt(px, py) > OPAQUE) inside++;

    const g = Math.max(4, Math.round(0.02 * W));
    const rx0 = clampX(x0 + (x1 - x0) * 0.5);
    let leak = 0;
    for (let py = y0; py < y1; py++)
      for (let px = clampX(x0 - g); px < x0; px++) if (alphaAt(px, py) > OPAQUE) leak++; // left edge
    for (let py = y1; py < clampY(y1 + g); py++)
      for (let px = rx0; px < x1; px++) if (alphaAt(px, py) > OPAQUE) leak++; // bottom edge

    if (log) {
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      if (inside < area * 0.001)
        log(`tweet watermark check: clear region nearly empty (${inside}px ink) - watermark may sit elsewhere; check tweet.clear`);
      else if (leak > area * 0.004)
        log(`tweet watermark check: ${leak}px ink leaking just outside clear region - widen tweet.clear (removed ${inside}px)`);
      else
        log(`tweet watermark check: ok - removed ${inside}px, ${leak}px leaking`);
    }
  }

  // Erase the watermark region(s).
  for (const [x, y, rw, rh] of clear) {
    const x0 = clampX(x * W), x1 = clampX((x + rw) * W);
    const y0 = clampY(y * W), y1 = clampY((y + rh) * W);
    for (let py = y0; py < y1; py++)
      for (let px = x0; px < x1; px++) d[(py * W + px) * 4 + 3] = 0;
  }
  ctx.putImageData(image, 0, 0);

  // Content bounding box (post-clear), so the trimmed watermark doesn't extend it.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (d[(py * W + px) * 4 + 3] > OPAQUE) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }

  let out = canvas;
  if (maxX >= minX && maxY >= minY) {
    // A few px of padding all around: start slightly above the first ink, end
    // slightly below the last. Scaled to content width so it reads the same at
    // any resolution.
    const padPx = Math.max(6, Math.round(pad * (maxX - minX + 1)));
    const cx0 = clampX(minX - padPx), cy0 = clampY(minY - padPx);
    const cx1 = clampX(maxX + 1 + padPx), cy1 = clampY(maxY + 1 + padPx);
    const cw = cx1 - cx0, ch = cy1 - cy0;
    const cropped = new OffscreenCanvas(cw, ch);
    cropped.getContext("2d").drawImage(canvas, cx0, cy0, cw, ch, 0, 0, cw, ch);
    out = cropped;
    if (log) log(`tweet cropped to content ${cw}x${ch} (from ${W}x${H})`);
  }

  const blob = await out.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
