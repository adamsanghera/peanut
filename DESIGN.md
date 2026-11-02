# peanut: design

peanut holds comment threads between a human and coding agents, anchored in
documents that keep changing. (The human is the peanut gallery.) mdview and
diffview each grew a copy of this, with diffview's forked from mdview's, and
the copies have drifted. This pulls the shared part into one library both
apps build on.

## Goals

- **One model of a conversation.** Threads, messages, statuses, whose turn
  it is, the human's pending batch, and waiting for the next turn are defined
  once and behave the same in every app.
- **Not shaped like code review.** The core knows nothing about branches,
  sides, hunks, stacks or approval. A Markdown doc fits as naturally as a
  diff.
- **But able to hold code review.** diffview's anchors have to fit without
  workarounds: line ranges on either side of a diff that follow their text
  through rebases, whole files, whole branches, and a branch's description.
  So does its own state, such as viewed files and stack membership.
- **Comments live where the user wants them.** By default in one store in
  the home folder, or in the project being worked on.

## Non-goals

- Rendering documents. Each app still renders its own Markdown or diffs.
- Rebuilding the UI in this pass. The shared front end comes after the store
  and CLI (see Plan).
- A cross-app CLI. Agents use each app's own comments CLI, which knows its
  documents well enough to say more (diffview's restack commands, for one).

## Vocabulary

| Term | Meaning | mdview | diffview |
|---|---|---|---|
| **app** | A namespace that registers document types, anchor types and its own tables | `mdview` | `diffview` |
| **document** | One thing people comment on. It keeps its identity while its content changes | a `.md` file | a branch in a repo |
| **document type** | What kind of document it is, named `<app>.<name>`. It says what a key means, how to read the document's content, and how to parse it | `mdview.doc` | `diffview.branch`, `diffview.stack`, `diffview.description` |
| **key** | The app's string naming one document of a type, opaque to the core | `notes/plan.md` | `feat-x` |
| **revision** | The document's content as it read when someone looked at it: `v1`, `v2`, and so on. A new one is recorded only when the content changes | the file's text | the branch's patch, plus base and head |
| **content type** | One way of parsing a revision's content. An anchor type reads one, and a document type says which ones it can produce | `markdown` | `diff`, and `markdown` for descriptions |
| **anchor type** | A way of pinning a thread to part of a document and finding that part again in a later revision, named `<namespace>.<name>` | `markdown.block` | `diffview.lines`, `diffview.file`, `core.whole`, `markdown.block` |
| **anchor** | One thread's pin, stored when the thread is made and never changed: JSON owned by its anchor type. It records *what* was commented on, such as a hash of the text | `{blockSha, ordinal}` | `{path, side, linesSha, ...}` |
| **location** | Where an anchor is found in one particular revision, computed on every read and never stored. It says *where that text is now*. The UI highlights it and the CLI prints it | block 12, lines 40-44, under "How" | `src/a.js`, new side, lines 40-42 |
| **thread**, **message**, **author**, **turn**, **batch** | As today in both apps | | |

Anchor and location are separate because a thread outlives the revision it
was made on. The anchor says "the paragraph that read *X*". The location
says "in v5, that paragraph is block 12, lines 40-44". Computing the
location afresh on every read is how a thread follows its text through
edits and rebases.

"Draft" is taken: in the code it already means a thread whose first message
is still in the human's pending batch.

## Core vs. app

| The core owns | Each app owns |
|---|---|
| documents, revisions, threads, messages | what a key means and how to read a document's content |
| statuses and who may change them (agents suggest, humans resolve and reopen) | its document types and anchor types |
| whose turn it is (`thread_facts`), the pending batch, sending it | its own tables, e.g. diffview's viewed files, stack members and description links |
| finding each thread's location in a revision: current, carried or outdated | how a location looks: labels in the terminal, highlights on the page |
| `wait`, its cursor, and change notification | which documents a CLI command covers |
| the CLI verbs and their conventions (`-m`, `--from`, `--json`, `--human`) | the `add` verb's anchor flags, and any extra verbs (`describe`, `review`) |
| where the store lives, and the config that says so | |
| the comment API the server mounts | the rest of the server |

## Document types

```js
{
  name: "mdview.doc",
  noun: "doc",                          // in messages: "the whole doc"
  contentTypes: ["markdown"],           // what parse() can return
  anchorTypes: ["markdown.block", "core.whole"],   // each must read one of the content types
  readContent(key) { return { content, meta } },  // as the document reads now; null when it is gone
  parse(revision) { return { markdown: { source, blocks } } },   // keyed by content type
  displayName(key) { return "plan.md" },
}
```

- `readContent()` is for callers that do not already have the content. The
  viewer usually does, and hands it to the store directly, as it does now.
- A revision's identity is the hash of its `content` alone. `meta` (such as
  diffview's base and head) is stored with the revision that first had that
  content. So a rebase that leaves a branch's patch alone is not a new
  revision, as diffview behaves today.
- `parse()` runs once per revision per process, and the result is cached.
  A parsed value may hold functions that do work only when called:
  diffview's `diff` content carries `fileText(path, side)`, which reads a
  blob from git only when a line anchor on unchanged lines asks for it.

## Anchor types

```js
{
  name: "markdown.block",
  reads: ["markdown"],                         // content types; checked against each document type that lists it
  create(parsed, spec) { return { anchor, quote } },   // or throws AnchorError, worded for the user
  locate(anchor, parsed) { return location ?? null },  // null: its text is gone from this revision
  successor(anchor, from, to) { return location ?? null },   // optional: what an outdated anchor's text became
  label(anchor, location, documentType) { return 'under "How"' },
  excerpt(anchor, location, parsed) { return "..." },        // optional: source text for `show`
}
```

The core derives a thread's state, so every anchor type means the same thing
by it:

- **current**: the thread was made on this revision.
- **carried**: made on an earlier revision, and `locate()` still finds its
  anchor here.
- **outdated**: `locate()` returns null here. The core locates the anchor in
  its own revision for `madeOn`, and asks `successor()` for `nowReads`.

Anchor types are named by who defines them, not who uses them, so apps can
share them:

- `core.whole`: the whole document. Reads nothing and always attaches. It
  replaces diffview's "whole branch" threads, and is how mdview could offer
  comments on a doc as a whole.
- `markdown.block`: today's identical `blocks.mjs`, plus the
  `successor()` both stores copy. It reads `markdown` content, which is
  `{source, blocks}`. Apps keep their own markdown-it setup and hand the core
  tokens, because which plugins run changes the tokens, and so the blocks'
  hashes.
- `diffview.lines` and `diffview.file` stay in diffview. They read `diff`
  content, which the core does not define.

## How the apps map onto it

mdview changes little: `docs` becomes `documents` of type `mdview.doc`,
`versions` become revisions, and block columns move into anchor JSON.

diffview changes more, and that is the test of the abstraction:

| Today | In peanut |
|---|---|
| `reviews (repo, entry)` | documents of type `diffview.branch`, keyed by branch |
| the `stack:<bottom>` entry with an empty patch | a document of type `diffview.stack`, threads anchored `core.whole` |
| `descriptions` snapshots, and `description` threads on the branch's review | a document of type `diffview.description` per branch or stack, with revisions and `markdown.block` anchors like any doc |
| thread kinds `lines`, `file`, `branch` | anchor types `diffview.lines`, `diffview.file`, `core.whole` |
| `description_links`, `stack_members`, `viewed_files`, `viewed_branches` | app tables `diffview_description_links`, and so on |

A branch's page shows threads from two documents, its diff and its
description. That stays the app's business: the viewer asks for both, and
the core needs no idea of related documents.

## Where comments are stored

Comments are stored in a SQLite file. Which file depends on where the work
is, and the first rule that matches wins:

1. `PEANUT_HOME`, when set.
2. **A project store**: the nearest `.peanut/` folder above the document
   (for mdview, the doc's folder; for diffview, the repo's worktree root).
   To keep a project's comments in the project, run `mkdir .peanut`.
3. `store` in `~/.config/peanut/config.json`.
4. `~/.peanut`.

In a project store, keys are relative to the folder holding `.peanut/`, so
the project can move. In the home store they are absolute: an mdview key is
the doc's absolute path, and a diffview key is `<git common dir>#<branch>`,
so every worktree of a repo shares its branches' threads.

Thread ids are unique within a store. A CLI command resolves one store from
where it runs, so `show 12` is never ambiguous. The viewer may open several
stores when a folder spans projects.

As now, a store uses WAL mode, a busy timeout, and `BEGIN IMMEDIATE` for
writes that take a sequence number. Deleting stays human-only.

```sql
documents (id, type, key, created_at, UNIQUE (type, key))
revisions (id, document_id, seq, sha256, content, meta /* JSON */, observed_at, UNIQUE (document_id, seq))
threads   (id, document_id, revision_id, anchor_type, anchor /* JSON */, quote,
           status, status_by, status_at, created_at)
messages  (id, thread_id, revision_id, author, author_kind, session, body, created_at, sent_at)
thread_facts  -- view: draft, first message, waiting_on; unchanged from today
migrations (namespace, version)
```

- **App namespaces.** An app's tables are named `<app>_<table>`, and its
  migrations are a list of SQL steps tracked per namespace in `migrations`.
  The core's own namespace is `core`. Opening a store runs the pending steps
  of every app the process registered, and leaves the tables of other apps
  alone.
- **Anchors as JSON.** No core query filters on an anchor's fields. An app
  that needs to, such as diffview counting threads per file, does it in JS
  or with `json_extract`.
- **Moving the old stores over.** On first open, the home store imports
  `~/.mdview` and `~/.diffview` when they exist and leaves them in place.
  Thread ids are renumbered, so ids printed before the move are stale.

## Which documents a command covers

`list` and `wait` need to know which documents to look at: "the docs in
this folder" for mdview, "the branches of this stack" for diffview. Each app
works that out from its own CLI arguments, then hands the core a **document
filter**: a list of conditions, where a document is included when it
matches any of them.

```js
// mdview: `mdview comments list notes/`, in a project store (in the home store, keys are absolute paths)
[{ type: "mdview.doc", keyPrefix: "notes/" }]

// diffview: `diffview comments wait` on a stack of feat-a and feat-b
[
  { type: "diffview.branch", key: "feat-a" }, { type: "diffview.description", key: "feat-a" },
  { type: "diffview.branch", key: "feat-b" }, { type: "diffview.description", key: "feat-b" },
  { type: "diffview.stack", key: "stack:feat-a" },
]
```

The core turns the filter into one SQL `WHERE`, so neither app writes a
query of its own.

`wait` returns as soon as a thread in the filter waits on the agent, and
prints a cursor: the id of the newest message it has seen. Passing that back
(`wait --after <n>`) wakes only on newer messages, so a thread the agent
left waiting on purpose does not wake it again. diffview has this today and
mdview gains it.

## CLI

The core exports the verbs: `list`, `show`, `reply`, `suggest-resolve`,
`apply`, `resolve`, `reopen`, `wait`. Each app supplies:

- `filter(args, env)`: its arguments and flags, turned into a document
  filter.
- `add`: its anchor flags, turned into `{type, key, anchorType, spec}`.
- `footer(thread)`: optional text after `show`, such as diffview's restack
  commands.

The conventions are settled once: a message is `-m <text>`, or
`--from <file|->` for long ones, and diffview's positional text goes away.
Every verb takes `--json`, and `--human` acts as the human.

Identity comes from `PEANUT_USER`, `PEANUT_AUTHOR` and `PEANUT_SESSION`.
Without `PEANUT_SESSION`, an agent's session is the host's own id, first
match winning: `PI_SESSION_ID` (Pi), `CLAUDE_CODE_SESSION_ID` (Claude
Code), `CURSOR_CONVERSATION_ID` (Cursor), then `TERM_SESSION_ID`. Each
app's old variables (`MDVIEW_USER`, `DIFFVIEW_SESSION`, ...) keep working
during the move.

## Server and UI

The core exports a request handler for `/api/comments/*` and a change stream
built on `changeToken()` / `onWrite()`, and the app mounts both. A thread as
JSON:

```js
{
  id, status, pending, waitingOn,
  document: { type, key, displayName },
  anchorType, state,                       // "current" | "carried" | "outdated"
  location, label,                         // location: the anchor type's JSON; label: its words
  madeOn: { seq, location }, nowReads,     // nowReads: a location, or null
  quote, createdAt, statusBy, statusAt,
  messages: [{ id, author, authorKind, session, body, revisionSeq, createdAt, sentAt, pending }],
}
```

The shared front end (rail, cards, composer, the pending-batch bar) is the
last step. Its seam is a client-side counterpart of each anchor type that
maps a location to elements on the page.

## Plan

1. This doc, then the shapes: types, registry, schema, the two built-in
   anchor types.
2. The store, ported from diffview's, which already does more: `apply`, the
   `--after` cursor, more than one anchor kind. With it, store resolution and
   the config file.
3. diffview on peanut, with its importer. This is the hard one, so it goes
   first.
4. mdview on peanut.
5. The shared CLI verbs, used by both apps.
6. The shared front end.

## Decisions

- **Statuses stay open / suggested / resolved, fixed in the core.** They
  encode the contract: agents propose, humans decide. Later, apps may define
  their own states that map onto these three and drive more of the state
  machine, but not now.
- **No cross-app CLI for now.** Agents use each app's comments CLI.

## Open questions

1. **Project stores in git.** Should a project's `.peanut/` be committed?
   SQLite is binary and does not merge, so if comments should travel with
   the repo (to another machine, or a teammate), a project store needs a text
   format, such as a JSON Lines file per document that only grows, with the
   SQLite file as a local cache built from it. If `.peanut/` only keeps
   comments next to the work, gitignored, SQLite is fine as is.
