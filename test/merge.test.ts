import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import MarkdownIt from "markdown-it";
import { markdownBlock, openStore, Registry, type Store, STORE_FILE } from "../src/index.ts";
import type { App, Author } from "../src/types.ts";

const md = new MarkdownIt();
const HUMAN: Author = { name: "adam", kind: "human" };
const AGENT: Author = { name: "agent", kind: "agent", session: "940d8cee" };
const PLAN = "# Plan\n\n## Why\n\nThe two stores drifted apart.\n\n## How\n\nOne library.\n";

function notesApp(pages: Map<string, string>): App {
  return {
    name: "notes",
    anchorTypes: [markdownBlock({ tokenize: (content) => ({ tokens: md.parse(content, {}) }) })],
    documentTypes: [
      {
        name: "notes.page",
        noun: "page",
        anchorTypes: ["markdown.block"],
        readContent: (key: string) => (pages.has(key) ? { content: pages.get(key)! } : null),
        displayName: (key: string) => path.basename(key),
      },
    ],
  };
}

/** One copy of a store, as on one machine: its own folder, and its own copy of the pages. */
async function machine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peanut-merge-"));
  const pages = new Map([["a/plan.md", PLAN]]);
  const store = await openStore({ registry: new Registry().register(notesApp(pages)), dir });
  return { dir, pages, store, file: path.join(dir, STORE_FILE) };
}

/** Two machines, each merging the other in: a full sync. */
function sync(a: { store: Store; file: string }, b: { store: Store; file: string }) {
  const intoA = a.store.merge(b.file);
  const intoB = b.store.merge(a.file);
  return { intoA, intoB };
}

function comment(store: Store, quote = "drifted apart", body = "Why?", author = HUMAN, pending = false): number {
  return store.createThread({ type: "notes.page", key: "a/plan.md", anchorType: "markdown.block", spec: { quote }, body, author, pending });
}

/** What a copy holds, by uid, which is what two copies can agree on. */
function contents(store: Store) {
  const found = store.threadsAt("notes.page", "a/plan.md");
  return (found?.threads ?? [])
    .map((t) => ({ uid: t.uid, status: t.status, quote: t.quote, waitingOn: t.waitingOn, messages: t.messages.map((m) => [m.uid, m.author, m.body]) }))
    .sort((x, y) => x.uid.localeCompare(y.uid));
}

const NOTHING = { threads: 0, messages: 0, statuses: 0, deleted: 0 };

test("a thread and its messages merge into the other copy with the same uids, and merging again changes nothing", async () => {
  const a = await machine();
  const b = await machine();
  const id = comment(a.store);
  a.store.reply(id, "Because each app forked it.", AGENT);

  assert.deepEqual(b.store.merge(a.file), { threads: 1, messages: 2, statuses: 0, deleted: 0 });
  assert.deepEqual(contents(b.store), contents(a.store));
  const [onB] = b.store.threadsAt("notes.page", "a/plan.md")!.threads;
  assert.equal(onB!.uid, a.store.thread(id).thread.uid);
  assert.equal(onB!.waitingOn, "human");
  assert.equal(onB!.state, "current");

  assert.deepEqual(b.store.merge(a.file), NOTHING, "merging again is a no-op");
  assert.deepEqual(a.store.merge(b.file), NOTHING, "and the other way has nothing new");
});

test("a thread is found by its uid as well as its id", async () => {
  const a = await machine();
  const id = comment(a.store);
  const { uid } = a.store.thread(id).thread;
  assert.equal(a.store.thread(uid).thread.id, id);
  assert.equal(a.store.thread(String(id)).thread.uid, uid, "a string of digits is still an id");
  a.store.reply(uid, "On it.", AGENT);
  a.store.apply([{ suggestResolve: uid, message: "Done." }], AGENT);
  assert.equal(a.store.thread(id).thread.status, "suggested");
  const reply = a.store.thread(id).thread.messages[1]!;
  a.store.deleteMessage(uid, reply.uid, HUMAN);
  assert.equal(a.store.thread(id).thread.messages.length, 2);
});

test("replies written on both machines at once both survive, in send order", async () => {
  const a = await machine();
  const b = await machine();
  const id = comment(a.store);
  sync(a, b);
  const idOnB = b.store.thread(a.store.thread(id).thread.uid).thread.id;

  a.store.reply(id, "From the laptop.", HUMAN);
  // Two copies order messages by send time. One sent in the same millisecond on both is ordered by local id, which is not shared.
  await new Promise((resolve) => setTimeout(resolve, 5));
  b.store.reply(idOnB, "From the desktop.", AGENT);
  sync(a, b);

  assert.deepEqual(contents(a.store), contents(b.store));
  assert.deepEqual(contents(a.store)[0]!.messages.map((m) => m[2]), ["Why?", "From the laptop.", "From the desktop."]);
  assert.equal(contents(a.store)[0]!.waitingOn, "human");
});

test("of a resolve and a concurrent suggestion, resolve wins on both copies", async () => {
  const a = await machine();
  const b = await machine();
  const id = comment(a.store);
  sync(a, b);
  const uid = a.store.thread(id).thread.uid;

  a.store.setStatus(id, "resolved", HUMAN);
  b.store.setStatus(uid, "suggested", AGENT, "Fixed on this machine.");
  const { intoA, intoB } = sync(a, b);

  assert.equal(intoA.statuses, 0, "the resolve stays");
  assert.equal(intoB.statuses, 1, "the suggestion gives way");
  assert.equal(a.store.thread(uid).thread.status, "resolved");
  assert.equal(b.store.thread(uid).thread.status, "resolved");
  assert.deepEqual(contents(a.store), contents(b.store));
});

test("a reopen made after seeing a resolve survives the merge", async () => {
  const a = await machine();
  const b = await machine();
  const id = comment(a.store);
  a.store.setStatus(id, "resolved", HUMAN);
  sync(a, b);
  const uid = a.store.thread(id).thread.uid;

  b.store.setStatus(uid, "open", HUMAN, "Not quite.");
  sync(a, b);

  assert.equal(a.store.thread(uid).thread.status, "open");
  assert.equal(a.store.thread(uid).thread.waitingOn, "agent");
  assert.deepEqual(contents(a.store), contents(b.store));
});

test("a delete on either copy wins, and a later merge does not bring the thread back", async () => {
  const a = await machine();
  const b = await machine();
  const kept = comment(a.store, "One library.");
  const gone = comment(a.store);
  a.store.reply(kept, "A reply that goes.", AGENT);
  sync(a, b);
  const goneUid = a.store.thread(gone).thread.uid;
  const replyUid = a.store.thread(kept).thread.messages[1]!.uid;

  b.store.deleteThread(goneUid, HUMAN);
  b.store.deleteMessage(a.store.thread(kept).thread.uid, replyUid, HUMAN);
  const { intoA } = sync(a, b);

  assert.equal(intoA.deleted, 2);
  assert.throws(() => a.store.thread(goneUid), /No thread/);
  assert.deepEqual(contents(a.store), contents(b.store));
  assert.deepEqual(sync(a, b), { intoA: NOTHING, intoB: NOTHING });
});

test("a document whose last thread is deleted on one copy goes from both", async () => {
  const a = await machine();
  const b = await machine();
  const id = comment(a.store);
  sync(a, b);
  a.store.deleteThread(id, HUMAN);
  sync(a, b);
  assert.deepEqual(a.store.documents(), []);
  assert.deepEqual(b.store.documents(), []);
});

test("the human's drafts and pending replies stay on the machine they were written on", async () => {
  const a = await machine();
  const b = await machine();
  const sent = comment(a.store);
  comment(a.store, "One library.", "Still drafting.", HUMAN, true);
  a.store.reply(sent, "Pending reply.", HUMAN, { pending: true });

  assert.deepEqual(b.store.merge(a.file), { threads: 1, messages: 1, statuses: 0, deleted: 0 });
  assert.equal(b.store.pendingCount(), 0);
  assert.equal(a.store.pendingCount(), 2, "and the source keeps them");
});

test("a revision only the other copy saw comes in as the next version here, and threads on it stay current", async () => {
  const a = await machine();
  const b = await machine();
  comment(a.store);
  sync(a, b);
  const edited = PLAN.replace("One library.", "One shared library.");
  a.pages.set("a/plan.md", edited);
  a.store.createThread({ type: "notes.page", key: "a/plan.md", anchorType: "markdown.block", spec: { quote: "shared" }, body: "New?", author: HUMAN });

  b.store.merge(a.file);
  const revisions = b.store.revisions("notes.page", "a/plan.md");
  assert.deepEqual(revisions.map((r) => r.seq), [2, 1]);
  const states = b.store.threadsAt("notes.page", "a/plan.md")!.threads.map((t) => [t.quote, t.state]);
  assert.deepEqual(states, [["drifted apart", "carried"], ["shared", "current"]]);
});

test("a source migrated differently is refused before anything changes", async () => {
  const a = await machine();
  const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "peanut-merge-old-")), STORE_FILE);
  const db = new DatabaseSync(old);
  db.exec("CREATE TABLE migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO migrations VALUES ('core', 1);");
  db.close();
  assert.throws(() => a.store.merge(old), /1 core migrations and this store has 2/);
});

test("a merge that brings something in rings the store's listeners once", async () => {
  const a = await machine();
  const b = await machine();
  comment(a.store);
  let rings = 0;
  b.store.onWrite(() => rings++);
  b.store.merge(a.file);
  b.store.merge(a.file);
  assert.equal(rings, 1);
});
