// Balanced line wrapping — makes lines of similar length instead of a greedy
// long-first-line + short-widow. Pure and environment-agnostic: it takes a
// `measure(str) -> width` function (canvas in the browser, opentype in Node).
//
// Explicit newlines in the input are respected: each \n-separated paragraph is
// balanced independently, so the user can always force exact breaks.
//
// The core balancer works on generic "items" (each { text, w, ...extra }) so it
// can also lay out a paragraph that contains a non-textual token of a known
// width — e.g. an inline emoji whose footprint must be reserved (see
// inline-emoji.js). `balanceText` is the plain string convenience wrapper.

// Greedy line count for `items` (each carrying a pixel width `w`): the minimal
// number of lines that fit within maxWidth. Used as the target line count so
// the balanced result never grows taller than necessary.
function greedyLineCount(items, spaceW, maxWidth) {
  let lines = 1, lineW = 0;
  for (const it of items) {
    if (lineW && lineW + spaceW + it.w > maxWidth) { lines++; lineW = it.w; }
    else lineW += (lineW ? spaceW : 0) + it.w;
  }
  return lines;
}

function greedyLines(items, spaceW, maxWidth) {
  const lines = [];
  let line = [], lineW = 0;
  for (const it of items) {
    if (line.length && lineW + spaceW + it.w > maxWidth) { lines.push(line); line = [it]; lineW = it.w; }
    else { line.push(it); lineW += (line.length > 1 ? spaceW : 0) + it.w; }
  }
  if (line.length) lines.push(line);
  return lines;
}

// Break `items` into balanced lines (arrays of the original items). Keeps the
// minimal line count (so text never grows taller than necessary), then chooses
// break points that make the lines as even as possible — a DP that minimizes
// each line's squared deviation from the average line width (e.g. 7 equal words
// -> 3+2+2, not the greedy 3+3+1 widow), while never exceeding maxWidth.
export function balanceItems(items, spaceW, maxWidth) {
  const n = items.length;
  if (n <= 1) return [items.slice()];
  const minLines = greedyLineCount(items, spaceW, maxWidth);
  if (minLines <= 1) return [items.slice()];

  const w = items.map((it) => it.w);
  const lineWidth = (i, j) => {
    let sum = 0;
    for (let k = i; k <= j; k++) sum += w[k];
    return sum + (j - i) * spaceW; // (j-i) interior spaces
  };
  const totalW = w.reduce((a, b) => a + b, 0);
  const target = (totalW + (n - minLines) * spaceW) / minLines; // avg line width

  const INF = Infinity;
  const dp = Array.from({ length: minLines + 1 }, () => new Array(n + 1).fill(INF));
  const prev = Array.from({ length: minLines + 1 }, () => new Array(n + 1).fill(-1));
  dp[0][0] = 0;
  for (let k = 1; k <= minLines; k++) {
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        if (dp[k - 1][j] === INF) continue;
        const lw = lineWidth(j, i - 1);
        if (lw > maxWidth && i - j > 1) continue; // over width (a lone item may exceed)
        const cost = dp[k - 1][j] + (lw - target) * (lw - target);
        if (cost < dp[k][i]) { dp[k][i] = cost; prev[k][i] = j; }
      }
    }
  }
  if (dp[minLines][n] === INF) return greedyLines(items, spaceW, maxWidth);

  const lines = [];
  let i = n;
  for (let k = minLines; k > 0; k--) {
    const j = prev[k][i];
    lines.unshift(items.slice(j, i));
    i = j;
  }
  return lines;
}

export function balanceText(text, measure, maxWidth) {
  const spaceW = measure(" ");
  return String(text)
    .split("\n")
    .map((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) return "";
      const items = words.map((word) => ({ text: word, w: measure(word) }));
      return balanceItems(items, spaceW, maxWidth).map((line) => line.map((it) => it.text).join(" ")).join("\n");
    })
    .join("\n");
}

// Convenience: how many lines the balanced text produces (for a live estimate).
export function countLines(text, measure, maxWidth) {
  return balanceText(text, measure, maxWidth).split("\n").length;
}
