// Subsystems: a box opens a diagram of its own (`%% subsystem: id file.mmd`),
// index.mmd is the root, every diagram has a tab in tree order, and a
// subsystem also opens from its box, with a trail back up. B asks the
// agent to break a diagram, or one box, into subsystems.
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./herdr-stub.mjs";
import Blueprint from "../mods/blueprint/main.js";
import { parseFlowchart } from "../mods/blueprint/mermaid.js";
import { ROOT, buildTree, trail } from "../mods/blueprint/tree.js";
import { text } from "../mods/blueprint/i18n.js";

const T = new Proxy({}, { get: () => "#808080" });
const PAL = { active: "#ffcc00", done: "#00cc66" };
const SIZE = { width: 900, height: 600 };
const flat = (e, out = []) => { if (e && typeof e === "object") { out.push(e); (e.kids ?? []).forEach((c) => flat(c, out)); } return out; };
const ids = (el) => flat(el).map((e) => String(e.props?.id ?? ""));
const words = (el) => flat(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

const FILES = {
  "index.mmd": "---\ntitle: System\n---\nflowchart LR\n  api[API] --> auth[Auth] --> db[(users)]\n  %% subsystem: auth auth.mmd\n  %% subsystem: db missing.mmd",
  "auth.mmd": "---\ntitle: Auth\n---\nflowchart LR\n  login[login] --> tokens[tokens]\n  click tokens \"tokens.mmd\"",
  "tokens.mmd": "---\ntitle: Tokens\n---\nflowchart LR\n  sign --> verify",
  "notes.mmd": "---\ntitle: Notes\n---\nflowchart LR\n  x --> y",
};
const diagrams = (files) => Object.entries(files).map(([key, src]) => ({ key, g: parseFlowchart(src) }));

test("a box names the subsystem it opens, by file name", () => {
  const g = parseFlowchart("flowchart LR\n  a --> b --> c --> d\n  %% subsystem: a ./auth\n  click b \"blueprint/billing.mmd\"\n  click c \"src/c.ts:4\"\n  %% code: d src/d.ts:1");
  const n = (id) => g.nodes.get(id);
  assert.equal(n("a").system, "auth.mmd");
  assert.equal(n("b").system, "billing.mmd");
  assert.deepEqual([n("c").system, n("c").ref], [null, "src/c.ts:4"], "a code link stays a code link");
  assert.deepEqual([n("d").system, n("d").ref], [null, "src/d.ts:1"]);
});

test("index.mmd and the diagrams nothing opens are the roots", () => {
  const tree = buildTree(diagrams(FILES));
  assert.deepEqual(tree.roots, ["index.mmd", "notes.mmd"]);
  assert.deepEqual(tree.order, ["index.mmd", "auth.mmd", "tokens.mmd", "notes.mmd"], "the tab order: depth first");
  assert.deepEqual(tree.children.get("index.mmd"), [{ id: "auth", file: "auth.mmd" }], "a link to a file that isn't there doesn't count");
  assert.deepEqual(tree.parents.get("tokens.mmd"), ["auth.mmd"]);
});

test("a loop of links nothing else reaches still has a way in", () => {
  const tree = buildTree(diagrams({
    "a.mmd": "flowchart LR\n  x\n  %% subsystem: x b.mmd",
    "b.mmd": "flowchart LR\n  y\n  %% subsystem: y a.mmd",
  }));
  assert.deepEqual(tree.roots, ["a.mmd"]);
  assert.deepEqual(trail(tree, "b.mmd"), ["a.mmd", "b.mmd"]);
});

test("the trail up goes through where it was opened from, else index.mmd", () => {
  const tree = buildTree(diagrams({
    "index.mmd": "flowchart LR\n  s\n  %% subsystem: s shared.mmd",
    "other.mmd": "flowchart LR\n  o\n  %% subsystem: o shared.mmd",
    "shared.mmd": "flowchart LR\n  z",
  }));
  assert.deepEqual(trail(tree, "shared.mmd"), [ROOT, "shared.mmd"]);
  assert.deepEqual(trail(tree, "shared.mmd", { "shared.mmd": "other.mmd" }), ["other.mmd", "shared.mmd"]);
});

// A Blueprint showing FILES, laid out and sized.
function blueprint(files = FILES) {
  state.settings.zoom = 1;
  state.sent = [];
  const bp = Object.create(Blueprint.prototype);
  Object.assign(bp, {
    graphs: [], tab: 0, revs: 0, measured: {}, vers: {}, whole: new Set(), cache: new Map(), views: {}, dirs: {}, from: {},
    prev: {}, failed: new Set(), paths: {}, lite: 0, size: null, selected: null, hovered: null, exporting: false,
    paneFocused: false, compose: null, editing: false, drag: null, mono: "mono", T: text("en"), lang: "en", loading: false,
    width: SIZE.width, project: { path: "/p", dir: "/p/blueprint", state: "/s", known: true, meta: { path: "/p", agent: null, files: {} } },
    input: { value: () => bp.note ?? "", set_value() {}, focus() {} }, focus: { focus() {} }, note: "",
  });
  bp.targets = () => [{ address: "w1:1", name: "Claude Code" }];
  bp.setDiagrams(Object.entries(files).map(([file, src]) => ({ file, src, mtime: 1 })));
  const timers = [], tasks = [];
  const cx = { notify() {}, timer: { after: (_ms, f) => timers.push(f) }, spawn: (f) => tasks.push(f(cx)) };
  bp.heal = () => {};
  bp.canvas(T, PAL, cx).handlers.on_size_change(SIZE, cx);
  // Lays out what is shown now, as a redraw would, and lets its timers run.
  const run = () => { bp.prepare(cx); for (let i = 0; timers.length && i < 1000; i++) { timers.shift()(cx); bp.prepare(cx); } };
  const settle = async () => { while (tasks.length) await tasks.shift(); };
  run();
  return { bp, cx, run, settle, canvas: () => bp.canvas(T, PAL, cx) };
}

test("every diagram has a tab, each subsystem after the diagram that opens it", () => {
  const { bp, cx } = blueprint();
  assert.equal(bp.vkey, "index.mmd", "index.mmd comes first");
  const tabs = () => flat(bp.tabs(T)).filter((e) => /^bp-tab-\d$/.test(e.props?.id ?? ""));
  assert.deepEqual(tabs().map((e) => words(e).join("")), ["System", "Auth", "Tokens", "Notes"]);
  bp.command("select-auth", cx);
  bp.command("open", cx);
  assert.equal(bp.vkey, "auth.mmd");
  assert.deepEqual(tabs().map((e) => e.props.bg), [undefined, "#808080", undefined, undefined], "its own tab is lit");
});

test("a double-click opens a subsystem, the trail leads back up", () => {
  const { bp, cx, run, canvas } = blueprint();
  bp.clickNode(bp.graph.nodes.get("auth"), 1, cx);
  assert.equal(bp.selected, "auth", "one click picks it");
  bp.clickNode(bp.graph.nodes.get("auth"), 2, cx);
  assert.equal(bp.vkey, "auth.mmd");
  bp.clickNode(bp.graph.nodes.get("tokens"), 2, cx);
  assert.equal(bp.vkey, "tokens.mmd");
  run();
  const el = canvas();
  assert.ok(ids(el).includes("bp-crumbs"));
  assert.deepEqual(words(flat(el).find((e) => e.props?.id === "bp-crumbs")).filter((w) => !"←›".includes(w)), ["System", "Auth", "Tokens"]);
  bp.command("up", cx);
  assert.equal(bp.vkey, "auth.mmd");
  bp.command("up", cx);
  assert.equal(bp.vkey, "index.mmd");
  run();
  assert.ok(!ids(canvas()).includes("bp-crumbs"), "no trail at a root");
  bp.clickNode(bp.graph.nodes.get("api"), 2, cx);
  assert.equal(bp.vkey, "index.mmd", "a box without a subsystem just gets picked");
});

test("a box that opens a subsystem has a badge; one whose file isn't there doesn't", () => {
  const { bp, run, canvas } = blueprint();
  run();
  const badges = ids(canvas()).filter((id) => id.startsWith("bp-open-"));
  assert.deepEqual(badges, [`bp-open-${bp.tab}-auth`]);
});

test("number keys follow the tab row", () => {
  const { bp, cx } = blueprint();
  bp.command("tab-3", cx);
  assert.equal(bp.vkey, "tokens.mmd");
  bp.command("tab-4", cx);
  assert.equal(bp.vkey, "notes.mmd");
  bp.command("tab-5", cx);
  assert.equal(bp.vkey, "notes.mmd", "there is no fifth");
});

test("breaking down with no root yet makes the diagram index.mmd", async () => {
  const { bp, cx, settle } = blueprint({ "login.mmd": FILES["auth.mmd"] });
  bp.openSplit();
  assert.deepEqual(bp.compose, { kind: "split", id: null });
  bp.send(cx);
  await settle();
  const prompt = state.sent.at(-1)[2];
  assert.match(prompt, /Move that file to `index\.mmd`/);
  assert.match(prompt, /%% subsystem: <node id> <file>\.mmd/);
  assert.equal(bp.expectSplit.target, ROOT);
  // The agent moves login.mmd to index.mmd, then adds the subsystems.
  bp.setDiagrams([{ file: "index.mmd", src: FILES["auth.mmd"], mtime: 2 }]);
  assert.equal(bp.vkey, "index.mmd", "the moved diagram stays on screen");
  assert.ok(bp.splitting(), "not done before a subsystem is linked");
  bp.setDiagrams([
    { file: "index.mmd", src: `${FILES["auth.mmd"]}\n  %% subsystem: login login-form.mmd`, mtime: 3 },
    { file: "login-form.mmd", src: "flowchart LR\n  f --> g", mtime: 3 },
  ]);
  assert.equal(bp.vkey, "index.mmd", "a new subsystem doesn't take over the view");
  assert.equal(bp.splitting(), null, "done");
});

test("breaking down a picked box asks for its own file and link", async () => {
  const { bp, cx, settle } = blueprint();
  bp.command("select-api", cx);
  bp.openSplit();
  assert.deepEqual(bp.compose, { kind: "split", id: "api" });
  bp.note = "one per route";
  bp.send(cx);
  await settle();
  const prompt = state.sent.at(-1)[2];
  assert.match(prompt, /break down the box "API"/);
  assert.match(prompt, /add `%% subsystem: api <file>\.mmd` to `\/p\/blueprint\/index\.mmd`/);
  assert.match(prompt, /one per route/);
  assert.match(prompt, /Don't overwrite `auth\.mmd`/);
});
