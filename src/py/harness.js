// Boots a RenderSession (identical to the phone app's) and exposes a single
// entry point for the Python CLI to drive via Playwright's page.evaluate.
// Reusing web/session.js here — rather than a separate Node implementation —
// means the CLI measures text, keys black, and reflows with the exact same
// code the browser app uses. No divergence between "CLI behavior" and
// "phone behavior" to keep in sync.

import { RenderSession } from "/web/session.js";
import { PRELUDE } from "/src/core/prelude.js";

const session = new RenderSession({ base: "" }); // served from the repo root

// Expose the live session + prelude for advanced drivers (e.g. one-off template
// authoring scripts that run custom Photopea ops via session.client). The CLI
// render path only uses __runRender below; these are inert for it.
window.__session = session;
window.__PRELUDE = PRELUDE;

window.__runRender = async (requestJson) => {
  const request = JSON.parse(requestJson);
  const png = await session.render(request, (m) => console.log("[render]", m));
  // Return as base64 — page.evaluate marshals strings cheaply over CDP.
  let binary = "";
  for (let i = 0; i < png.length; i++) binary += String.fromCharCode(png[i]);
  return btoa(binary);
};

session.ready
  .then(() => { window.__harnessReady = true; })
  .catch((err) => { window.__harnessError = err.message || String(err); });
