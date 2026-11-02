/**
 * The shapes an app hands peanut. The registry (registry.ts) also checks
 * them at runtime, for apps written in plain JavaScript.
 *
 * Names are namespaced: a document type or an anchor type is
 * "<namespace>.<name>", where the namespace is the app that defines it, or
 * "core" / "markdown" for the ones peanut ships.
 */

/** JSON as the store keeps it: anchors, placements and revision meta. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** An app: a namespace that registers document types, anchor types and its own tables. */
export interface App {
  /** Lowercase, e.g. "diffview". Prefixes its types and tables. */
  name: string;
  /** Names the folder its store lives in: ".<folder>" in a project, "~/.<folder>" at home. Defaults to the app's name. */
  folder?: string;
  documentTypes?: DocumentType[];
  anchorTypes?: AnyAnchorType[];
  /** SQL steps, run once each in order. Tables must be named "<app>_<table>". */
  migrations?: string[];
}

/**
 * What kind of document something is: what its document key means, and how
 * to read its content. It never parses the content; its anchor types do.
 */
export interface DocumentType {
  /** "<app>.<name>", e.g. "mdview.doc". */
  name: string;
  /** What people call one: "doc", "branch". Used in "the whole branch". */
  noun: string;
  /** Anchor types threads on it may use. */
  anchorTypes: string[];
  /** The document's content as it reads now, or null when it is gone. */
  readContent(key: string): RevisionInput | null;
  /** A short name for the document: "plan.md", "feat-x". */
  displayName(key: string): string;
}

/**
 * What a document type hands the store to record. A revision's identity is
 * the hash of `content` alone; `meta` rides along with the first revision
 * that has that content.
 */
export interface RevisionInput {
  content: string;
  meta?: JsonObject;
}

/** A revision as anchor types and callers see it. `seq` is null for content not stored yet. */
export interface Revision {
  /** The "v3" people see. */
  seq: number | null;
  /** Of `content`. */
  sha256: string;
  content: string;
  meta: JsonObject;
}

/** A stored revision. */
export interface StoredRevision extends Revision {
  id: number;
  seq: number;
  observedAt: string;
}

/**
 * A way of pinning a thread to part of a document and finding that part
 * again in a later revision.
 *
 * An anchor is stored when the thread is made and never changes: it records
 * what was commented on. An anchor placement is where the anchor is placed
 * in one revision, computed on every read: what the UI highlights and the
 * CLI prints. Both are JSON the anchor type owns, typed by its parameters.
 *
 * The store derives a thread's state from place(): current when the thread
 * was made on the revision shown, carried when made earlier and still
 * placed, outdated when place() returns null.
 *
 * Each method gets revisions as the store holds them, parses what it needs
 * itself, and caches that by the revision's sha256. Every method is
 * synchronous: the store runs them inside reads and transactions.
 */
export interface AnchorType<Anchor extends JsonObject = JsonObject, Placement extends JsonObject = JsonObject, Spec = unknown> {
  /** "<namespace>.<name>", e.g. "markdown.block". */
  name: string;
  /** Pins a new thread from a spec the app's UI or CLI built. Throws AnchorError, worded for the user. */
  create(revision: Revision, spec: Spec): { anchor: Anchor; quote: string };
  /** The anchor's placement in a revision, or null when its text is gone. */
  place(anchor: Anchor, revision: Revision): Placement | null;
  /** For an outdated anchor: the placement in `to` most likely to be what its text became. */
  successor?(anchor: Anchor, from: Revision, to: Revision): Placement | null;
  /** Where the thread sits, in words: 'under "How", line 12', "src/a.js lines 4-6". */
  label(anchor: Anchor, placement: Placement | null, documentType: DocumentType): string;
  /** Source text at the placement, for the CLI's `show`. */
  excerpt?(anchor: Anchor, placement: Placement, revision: Revision): string;
}

/**
 * An anchor type of any anchor and placement, as the registry and store hold
 * them: they only pass anchors and placements between an anchor type's own
 * methods, so they never need to know the shapes.
 */
export type AnyAnchorType = AnchorType<any, any, any>;

export interface Author {
  name: string;
  kind: "human" | "agent";
  /** For agents: the start of their session id. */
  session?: string | null;
}

/**
 * Which documents a list or wait covers. A document is included when it
 * matches any condition. null covers every document; [] covers none.
 */
export type DocumentFilter = Condition[] | null;
export type Condition = { app: string } | { type: string; key: string } | { type: string; keyPrefix: string };

export type Status = "open" | "suggested" | "resolved";
export type ThreadState = "current" | "carried" | "outdated";

/** A document as reads return it. */
export interface DocumentInfo {
  type: string;
  key: string;
  displayName: string;
}

export interface Message {
  id: number;
  author: string;
  authorKind: Author["kind"];
  session: string | null;
  body: string;
  /** The revision that was latest when the message was written. */
  revisionSeq: number;
  createdAt: string;
  /** null while pending in the human's batch. */
  sentAt: string | null;
  pending: boolean;
}

/** A thread as reads return it, placed in one revision. */
export interface ThreadView {
  id: number;
  status: Status;
  /** A draft: its first message is still in the human's batch. */
  pending: boolean;
  waitingOn: Author["kind"] | null;
  document: DocumentInfo;
  anchorType: string;
  /** What the thread was pinned to, as its anchor type stored it. */
  anchor: JsonObject;
  state: ThreadState;
  /** Where the anchor is placed in the revision shown; null when outdated. */
  placement: JsonObject | null;
  /** The anchor type's words for where the thread sits, or sat when outdated. */
  label: string;
  /** Where it was, in the revision it was made on. */
  madeOn: { seq: number; placement: JsonObject | null };
  /** Outdated only: what its text most likely became. */
  nowReads: { placement: JsonObject; label: string; excerpt?: string } | null;
  /** When asked for: the source shown, from the revision it was shown in. */
  excerpt?: { seq: number; text: string } | null;
  quote: string;
  statusBy: string | null;
  statusAt: string | null;
  createdAt: string;
  messages: Message[];
}
