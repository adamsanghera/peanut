/**
 * The comment store: one SQLite file per app folder, holding threads on
 * documents and the revisions of those documents they were made on.
 *
 * Nothing can rebuild this data, and peanut never writes a document. A
 * document becomes tracked with its first thread. From then on, every
 * observe() records its content as a new revision when it changed, so each
 * thread can say which revision it was made on. Where a thread's anchor is
 * placed in a later revision is computed on read by its anchor type, never
 * stored.
 *
 * The viewer and any number of CLI processes share the file. WAL mode and a
 * busy timeout serialize their writes, and BEGIN IMMEDIATE keeps two writers
 * from claiming the same revision number.
 *
 * Deleting is permanent and human-only. The CLI that agents use has no
 * delete verb, so in practice only the viewer deletes.
 *
 * A human's messages can be pending, like comments in a GitHub review that
 * is not yet submitted: stored and shown in the viewer, but hidden from every
 * agent-facing read until the human sends the batch. A pending message has no
 * sent_at yet. Sending stamps them all in one transaction, so an agent sees
 * the whole batch at once. A thread is a draft while its first message is
 * pending, and anything added to a draft joins it.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StoreError } from "./errors.ts";
import { filterSql } from "./filter.ts";
import type { Registry } from "./registry.ts";
import { migrate } from "./schema.ts";
import type {
  Author,
  DocumentFilter,
  DocumentInfo,
  JsonObject,
  Message,
  Revision,
  RevisionInput,
  Status,
  StoredRevision,
  ThreadView,
} from "./types.ts";

export const STORE_FILE = "peanut.sqlite3";
const BUSY_TIMEOUT_MS = 5000;

export const STATUS_LABELS: Record<Status, string> = { open: "open", suggested: "suggested resolved", resolved: "resolved" };

// The statuses each kind of author may move a thread to, and from which.
// Agents can only say a thread is done. Humans resolve and reopen.
const TRANSITIONS: Record<Author["kind"], Partial<Record<Status, Status[]>>> = {
  agent: { suggested: ["open"] },
  human: { resolved: ["open", "suggested"], open: ["suggested", "resolved"] },
};

const THREAD_ROW = "SELECT t.*, f.first_message_id, f.draft, f.waiting_on FROM threads t JOIN thread_facts f ON f.thread_id = t.id";

// Rows as SQLite returns them, named as the schema (schema.ts) names columns.
interface DocumentRow {
  id: number;
  type: string;
  key: string;
  created_at: string;
}

interface RevisionRow {
  id: number;
  document_id: number;
  seq: number;
  sha256: string;
  content: string;
  meta: string;
  observed_at: string;
}

interface ThreadRow {
  id: number;
  document_id: number;
  revision_id: number;
  anchor_type: string;
  anchor: string;
  quote: string;
  status: Status;
  status_by: string | null;
  status_at: string | null;
  created_at: string;
  first_message_id: number;
  draft: number;
  waiting_on: Author["kind"] | null;
}

interface MessageRow {
  id: number;
  thread_id: number;
  author: string;
  author_kind: Author["kind"];
  session: string | null;
  body: string;
  revision_seq: number;
  created_at: string;
  sent_at: string | null;
}

/** A tracked document as documents() lists it. */
export interface DocumentSummary {
  type: string;
  key: string;
  createdAt: string;
  threads: number;
}

export interface ReadOptions {
  /** The viewer's view: drafts and pending messages too. */
  includePending?: boolean;
  /** Each thread's source text, from its anchor type. */
  excerpts?: boolean;
}

export interface ThreadsAt {
  document: DocumentInfo;
  revision: StoredRevision;
  threads: ThreadView[];
}

export interface CreateThread {
  type: string;
  key: string;
  /** The content the commenter saw. Without it the document type reads the document as it is now. */
  content?: string;
  meta?: JsonObject;
  anchorType: string;
  spec?: unknown;
  body: string;
  author: Author;
  pending?: boolean;
}

export type Action = { reply: number; message: string } | { suggestResolve: number; message: string };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Opens the store in `dir` (from findFolder() and prepareFolder()), creating
 * it on first use, and migrates the core's and `registry`'s apps' tables.
 * node:sqlite loads lazily, so a Node without it fails here instead of at
 * import time.
 */
export async function openStore({ registry, dir }: { registry: Registry; dir: string }): Promise<Store> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, STORE_FILE));
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db, registry);
  db.exec("PRAGMA foreign_keys = ON");
  return new Store(db, registry);
}

export class Store {
  #db: DatabaseSync;
  #registry: Registry;
  #writes = 0;
  #listeners = new Set<() => void>();

  constructor(db: DatabaseSync, registry: Registry) {
    this.#db = db;
    this.#registry = registry;
  }

  close(): void {
    this.#db.close();
  }

  /** The SQLite handle, for an app's own tables. Its writes do not notify onWrite() listeners. */
  get db(): DatabaseSync {
    return this.#db;
  }

  /** Changes whenever this process or another one writes to the store. */
  changeToken(): string {
    return `${this.#get<{ data_version: number }>("PRAGMA data_version")!.data_version}:${this.#writes}`;
  }

  /** Calls `listener` after each write this process commits. Returns a function that stops it. */
  onWrite(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The tracked document, or null when it has no threads. */
  document(type: string, key: string): DocumentRow | null {
    return this.#get<DocumentRow>("SELECT * FROM documents WHERE type = ? AND key = ?", type, key) ?? null;
  }

  /** Tracked documents matching `filter`, by type and key, with how many threads each has. */
  documents(filter: DocumentFilter = null): DocumentSummary[] {
    const where = filterSql(filter);
    return this.#all<DocumentSummary>(
      `SELECT d.type, d.key, d.created_at AS createdAt, (SELECT count(*) FROM threads t WHERE t.document_id = d.id) AS threads
       FROM documents d WHERE ${where.sql} ORDER BY d.type, d.key`,
      ...where.params,
    );
  }

  /**
   * Records a tracked document's content as a new revision when it changed.
   * `input` is what the caller already read; without it the document type
   * reads it. Returns {document, revision}, or null for a document without
   * threads. A document that is gone keeps its last revision.
   */
  observe(type: string, key: string, input?: RevisionInput): { document: DocumentRow; revision: StoredRevision } | null {
    const document = this.document(type, key);
    if (!document) return null;
    const current = input ?? this.#registry.documentType(type).readContent(key);
    if (!current) return { document, revision: this.#info(this.#latestRevision(document.id)!) };
    return this.#transaction(() => ({ document, revision: this.#info(this.#recordRevision(document.id, current)) }));
  }

  /** A tracked document's stored content with hash `sha`, or null. */
  contentForSha(type: string, key: string, sha: string): string | null {
    const document = this.document(type, key);
    return (document && this.#revisionBySha(document.id, sha)?.content) ?? null;
  }

  /**
   * Starts a thread on what the commenter saw and returns its id.
   * `anchorType` pins the thread from `spec`. The document becomes tracked
   * if it was not already. A `pending` thread stays hidden from agents until
   * the human sends the batch.
   */
  createThread({ type, key, content, meta, anchorType, spec = {}, body, author, pending = false }: CreateThread): number {
    if (!body?.trim()) throw new StoreError("A comment needs a message.");
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    const documentType = this.#registry.documentType(type);
    if (!this.#registry.allows(type, anchorType)) {
      throw new StoreError(`A thread on a ${documentType.noun} cannot be pinned with ${anchorType}. It allows ${documentType.anchorTypes.join(", ")}.`);
    }
    const input = content !== undefined ? { content, meta } : documentType.readContent(key);
    if (!input) throw new StoreError(`${documentType.displayName(key)} is gone, so there is nothing to comment on.`);
    const seen: Revision = { seq: null, sha256: sha256(input.content), content: input.content, meta: input.meta ?? {} };

    // Pin before taking the write lock: an anchor type may read files or git to do it.
    const pinned = this.#registry.anchorType(anchorType).create(seen, spec);
    return this.#transaction(() => {
      const document = this.#findOrInsertDocument(type, key);
      const revision = this.#revisionBySha(document.id, seen.sha256) ?? this.#recordRevision(document.id, input);
      const thread = this.#get<{ id: number }>(
        `INSERT INTO threads (document_id, revision_id, anchor_type, anchor, quote, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        document.id,
        revision.id,
        anchorType,
        JSON.stringify(pinned.anchor ?? {}),
        pinned.quote ?? "",
        now(),
      )!;
      this.#insertMessage(thread.id, revision.id, body, author, pending);
      this.#writes++;
      return Number(thread.id);
    });
  }

  /**
   * Adds a message. A human reply to a suggested thread reopens it at once;
   * if the reply is `pending`, the thread still waits on the human until the
   * batch is sent. A reply to a draft thread is pending too, so no agent ever
   * sees a reply before the comment it answers.
   */
  reply(threadId: number, body: string, author: Author, { pending = false } = {}): void {
    if (!body?.trim()) throw new StoreError("A reply needs a message.");
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    this.#transaction(() => {
      const thread = this.#visibleThreadRow(threadId, author);
      this.#insertMessage(thread.id, this.#latestRevision(thread.document_id)!.id, body, author, pending || Boolean(thread.draft));
      if (author.kind === "human" && thread.status === "suggested") this.#updateStatus(thread.id, "open", author);
      this.#writes++;
    });
  }

  /**
   * Moves a thread to `status` if `author` may: agents suggest resolving,
   * which needs a message saying what changed, and humans resolve or reopen.
   * An optional `body` is added as a message first. A reopen without one
   * records "Reopened." so the thread shows it waits on the agent again.
   * With `pending`, that message joins the human's batch.
   */
  setStatus(threadId: number, status: Status, author: Author, body?: string, { pending = false } = {}): void {
    this.#transaction(() => this.#setStatus(threadId, status, author, body, { pending }));
  }

  /**
   * Applies a list of agent actions in one transaction, all or none. One
   * write wakes the viewer once, however many threads it answers.
   */
  apply(actions: Action[], author: Author): void {
    if (!Array.isArray(actions) || !actions.length) throw new StoreError("Give a non-empty list of actions.");
    this.#transaction(() => {
      actions.forEach((action, i) => {
        const where = `Action ${i + 1}`;
        if (typeof action?.message !== "string" || !action.message.trim()) throw new StoreError(`${where} needs a message.`);
        if ("reply" in action && Number.isInteger(action.reply)) {
          const thread = this.#visibleThreadRow(action.reply, author);
          this.#insertMessage(thread.id, this.#latestRevision(thread.document_id)!.id, action.message, author, false);
          this.#writes++;
        } else if ("suggestResolve" in action && Number.isInteger(action.suggestResolve)) {
          this.#setStatus(action.suggestResolve, "suggested", author, action.message, { pending: false });
        } else {
          throw new StoreError(`${where} must name a thread with "reply" or "suggestResolve".`);
        }
      });
    });
  }

  /** How many messages wait in the human's unsent batch. */
  pendingCount(): number {
    return Number(this.#get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE sent_at IS NULL")!.n);
  }

  /**
   * Sends every pending message in one transaction and returns how many went.
   * Each takes a send time later than every sent message, so a reply drafted
   * before an agent's answer still reads as the latest word, even when both
   * land in the same millisecond.
   */
  sendPending(author: Author): number {
    if (author.kind !== "human") throw new StoreError("Only a human sends a batch.");
    return this.#transaction(() => {
      const latest = this.#get<{ at: string | null }>("SELECT max(sent_at) AS at FROM messages")!.at;
      const at = new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString();
      const changes = Number(this.#run("UPDATE messages SET sent_at = ? WHERE sent_at IS NULL", at));
      if (changes) this.#writes++;
      return changes;
    });
  }

  /** Deletes every pending message, and every thread that was only a draft. Returns how many messages went. */
  discardPending(author: Author): number {
    if (author.kind !== "human") throw new StoreError("Only a human discards a batch.");
    return this.#transaction(() => {
      const drafts = this.#all<{ id: number; document_id: number }>(
        "SELECT t.id, t.document_id FROM threads t JOIN thread_facts f ON f.thread_id = t.id WHERE f.draft",
      );
      const count = Number(this.#run("DELETE FROM messages WHERE sent_at IS NULL"));
      for (const draft of drafts) this.#deleteThreadRows(draft.id, draft.document_id);
      if (count) this.#writes++;
      return count;
    });
  }

  /**
   * Permanently deletes a thread and its messages. Only a human may. When it
   * was the document's last thread, its stored revisions go too, because only
   * documents with threads keep copies.
   */
  deleteThread(threadId: number, author: Author): void {
    if (author.kind !== "human") throw new StoreError("Only a human deletes comments.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      this.#deleteThreadRows(thread.id, thread.document_id);
      this.#writes++;
    });
  }

  /** Permanently deletes one reply. Only a human may. The first message goes only with its thread. */
  deleteMessage(threadId: number, messageId: number, author: Author): void {
    if (author.kind !== "human") throw new StoreError("Only a human deletes comments.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      const message = this.#get<{ id: number }>("SELECT id FROM messages WHERE id = ? AND thread_id = ?", Number(messageId), thread.id);
      if (!message) throw new StoreError(`Thread #${thread.id} has no message ${messageId}.`);
      if (message.id === thread.first_message_id) throw new StoreError("The first message is the comment itself. Delete the thread instead.");
      this.#run("DELETE FROM messages WHERE id = ?", message.id);
      this.#writes++;
    });
  }

  /** One stored revision of a tracked document, with its content, or null. */
  revisionAt(type: string, key: string, seq: number): StoredRevision | null {
    const document = this.document(type, key);
    const revision = document && this.#get<RevisionRow>("SELECT * FROM revisions WHERE document_id = ? AND seq = ?", document.id, seq);
    return revision ? this.#info(revision) : null;
  }

  /** A tracked document's revisions, newest first, with how many threads each one started. */
  revisions(type: string, key: string): (StoredRevision & { threads: number })[] {
    const document = this.document(type, key);
    if (!document) return [];
    return this.#all<RevisionRow & { threads: number }>(
      `SELECT r.*, (SELECT count(*) FROM threads t WHERE t.revision_id = r.id) AS threads
       FROM revisions r WHERE r.document_id = ? ORDER BY r.seq DESC`,
      document.id,
    ).map((row) => ({ ...this.#info(row), threads: row.threads }));
  }

  /**
   * Ids of threads waiting on an agent in documents matching `filter`, and
   * with a sent message newer than message id `after` when given. Cheap
   * enough to run on every doorbell ring.
   */
  waitingOnAgent({ filter = null, after = 0 }: { filter?: DocumentFilter; after?: number } = {}): number[] {
    const where = filterSql(filter);
    return this.#all<{ id: number }>(
      `SELECT t.id FROM threads t
       JOIN thread_facts f ON f.thread_id = t.id JOIN documents d ON d.id = t.document_id
       WHERE f.waiting_on = 'agent' AND ${where.sql}
         AND (SELECT max(id) FROM messages WHERE thread_id = t.id AND sent_at IS NOT NULL) > ?
       ORDER BY t.id`,
      ...where.params,
      after,
    ).map((row) => Number(row.id));
  }

  /** The newest sent message's id: the cursor `wait --after` takes. 0 in an empty store. */
  cursor(): number {
    return Number(this.#get<{ id: number | null }>("SELECT max(id) AS id FROM messages WHERE sent_at IS NOT NULL")!.id ?? 0);
  }

  /**
   * Every thread on a document, placed in one of its revisions: the one
   * whose content hashes to `sha`, or the latest. Threads made after that
   * revision are left out, and so are drafts and pending messages unless
   * `includePending` (the viewer) asks for them. Returns null when the
   * document has no threads or no such revision.
   */
  threadsAt(type: string, key: string, { sha, ...options }: ReadOptions & { sha?: string } = {}): ThreadsAt | null {
    const document = this.document(type, key);
    if (!document) return null;
    const revision = sha ? this.#revisionBySha(document.id, sha) : this.#latestRevision(document.id);
    if (!revision) return null;
    const rows = this.#all<ThreadRow>(
      `${THREAD_ROW} WHERE t.document_id = ? AND t.revision_id IN (SELECT id FROM revisions WHERE document_id = ? AND seq <= ?) ORDER BY t.id`,
      document.id,
      document.id,
      revision.seq,
    );
    return { document: this.#documentInfo(document), revision: this.#info(revision), threads: this.#views(document, revision, rows, options) };
  }

  /** threadsAt() for every tracked document matching `filter`, at its latest revision, leaving out documents with nothing to show. */
  threadsIn(filter: DocumentFilter, options: ReadOptions = {}): ThreadsAt[] {
    return this.documents(filter)
      .map((d) => this.threadsAt(d.type, d.key, options))
      .filter((group): group is ThreadsAt => Boolean(group?.threads.length));
  }

  /** One thread, placed in its document's latest revision. A draft does not exist for agents. */
  thread(threadId: number, options: ReadOptions = {}): { document: DocumentInfo; revision: StoredRevision; thread: ThreadView } {
    const row = this.#threadRow(threadId);
    const document = this.#documentById(row.document_id);
    const revision = this.#latestRevision(document.id)!;
    const [view] = this.#views(document, revision, [row], options);
    if (!view) throw new StoreError(`No thread #${threadId}.`);
    return { document: this.#documentInfo(document), revision: this.#info(revision), thread: view };
  }

  /** The document a thread is on, so callers can observe it before acting. */
  documentOf(threadId: number): { type: string; key: string } {
    const document = this.#documentById(this.#threadRow(threadId).document_id);
    return { type: document.type, key: document.key };
  }

  // node:sqlite types every row as Record<string, SQLOutputValue>. These name the shape each query returns.
  #get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }

  /** Runs a write and returns how many rows it changed. */
  #run(sql: string, ...params: SQLInputValue[]): number | bigint {
    return this.#db.prepare(sql).run(...params).changes;
  }

  /** Runs `fn` under the write lock. Listeners hear about its writes only after they commit. */
  #transaction<T>(fn: () => T): T {
    const before = this.#writes;
    this.#db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      this.#writes = before;
      throw err;
    }
    if (this.#writes !== before) for (const listener of this.#listeners) listener();
    return result;
  }

  #setStatus(threadId: number, status: Status, author: Author, body: string | undefined, { pending }: { pending: boolean }): void {
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    if (!Object.hasOwn(STATUS_LABELS, status)) throw new StoreError(`Unknown status "${status}".`);
    const allowedFrom = TRANSITIONS[author.kind]?.[status];
    if (!allowedFrom) {
      throw new StoreError(
        author.kind === "agent"
          ? "Only a human resolves or reopens a thread. Use suggest-resolve to say it is done."
          : "Suggesting is for agents. Resolve the thread instead.",
      );
    }
    if (status === "suggested" && !body?.trim()) throw new StoreError("Say what changed when suggesting a thread is resolved.");
    const thread = this.#visibleThreadRow(threadId, author);
    if (thread.status === status) throw new StoreError(`Thread #${thread.id} is already ${STATUS_LABELS[status]}.`);
    if (!allowedFrom.includes(thread.status)) {
      throw new StoreError(`Thread #${thread.id} is ${STATUS_LABELS[thread.status]}, so it cannot become ${STATUS_LABELS[status]}.`);
    }
    const message = body?.trim() || (status === "open" ? "Reopened." : "");
    if (message) this.#insertMessage(thread.id, this.#latestRevision(thread.document_id)!.id, message, author, pending || Boolean(thread.draft));
    this.#updateStatus(thread.id, status, author);
    this.#writes++;
  }

  /** Returns the document's latest revision, inserting `input` as the next one when its content differs. */
  #recordRevision(documentId: number, { content, meta = {} }: RevisionInput): RevisionRow {
    const sha = sha256(content);
    const latest = this.#latestRevision(documentId);
    // Only the content is what threads are on: a change to meta alone (a rebase that moves no code) is not a revision.
    if (latest?.sha256 === sha) return latest;
    this.#writes++;
    return this.#get<RevisionRow>(
      "INSERT INTO revisions (document_id, seq, sha256, content, meta, observed_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
      documentId,
      (latest?.seq ?? 0) + 1,
      sha,
      content,
      JSON.stringify(meta ?? {}),
      now(),
    )!;
  }

  #findOrInsertDocument(type: string, key: string): DocumentRow {
    return this.document(type, key) ?? this.#get<DocumentRow>("INSERT INTO documents (type, key, created_at) VALUES (?, ?, ?) RETURNING *", type, key, now())!;
  }

  #documentById(id: number): DocumentRow {
    return this.#get<DocumentRow>("SELECT * FROM documents WHERE id = ?", id)!;
  }

  #documentInfo(document: DocumentRow): DocumentInfo {
    const type = this.#registry.documentType(document.type);
    return { type: document.type, key: document.key, displayName: type.displayName(document.key) };
  }

  #threadRow(id: number): ThreadRow {
    const row = this.#get<ThreadRow>(`${THREAD_ROW} WHERE t.id = ?`, Number(id));
    if (!row) throw new StoreError(`No thread #${id}.`);
    return row;
  }

  /** A thread's row, refusing agents a thread that is still a human's draft, as if it did not exist. */
  #visibleThreadRow(id: number, author: Author): ThreadRow {
    const row = this.#threadRow(id);
    if (author.kind !== "human" && row.draft) throw new StoreError(`No thread #${id}.`);
    return row;
  }

  #deleteThreadRows(threadId: number, documentId: number): void {
    this.#run("DELETE FROM messages WHERE thread_id = ?", threadId);
    this.#run("DELETE FROM threads WHERE id = ?", threadId);
    if (this.#get<{ n: number }>("SELECT count(*) AS n FROM threads WHERE document_id = ?", documentId)!.n === 0) {
      this.#run("DELETE FROM revisions WHERE document_id = ?", documentId);
      this.#run("DELETE FROM documents WHERE id = ?", documentId);
    }
  }

  #latestRevision(documentId: number): RevisionRow | undefined {
    return this.#get<RevisionRow>("SELECT * FROM revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1", documentId);
  }

  #revisionBySha(documentId: number, sha: string): RevisionRow | undefined {
    return this.#get<RevisionRow>("SELECT * FROM revisions WHERE document_id = ? AND sha256 = ? ORDER BY seq DESC LIMIT 1", documentId, sha);
  }

  #revisionById(id: number): RevisionRow {
    return this.#get<RevisionRow>("SELECT * FROM revisions WHERE id = ?", id)!;
  }

  /** A revision row as anchor types and callers see it. Rows from node:sqlite have a null prototype, so this also makes a plain object. */
  #info(row: RevisionRow): StoredRevision {
    return { id: Number(row.id), seq: row.seq, sha256: row.sha256, content: row.content, meta: JSON.parse(row.meta) as JsonObject, observedAt: row.observed_at };
  }

  #insertMessage(threadId: number, revisionId: number, body: string, author: Author, pending = false): void {
    const at = now();
    this.#run(
      `INSERT INTO messages (thread_id, revision_id, author, author_kind, session, body, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      threadId,
      revisionId,
      author.name,
      author.kind,
      author.session ?? null,
      body.trim(),
      at,
      pending ? null : at,
    );
  }

  #updateStatus(threadId: number, status: Status, author: Author): void {
    this.#run("UPDATE threads SET status = ?, status_by = ?, status_at = ? WHERE id = ?", status, author.name, now(), threadId);
  }

  #messagesFor(threadIds: number[]): Map<number, Message[]> {
    const byThread = new Map<number, Message[]>(threadIds.map((id) => [id, []]));
    if (!threadIds.length) return byThread;
    // Sent messages go by send time, so a sent batch follows anything posted while it was drafted; pending ones come last.
    const rows = this.#all<MessageRow>(
      `SELECT m.*, r.seq AS revision_seq FROM messages m JOIN revisions r ON r.id = m.revision_id
       WHERE m.thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY m.sent_at IS NULL, m.sent_at, m.id`,
      ...threadIds,
    );
    for (const m of rows) {
      byThread.get(Number(m.thread_id))?.push({
        id: Number(m.id),
        author: m.author,
        authorKind: m.author_kind,
        session: m.session,
        body: m.body,
        revisionSeq: m.revision_seq,
        createdAt: m.created_at,
        sentAt: m.sent_at,
        pending: m.sent_at === null,
      });
    }
    return byThread;
  }

  /**
   * Thread rows as callers see them, placed in `revisionRow`. Without
   * `includePending`, drafts and pending messages are left out.
   *
   * The state is the core's, the same for every anchor type: current when
   * made on this revision, carried when made earlier and still placed,
   * outdated when the anchor type cannot place it here. An outdated thread
   * shows where it was (madeOn) and, when the anchor type can guess, what
   * its text became (nowReads).
   */
  #views(document: DocumentRow, revisionRow: RevisionRow, rows: ThreadRow[], { includePending = false, excerpts = false }: ReadOptions): ThreadView[] {
    const documentType = this.#registry.documentType(document.type);
    const documentInfo = this.#documentInfo(document);
    const revision = this.#info(revisionRow);
    const revisions = new Map<number, StoredRevision>([[revision.id, revision]]);
    const revisionOf = (id: number): StoredRevision => {
      let found = revisions.get(id);
      if (!found) revisions.set(id, (found = this.#info(this.#revisionById(id))));
      return found;
    };
    const visible = includePending ? rows : rows.filter((row) => !row.draft);
    const messages = this.#messagesFor(visible.map((r) => Number(r.id)));

    return visible.map((row) => {
      const anchorType = this.#registry.anchorType(row.anchor_type);
      const anchor = JSON.parse(row.anchor) as JsonObject;
      const origin = revisionOf(Number(row.revision_id));
      const madeHere = origin.id === revision.id;
      const placement: JsonObject | null = anchorType.place(anchor, revision);
      const madeOnPlacement: JsonObject | null = madeHere ? placement : anchorType.place(anchor, origin);
      const state = !placement ? "outdated" : madeHere ? "current" : "carried";
      const next: JsonObject | null = !placement && madeOnPlacement && anchorType.successor ? anchorType.successor(anchor, origin, revision) : null;
      // An outdated thread is shown where it was, in the revision it was made on.
      const shown = placement ? { placement, revision } : { placement: madeOnPlacement, revision: origin };
      const all = messages.get(Number(row.id)) ?? [];
      const view: ThreadView = {
        id: Number(row.id),
        status: row.status,
        pending: Boolean(row.draft),
        waitingOn: row.waiting_on,
        document: documentInfo,
        anchorType: row.anchor_type,
        state,
        placement,
        label: anchorType.label(anchor, shown.placement, documentType),
        madeOn: { seq: origin.seq, placement: madeOnPlacement },
        nowReads: next && { placement: next, label: anchorType.label(anchor, next, documentType) },
        quote: row.quote,
        statusBy: row.status_by,
        statusAt: row.status_at,
        createdAt: row.created_at,
        messages: includePending ? all : all.filter((m) => !m.pending),
      };
      if (excerpts && anchorType.excerpt) {
        view.excerpt = shown.placement ? { seq: shown.revision.seq, text: anchorType.excerpt(anchor, shown.placement, shown.revision) } : null;
        if (view.nowReads && next) view.nowReads.excerpt = anchorType.excerpt(anchor, next, revision);
      }
      return view;
    });
  }
}
