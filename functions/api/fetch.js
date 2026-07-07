// GET /api/fetch?url=<encoded image url>  ->  the image bytes, re-served with
// permissive CORS.
//
// Cloudflare Pages Function. The render pipeline needs the actual image *bytes*
// (place in Photopea, downscale, key-black), but fetching bytes cross-origin
// from arbitrary domains is CORS-blocked in the browser. This proxies the chosen
// image server-side and streams it back with `Access-Control-Allow-Origin: *`
// so `env.loadImage` can read it like any local asset.
//
// Scope guard: only http(s) URLs, and only responses that are actually images.

export async function onRequestGet({ request }) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return new Response("missing url", { status: 400 });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return new Response("unsupported scheme", { status: 400 });

  let upstream;
  try {
    upstream = await fetch(parsed, {
      headers: { "user-agent": "Mozilla/5.0", accept: "image/*" },
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`upstream unreachable: ${err.message}`, { status: 502 });
  }
  if (!upstream.ok) return new Response(`upstream ${upstream.status}`, { status: 502 });

  const type = upstream.headers.get("content-type") || "";
  if (!type.startsWith("image/")) return new Response("not an image", { status: 415 });

  return new Response(upstream.body, {
    headers: {
      "content-type": type,
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=86400",
    },
  });
}
