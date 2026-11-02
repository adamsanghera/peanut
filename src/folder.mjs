/**
 * Where an app's store lives. Each app names a folder ("diffview"), and the
 * first rule that matches wins:
 *
 *   1. <FOLDER>_HOME, when set ("DIFFVIEW_HOME").
 *   2. A project folder: the nearest ".diffview/" at or above `from`.
 *   3. "home" in $XDG_CONFIG_HOME/diffview/config.json (~/.config by default).
 *   4. ~/.diffview.
 *
 * A project folder keeps comments next to the work, never in its history:
 * preparing one writes a .gitignore holding "*" into it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StoreError } from "./errors.mjs";

const IGNORE_ALL = "# peanut: comments stay next to the work, out of git.\n*\n";

/** The environment variable that overrides a folder: "code-review" → "CODE_REVIEW_HOME". */
export function homeVariable(folder) {
  return `${folder.toUpperCase().replace(/-/g, "_")}_HOME`;
}

/**
 * Finds the folder for `folder` from `from` (a file or directory; the
 * process's cwd by default). Returns {dir, project}, where `project` is the
 * directory holding a project folder, or null for any other rule. Reads
 * only; prepareFolder() creates it.
 */
export function findFolder(folder, { from = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  const fromEnv = env[homeVariable(folder)];
  if (fromEnv) return { dir: path.resolve(fromEnv), project: null };

  let dir = path.resolve(from);
  if (!isDirectory(dir)) dir = path.dirname(dir);
  for (;;) {
    const candidate = path.join(dir, `.${folder}`);
    // ~/.diffview is the home folder, not a project one, though it sits above everything in ~.
    if (dir !== home && isDirectory(candidate)) return { dir: candidate, project: dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const configured = readConfig(folder, env, home)?.home;
  if (configured) return { dir: path.resolve(home, configured.replace(/^~(?=$|\/)/, home)), project: null };

  return { dir: path.join(home, `.${folder}`), project: null };
}

/** Creates the folder findFolder() returned, and keeps a project folder out of git. */
export function prepareFolder({ dir, project }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (project) {
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, IGNORE_ALL);
  }
  return dir;
}

function readConfig(folder, env, home) {
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const file = path.join(base, folder, "config.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StoreError(`${file} is not valid JSON: ${err.message}`);
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
