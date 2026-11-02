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
- **Comments live where the user wants them.** By default in the app's
  folder in the home folder, or in the project being worked on.

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
| **document type** | What kind of document it is, named `<app>.<name>`. It says what a document key means and how to read the document's content | `mdview.doc` | `diffview.branch`, `diffview.stack`, `diffview.description` |
| **document key** | The app's string naming one document of a type, opaque to the core | `notes/plan.md` | `feat-x` |
| **revision** | The document's content as it read when someone looked at it: `v1`, `v2`, and so on. A new one is recorded only when the content changes | the file's text | the branch's patch, plus base and head |
| **anchor type** | A way of pinning a thread to part of a document and finding that part again in a later revision, named `<namespace>.<name>` | `markdown.block` | `diffview.lines`, `diffview.file`, `core.whole`, `markdown.block` |
| **anchor** | One thread's pin, stored when the thread is made and never changed: JSON owned by its anchor type. It records *what* was commented on, such as a hash of the text | `{blockSha, ordinal}` | `{path, side, linesSha, ...}` |
| **anchor placement** | Where an anchor is placed in one revision: computed on every read, never stored. The UI highlights it and the CLI prints it | in v5: block 12, lines 40-44, under "How" | in v5: `src/a.js`, new side, lines 40-42 |
| **thread**, **message**, **author**, **turn**, **batch** | As today in both apps | | |

"Draft" is taken: in the code it already means a thread whose first message
is still in the human's pending batch.

## Core vs. app

| The core owns | Each app owns |
|---|---|
| documents, revisions, threads, messages | what a document key means, and how to read a document's content |
| statuses and who may change them (agents suggest, humans resolve and reopen) | its document types and anchor types |
| whose turn it is (`thread_facts`), the pending batch, sending it | its own tables, e.g. diffview's viewed files, stack members and description links |
| placing each thread's anchor in a revision: current, carried or outdated | how a placement looks: labels in the terminal, highlights on the page |
| `wait`, its cursor, and change notification | which documents a CLI command covers |
| the CLI verbs and their conventions (`-m`, `--from`, `--json`, `--human`) | the `add` verb's anchor flags, and any extra verbs (`describe`, `review`) |
| finding the store from the app's folder name, and the config that moves it | the folder's name (`.mdview`, `.diffview`) |
| the comment API the server mounts | the rest of the server |

## Document types

```js
{
  name: "mdview.doc",
  noun: "doc",                          // in messages: "the whole doc"
  anchorTypes: ["markdown.block", "core.whole"],
  readContent(key) { return { content, meta } },  // as the document reads now; null when it is gone
  displayName(key) { return "plan.md" },
}
```

- `readContent()` is for callers that do not already have the content. The
  viewer usually does, and hands it to the store directly, as it does now.
- A revision's identity is the hash of its `content` alone. `meta` (such as
  diffview's base and head) is stored with the revision that first had that
  content. So a rebase that leaves a branch's patch alone is not a new
  revision, as diffview behaves today.
- A document type does not parse its content. Its anchor types do (see
  below), so nothing has to agree on a parsed shape.

## Anchor types

```js
{
  name: "markdown.block",
  create(revision, spec) { return { anchor, quote } },     // or throws AnchorError, worded for the user
  place(anchor, revision) { return placement ?? null },    // null: its text is gone from this revision
  successor(anchor, from, to) { return placement ?? null },   // optional: what an outdated anchor's text became
  label(anchor, placement, documentType) { return 'under "How"' },
  excerpt(anchor, placement, revision) { return "..." },        // optional: source text for `show`
}
```

Every method gets revisions as the store holds them, `{seq, sha256, content,
meta}`, and parses what it needs itself. An anchor type caches its parse by
the revision's `sha256`, so placing fifty threads in one revision parses it
once.

The core derives a thread's state, so every anchor type means the same thing
by it:

- **current**: the thread was made on this revision.
- **carried**: made on an earlier revision, and `place()` still places its
  anchor here.
- **outdated**: `place()` returns null here. The core places the anchor in
  its own revision for `madeOn`, and asks `successor()` for `nowReads`.

Anchor types are named by who defines them, not who uses them, so apps can
share them:

- `core.whole`: the whole document. Parses nothing and is always placed. It
  replaces diffview's "whole branch" threads, and is how mdview could offer
  comments on a doc as a whole.
- `markdown.block`: today's identical `blocks.mjs`, plus the
  `successor()` both stores copy. An app makes its own with
  `markdownBlock({ tokenize })`, handing over its markdown-it setup, because
  which plugins run changes the tokens, and so the blocks' hashes.
- `diffview.lines` and `diffview.file` stay in diffview. They parse the
  revision's patch, and read a file's unchanged lines from git, using the
  repo and commits in the revision's `meta`, only when a thread on those
  lines asks.

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

Each app names its folder, and peanut's store is a SQLite file in it,
beside whatever else the app keeps there (diffview's logs and server
records, for one). An app registers `folder: "diffview"`, and peanut finds
the folder from where the work is. For diffview the first rule that matches
wins:

1. `DIFFVIEW_HOME`, when set.
2. **A project folder**: the nearest `.diffview/` folder above the document
   (for mdview, the doc's folder; for diffview, the repo's worktree root).
   To keep a project's comments in the project, run `mkdir .diffview`.
   It stays out of git (see Decisions).
3. `home` in `~/.config/diffview/config.json`.
4. `~/.diffview`.

The file keeps today's name, `diffview.sqlite3`, so both apps' existing
stores migrate in place.

Two apps can share a store by naming the same folder. Neither does by
default, because nothing needs it now that each app's CLI covers only its
own documents. Nesting peanut's own folder inside the app's
(`.mdview/.peanut/`) buys nothing: peanut's tables are already set apart
from the app's by their names.

In a project folder, document keys are relative to the folder holding it, so
the project can move. In the home folder they are absolute: an mdview key is
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
- **Moving the old stores over.** Each app's last migration under its own
  schema copies its tables into peanut's, in the same file, and keeps every
  thread id. A backup of the file is taken first.

## Which documents a command covers

`list` and `wait` need to know which documents to look at: "the docs in
this folder" for mdview, "the branches of this stack" for diffview. Each app
works that out from its own CLI arguments, then hands the core a **document
filter**: a list of conditions, where a document is included when it
matches any of them.

```js
// mdview: `mdview comments list notes/`, in a project folder (in the home folder, keys are absolute paths)
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
- `add`: its anchor flags, turned into `{type, key, anchorType, spec}`,
  where `key` is the document key.
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
  placement, label,                        // placement: the anchor type's JSON; label: its words
  madeOn: { seq, placement }, nowReads,    // nowReads: a placement, or null
  quote, createdAt, statusBy, statusAt,
  messages: [{ id, author, authorKind, session, body, revisionSeq, createdAt, sentAt, pending }],
}
```

The shared front end (rail, cards, composer, the pending-batch bar) is the
last step. Its seam is a client-side counterpart of each anchor type that
maps a placement to elements on the page.

## Plan

1. This doc, then the shapes: types, registry, schema, the two built-in
   anchor types.
2. The store, ported from diffview's, which already does more: `apply`, the
   `--after` cursor, more than one anchor kind. With it, finding the app's
   folder and the config file.
3. diffview on peanut, with its in-place migration. This is the hard one, so it goes
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
- **One store per app by default**, in the app's own folder, at home or in a
  project.
- **Comments are not committed.** A project folder keeps comments next to the
  work, not in its history, so SQLite stays the only format and ids stay
  plain integers. When peanut creates a store in a project folder, it writes
  a `.gitignore` there holding `*`, so the folder never lands in a commit by
  accident. Sharing comments through git would mean append-only text files
  as the source of truth, which we can add later if it is ever wanted.
