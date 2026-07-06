// Browser transport: talks to Photopea running in a hidden <iframe> via
// postMessage. Implements the same small surface the core PhotopeaClient needs
// as the Node PlaywrightTransport, so the render logic is shared verbatim.

export class IframeTransport {
  constructor(iframe) {
    this.iframe = iframe;
    this.msgs = [];
    this.bins = [];
    window.addEventListener("message", (e) => {
      if (e.source !== iframe.contentWindow) return;
      if (typeof e.data === "string") this.msgs.push(e.data);
      else this.bins.push(new Uint8Array(e.data));
    });
  }

  send(data) {
    const win = this.iframe.contentWindow;
    if (typeof data === "string") {
      win.postMessage(data, "*");
    } else {
      // Post a standalone ArrayBuffer sized exactly to the byte range.
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      win.postMessage(buf, "*");
    }
  }

  stringCount() { return this.msgs.length; }
  readStrings(from) { return this.msgs.slice(from); }
  binaryCount() { return this.bins.length; }
  readLastBinary() { return this.bins[this.bins.length - 1]; }
}
