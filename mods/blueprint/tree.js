// Subsystems: a box can stand for a part of the system drawn in a diagram of
// its own, written `%% subsystem: <node id> <file>.mmd` in its file. index.mmd
// is the root, the whole system at a glance; its boxes open their subsystems,
// whose boxes can open theirs, and so on.
//
// The links make a tree, or near enough: a file may be linked from two boxes,
// or a link may point back up. So the roots are index.mmd, every diagram
// nothing links to, and the first file of any loop of links that can't be
// reached from those, so every diagram can be reached. A link to a file that
// isn't there (yet) doesn't count. The tab row follows the tree: each root,
// then what it opens, depth first, so a subsystem sits after its overview.

export const ROOT = "index.mmd";

// diagrams: [{ key (file), g (parsed) }]. Returns { of, files, roots, order,
// parents, children }: children maps a file to the boxes in it that open
// another, [{ id, file }]; parents maps a file to the files that open it;
// order is every file once, in tab order.
export function buildTree(diagrams) {
  const files = new Set(diagrams.map((d) => d.key));
  const children = new Map(), parents = new Map();
  for (const d of diagrams) {
    const kids = [];
    for (const n of d.g?.nodes?.values() ?? []) {
      if (!n.system || n.system === d.key || !files.has(n.system)) continue;
      kids.push({ id: n.id, file: n.system });
      const ps = parents.get(n.system) ?? [];
      if (!ps.includes(d.key)) parents.set(n.system, [...ps, d.key]);
    }
    children.set(d.key, kids);
  }
  const order = [...files].sort((a, b) => (a === ROOT ? -1 : b === ROOT ? 1 : a.localeCompare(b)));
  const roots = order.filter((f) => f === ROOT || !parents.has(f));
  const reached = new Set(), tabs = [];
  const visit = (f) => {
    if (reached.has(f)) return;
    reached.add(f);
    tabs.push(f);
    for (const k of children.get(f) ?? []) visit(k.file);
  };
  roots.forEach(visit);
  for (const f of order) {
    if (reached.has(f)) continue;
    roots.push(f);
    visit(f);
  }
  return { of: diagrams, files, roots, order: tabs, parents, children };
}

// The way down from a root to file, root first. Each step up goes to the file
// it was opened from when that still opens it (from: file -> file), else to
// index.mmd, else to the first file that opens it.
export function trail(tree, file, from = {}) {
  const path = [file], seen = new Set(path);
  for (let f = file; !tree.roots.includes(f);) {
    const ps = tree.parents.get(f) ?? [];
    const up = [from[f], ROOT, ...ps].find((p) => p && ps.includes(p) && !seen.has(p));
    if (!up) break;
    path.unshift(up);
    seen.add(up);
    f = up;
  }
  return path;
}
