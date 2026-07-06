// Inline emoji that flows with the headline (trending template).
//
// The reaction emoji is a Smart Object that must read as *part of the text*: the
// text reserves horizontal space for it and flows around it, and it can sit
// anywhere in the headline — not just the end. The user marks the spot with a
// token (default `[e]`); if absent, the emoji goes at the end.
//
// This module is pure and environment-agnostic (like textwrap.js): given a
// measurer and the emoji's reserved width, it (a) produces the text to actually
// set — the token replaced by a filler that occupies that width — and (b)
// reports where the token landed after balancing, so the caller can translate
// the emoji Smart Object onto that exact gap.
//
// Why the filler is non-breaking spaces (U+00A0): the trending text is
// center-justified, and center justification TRIMS trailing regular spaces — so
// a space-run at a line end (the common case, since the token is often last)
// would collapse and the reserved gap would vanish. NBSP is not trimmed, and it
// has no ink, so nothing peeks out from under the opaque emoji.

import { balanceItems } from "./textwrap.js";

// Marker token, matched case-insensitively (so it survives an uppercase
// transform, e.g. "[e]" -> "[E]").
export const EMOJI_MARKER = "[e]";
const MARKER_RE = /\[e\]/i;
const NBSP = String.fromCharCode(0xa0); // U+00A0 — not trimmed by justification

export function hasMarker(text) {
  return MARKER_RE.test(String(text));
}

// Split one paragraph into ordered items, turning the first marker into a single
// emoji item; any further markers are dropped (one emoji per headline).
function tokenizeParagraph(par, measure, fillerWidth, markerTaken) {
  const items = [];
  let taken = markerTaken;
  let rest = par;
  let m;
  const pushWords = (s) => {
    for (const word of s.split(/\s+/).filter(Boolean)) items.push({ text: word, w: measure(word) });
  };
  while ((m = MARKER_RE.exec(rest))) {
    pushWords(rest.slice(0, m.index));
    if (!taken) { items.push({ emoji: true, w: fillerWidth }); taken = true; }
    rest = rest.slice(m.index + m[0].length);
  }
  pushWords(rest);
  return { items, markerTaken: taken };
}

// Plan the layout. `text` is the final-cased headline (may contain typed \n).
// `reserveWidth` is the emoji's footprint in px (SO width + padding). Returns:
//   render : the string to setText (marker -> NBSP filler of ~reserveWidth)
//   place  : { lineIndex, lineCount, beforeWidth, lineWidth, fillerWidth }
//            — the gap's line, that line's advance width, the advance width
//            before the gap on that line, and the gap's own width. The caller
//            turns these into the emoji's target center.
export function planInlineEmoji({ text, measure, maxWidth, reserveWidth }) {
  const spaceW = measure(" ");
  const nbspW = measure(NBSP) || spaceW; // Impact may not define NBSP metrics
  const nbspCount = Math.max(1, Math.round(reserveWidth / nbspW));
  const fillerWidth = nbspCount * nbspW;
  const filler = NBSP.repeat(nbspCount);

  // Default to end-of-text if the user didn't place a marker.
  let source = String(text);
  if (!MARKER_RE.test(source)) source = source.replace(/\s*$/, "") + " " + EMOJI_MARKER;

  const renderLines = [];
  let place = null;
  let markerTaken = false;

  for (const par of source.split("\n")) {
    const tok = tokenizeParagraph(par, measure, fillerWidth, markerTaken);
    markerTaken = tok.markerTaken;
    if (!tok.items.length) { renderLines.push(""); continue; }

    for (const line of balanceItems(tok.items, spaceW, maxWidth)) {
      const idx = line.findIndex((it) => it.emoji);
      if (idx >= 0 && !place) {
        let beforeWidth = idx * spaceW; // one space before each preceding word
        for (let k = 0; k < idx; k++) beforeWidth += line[k].w;
        let lineWidth = (line.length - 1) * spaceW;
        for (const it of line) lineWidth += it.w;
        place = { lineIndex: renderLines.length, beforeWidth, lineWidth, fillerWidth };
      }
      renderLines.push(line.map((it) => (it.emoji ? filler : it.text)).join(" "));
    }
  }

  if (place) place.lineCount = renderLines.length;
  return { render: renderLines.join("\n"), place };
}
