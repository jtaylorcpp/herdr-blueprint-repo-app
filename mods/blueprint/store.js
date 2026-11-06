// Diagrams on disk live in the project itself, so they can be committed with
// the code they draw:
//
//   <checkout>/blueprint/
//     <diagram>.mmd   one Mermaid diagram each: the agent writes, Blueprint reads
//     topic.txt       the project's main topic, one line, written by the agent
//
// Herdr lets a mod write only under its app folder, so Blueprint never writes
// there: the agent makes the folder and its files, and Blueprint reads them
// (fs/promises reads only inside the home folder, so the checkout must be in
// it). Nothing in it is ever deleted by Blueprint. What Blueprint keeps for
// itself stays in the app folder, one small folder per project:
//
//   <app home>/data/blueprint/projects/<name>-<hash>/
//     project.json    { path, agent, asked, opened: ms, files: { file: { sum, at } } }
//
// A project is a checkout: the git top level of the tab's terminal folder, so
// every worktree is its own project (its folder stays put while branches come
// and go), or that folder when it is not in git.
//
// More than one Blueprint can have a project open (the panel and a pane), so
// project.json changes through updateMeta: a change applied to what is on disk
// and written only if nobody wrote in between (else read and apply again).
//
// It runs on macOS, Linux and Windows, so no shell and no stat: when a file
// last changed is when Blueprint first saw its current text (files.at).
// Paths use "/" everywhere, Windows ones too.

import * as fs from "fs/promises";
import { exec, appHome, readTextFile, writeTextFile } from "herdr";

export const DIAGRAMS = "blueprint"; // the folder in the checkout
export const KEEP_DAYS = 7; // for Blueprint's own record of a project, not the diagrams
const DAY = 86400000;

export const slashes = (p) => p.replace(/\\/g, "/");
export const projectsDir = () => `${slashes(appHome())}/data/blueprint/projects`;

const checkouts = new Map(); // folder -> checkout
export async function checkoutOf(cwd) {
  const folder = slashes(cwd);
  if (checkouts.has(folder)) return checkouts.get(folder);
  let root = folder;
  try {
    const r = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"]);
    if (r.code === 0 && r.stdout.trim()) root = slashes(r.stdout.trim());
    checkouts.set(folder, root);
  } catch (_) {} // git didn't run: ask again next time
  return root;
}

// FNV-1a: a short id that stays the same for the same path (or text).
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// Where the agent saves a project's diagrams.
export const diagramDir = (path) => `${path.replace(/\/+$/, "")}/${DIAGRAMS}`;

// Where Blueprint keeps its own record of a project (project.json).
export function stateDir(path) {
  const name = path.split("/").filter(Boolean).slice(-2).join("-").replace(/[^\w.-]+/g, "_").replace(/^_+/, "") || "root";
  return `${projectsDir()}/${name}-${hash(path)}`;
}

export async function hasDir(dir) {
  try {
    return await fs.exists(dir);
  } catch (_) {
    return false;
  }
}

function parseMeta(text, path) {
  let saved = null;
  try {
    saved = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { path, agent: null, files: {}, opened: 0, ...saved };
}

export async function readMeta(dir, path) {
  return parseMeta(await readTextFile(`${dir}/project.json`).catch(() => null), path);
}

// Applies change(meta) to project.json as it is on disk now, makes the folder
// if needed, and returns what was written. Changes from this Blueprint go one
// at a time; another one writing in between makes this read and apply again.
const queues = new Map(); // dir -> the last change's promise
export function updateMeta(dir, path, change) {
  const next = (queues.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => apply(dir, path, change));
  queues.set(dir, next);
  next.finally(() => queues.get(dir) === next && queues.delete(dir)).catch(() => {});
  return next;
}

async function apply(dir, path, change) {
  await fs.mkdir(dir, { recursive: true });
  const file = `${dir}/project.json`;
  for (let tries = 0; ; tries++) {
    const text = await readTextFile(file);
    const meta = parseMeta(text, path);
    change(meta);
    try {
      await writeTextFile(file, JSON.stringify(meta, null, 1), text);
      return meta;
    } catch (err) {
      if (tries >= 3) throw err; // written by someone else meanwhile: again, on theirs
    }
  }
}

// What changed in the diagram folder is news when it is a diagram or the
// topic; anything else there (a README, an editor's swap file) is not. Herdr
// sends the folder itself when too much changed to list: anything may have
// (and so may a path not spelled the way dir is).
export const isNews = (f, dir) => /\.mmd$|topic\.txt$/.test(f) || !slashes(f).startsWith(`${dir}/`);

// *.mmd in the folder, read, each with when its text last changed: the time
// recorded with the same text, else now (a new or changed file).
async function listed(dir, meta, now) {
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".mmd"));
  } catch (_) {
    return { list: [], files: {} };
  }
  const list = [], files = {};
  for (const file of names) {
    const src = await readTextFile(`${dir}/${file}`).catch(() => null);
    if (src == null) continue;
    const sum = hash(src), was = meta.files?.[file];
    files[file] = was?.sum === sum ? was : { sum, at: now };
    list.push({ file, src, mtime: files[file].at });
  }
  return { list, files };
}

// The project's diagrams in dir, as { file, mtime, src }, most recently
// changed first. New or changed files get their time recorded in the
// project.json in state (and in meta). Nothing is deleted: the files are the
// person's, in their repository.
export async function load(dir, state, meta, now = Date.now()) {
  const { list, files } = await listed(dir, meta, now);
  list.sort((a, b) => b.mtime - a.mtime);
  const before = meta.files ?? {};
  const changed = Object.keys(files).length !== Object.keys(before).length
    || Object.entries(files).some(([f, r]) => before[f]?.sum !== r.sum);
  meta.files = files;
  if (changed) await updateMeta(state, meta.path, (m) => (m.files = files)).catch(() => {});
  return list;
}

// When Blueprint starts: Blueprint's own record of a project goes once the
// project has no diagram folder (say, a removed worktree) and was not opened
// or asked to draw for KEEP_DAYS. The diagrams themselves are never touched.
export async function pruneAll(now = Date.now()) {
  let names = [];
  try {
    names = await fs.readdir(projectsDir());
  } catch (_) {
    return;
  }
  for (const name of names) {
    const state = `${projectsDir()}/${name}`;
    const meta = await readMeta(state, null);
    if (now - Math.max(meta.opened ?? 0, meta.asked ?? 0) <= KEEP_DAYS * DAY) continue;
    if (meta.path && await hasDir(diagramDir(meta.path))) continue;
    await fs.unlink(`${state}/project.json`).catch(() => {});
    await fs.rmdir(state).catch(() => {});
  }
}
