#!/usr/bin/env python3
"""CLI entry: render a request JSON through headless Photopea.

    python src/py/cli.py <request.json> [--headed] [--debug]

Design: rather than re-implementing the render pipeline in Python, this drives
a real (optionally headless) Chromium via Playwright to the exact same
render session the phone web app uses (web/session.js -> src/core/renderer.js).
A tiny local HTTP server exposes the repo root so the browser can fetch
manifests/fonts/templates/assets by path, same as the phone app does over wifi.
This keeps exactly one implementation of the render pipeline (JS, shared with
the browser) and avoids a second one drifting out of sync in Python.
"""
import argparse
import base64
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
READY_TIMEOUT_MS = 90_000


def serve_repo_root():
    """Start a background HTTP server rooted at the project directory."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, httpd.server_address[1]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("request", help="path to a request JSON file")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--debug", action="store_true", help="print browser console output")
    args = ap.parse_args()

    with open(args.request, encoding="utf8") as f:
        request = json.load(f)

    httpd, port = serve_repo_root()
    base_url = f"http://127.0.0.1:{port}"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headed)
            page = browser.new_page()
            if args.debug:
                page.on("console", lambda m: print(f"[browser] {m.text}"))
                page.on("pageerror", lambda e: print(f"[browser pageerror] {e}"))

            page.goto(f"{base_url}/src/py/harness.html", wait_until="load")
            page.wait_for_function(
                "window.__harnessReady === true || window.__harnessError",
                timeout=READY_TIMEOUT_MS,
            )
            harness_error = page.evaluate("window.__harnessError")
            if harness_error:
                raise RuntimeError(f"Photopea session failed to boot: {harness_error}")

            print("• Photopea ready")
            # No timeout kwarg on evaluate() — it awaits the JS promise directly,
            # and photopea-client.js already enforces its own internal timeout.
            b64 = page.evaluate("(reqJson) => window.__runRender(reqJson)", json.dumps(request))
            png_bytes = base64.b64decode(b64)

            output = request.get("output", f"renders/{request.get('template', 'out')}_out.png")
            out_path = os.path.join(ROOT, output)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, "wb") as f:
                f.write(png_bytes)
            print(f"• wrote {out_path} ({len(png_bytes) // 1024} KB)")

            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - surface any failure to the CLI user
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
