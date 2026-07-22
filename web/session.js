// A long-lived render session for the web app: boots Photopea once in a hidden
// iframe, then reuses the same client (and installed-font set) across renders
// so only the per-render work (text/images/export) repeats.
//
// Rebootable: on cancel or hard failure the iframe is torn down and rebuilt.
// Only Photopea state is lost — the caller's form inputs stay put, so the user
// doesn't have to refresh the page and re-enter everything after a crash.

import { PhotopeaClient } from "../src/core/photopea-client.js";
import { render } from "../src/core/renderer.js";
import { IframeTransport } from "./iframe-transport.js";
import { createWebEnv } from "./env.js";

const PHOTOPEA_CONFIG = encodeURIComponent(JSON.stringify({ environment: { vmode: 1, intro: false } }));

export class RenderSession {
  constructor({ base = "" } = {}) {
    this.env = createWebEnv({ base });
    this.installedFonts = new Set();
    this._boot();
  }

  _boot() {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;border:0";
    iframe.src = `https://www.photopea.com#${PHOTOPEA_CONFIG}`;
    document.body.appendChild(iframe);
    this._iframe = iframe;
    this.transport = new IframeTransport(iframe);
    this.client = new PhotopeaClient(this.transport);
    this.ready = this.client.ready();
  }

  // Tear down the Photopea iframe and boot a fresh one. Fonts must be
  // reinstalled — a new session means an empty font set.
  reboot() {
    if (this.client) this.client._cancelled = true;
    try { this._iframe?.remove(); } catch { /* ignore */ }
    this.installedFonts = new Set();
    this._boot();
  }

  // Abort the in-flight render (if any). The pending _waitFor on the old client
  // observes _cancelled and throws; we swap in a fresh iframe so the next
  // render starts from a clean slate.
  cancel() { this.reboot(); }

  async render(request, log) {
    await this.ready;
    return render(request, {
      client: this.client,
      env: this.env,
      installedFonts: this.installedFonts,
      log,
    });
  }
}
