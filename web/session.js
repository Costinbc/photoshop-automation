// A long-lived render session for the web app: boots Photopea once in a hidden
// iframe, then reuses the same client (and installed-font set) across renders
// so only the per-render work (text/images/export) repeats.

import { PhotopeaClient } from "../src/core/photopea-client.js";
import { render } from "../src/core/renderer.js";
import { IframeTransport } from "./iframe-transport.js";
import { createWebEnv } from "./env.js";

const PHOTOPEA_CONFIG = encodeURIComponent(JSON.stringify({ environment: { vmode: 1, intro: false } }));

export class RenderSession {
  constructor({ base = "" } = {}) {
    this.env = createWebEnv({ base });
    this.installedFonts = new Set();
    this.ready = this._boot();
  }

  async _boot() {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;border:0";
    iframe.src = `https://www.photopea.com#${PHOTOPEA_CONFIG}`;
    document.body.appendChild(iframe);

    this.transport = new IframeTransport(iframe);
    this.client = new PhotopeaClient(this.transport);
    await this.client.ready();
  }

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
