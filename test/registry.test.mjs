import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, RegistryError } from "../src/index.mjs";

const noop = () => null;

function kind(overrides = {}) {
  return { name: "notes.page", noun: "page", facets: ["markdown"], anchors: ["markdown.block"], current: noop, view: noop, label: noop, ...overrides };
}

function anchorType(overrides = {}) {
  return { name: "code.lines", needs: ["diff"], create: noop, locate: noop, label: noop, ...overrides };
}

test("an app's kinds may use margin's anchor types", () => {
  const registry = new Registry().register({ name: "notes", kinds: [kind({ anchors: ["markdown.block", "core.whole"] })] });
  assert.equal(registry.kind("notes.page").noun, "page");
  assert.ok(registry.allows("notes.page", "core.whole"));
  assert.ok(!registry.allows("notes.page", "code.lines"));
});

test("an app's kinds may use its own anchor types", () => {
  const registry = new Registry().register({
    name: "code",
    anchorTypes: [anchorType()],
    kinds: [kind({ name: "code.branch", facets: ["diff"], anchors: ["code.lines", "core.whole"] })],
  });
  assert.equal(registry.anchorType("code.lines").needs[0], "diff");
});

test("a later app may share an earlier app's anchor type", () => {
  const registry = new Registry().register({ name: "code", anchorTypes: [anchorType()] });
  registry.register({ name: "review", kinds: [kind({ name: "review.patch", facets: ["diff"], anchors: ["code.lines"] })] });
  assert.ok(registry.allows("review.patch", "code.lines"));
});

test("names must sit under their app", () => {
  assert.throws(() => new Registry().register({ name: "notes", kinds: [kind({ name: "other.page" })] }), /must be named under its app: "notes.page"/);
  assert.throws(() => new Registry().register({ name: "notes", anchorTypes: [anchorType()] }), /"notes.lines"/);
  assert.throws(() => new Registry().register({ name: "notes", kinds: [kind({ name: "page" })] }), /<namespace>.<name>/);
});

test("margin's namespaces and taken names are refused", () => {
  assert.throws(() => new Registry().register({ name: "core" }), /reserved/);
  assert.throws(() => new Registry().register({ name: "markdown" }), /reserved/);
  assert.throws(() => new Registry().register({ name: "Notes" }), /lowercase/);
  const registry = new Registry().register({ name: "notes" });
  assert.throws(() => registry.register({ name: "notes" }), /already registered/);
});

test("a kind must provide every facet its anchor types need", () => {
  assert.throws(
    () => new Registry().register({ name: "notes", kinds: [kind({ facets: [] })] }),
    (err) => err instanceof RegistryError && /needs facets it does not provide: markdown/.test(err.message),
  );
});

test("a kind may only allow registered anchor types", () => {
  assert.throws(() => new Registry().register({ name: "notes", kinds: [kind({ anchors: ["code.lines"] })] }), /not registered/);
  assert.throws(() => new Registry().register({ name: "notes", kinds: [kind({ anchors: [] })] }), /at least one/);
});

test("a malformed app leaves the registry as it was", () => {
  const registry = new Registry();
  assert.throws(() => registry.register({ name: "code", anchorTypes: [anchorType()], kinds: [kind({ name: "code.branch", facets: [] , anchors: ["code.lines"] })] }));
  assert.throws(() => registry.anchorType("code.lines"), /No anchor type/);
  assert.deepEqual(registry.apps(), []);
});

test("an app's migrations may only create tables under its name", () => {
  new Registry().register({ name: "notes", migrations: ["CREATE TABLE notes_viewed (path TEXT); CREATE INDEX IF NOT EXISTS notes_by_path ON notes_viewed (path)"] });
  assert.throws(
    () => new Registry().register({ name: "notes", migrations: ["CREATE TABLE notes_viewed (path TEXT);\nCREATE TABLE viewed (path TEXT)"] }),
    /migration 1 creates "viewed"/,
  );
});
