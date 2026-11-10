import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CORE_MIGRATIONS, migrate, Registry } from "../src/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NOTES = { name: "notes", migrations: ["CREATE TABLE notes_viewed (path TEXT PRIMARY KEY)"] };

function tables(db: DatabaseSync): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all().map((r) => String(r.name));
}

test("migrating creates the core's tables and each registered app's, once", () => {
  const db = new DatabaseSync(":memory:");
  const registry = new Registry().register(NOTES);
  assert.deepEqual(migrate(db, registry), ["core:1", "core:2", "notes:1"]);
  assert.deepEqual(migrate(db, registry), []);
  assert.deepEqual(tables(db), ["documents", "messages", "migrations", "notes_viewed", "revisions", "thread_facts", "threads", "tombstones"]);
});

test("an app's new steps run without touching the core or other apps", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, new Registry().register(NOTES).register({ name: "code", migrations: ["CREATE TABLE code_viewed (path TEXT)"] }));
  const grown = { ...NOTES, migrations: [...NOTES.migrations, "ALTER TABLE notes_viewed ADD COLUMN at TEXT"] };
  // A process that registers only notes leaves code's tables and version alone.
  assert.deepEqual(migrate(db, new Registry().register(grown)), ["notes:2"]);
  assert.deepEqual(db.prepare("SELECT namespace, version FROM migrations ORDER BY namespace").all().map((r) => ({ ...r })), [
    { namespace: "code", version: 1 },
    { namespace: "core", version: 2 },
    { namespace: "notes", version: 2 },
  ]);
});

test("a store migrated by newer code is refused, and nothing changes", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, new Registry().register({ ...NOTES, migrations: [...NOTES.migrations, "CREATE TABLE notes_more (x)"] }));
  assert.throws(() => migrate(db, new Registry().register(NOTES)), /more than this code knows/);
});

test("a failing step rolls back every step of that open", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => migrate(db, new Registry().register({ name: "notes", migrations: ["CREATE TABLE notes_ok (x)", "CREATE TABLE notes_ok (x)"] })));
  assert.deepEqual(tables(db), []);
});

test("thread_facts says whose turn it is", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, new Registry());
  const now = "2026-11-01T00:00:00.000Z";
  db.exec(`INSERT INTO documents (id, type, key, created_at) VALUES (1, 'notes.page', '/a.md', '${now}');
    INSERT INTO revisions (id, document_id, seq, sha256, content, observed_at) VALUES (1, 1, 1, 'x', '# A', '${now}');
    INSERT INTO threads (id, document_id, revision_id, anchor_type, anchor, created_at) VALUES (1, 1, 1, 'markdown.block', '{}', '${now}');`);
  const say = (kind: string, sentAt: string | null) =>
    db.prepare("INSERT INTO messages (thread_id, revision_id, author, author_kind, body, created_at, sent_at) VALUES (1, 1, 'x', ?, 'hi', ?, ?)").run(kind, now, sentAt);
  const facts = () => ({ ...db.prepare("SELECT draft, waiting_on FROM thread_facts").get() });

  say("human", null);
  assert.deepEqual(facts(), { draft: 1, waiting_on: null });
  db.exec(`UPDATE messages SET sent_at = '${now}'`);
  assert.deepEqual(facts(), { draft: 0, waiting_on: "agent" });
  say("agent", "2026-11-01T00:00:01.000Z");
  assert.deepEqual(facts(), { draft: 0, waiting_on: "human" });
  db.exec("UPDATE threads SET status = 'resolved'");
  assert.deepEqual(facts(), { draft: 0, waiting_on: null });
});

test("anchors and meta must be JSON", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, new Registry());
  assert.throws(() => db.exec("INSERT INTO revisions (document_id, seq, sha256, content, meta, observed_at) VALUES (1, 1, 'x', '', 'nope', 'now')"), /CHECK/);
});

test("core:2 gives existing threads and messages uids, keeps their ids, and code from before it still gets uids", () => {
  const db = new DatabaseSync(":memory:");
  // A store as core:1 left it, with a thread whose status changed and one whose did not.
  db.exec("CREATE TABLE migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  db.exec(CORE_MIGRATIONS[0]!);
  db.exec("INSERT INTO migrations VALUES ('core', 1)");
  const now = "2026-11-01T00:00:00.000Z";
  db.exec(`INSERT INTO documents (id, type, key, created_at) VALUES (1, 'notes.page', '/a.md', '${now}');
    INSERT INTO revisions (id, document_id, seq, sha256, content, observed_at) VALUES (1, 1, 1, 'x', '# A', '${now}');
    INSERT INTO threads (id, document_id, revision_id, anchor_type, anchor, created_at) VALUES (7, 1, 1, 'markdown.block', '{}', '${now}');
    INSERT INTO threads (id, document_id, revision_id, anchor_type, anchor, status, status_by, status_at, created_at)
      VALUES (12, 1, 1, 'markdown.block', '{}', 'resolved', 'adam', '${now}', '${now}');
    INSERT INTO messages (id, thread_id, revision_id, author, author_kind, body, created_at, sent_at) VALUES (3, 7, 1, 'adam', 'human', 'hi', '${now}', '${now}');
    INSERT INTO messages (id, thread_id, revision_id, author, author_kind, body, created_at, sent_at) VALUES (4, 12, 1, 'adam', 'human', 'yo', '${now}', '${now}');`);

  assert.deepEqual(migrate(db, new Registry()), ["core:2"]);
  assert.deepEqual(migrate(db, new Registry()), [], "a second open runs nothing");

  const threads = db.prepare("SELECT id, uid, status_seq FROM threads ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(threads.map((t) => [t.id, t.status_seq]), [[7, 0], [12, 1]]);
  const messages = db.prepare("SELECT id, uid FROM messages ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(messages.map((m) => m.id), [3, 4]);
  const uids = [...threads, ...messages].map((r) => String(r.uid));
  for (const uid of uids) assert.match(uid, UUID);
  assert.equal(new Set(uids).size, uids.length);

  // An insert that names no uid, as code from before core:2 makes, gets one.
  db.exec(`INSERT INTO threads (id, document_id, revision_id, anchor_type, anchor, created_at) VALUES (13, 1, 1, 'markdown.block', '{}', '${now}');
    INSERT INTO messages (id, thread_id, revision_id, author, author_kind, body, created_at, sent_at) VALUES (5, 13, 1, 'adam', 'human', 'new', '${now}', '${now}');`);
  assert.match(String(db.prepare("SELECT uid FROM threads WHERE id = 13").get()!.uid), UUID);
  assert.match(String(db.prepare("SELECT uid FROM messages WHERE id = 5").get()!.uid), UUID);
  assert.throws(() => db.exec(`UPDATE threads SET uid = '${threads[0]!.uid}' WHERE id = 12`), /UNIQUE/);
});
