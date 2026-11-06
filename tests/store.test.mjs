// Where diagrams live: in the checkout's blueprint/ folder, read and never
// deleted by Blueprint, while Blueprint's own record of the project
// (project.json) stays in the app folder and is the only thing cleaned up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { state } from "./herdr-stub.mjs";
import { diagramDir, stateDir, load, pruneAll, KEEP_DAYS } from "../mods/blueprint/store.js";

const DAY = 86400000;
const temp = (name) => mkdtempSync(join(tmpdir(), `bp-${name}-`)).replace(/\\/g, "/");

test("a project's diagrams are in its own blueprint/ folder", () => {
  assert.equal(diagramDir("/home/me/app"), "/home/me/app/blueprint");
  assert.equal(diagramDir("/home/me/app/"), "/home/me/app/blueprint");
  state.appHome = "/app";
  try {
    assert.match(stateDir("/home/me/app"), /^\/app\/data\/blueprint\/projects\/me-app-[0-9a-f]{8}$/);
  } finally {
    delete state.appHome;
  }
});

test("old diagrams are shown and stay on disk", async () => {
  const repo = temp("repo"), dir = diagramDir(repo);
  mkdirSync(dir);
  writeFileSync(join(dir, "old.mmd"), "");
  writeFileSync(join(dir, "new.mmd"), "");
  writeFileSync(join(dir, "notes.md"), "");
  state.files = { [`${dir}/old.mmd`]: "flowchart LR\n  a --> b", [`${dir}/new.mmd`]: "flowchart LR\n  c --> d" };
  const now = Date.now(), long = now - 30 * DAY;
  // old.mmd was last changed a month ago and nobody looked at it since.
  const meta = { path: repo, files: { "old.mmd": { sum: null, at: long } } };
  try {
    const first = await load(dir, temp("state"), meta, long);
    assert.deepEqual(first.map((f) => f.file).sort(), ["new.mmd", "old.mmd"]);
    const later = await load(dir, temp("state"), meta, now);
    assert.deepEqual(later.map((f) => f.file).sort(), ["new.mmd", "old.mmd"], "only .mmd files, none dropped");
    assert.ok(existsSync(join(dir, "old.mmd")), "never deleted");
    assert.equal(meta.files["old.mmd"].at, long, "its time is when its text last changed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Blueprint's own record goes once the project's folder is gone and it sat unused", async () => {
  const app = temp("app"), repo = temp("repo");
  state.appHome = app;
  const old = Date.now() - (KEEP_DAYS + 1) * DAY;
  const record = (path, opened) => {
    const s = stateDir(path);
    mkdirSync(s, { recursive: true });
    writeFileSync(`${s}/project.json`, "");
    state.files[`${s}/project.json`] = JSON.stringify({ path, opened });
    return s;
  };
  try {
    state.files = {};
    mkdirSync(diagramDir(repo));
    const withDiagrams = record(repo, old);
    const gone = record(`${repo}-removed-worktree`, old);
    const recent = record(`${repo}-recent`, Date.now());
    await pruneAll();
    assert.ok(existsSync(withDiagrams), "its repository still has diagrams");
    assert.ok(!existsSync(gone), "no diagram folder, unused for a week");
    assert.ok(existsSync(recent), "opened lately");
  } finally {
    delete state.appHome;
    rmSync(app, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("connecting asks the agent to save in the repo's blueprint/ folder, and Blueprint writes nothing there", async () => {
  const { default: Blueprint } = await import("../mods/blueprint/main.js");
  const { text } = await import("../mods/blueprint/i18n.js");
  const app = temp("app"), repo = temp("repo");
  state.appHome = app;
  state.files = {};
  state.sent = [];
  const bp = Object.create(Blueprint.prototype);
  Object.assign(bp, {
    graphs: [], tab: 0, revs: 0, measured: {}, vers: {}, whole: new Set(), cache: new Map(), views: {}, dirs: {},
    prev: {}, failed: new Set(), paths: {}, lite: 0, size: null, selected: null, compose: null, project: null,
    lang: "en", T: text("en"),
  });
  bp.redraw = () => {};
  const tasks = [], cx = { notify() {}, timer: { after() {} }, spawn: (f) => tasks.push(f(cx)) };
  const settle = async () => { while (tasks.length) await tasks.shift(); };
  try {
    await bp.openProject(repo, cx);
    assert.equal(bp.project.dir, `${repo}/blueprint`);
    assert.equal(bp.project.known, false);
    bp.connect({ address: "w1:1", name: "Claude Code" }, cx);
    await settle();
    const [cmd, address, prompt] = state.sent.at(-1);
    assert.deepEqual([cmd, address], ["send", "w1:1"]);
    assert.ok(prompt.includes(`\`${repo}/blueprint/\``), "the agent is told where to save");
    assert.ok(!existsSync(join(repo, "blueprint")), "the agent makes the folder, not Blueprint");
    assert.ok(existsSync(stateDir(repo)), "the connection is recorded in the app folder");
  } finally {
    delete state.appHome;
    rmSync(app, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
