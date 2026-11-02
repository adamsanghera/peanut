/**
 * The apps a process uses, and their document types and anchor types,
 * checked once at registration so the store can trust them.
 *
 * peanut's own anchor types are always present. A document type may list any
 * anchor type already registered, its app's own or another app's, so an app
 * that shares one must be registered after the app that defines it.
 */
import * as markdownBlock from "./anchors/markdown-block.mjs";
import * as whole from "./anchors/whole.mjs";
import { RegistryError } from "./errors.mjs";

/** Namespaces peanut keeps for itself. */
export const RESERVED = new Set(["core", "markdown"]);
const BUILT_INS = [whole.anchorType, markdownBlock.anchorType];

const APP_NAME = /^[a-z][a-z0-9]*$/;
const QUALIFIED = /^([a-z][a-z0-9]*)\.([a-z][a-z0-9-]*)$/;
const DOCUMENT_TYPE_METHODS = ["readContent", "parse", "displayName"];
const ANCHOR_TYPE_METHODS = ["create", "locate", "label"];
// CREATE TABLE, INDEX, VIEW or TRIGGER, with optional IF NOT EXISTS, and the name after it.
const CREATED_NAME = /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi;

export class Registry {
  #apps = new Map();
  #documentTypes = new Map();
  #anchorTypes = new Map(BUILT_INS.map((t) => [t.name, t]));

  /** Adds an app. Throws RegistryError when anything in it is malformed or taken. */
  register(app) {
    if (!APP_NAME.test(app?.name ?? "")) throw new RegistryError(`App name ${JSON.stringify(app?.name)} must be lowercase letters and digits.`);
    if (RESERVED.has(app.name)) throw new RegistryError(`"${app.name}" is reserved for peanut.`);
    if (this.#apps.has(app.name)) throw new RegistryError(`App "${app.name}" is already registered.`);

    const anchorTypes = (app.anchorTypes ?? []).map((t) => checkAnchorType(app.name, t));
    for (const t of anchorTypes) {
      if (this.#anchorTypes.has(t.name)) throw new RegistryError(`Anchor type "${t.name}" is already registered.`);
    }
    // An app's document types may use its own anchor types, so those count as registered while checking them.
    const visible = new Map([...this.#anchorTypes, ...anchorTypes.map((t) => [t.name, t])]);
    const documentTypes = (app.documentTypes ?? []).map((d) => checkDocumentType(app.name, d, visible));
    for (const d of documentTypes) {
      if (this.#documentTypes.has(d.name)) throw new RegistryError(`Document type "${d.name}" is already registered.`);
    }
    const migrations = checkMigrations(app.name, app.migrations ?? []);

    for (const t of anchorTypes) this.#anchorTypes.set(t.name, t);
    for (const d of documentTypes) this.#documentTypes.set(d.name, d);
    this.#apps.set(app.name, Object.freeze({ name: app.name, documentTypes, anchorTypes, migrations }));
    return this;
  }

  apps() {
    return [...this.#apps.values()];
  }

  /** The document type named `name`, or a RegistryError naming what is registered. */
  documentType(name) {
    const type = this.#documentTypes.get(name);
    if (!type) throw new RegistryError(`No document type "${name}". Registered: ${[...this.#documentTypes.keys()].join(", ") || "none"}.`);
    return type;
  }

  anchorType(name) {
    const type = this.#anchorTypes.get(name);
    if (!type) throw new RegistryError(`No anchor type "${name}".`);
    return type;
  }

  /** Whether threads on documents of `documentType` may use `anchorType`. */
  allows(documentType, anchorType) {
    return this.documentType(documentType).anchorTypes.includes(anchorType);
  }
}

function qualified(app, what, name) {
  const match = QUALIFIED.exec(name ?? "");
  if (!match) throw new RegistryError(`${what} name ${JSON.stringify(name)} must read "<namespace>.<name>".`);
  if (match[1] !== app) throw new RegistryError(`${what} "${name}" must be named under its app: "${app}.${match[2]}".`);
  return name;
}

function checkAnchorType(app, type) {
  qualified(app, "Anchor type", type?.name);
  for (const method of ANCHOR_TYPE_METHODS) {
    if (typeof type[method] !== "function") throw new RegistryError(`Anchor type "${type.name}" needs a ${method}() method.`);
  }
  if (!Array.isArray(type.reads)) throw new RegistryError(`Anchor type "${type.name}" must list the content types it reads.`);
  return Object.freeze({ ...type, reads: [...type.reads] });
}

function checkDocumentType(app, type, anchorTypes) {
  qualified(app, "Document type", type?.name);
  if (!type.noun) throw new RegistryError(`Document type "${type.name}" needs a noun, such as "doc" or "branch".`);
  for (const method of DOCUMENT_TYPE_METHODS) {
    if (typeof type[method] !== "function") throw new RegistryError(`Document type "${type.name}" needs a ${method}() method.`);
  }
  const contentTypes = new Set(type.contentTypes ?? []);
  if (!type.anchorTypes?.length) throw new RegistryError(`Document type "${type.name}" must allow at least one anchor type.`);
  for (const name of type.anchorTypes) {
    const anchorType = anchorTypes.get(name);
    if (!anchorType) throw new RegistryError(`Document type "${type.name}" allows anchor type "${name}", which is not registered.`);
    const missing = anchorType.reads.filter((c) => !contentTypes.has(c));
    if (missing.length) {
      throw new RegistryError(`Document type "${type.name}" allows "${name}", which reads content types it does not parse: ${missing.join(", ")}.`);
    }
  }
  return Object.freeze({ ...type, contentTypes: [...contentTypes], anchorTypes: [...type.anchorTypes] });
}

/** Checks that every table, index, view or trigger an app's migrations create is named under the app. */
function checkMigrations(app, steps) {
  if (!Array.isArray(steps)) throw new RegistryError(`App "${app}" migrations must be a list of SQL steps.`);
  for (const [i, sql] of steps.entries()) {
    if (typeof sql !== "string") throw new RegistryError(`App "${app}" migration ${i + 1} is not SQL text.`);
    for (const [, name] of sql.matchAll(CREATED_NAME)) {
      if (!name.startsWith(`${app}_`)) {
        throw new RegistryError(`App "${app}" migration ${i + 1} creates "${name}". Its tables must be named "${app}_<table>".`);
      }
    }
  }
  return Object.freeze([...steps]);
}
