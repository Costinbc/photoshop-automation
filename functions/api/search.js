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

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q) return json({ error: "missing query" }, 400);
  if (!env.SERPER_KEY) return json({ error: "search not configured (set SERPER_KEY)" }, 501);

  let data;
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": env.SERPER_KEY, "content-type": "application/json" },
      body: JSON.stringify({ q, num: 20 }),
    });
    data = await res.json();
    if (!res.ok) {
      const reason = data?.message || `upstream ${res.status}`;
      return json({ error: `search failed: ${reason}` }, 502);
    }
  } catch (err) {
    return json({ error: `search unreachable: ${err.message}` }, 502);
  }

  // Normalize to the picker's shape. Serper gives full image + thumbnail URLs and
  // real dimensions, so the client can show thumbnails and the pipeline can pull
  // the full image (through /api/fetch) at template resolution.
  const results = (data.images || [])
    .map((it) => ({
      thumb: it.thumbnailUrl || it.imageUrl,
      full: it.imageUrl,
      w: it.imageWidth,
      h: it.imageHeight,
    }))
    .filter((r) => r.thumb && r.full);

  return json({ results });
}
