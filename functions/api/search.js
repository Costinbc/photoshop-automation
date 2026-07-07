// GET /api/search?q=<terms>  ->  { results: [{ thumb, full, w, h }] }
//
// Cloudflare Pages Function backed by Serper (https://serper.dev) image search —
// real whole-web Google Images results. The API key is a Pages secret
// (SERPER_KEY) so it never reaches the client; that's why this runs server-side.
//
// Local dev: set SERPER_KEY in a gitignored `.dev.vars` and run
// `npx wrangler pages dev .` (see CLAUDE.md "in-app web image search").

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Google Images size filter for "high quality": only images ≥4 megapixels, which
// is roughly a large/high-res photo (e.g. ~2400×1600+) — big enough to fill the
// 1080×1350 templates without upscaling. Passed through Serper as `tbs`.
const HQ_TBS = "isz:lt,islt:4mp";

// Serper bills by result count in hard tiers: num≤10 = 1 credit, num 11–100 = 2
// credits (it rounds anything above 10 up to 100). So only 10 or 100 are ever
// worth requesting — the client picks one, and we clamp here so a stray value
// can't silently cost 2 credits.
const clampNum = (n) => (n === 100 ? 100 : 10);

// One Serper image query, normalized to the picker's shape. `tbs` optionally
// applies Google's image-size filter. Throws on a non-OK upstream response.
async function serperImages(key, q, num, tbs) {
  const body = { q, num };
  if (tbs) body.tbs = tbs;
  const res = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: { "X-API-KEY": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `upstream ${res.status}`);
  return (data.images || [])
    .map((it) => ({
      thumb: it.thumbnailUrl || it.imageUrl,
      full: it.imageUrl,
      w: it.imageWidth,
      h: it.imageHeight,
    }))
    .filter((r) => r.thumb && r.full);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const hq = url.searchParams.get("hq") === "1";
  const num = clampNum(Number(url.searchParams.get("count")));
  if (!q) return json({ error: "missing query" }, 400);
  if (!env.SERPER_KEY) return json({ error: "search not configured (set SERPER_KEY)" }, 501);

  try {
    let results = await serperImages(env.SERPER_KEY, q, num, hq ? HQ_TBS : null);
    // "High quality if possible": if the size filter left nothing, fall back to
    // unfiltered so a niche query never comes back empty.
    if (hq && results.length === 0) results = await serperImages(env.SERPER_KEY, q, num, null);
    return json({ results });
  } catch (err) {
    return json({ error: `search failed: ${err.message}` }, 502);
  }
}
