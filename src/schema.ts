/**
 * The shared store's tables, and the migrations of each namespace.
 *
 * The core and every app migrate independently: `migrations` holds how many
 * of each namespace's steps have run. Opening the store runs the core's
 * pending steps and those of every app the process registered. Tables of
 * apps it did not register are left alone, so diffview never needs mdview's
 * code to open the file both write.
 *
 * What is derived from messages (whether a thread is a draft, and whose turn
 * it is) is defined once, in the thread_facts view, and every reader uses it.
 * It is unchanged from mdview's and diffview's stores.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Registry } from "./registry.ts";

/** A random version 4 UUID, made by SQLite, the same shape as crypto.randomUUID(). */
const UUID_SQL =
  "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || " +
  "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";

/** The core's steps. Append; never edit a step that has shipped. */
export const CORE_MIGRATIONS: readonly string[] = [
  `
CREATE TABLE documents (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,          -- the document type, "<app>.<name>", from the registry
  key        TEXT NOT NULL,          -- the document key, the app's; filters match it whole or by prefix
  created_at TEXT NOT NULL,
  UNIQUE (type, key)
);
CREATE TABLE revisions (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  seq         INTEGER NOT NULL,      -- the "v3" people see
  sha256      TEXT NOT NULL,         -- of content alone
  content     TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  observed_at TEXT NOT NULL,
  UNIQUE (document_id, seq)
);
CREATE INDEX revisions_by_sha ON revisions (document_id, sha256);
CREATE TABLE threads (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  anchor_type TEXT NOT NULL,         -- "<namespace>.<name>", from the registry
  anchor      TEXT NOT NULL CHECK (json_valid(anchor)),
  quote       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'suggested', 'resolved')),
  status_by   TEXT,
  status_at   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX threads_by_document ON threads (document_id);
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  author      TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  session     TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,                  -- null while pending in the human's batch
  pending     INTEGER GENERATED ALWAYS AS (sent_at IS NULL) VIRTUAL
);
CREATE INDEX messages_by_thread ON messages (thread_id);

-- A thread's first message is the comment itself. Its turn goes by the last
-- sent word, except that a suggested thread waits on the human.
CREATE VIEW thread_facts AS
SELECT t.id AS thread_id,
       first.id AS first_message_id,
       first.sent_at IS NULL AS draft,
       CASE
         WHEN first.sent_at IS NULL OR t.status = 'resolved' OR last.author_kind IS NULL THEN NULL
         WHEN t.status = 'suggested' THEN 'human'
         WHEN last.author_kind = 'human' THEN 'agent'
         ELSE 'human'
       END AS waiting_on
FROM threads t
JOIN messages first ON first.id = (SELECT min(id) FROM messages WHERE thread_id = t.id)
LEFT JOIN messages last ON last.id = (
  SELECT id FROM messages WHERE thread_id = t.id AND sent_at IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT 1
);
`,
  // 2: stable ids, so stores on different machines can be merged (Store.merge).
  // Integer ids stay the primary keys and what apps and URLs name, so nothing
  // that refers to "#12" changes. uid is a random UUID that is the same in
  // every copy of the store. The triggers give a uid to rows that code from
  // before this step inserts, so a process still running it keeps working.
  // status_seq counts status changes, so a merge can tell a later reopen
  // from a concurrent resolve. Tombstones carry deletes across a merge.
  `
ALTER TABLE threads ADD COLUMN uid TEXT;
ALTER TABLE threads ADD COLUMN status_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN uid TEXT;
UPDATE threads SET uid = ${UUID_SQL} WHERE uid IS NULL;
UPDATE messages SET uid = ${UUID_SQL} WHERE uid IS NULL;
UPDATE threads SET status_seq = 1 WHERE status_at IS NOT NULL;
CREATE UNIQUE INDEX threads_by_uid ON threads (uid);
CREATE UNIQUE INDEX messages_by_uid ON messages (uid);
CREATE TRIGGER threads_get_uid AFTER INSERT ON threads WHEN NEW.uid IS NULL
BEGIN UPDATE threads SET uid = ${UUID_SQL} WHERE id = NEW.id; END;
CREATE TRIGGER messages_get_uid AFTER INSERT ON messages WHEN NEW.uid IS NULL
BEGIN UPDATE messages SET uid = ${UUID_SQL} WHERE id = NEW.id; END;
CREATE TABLE tombstones (
  uid        TEXT PRIMARY KEY,       -- of a deleted thread or message
  kind       TEXT NOT NULL CHECK (kind IN ('thread', 'message')),
  deleted_at TEXT NOT NULL
);
`,
];



const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS migrations (
  namespace TEXT PRIMARY KEY,
  version   INTEGER NOT NULL
)`;

/**
 * Brings the core's and every registered app's tables up to date, in one
 * transaction, and returns the steps it ran as ["core:1", "diffview:1", ...].
 * `db` is a node:sqlite DatabaseSync.
 */
export function migrate(db: DatabaseSync, registry: Registry): string[] {
  const namespaces: [string, readonly string[]][] = [["core", CORE_MIGRATIONS], ...registry.apps().map((app): [string, readonly string[]] => [app.name, app.migrations])];
  const ran: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(MIGRATIONS_TABLE);
    const read = db.prepare("SELECT version FROM migrations WHERE namespace = ?");
    const write = db.prepare(
      "INSERT INTO migrations (namespace, version) VALUES (?, ?) ON CONFLICT (namespace) DO UPDATE SET version = excluded.version",
    );
    for (const [namespace, steps] of namespaces) {
      const done = Number(read.get(namespace)?.version ?? 0);
      if (done > steps.length) {
        throw new Error(`The store has ${done} "${namespace}" migrations, more than this code knows (${steps.length}). Is an older ${namespace} running?`);
      }
      for (let i = done; i < steps.length; i++) {
        db.exec(steps[i]!);
        ran.push(`${namespace}:${i + 1}`);
      }
      if (steps.length > done) write.run(namespace, steps.length);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return ran;
}
