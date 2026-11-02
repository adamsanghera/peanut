import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import MarkdownIt from "markdown-it";
import { markdownBlock, openStore, Registry, type Store, StoreError } from "../src/index.ts";
import type { Action, CreateThread } from "../src/store.ts";
import type { App, Author } from "../src/types.ts";

const md = new MarkdownIt();
const HUMAN: Author = { name: "adam", kind: "human" };
const AGENT: Author = { name: "agent", kind: "agent", session: "940d8cee" };

/**
 * A notes app: pages whose content lives in `pages`, so a test edits a page
 * by setting it. A second document type, notes.sketch, takes only whole
 * comments, for filters and allowed anchor types.
 */
function notesApp(pages: Map<string, string>): App {
  return {
    name: "notes",
    anchorTypes: [markdownBlock({ tokenize: (content) => ({ tokens: md.parse(content, {}) }) })],
    documentTypes: [
      {
        name: "notes.page",
        noun: "page",
        anchorTypes: ["markdown.block", "core.whole"],
        readContent: (key: string) => (pages.has(key) ? { content: pages.get(key)!, meta: { from: "disk" } } : null),
        displayName: (key: string) => path.basename(key),
      },
      {
        name: "notes.sketch",
        noun: "sketch",
        anchorTypes: ["core.whole"],
        readContent: (key: string) => ({ content: `sketch ${key}` }),
        displayName: (key: string) => key,
      },
    ],
  };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peanut-store-"));
  const pages = new Map<string, string>();
  const open = () => openStore({ registry: new Registry().register(notesApp(pages)), dir });
  return { pages, store: await open(), open };
}

const PLAN = "# Plan\n\n## Why\n\nThe two stores drifted apart.\n\n## How\n\nOne library.\n";

function comment(store: Store, { key = "a/plan.md", spec = { quote: "drifted apart" }, body = "Why?", author = HUMAN, ...rest }: Partial<CreateThread> = {}): number {
  return store.createThread({ type: "notes.page", key, anchorType: "markdown.block", spec, body, author, ...rest });
}

test("observing a document without threads records nothing", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  assert.equal(store.observe("notes.page", "a/plan.md"), null);
  assert.deepEqual(store.documents(), []);
});

test("a first thread stores what the commenter saw, and only content changes add revisions", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  comment(store);
  assert.deepEqual(store.revisions("notes.page", "a/plan.md").map((r) => [r.seq, r.meta.from, r.threads]), [[1, "disk", 1]]);

  assert.equal(store.observe("notes.page", "a/plan.md")!.revision.seq, 1);
  assert.equal(store.observe("notes.page", "a/plan.md", { content: PLAN, meta: { from: "elsewhere" } })!.revision.seq, 1, "meta alone is not a revision");
  pages.set("a/plan.md", `${PLAN}\nMore.\n`);
  assert.equal(store.observe("notes.page", "a/plan.md")!.revision.seq, 2);
  assert.equal(store.revisionAt("notes.page", "a/plan.md", 1)?.content, PLAN);
  assert.deepEqual(store.revisions("notes.page", "a/plan.md").map((r) => r.seq), [2, 1]);
});

test("two connections observing the same edit record one revision", async () => {
  const { pages, store, open } = await setup();
  pages.set("a/plan.md", PLAN);
  comment(store);
  const other = await open();
  pages.set("a/plan.md", `${PLAN}\nEdited.\n`);
  store.observe("notes.page", "a/plan.md");
  other.observe("notes.page", "a/plan.md");
  assert.deepEqual(store.revisions("notes.page", "a/plan.md").map((r) => r.seq), [2, 1]);
});

test("a thread is carried while its anchor holds, and outdated with a guess when its text changes", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const id = comment(store);
  assert.equal(store.thread(id).thread.state, "current");

  pages.set("a/plan.md", `# Plan\n\n## How\n\nOne library.\n\n## Why\n\nThe two stores\ndrifted apart.\n`);
  store.observe("notes.page", "a/plan.md");
  const carried = store.thread(id, { excerpts: true }).thread;
  assert.equal(carried.state, "carried");
  assert.equal(carried.label, 'under "Why", lines 9-10');
  assert.deepEqual(carried.excerpt, { seq: 2, text: "The two stores\ndrifted apart." });
  assert.equal(carried.madeOn.seq, 1);

  pages.set("a/plan.md", PLAN.replace("drifted apart.", "drifted apart over a month."));
  store.observe("notes.page", "a/plan.md");
  const outdated = store.thread(id, { excerpts: true }).thread;
  assert.equal(outdated.state, "outdated");
  assert.equal(outdated.placement, null);
  assert.equal(outdated.label, 'under "Why", line 5', "shown where it was");
  assert.deepEqual(outdated.excerpt, { seq: 1, text: "The two stores drifted apart." });
  assert.equal(outdated.nowReads?.label, 'under "Why", line 5');
  assert.equal(outdated.nowReads?.excerpt, "The two stores drifted apart over a month.");
});

test("threads are placed in the revision a tab rendered, and later threads are left out", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const first = comment(store);
  const v1 = store.observe("notes.page", "a/plan.md")!.revision.sha256;
  pages.set("a/plan.md", `${PLAN}\nNew paragraph.\n`);
  const second = comment(store, { spec: { quote: "New paragraph" } });

  assert.deepEqual(store.threadsAt("notes.page", "a/plan.md", { sha: v1 })!.threads.map((t) => t.id), [first]);
  assert.deepEqual(store.threadsAt("notes.page", "a/plan.md")!.threads.map((t) => t.id), [first, second]);
  assert.equal(store.threadsAt("notes.page", "a/plan.md", { sha: "nope" }), null);
});

test("a comment typed against an older revision stays pinned to it", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  comment(store);
  pages.set("a/plan.md", "# Rewritten\n");
  store.observe("notes.page", "a/plan.md");
  // The tab still showed v1 when the human typed.
  const id = comment(store, { content: PLAN, spec: { quote: "One library" } });
  const thread = store.thread(id).thread;
  assert.equal(thread.madeOn.seq, 1);
  assert.equal(thread.state, "outdated");
});

test("a document type allows only its own anchor types, and a gone document takes no comments", async () => {
  const { store } = await setup();
  assert.throws(
    () => store.createThread({ type: "notes.sketch", key: "s1", anchorType: "markdown.block", spec: {}, body: "x", author: HUMAN }),
    (err) => err instanceof StoreError && /cannot be pinned with markdown.block/.test(err.message),
  );
  assert.throws(() => comment(store, { key: "missing.md" }), /missing.md is gone/);
});

test("agents suggest resolving, and only humans resolve or reopen", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const id = comment(store);
  assert.throws(() => store.setStatus(id, "resolved", AGENT), /Only a human resolves/);
  assert.throws(() => store.setStatus(id, "suggested", AGENT, " "), /Say what changed/);
  assert.throws(() => store.setStatus(id, "suggested", HUMAN, "done"), /Suggesting is for agents/);

  store.setStatus(id, "suggested", AGENT, "Reworded it.");
  assert.equal(store.thread(id).thread.waitingOn, "human");
  store.setStatus(id, "resolved", HUMAN);
  assert.throws(() => store.setStatus(id, "resolved", HUMAN), /already resolved/);
  assert.equal(store.thread(id).thread.waitingOn, null);

  store.setStatus(id, "open", HUMAN);
  const reopened = store.thread(id).thread;
  assert.equal(reopened.messages.at(-1)?.body, "Reopened.");
  assert.equal(reopened.waitingOn, "agent");
});

test("a human reply reopens a suggested thread, and an agent reply does not", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const id = comment(store);
  store.setStatus(id, "suggested", AGENT, "Done.");
  store.reply(id, "One more thing.", AGENT);
  assert.equal(store.thread(id).thread.status, "suggested");
  store.reply(id, "Not quite.", HUMAN);
  const thread = store.thread(id).thread;
  assert.equal(thread.status, "open");
  assert.equal(thread.waitingOn, "agent");
  assert.equal(thread.messages[1]?.session, "940d8cee");
});

test("apply answers several threads in one transaction, all or nothing", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const a = comment(store);
  const b = comment(store, { spec: { quote: "One library" } });
  let notified = 0;
  store.onWrite(() => notified++);

  assert.throws(() => store.apply([{ reply: a, message: "ok" }, { reply: 999, message: "no" }], AGENT), /No thread #999/);
  assert.equal(store.thread(a).thread.messages.length, 1, "nothing applied");
  assert.equal(notified, 0, "a rolled-back write notifies no one");

  store.apply([{ reply: a, message: "Because." }, { suggestResolve: b, message: "Done." }], AGENT);
  assert.equal(notified, 1);
  assert.equal(store.thread(a).thread.waitingOn, "human");
  assert.equal(store.thread(b).thread.status, "suggested");
  assert.throws(() => store.apply([{ resolve: a, message: "x" } as unknown as Action], AGENT), /must name a thread/);
});

test("a human's batch stays out of agent views until it is sent", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const id = comment(store, { pending: true });
  assert.equal(store.pendingCount(), 1);
  assert.deepEqual(store.threadsAt("notes.page", "a/plan.md")!.threads, []);
  assert.equal(store.threadsAt("notes.page", "a/plan.md", { includePending: true })!.threads[0]?.pending, true);
  assert.throws(() => store.thread(id), /No thread/);
  assert.throws(() => store.reply(id, "hi", AGENT), /No thread/);
  assert.throws(() => comment(store, { author: AGENT, pending: true }), /Only a human batches/);

  // A reply to a draft joins the draft, so it can never be sent ahead of the comment.
  store.reply(id, "Also this.", HUMAN);
  assert.equal(store.pendingCount(), 2);
  assert.deepEqual(store.waitingOnAgent(), []);

  assert.equal(store.sendPending(HUMAN), 2);
  assert.equal(store.thread(id).thread.messages.length, 2);
  assert.deepEqual(store.waitingOnAgent(), [id]);
});

test("a batch sent after an agent's answer still reads as the latest word", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const id = comment(store);
  store.reply(id, "Drafted before the answer.", HUMAN, { pending: true });
  store.reply(id, "Here's the answer.", AGENT);
  assert.equal(store.thread(id).thread.waitingOn, "human");
  store.sendPending(HUMAN);
  const thread = store.thread(id).thread;
  assert.equal(thread.messages.at(-1)?.body, "Drafted before the answer.");
  assert.equal(thread.waitingOn, "agent");
});

test("discarding a batch drops drafts, and a document with only drafts goes back to untracked", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  comment(store, { pending: true });
  assert.equal(store.discardPending(HUMAN), 1);
  assert.equal(store.document("notes.page", "a/plan.md"), null);
  assert.deepEqual(store.revisions("notes.page", "a/plan.md"), []);
});

test("waitingOnAgent stays inside its filter, and --after skips what was already seen", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  pages.set("a/deep/notes.md", "# Notes\n\nSome notes.\n");
  pages.set("b/plan.md", PLAN);
  const inA = comment(store);
  const deep = comment(store, { key: "a/deep/notes.md", spec: { line: 3 } });
  const inB = comment(store, { key: "b/plan.md" });
  const sketch = store.createThread({ type: "notes.sketch", key: "s1", anchorType: "core.whole", body: "Hm.", author: HUMAN });

  assert.deepEqual(store.waitingOnAgent({ filter: [{ type: "notes.page", keyPrefix: "a/" }] }), [inA, deep]);
  assert.deepEqual(store.waitingOnAgent({ filter: [{ type: "notes.page", key: "b/plan.md" }, { type: "notes.sketch", key: "s1" }] }), [inB, sketch]);
  assert.deepEqual(store.waitingOnAgent({ filter: [{ app: "notes" }] }), [inA, deep, inB, sketch]);
  assert.deepEqual(store.waitingOnAgent({ filter: [] }), [], "an empty filter covers nothing");
  assert.throws(() => store.waitingOnAgent({ filter: [{ type: "notes.page" } as never] }), /filter condition/);

  const after = store.cursor();
  assert.deepEqual(store.waitingOnAgent({ after }), [], "nothing newer than the cursor");
  store.reply(deep, "Still?", HUMAN);
  assert.deepEqual(store.waitingOnAgent({ after }), [deep]);
});

test("a key prefix is matched as text, not as a pattern", async () => {
  const { pages, store } = await setup();
  pages.set("100%/a.md", PLAN);
  pages.set("100x/a.md", PLAN);
  const literal = comment(store, { key: "100%/a.md" });
  comment(store, { key: "100x/a.md" });
  assert.deepEqual(store.waitingOnAgent({ filter: [{ type: "notes.page", keyPrefix: "100%" }] }), [literal]);
});

test("threadsIn lists each matching document's threads at its latest revision", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  pages.set("b/plan.md", PLAN);
  comment(store);
  comment(store, { key: "b/plan.md", pending: true });
  const groups = store.threadsIn([{ type: "notes.page", keyPrefix: "" }]);
  assert.deepEqual(groups.map((g) => [g.document.key, g.document.displayName, g.threads.length]), [["a/plan.md", "plan.md", 1]]);
});

test("only a human deletes, and a document's last thread takes its revisions along", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const a = comment(store);
  const b = comment(store, { spec: { quote: "One library" } });
  store.reply(a, "Answer.", AGENT);
  assert.throws(() => store.deleteThread(a, AGENT), /Only a human deletes/);

  const [first, answer] = store.thread(a).thread.messages;
  assert.throws(() => store.deleteMessage(a, first!.id, HUMAN), /Delete the thread instead/);
  store.deleteMessage(a, answer!.id, HUMAN);
  assert.equal(store.thread(a).thread.messages.length, 1);

  store.deleteThread(a, HUMAN);
  assert.ok(store.document("notes.page", "a/plan.md"), "b still tracks it");
  store.deleteThread(b, HUMAN);
  assert.equal(store.document("notes.page", "a/plan.md"), null);
  assert.deepEqual(store.revisions("notes.page", "a/plan.md"), []);
});

test("messages record the revision that was latest when they were written", async () => {
  const { pages, store } = await setup();
  pages.set("a/plan.md", PLAN);
  const id = comment(store);
  pages.set("a/plan.md", `${PLAN}\nMore.\n`);
  store.observe("notes.page", "a/plan.md");
  store.reply(id, "Seen the edit.", AGENT);
  assert.deepEqual(store.thread(id).thread.messages.map((m) => m.revisionSeq), [1, 2]);
});

test("the change token moves on writes from any process, and not on reads", async () => {
  const { pages, store, open } = await setup();
  pages.set("a/plan.md", PLAN);
  const other = await open();
  const before = store.changeToken();
  store.threadsIn(null);
  store.observe("notes.page", "a/plan.md");
  assert.equal(store.changeToken(), before);
  comment(other);
  assert.notEqual(store.changeToken(), before);
});

test("an app's own tables live beside the core's, under its name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peanut-store-"));
  const app = { ...notesApp(new Map()), migrations: ["CREATE TABLE notes_viewed (key TEXT PRIMARY KEY)"] };
  const store = await openStore({ registry: new Registry().register(app), dir });
  store.db.prepare("INSERT INTO notes_viewed VALUES ('a')").run();
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM notes_viewed").get()?.n, 1);
  assert.ok(fs.existsSync(path.join(dir, "peanut.sqlite3")));
});
