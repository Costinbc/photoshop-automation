// Shared top navigation, mounted into a <nav id="nav"></nav> placeholder on
// every page. Data-driven: adding a page here makes it appear across the whole
// app at once. Each page passes its own key so the current tab is highlighted.

const LINKS = [
  { key: "create", href: "/web/create.html", label: "Create" },
  { key: "templates", href: "/web/templates.html", label: "Templates" },
  { key: "prep", href: "/web/prep.html", label: "Upload" },
];

// Render the nav into #nav. `active` is the current page's key (e.g. "create");
// pass null on the landing page (only the brand links home there).
export function mountNav(active = null) {
  const host = document.getElementById("nav");
  if (!host) return;
  host.className = "nav";

  const brand = document.createElement("a");
  brand.className = "nav-brand";
  brand.href = "/web/";
  brand.textContent = "Card Maker";
  host.append(brand);

  for (const link of LINKS) {
    const a = document.createElement("a");
    a.className = "nav-link";
    a.href = link.href;
    a.textContent = link.label;
    if (link.key === active) a.setAttribute("aria-current", "page");
    host.append(a);
  }
}
