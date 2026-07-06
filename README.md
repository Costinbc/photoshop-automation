# photoshop-automation

Automate editing Photoshop social templates (quote cards, tweet reposts, trending
headlines) by driving **headless Photopea** — free, no Adobe API, high fidelity
(fonts, per-character color, clip masks all preserved). One JS render engine runs
from a Python CLI and from a client-side phone web app.

## Architecture

The render pipeline is JavaScript and runs only in a browser (Photopea, canvas
text measuring, canvas black-key). There's one implementation, used two ways:
the phone app runs it directly; the CLI drives a real (usually headless)
Chromium via Playwright to run the exact same code.

```
src/core/     prelude.js            ExtendScript helpers injected into Photopea
              photopea-client.js    high-level driver over an abstract transport
              renderer.js           manifest-driven orchestration (text, reflow,
                                     images, tweet-key, emoji) — the one true impl
              textwrap.js           balanced line-wrap (pure, injected measurer)
              inline-emoji.js       inline-emoji layout (pure, injected measurer)
src/keyblack.py                     standalone reference black-key impl (manual
                                     testing only — the pipeline uses the browser's
                                     own canvas keyer, web/keyblack-web.js)
src/py/       cli.py                CLI entry: Playwright + local static server
              harness.html/.js      headless stand-in for web/index.html
web/          iframe-transport.js   Photopea in a hidden <iframe>
              env.js                fetch IO + canvas black-key
              session.js            boots Photopea once, reuses it across renders
              index.html / app.js   the phone UI
configs/      <template>.manifest.json + example requests
templates/    PSDs    fonts/  .ttf    assets/  input images    renders/  output
```

## CLI

```bash
pip install -r requirements.txt
python -m playwright install chromium

python src/py/cli.py configs/example-request.json      # single-image quote
python src/py/cli.py configs/req_tweet.json            # tweet repost (split + keyed tweet)
python src/py/cli.py configs/req_trending.json         # trending headline + emoji
```
Add `--headed` to watch the browser, `--debug` for browser console output.

## Web app (phone)

Static — serve the repo root and open `/web/index.html`:

```
python -m http.server 8080      # or any static server
# then open http://localhost:8080/web/index.html
```

Boots Photopea in a hidden iframe; the user only sees the form. Renders locally
(no server), then Save/Share. `web/test.html` is a dev integration harness.

## Templates

Each template needs one-time Photoshop prep + a manifest:
1. Name editable layers with stable IDs; make image slots **Smart Objects**.
2. Write `configs/<name>.manifest.json`: fonts, text slots, image modes/slots with
   `[x,y,w,h]` frames, optional `circle` / `tweet` (with `keyBlack` + `containWidth`
   + `clear` for stripping tweet-UI buttons) / `emoji` choice group (fixed or
   inline-following-text), and a `layout.block` for measure-and-reflow of text.

## Render request shape

```json
{
  "template": "quote_big_template",
  "quote": "…", "caption": "…", "fontSize": 92,
  "mode": "single",                       // or "split"
  "images": { "main": "assets/a.jpg" },   // split: { "left": "…", "right": "…" }
  "circle": "assets/head.jpg",            // optional
  "tweet":  "assets/tweet.png",           // optional (tweet template)
  "emoji":  "joy",                        // optional (trending template)
  "offsets": { "main": [0, -40] },        // optional per-slot framing nudge (px)
  "output": "renders/out.png"
}
```

## Deploying the web app (Cloudflare Pages)

The phone app is static and client-side, so Pages just needs to serve the repo
root as-is — no build step:

- **Framework preset:** None
- **Build command:** (leave empty)
- **Build output directory:** `/` (repo root — `web/env.js` fetches
  `/configs/...`, `/fonts/...`, `/templates/...` relative to the site root, and
  `web/app.js` resolves `..` back to that root from `/web/index.html`)

Connect the repo (push it to GitHub/GitLab first) in the Cloudflare dashboard,
or skip git entirely and deploy the working directory directly with
`npx wrangler pages deploy .`. Either way, once live, open
`https://<project>.pages.dev/web/index.html` on a phone — HTTPS is required for
the photo picker and Web Share API to work.

Free tier is enough: Pages has no bandwidth/egress charges, and the platform's
25 MiB per-file cap (same on free and paid) is the only real constraint —
template PSDs must stay under that (embedded Smart Object placeholders are
never seen in output, so shrinking them before saving costs nothing).

## Notes / gotchas

Driving Photopea headlessly has sharp edges (one op per message, unreliable
`layer.bounds`, can't hide certain clip smart objects, paste centers on canvas).
They're documented inline in `src/core/` and in `CLAUDE.md`.
