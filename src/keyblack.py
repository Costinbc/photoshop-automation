"""Key out a (near-)black background, leaving the writing/avatar on transparency.

Reproduces the manual "Select Color Range on black -> delete" step, but keys on
*brightness* (max RGB channel) so only near-#000 pixels become transparent while
mid/light pixels (gray @handle, white text, colored avatar) stay fully solid.
The smooth ramp preserves anti-aliased edges.

Optionally also erases rectangular regions to transparency (--clear) — used to
drop the tweet UI buttons (X / ... / Grok) in the top-right corner. Rectangles
are [x, y, w, h] in fractions of the image WIDTH (both axes), because X's tweet
layout scales with width, so a width-relative box stays correctly sized whether
the tweet is short or tall.

Usage: python src/keyblack.py <in_image> <out_png> [--clear JSON] [--lo L] [--hi H]
"""
import argparse
import json
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("inp")
ap.add_argument("outp")
ap.add_argument("--clear", default="[]", help="JSON [[x,y,w,h], ...] in width fractions")
ap.add_argument("--lo", type=float, default=16.0)
ap.add_argument("--hi", type=float, default=64.0)
args = ap.parse_args()

img = Image.open(args.inp).convert("RGB")
arr = np.asarray(img).astype(np.float32)
val = arr.max(axis=2)                            # brightness = brightest channel
alpha = np.clip((val - args.lo) / (args.hi - args.lo), 0, 1) * 255

h, w = alpha.shape
for x, y, rw, rh in json.loads(args.clear):
    x0 = max(0, min(w, round(x * w)))
    x1 = max(0, min(w, round((x + rw) * w)))
    y0 = max(0, min(h, round(y * w)))           # y/h also scale with WIDTH
    y1 = max(0, min(h, round((y + rh) * w)))
    alpha[y0:y1, x0:x1] = 0

rgba = np.dstack([arr, alpha]).astype("uint8")
Image.fromarray(rgba, "RGBA").save(args.outp)
print(args.outp)
