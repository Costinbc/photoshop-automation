// High-level Photopea driver, independent of how we talk to Photopea.
//
// It depends only on an abstract `transport` (see the adapters in src/node and
// web/) providing:
//   send(data)             -> post a string (script) or Uint8Array (file bytes)
//   stringCount()          -> Promise<number>  total string messages received
//   readStrings(fromIndex) -> Promise<string[]> string messages since an index
//   binaryCount()          -> Promise<number>  total binary messages received
//   readLastBinary()       -> Promise<Uint8Array>  the most recent binary blob
//
// Photopea's message protocol (child -> us): the string "done" after each
// finished op, and a binary blob whenever a running script calls saveToOE().
// Us -> child: a string is executed as a script; bytes are opened as a file
// (font files are auto-detected and installed).

import { PRELUDE } from "./prelude.js";

const js = (v) => JSON.stringify(v); // safely embed a value into a script
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PhotopeaClient {
  constructor(transport, { timeout = 90000, pollMs = 100 } = {}) {
    this.t = transport;
    this.timeout = timeout;
    this.pollMs = pollMs;
  }

  async _waitFor(fn, timeout = this.timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = await fn();
      if (r) return r;
      await sleep(this.pollMs);
    }
    throw new Error("Photopea: timed out waiting for a response");
  }

  // Wait for Photopea's initial ready signal (the first "done").
  async ready() {
    await this._waitFor(async () => (await this.t.readStrings(0)).includes("done"));
  }

  async _sendBytesAndWait(bytes) {
    const before = await this.t.stringCount();
    await this.t.send(bytes);
    await this._waitFor(async () => (await this.t.readStrings(before)).includes("done"));
  }

  // Run a script, surfacing thrown errors (Photopea otherwise stalls silently
  // on a throw and never emits "done").
  async runScript(script) {
    const wrapped =
      `try{\n${script}\napp.echoToOE("__OK__");}catch(e){app.echoToOE("__ERR__"+(e&&e.message?e.message:e));}`;
    const before = await this.t.stringCount();
    await this.t.send(wrapped);
    const hit = await this._waitFor(async () => {
      const msgs = await this.t.readStrings(before);
      return msgs.find((m) => m.startsWith("__OK__") || m.startsWith("__ERR__"));
    });
    if (hit.startsWith("__ERR__")) throw new Error("Photopea script error: " + hit.slice(7));
  }

  // Run a script that assigns to __RET__; returns that string.
  async evalString(script) {
    const wrapped =
      `try{var __RET__="";\n${script}\napp.echoToOE("__RET__"+__RET__);}catch(e){app.echoToOE("__ERR__"+(e&&e.message?e.message:e));}`;
    const before = await this.t.stringCount();
    await this.t.send(wrapped);
    const hit = await this._waitFor(async () => {
      const msgs = await this.t.readStrings(before);
      return msgs.find((m) => m.startsWith("__RET__") || m.startsWith("__ERR__"));
    });
    if (hit.startsWith("__ERR__")) throw new Error("Photopea script error: " + hit.slice(7));
    return hit.slice(7);
  }

  // --- Files ---
  async installFont(bytes) { await this._sendBytesAndWait(bytes); }
  async openDocument(bytes) { await this._sendBytesAndWait(bytes); }

  async exportPNG() {
    const before = await this.t.binaryCount();
    await this.runScript(`app.activeDocument.saveToOE("png");`);
    await this._waitFor(async () => (await this.t.binaryCount()) > before);
    return this.t.readLastBinary();
  }

  // Close every open document (fonts stay installed). Call between renders so
  // the next openDocument() starts from a pristine template as documents[0].
  async closeAll() {
    await this.runScript(
      `while (app.documents.length > 0){ app.activeDocument = app.documents[0]; app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); }`
    );
  }

  // --- Template helpers (require the template opened & tagged) ---
  async tagTemplate() {
    await this.runScript(`${PRELUDE}\nwindow._tpl = app.documents[0];`);
  }
  async activateTemplate() {
    await this.runScript(`${PRELUDE}\napp.activeDocument = window._tpl;`);
  }
  async setText(layer, value) {
    await this.runScript(`${PRELUDE}\nsetText(window._tpl, ${js(layer)}, ${js(value)});`);
  }
  async setFontSize(layer, size) {
    await this.runScript(`${PRELUDE}\nfindLayer(window._tpl, ${js(layer)}).textItem.size = ${Number(size)};`);
  }

  // Set fixed line spacing (leading), in the same units as font size.
  async setLeading(layer, value) {
    await this.runScript(
      `${PRELUDE}\nvar ti = findLayer(window._tpl, ${js(layer)}).textItem; ti.useAutoLeading = false; ti.autoLeading = false; ti.leading = ${Number(value)};`
    );
  }
  async setVisible(layer, on) {
    await this.runScript(`${PRELUDE}\nsetVisible(window._tpl, ${js(layer)}, ${on ? "true" : "false"});`);
  }
  async translateLayer(layer, dx, dy) {
    await this.runScript(`${PRELUDE}\nfindLayer(window._tpl, ${js(layer)}).translate(${dx}, ${dy});`);
  }

  // Scale a layer about its own center by a percentage (100 = unchanged).
  async scaleLayer(layer, pct) {
    await this.runScript(
      `${PRELUDE}\nfindLayer(window._tpl, ${js(layer)}).resize(${pct}, ${pct}, AnchorPosition.MIDDLECENTER);`
    );
  }

  // Actual rendered pixel bounds of a layer (reliable for mid-canvas layers).
  async bounds(layer) {
    const s = await this.evalString(
      `${PRELUDE}\nvar b = findLayer(window._tpl, ${js(layer)}).bounds; __RET__ = px(b[0])+","+px(b[1])+","+px(b[2])+","+px(b[3]);`
    );
    const [l, t, r, b] = s.split(",").map(Number);
    return { l, t, r, b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
  }

  // Place an image (bytes) into the template, fitting it to `frame`
  // ([x,y,w,h] + optional offX,offY). One op per message — batching multiple
  // layer ops in a single script triggers an internal Photopea crash. opts:
  //   above      : stack directly above this layer
  //   clip       : clip to the layer below (clip-mask slots)
  //   fit        : "cover" (default) | "containWidth" (fit width, keep aspect,
  //                top-anchored — for tweet screenshots)
  //   hideTarget : hide `above` after placing (transparent overlays that must
  //                fully replace, not sit on top of, the original)
  async placeImage(bytes, { name, frame, above, clip, fit = "cover", hideTarget } = {}) {
    const [fx, fy, fw, fh, offX = 0, offY = 0] = frame;
    await this.openDocument(bytes);
    await this.runScript(
      `${PRELUDE}\nwindow._src = lastOpened(); window._iw = window._src.width; window._ih = window._src.height;`
    );
    await this.runScript(
      `${PRELUDE}\nwindow._ph = pasteImageInto(window._src, window._tpl, ${js(name)});`
    );
    if (above) {
      await this.runScript(
        `${PRELUDE}\nwindow._ph.move(findLayer(window._tpl, ${js(above)}), ElementPlacement.PLACEBEFORE);`
      );
    }
    if (fit === "containWidth") {
      await this.runScript(
        `var s = (${fw}/window._iw) * 100; window._ph.resize(s, s, AnchorPosition.MIDDLECENTER);`
      );
      await this.runScript(
        `var dw = window._tpl.width, dh = window._tpl.height; var lh = window._ih*(${fw}/window._iw); window._ph.translate(${fx}+${fw}/2-dw/2+${offX}, ${fy}+lh/2-dh/2+${offY});`
      );
    } else {
      // cover: fill the frame (crop overflow), centered, then nudged by the
      // offset. Scale up by 2*|offset| per axis so the shifted image still fully
      // covers the frame (no exposed edge). Zero offset -> plain cover.
      await this.runScript(
        `var s = Math.max((${fw}+2*Math.abs(${offX}))/window._iw, (${fh}+2*Math.abs(${offY}))/window._ih) * 100; window._ph.resize(s, s, AnchorPosition.MIDDLECENTER);`
      );
      await this.runScript(
        `var dw = window._tpl.width, dh = window._tpl.height; window._ph.translate(${fx}+${fw}/2-dw/2+${offX}, ${fy}+${fh}/2-dh/2+${offY});`
      );
    }
    if (clip) await this.runScript(`window._ph.grouped = true;`);
    if (hideTarget && above) await this.setVisible(above, false);
  }
}
