// Browser black-key: near-black -> transparent, matching src/keyblack.py so the
// web app and the Node engine produce identical results. Keys on brightness
// (max RGB channel) with a smooth ramp so anti-aliased edges stay clean.
//
// `clear` erases rectangles to transparency (in addition to keying black) —
// used to drop the tweet UI buttons (X / ... / Grok) top-right. Rectangles are
// [x, y, w, h] in fractions of image WIDTH on both axes (X's layout scales with
// width), matching keyblack.py.

export async function keyBlackCanvas(bytes, { lo = 16, hi = 64, clear = [] } = {}) {
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
  for (const [x, y, rw, rh] of clear) {
    const x0 = clampX(x * W), x1 = clampX((x + rw) * W);
    const y0 = clampY(y * W), y1 = clampY((y + rh) * W); // y/h also scale with WIDTH
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) d[(py * W + px) * 4 + 3] = 0;
    }
  }
  ctx.putImageData(image, 0, 0);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
