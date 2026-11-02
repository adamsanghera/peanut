import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownBlock, Registry, RegistryError } from "../src/index.ts";
import type { AnyAnchorType, DocumentType } from "../src/types.ts";

const noop = () => null;

// Typed as what the registry is given, not as what it accepts: several tests hand it malformed ones on purpose.
function documentType(overrides: Record<string, unknown> = {}): DocumentType {
  return { name: "notes.page", noun: "page", anchorTypes: ["core.whole"], readContent: noop, displayName: () => "page", ...overrides } as DocumentType;
}

function anchorType(overrides: Record<string, unknown> = {}): AnyAnchorType {
  return { name: "code.lines", create: noop, place: noop, label: () => "", ...overrides } as unknown as AnyAnchorType;
}

test("an app's document types may use core.whole, and the markdown.block it made", () => {
  const block = markdownBlock({ tokenize: () => ({ tokens: [] }) });
  const registry = new Registry().register({ name: "notes", anchorTypes: [block], documentTypes: [documentType({ anchorTypes: ["markdown.block", "core.whole"] })] });
  assert.equal(registry.anchorType("markdown.block"), registry.apps()[0]!.anchorTypes[0]);
  assert.equal(registry.documentType("notes.page").noun, "page");
  assert.ok(registry.allows("notes.page", "core.whole"));
  assert.ok(!registry.allows("notes.page", "code.lines"));
});

test("an app's document types may use its own anchor types", () => {
  const registry = new Registry().register({
    name: "code",
    anchorTypes: [anchorType()],
    documentTypes: [documentType({ name: "code.branch", anchorTypes: ["code.lines", "core.whole"] })],
  });
  assert.equal(registry.anchorType("code.lines").name, "code.lines");
});

test("a later app may share an earlier app's anchor type", () => {
  const registry = new Registry().register({ name: "code", anchorTypes: [anchorType()] });
  registry.register({ name: "review", documentTypes: [documentType({ name: "review.patch", anchorTypes: ["code.lines"] })] });
  assert.ok(registry.allows("review.patch", "code.lines"));
});

test("names must sit under their app", () => {
  assert.throws(() => new Registry().register({ name: "notes", documentTypes: [documentType({ name: "other.page" })] }), /must be named under its app: "notes.page"/);
  assert.throws(() => new Registry().register({ name: "notes", anchorTypes: [anchorType()] }), /"notes.lines"/);
  assert.throws(() => new Registry().register({ name: "notes", documentTypes: [documentType({ name: "page" })] }), /<namespace>.<name>/);
});

test("markdown.block is not there until an app registers one", () => {
  assert.throws(() => new Registry().register({ name: "notes", documentTypes: [documentType({ anchorTypes: ["markdown.block"] })] }), /not registered/);
  assert.throws(() => new Registry().register({ name: "notes", anchorTypes: [anchorType({ name: "markdown.table" })] }), /must be named under its app/);
});

test("peanut's namespaces and taken names are refused", () => {
  assert.throws(() => new Registry().register({ name: "core" }), /reserved/);
  assert.throws(() => new Registry().register({ name: "markdown" }), /reserved/);
  assert.throws(() => new Registry().register({ name: "Notes" }), /lowercase/);
  const registry = new Registry().register({ name: "notes" });
  assert.throws(() => registry.register({ name: "notes" }), /already registered/);
});

test("an app's folder defaults to its name, and must be a plain name", () => {
  const registry = new Registry().register({ name: "notes" }).register({ name: "code", folder: "code-review" });
  assert.deepEqual(registry.apps().map((a) => a.folder), ["notes", "code-review"]);
  assert.throws(() => new Registry().register({ name: "notes", folder: "../elsewhere" }), /plain name/);
  assert.throws(() => new Registry().register({ name: "notes", folder: ".notes" }), /plain name/);
});

test("a document type may only allow registered anchor types", () => {
  assert.throws(() => new Registry().register({ name: "notes", documentTypes: [documentType({ anchorTypes: ["code.lines"] })] }), /not registered/);
  assert.throws(() => new Registry().register({ name: "notes", documentTypes: [documentType({ anchorTypes: [] })] }), /at least one/);
});

test("a malformed app leaves the registry as it was", () => {
  const registry = new Registry();
  assert.throws(() => registry.register({ name: "code", anchorTypes: [anchorType()], documentTypes: [documentType({ name: "code.branch", noun: "" , anchorTypes: ["code.lines"] })] }));
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
