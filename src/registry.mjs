/**
 * The apps a process uses, and their kinds and anchor types, checked once
 * at registration so the store can trust them.
 *
 * margin's own anchor types are always present. An app may list any anchor
 * type already registered, its own or another app's, so an app that shares
 * one must be registered after the app that defines it.
 */
import * as markdownBlock from "./anchors/markdown-block.mjs";
import * as whole from "./anchors/whole.mjs";
import { RegistryError } from "./errors.mjs";

/** Namespaces margin keeps for itself. */
export const RESERVED = new Set(["core", "markdown"]);
const BUILT_INS = [whole.anchorType, markdownBlock.anchorType];

const APP_NAME = /^[a-z][a-z0-9]*$/;
const QUALIFIED = /^([a-z][a-z0-9]*)\.([a-z][a-z0-9-]*)$/;
const KIND_METHODS = ["current", "view", "label"];
const ANCHOR_METHODS = ["create", "locate", "label"];
// CREATE TABLE, INDEX or VIEW, with optional IF NOT EXISTS, and the name after it.
const CREATED_NAME = /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi;

export class Registry {
  #apps = new Map();
  #kinds = new Map();
  #anchorTypes = new Map(BUILT_INS.map((t) => [t.name, t]));

  /** Adds an app. Throws RegistryError when anything in it is malformed or taken. */
  register(app) {
    if (!APP_NAME.test(app?.name ?? "")) throw new RegistryError(`App name ${JSON.stringify(app?.name)} must be lowercase letters and digits.`);
    if (RESERVED.has(app.name)) throw new RegistryError(`"${app.name}" is reserved for margin.`);
    if (this.#apps.has(app.name)) throw new RegistryError(`App "${app.name}" is already registered.`);

    const anchorTypes = (app.anchorTypes ?? []).map((t) => checkAnchorType(app.name, t));
    for (const t of anchorTypes) {
      if (this.#anchorTypes.has(t.name)) throw new RegistryError(`Anchor type "${t.name}" is already registered.`);
    }
    // An app's kinds may use its own anchor types, so those count as registered while checking them.
    const visible = new Map([...this.#anchorTypes, ...anchorTypes.map((t) => [t.name, t])]);
    const kinds = (app.kinds ?? []).map((k) => checkKind(app.name, k, visible));
    for (const k of kinds) {
      if (this.#kinds.has(k.name)) throw new RegistryError(`Kind "${k.name}" is already registered.`);
    }
    const migrations = checkMigrations(app.name, app.migrations ?? []);

    for (const t of anchorTypes) this.#anchorTypes.set(t.name, t);
    for (const k of kinds) this.#kinds.set(k.name, k);
    this.#apps.set(app.name, Object.freeze({ name: app.name, kinds, anchorTypes, migrations }));
    return this;
  }

  apps() {
    return [...this.#apps.values()];
  }

  /** The kind named `name`, or a RegistryError naming what is registered. */
  kind(name) {
    const kind = this.#kinds.get(name);
    if (!kind) throw new RegistryError(`No kind "${name}". Registered: ${[...this.#kinds.keys()].join(", ") || "none"}.`);
    return kind;
  }

  anchorType(name) {
    const type = this.#anchorTypes.get(name);
    if (!type) throw new RegistryError(`No anchor type "${name}".`);
    return type;
  }

  /** Whether threads on `kind` may use `anchorType`. */
  allows(kind, anchorType) {
    return this.kind(kind).anchors.includes(anchorType);
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
  for (const method of ANCHOR_METHODS) {
    if (typeof type[method] !== "function") throw new RegistryError(`Anchor type "${type.name}" needs a ${method}() method.`);
  }
  if (!Array.isArray(type.needs)) throw new RegistryError(`Anchor type "${type.name}" must list the facets it needs.`);
  return Object.freeze({ ...type, needs: [...type.needs] });
}

function checkKind(app, kind, anchorTypes) {
  qualified(app, "Kind", kind?.name);
  if (!kind.noun) throw new RegistryError(`Kind "${kind.name}" needs a noun, such as "doc" or "branch".`);
  for (const method of KIND_METHODS) {
    if (typeof kind[method] !== "function") throw new RegistryError(`Kind "${kind.name}" needs a ${method}() method.`);
  }
  const facets = new Set(kind.facets ?? []);
  if (!kind.anchors?.length) throw new RegistryError(`Kind "${kind.name}" must allow at least one anchor type.`);
  for (const name of kind.anchors) {
    const type = anchorTypes.get(name);
    if (!type) throw new RegistryError(`Kind "${kind.name}" allows anchor type "${name}", which is not registered.`);
    const missing = type.needs.filter((f) => !facets.has(f));
    if (missing.length) {
      throw new RegistryError(`Kind "${kind.name}" allows "${name}", which needs facets it does not provide: ${missing.join(", ")}.`);
    }
  }
  return Object.freeze({ ...kind, facets: [...facets], anchors: [...kind.anchors] });
}

/** Checks that every table, index or view an app's migrations create is named under the app. */
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
