// Templates gallery — browse every available template and jump into the card
// maker with one pre-selected. The list comes from registry.js (the same source
// the create page uses), so a new template shows up in both places at once.
// "Use" deep-links to create.html?template=<id>.

import { listTemplates } from "./registry.js";
import { mountNav } from "./ui/nav.js";

const humanize = (s) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function tile(t) {
  const card = document.createElement("div");
  card.className = "tpl";

  const thumb = document.createElement("div");
  thumb.className = "tpl-thumb";
  if (t.thumb) {
    const img = document.createElement("img");
    img.src = t.thumb;
    img.alt = t.label;
    img.loading = "lazy";
    thumb.append(img);
  } else {
    thumb.textContent = "No preview"; // no thumbnail yet; prep will generate these later
  }

  const body = document.createElement("div");
  body.className = "tpl-body";
  const label = document.createElement("div");
  label.className = "tpl-label";
  label.textContent = t.label || humanize(t.id);
  const cat = document.createElement("div");
  cat.className = "tpl-cat";
  cat.textContent = t.category || "";
  const use = document.createElement("a");
  use.className = "tpl-use";
  use.href = `/web/create.html?template=${encodeURIComponent(t.id)}`;
  use.textContent = "Use";
  body.append(label, cat, use);

  card.append(thumb, body);
  return card;
}

async function init() {
  mountNav("templates");
  const grid = document.getElementById("grid");
  try {
    const templates = await listTemplates();
    if (!templates.length) {
      grid.innerHTML = `<div class="empty">No templates yet.</div>`;
      return;
    }
    grid.append(...templates.map(tile));
  } catch (err) {
    grid.innerHTML = `<div class="empty">Couldn't load templates: ${err.message}</div>`;
  }
}

init();
