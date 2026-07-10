// Template registry — the single source of truth for "what templates exist".
// Every page (create form, gallery) asks here instead of hard-coding a list.
//
// Today it reads a static index committed next to the manifests. This is a
// deliberate SEAM: when the app grows a backend, swap the fetch below for
// `fetch('/api/templates')` (scoped per user) and no caller changes. Keep the
// returned shape stable: { id, label, thumb? }.

const INDEX_URL = "/configs/templates.index.json";

let cache = null;

// All templates, in display order. Cached for the page's lifetime (the index is
// small and static; a reload picks up edits).
export async function listTemplates() {
  if (cache) return cache;
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`template index unavailable (HTTP ${res.status})`);
  const data = await res.json();
  cache = data.templates || [];
  return cache;
}

// One template's registry entry (label/thumb), or null if unknown.
export async function getTemplate(id) {
  return (await listTemplates()).find((t) => t.id === id) || null;
}
