import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findFolder, homeVariable, prepareFolder } from "../src/index.mjs";

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "peanut-folder-")));
  const home = path.join(root, "home");
  const project = path.join(root, "work", "repo");
  fs.mkdirSync(path.join(project, "docs", "deep"), { recursive: true });
  fs.mkdirSync(home);
  return { root, home, project, env: { XDG_CONFIG_HOME: path.join(home, ".config") } };
}

test("without anything set, the folder is ~/.<folder>", () => {
  const { home, project, env } = sandbox();
  assert.deepEqual(findFolder("notes", { from: project, env, home }), { dir: path.join(home, ".notes"), project: null });
});

test("the nearest project folder above the work wins over home", () => {
  const { home, project, env } = sandbox();
  fs.mkdirSync(path.join(project, ".notes"));
  const file = path.join(project, "docs", "deep", "plan.md");
  assert.deepEqual(findFolder("notes", { from: file, env, home }), { dir: path.join(project, ".notes"), project });
});

test("the home folder is never mistaken for a project folder", () => {
  const { home, env } = sandbox();
  fs.mkdirSync(path.join(home, ".notes"));
  fs.mkdirSync(path.join(home, "code"));
  assert.deepEqual(findFolder("notes", { from: path.join(home, "code"), env, home }), { dir: path.join(home, ".notes"), project: null });
});

test("the config file moves the home folder, and the environment beats everything", () => {
  const { root, home, project, env } = sandbox();
  fs.mkdirSync(path.join(home, ".config", "notes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "notes", "config.json"), JSON.stringify({ home: "~/Dropbox/notes-comments" }));
  assert.equal(findFolder("notes", { from: project, env, home }).dir, path.join(home, "Dropbox", "notes-comments"));

  fs.mkdirSync(path.join(project, ".notes"));
  const pinned = path.join(root, "pinned");
  assert.deepEqual(findFolder("notes", { from: project, env: { ...env, NOTES_HOME: pinned }, home }), { dir: pinned, project: null });
});

test("a broken config file says which file and why", () => {
  const { home, project, env } = sandbox();
  fs.mkdirSync(path.join(home, ".config", "notes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "notes", "config.json"), "{ nope");
  assert.throws(() => findFolder("notes", { from: project, env, home }), /config\.json is not valid JSON/);
});

test("preparing a project folder keeps it out of git, and leaves a .gitignore someone wrote alone", () => {
  const { home, project, env } = sandbox();
  fs.mkdirSync(path.join(project, ".notes"));
  const found = findFolder("notes", { from: project, env, home });
  prepareFolder(found);
  assert.match(fs.readFileSync(path.join(project, ".notes", ".gitignore"), "utf8"), /^\*$/m);

  fs.writeFileSync(path.join(project, ".notes", ".gitignore"), "custom\n");
  prepareFolder(found);
  assert.equal(fs.readFileSync(path.join(project, ".notes", ".gitignore"), "utf8"), "custom\n");

  const homeFolder = findFolder("notes", { from: home, env: {}, home: path.join(home, "elsewhere") });
  assert.equal(homeFolder.project, null);
  prepareFolder(homeFolder);
  assert.ok(!fs.existsSync(path.join(homeFolder.dir, ".gitignore")), "the home folder needs no .gitignore");
});

test("a folder's variable is its name in capitals", () => {
  assert.equal(homeVariable("diffview"), "DIFFVIEW_HOME");
  assert.equal(homeVariable("code-review"), "CODE_REVIEW_HOME");
});
