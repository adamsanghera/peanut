# margin: design

margin holds comment threads between a human and coding agents, anchored in
documents that keep changing. mdview and diffview each grew a copy of this
(diffview's started as a fork of mdview's) and the copies have drifted. This
pulls the shared part into one library both apps build on.

## Goals

- **One model of a conversation.** Threads, messages, statuses, whose turn
  it is, the human's pending batch, and waiting for the next turn are defined
  once and behave the same in every app.
- **Not shaped like code review.** The core knows nothing about branches,
  sides, hunks, stacks or approval. A Markdown doc is as natural a fit as a
  diff.
- **But able to hold code review.** diffview's anchors (line ranges on either
  side of a diff that follow their text through rebases, whole files, whole
  branches, a branch's description) and its app state (viewed files, stack
  membership) have to fit without workarounds.
- **One store.** Every app writes to the same SQLite file, so an agent can
  wait on "anything the human said" across apps, and thread ids are unique
  everywhere.

## Non-goals

- Rendering documents. Each app still renders its own Markdown or diffs.
- Rebuilding the UI in this pass. The shared front end comes after the store
  and CLI (see Plan).
- Statuses defined per app. See Open questions.

## Vocabulary

| Term | Meaning | mdview | diffview |
|---|---|---|---|
| **app** | A namespace that registers kinds, anchor types and its own tables | `mdview` | `diffview` |
| **kind** | A type of document, named `<app>.<name>` | `mdview.doc` | `diffview.branch`, `diffview.stack`, `diffview.description` |
| **document** | One thing people comment on, identified by `(kind, key)`. It keeps its identity while its content changes | a `.md` file | a branch in a repo |
| **key** | The app's string for a document, opaque to the core but matched by prefix | `/abs/path/notes.md` | `<git common dir>#feat-x` |
| **revision** | The document's content when someone looked at it: `v1`, `v2`, ... Recorded only when the content changes | the file's text | the branch's patch, plus base and head |
| **view** | A revision parsed into what anchor types read (*facets*) | `markdown` | `diff`, and `markdown` for descriptions |
| **anchor type** | A way of pinning a thread to part of a document and finding that part again in a later revision, named `<namespace>.<name>` | `markdown.block` | `diffview.lines`, `diffview.file`, `core.whole`, `markdown.block` |
| **anchor** | One thread's pin: JSON owned by its anchor type | `{blockSha, ordinal, start}` | `{path, side, linesSha, ...}` |
| **place** | Where an anchor lands in one view, which the anchor type computes and the UI reads | block 12, lines 40-44 | `src/a.js` new side 40-42 |
| **thread**, **message**, **author**, **turn**, **batch** | As today in both apps | | |

A note on "draft": in the code it already means a thread whose first message
is still in the human's pending batch, so it never names a document or a
revision.

## Core vs. app

| The core owns | Each app owns |
|---|---|
| documents, revisions, threads, messages | what a key means and how to read a document's content |
| statuses and who may change them (agents suggest, humans resolve and reopen) | its kinds and anchor types |
| whose turn it is (`thread_facts`), the pending batch, sending it | its own tables, e.g. diffview's viewed files, stack members and description links |
| locating threads in a revision: current, carried or outdated | how a place looks: labels in the terminal, highlights on the page |
| `wait`, its cursor, and change notification | turning CLI arguments into a scope |
| the CLI verbs and their conventions (`-m`, `--from`, `--json`, `--human`) | the `add` verb's anchor flags, and any extra verbs (`describe`, `review`) |
| the comment API the server mounts | the rest of the server |

## Kinds

```js
{
  name: "mdview.doc",
  noun: "doc",                         // "the whole doc", "on doc notes.md"
  facets: ["markdown"],                // what view() returns
  anchors: ["markdown.block", "core.whole"],   // each one's needs must be among the facets
  current(key) { return { content, meta } },   // the content as it reads now, or null when gone
  view(revision) { return { markdown: { source, blocks } } },
  label(key) { return "notes.md" },
}
```

- `current()` exists for callers that do not already have the content. The
  viewer usually does, and passes it to `observe()` directly, as it does now.
- A revision's identity is the hash of its `content` alone. `meta` (such as
  diffview's base and head) is stored with the revision that first had that
  content. So a rebase that leaves a branch's patch alone is not a new
  revision, as diffview behaves today.
- `view()` runs once per revision per process and is cached. A facet may be
  lazy: diffview's `diff` facet carries `fileText(path, side)`, which reads a
  blob from git only when a file-scoped line anchor asks for it.

## Anchor types

```js
{
  name: "markdown.block",
  needs: ["markdown"],                       // view facets it reads, checked against each kind that lists it
  create(view, spec) { return { anchor, quote } },   // or throws AnchorError, worded for the user
  locate(anchor, view) { return place ?? null },     // null: its text is gone from this view
  successor(anchor, from, to) { return place ?? null },   // optional: what an outdated anchor became
  label(anchor, place, kind) { return 'under "How"' },
  excerpt(anchor, place, view) { return "..." },          // optional: source text for `show`
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

- `core.whole`: the whole document. Needs no facet and always attaches. It
  replaces diffview's `branch` kind of thread, and is how mdview could offer
  comments on a doc as a whole.
- `markdown.block`: today's identical `blocks.mjs`, plus the
  `successor()` both stores copy. It reads a `markdown` facet of
  `{source, blocks}`. Apps keep their own markdown-it setup and hand the
  core tokens, because which plugins run changes the tokens, and so the
  blocks' hashes.
- `diffview.lines` and `diffview.file` stay in diffview. They read a `diff`
  facet, which the core does not define.

## How the apps map onto it

mdview changes little: `docs` becomes `documents` of kind `mdview.doc`,
`versions` become revisions, and block columns move into anchor JSON.

diffview changes more, and that is the test of the abstraction:

| Today | In margin |
|---|---|
| `reviews (repo, entry)` | documents of kind `diffview.branch`, key `<repo>#<entry>` |
| the `stack:<bottom>` entry with an empty patch | a document of kind `diffview.stack`, threads anchored `core.whole` |
| `descriptions` snapshots, and `description` threads on the branch's review | a document of kind `diffview.description` per branch or stack, with revisions and `markdown.block` anchors like any doc |
| thread kinds `lines`, `file`, `branch` | anchor types `diffview.lines`, `diffview.file`, `core.whole` |
| `description_links`, `stack_members`, `viewed_files`, `viewed_branches` | app tables `diffview_description_links`, ... |

A branch's page shows threads from two documents, its diff and its
description. That stays the app's business: the viewer asks for both, and
the core needs no idea of related documents.

## Storage

One file, `$MARGIN_HOME/comments.sqlite` (default `~/.margin`). As now, it
uses WAL mode, a busy timeout, and `BEGIN IMMEDIATE` for writes that take a
sequence number. Deleting stays human-only.

```sql
documents (id, kind, key, created_at, UNIQUE (kind, key))
revisions (id, document_id, seq, sha256, content, meta /* JSON */, observed_at, UNIQUE (document_id, seq))
threads   (id, document_id, revision_id, anchor_type, anchor /* JSON */, quote,
           status, status_by, status_at, created_at)
messages  (id, thread_id, revision_id, author, author_kind, session, body, created_at, sent_at)
thread_facts  -- view: draft, first message, waiting_on; unchanged from today
migrations (namespace, version)
```

- **App namespaces.** An app's tables are named `<app>_<table>`, and its
  migrations are a list of SQL steps tracked per namespace in `migrations`.
  The core's own namespace is `core`. Opening the store runs the pending
  steps of every app the process registered, and leaves alone the tables of
  apps it did not register.
- **Anchors as JSON.** No core query filters on an anchor's fields. An app
  that needs to, such as diffview counting threads per file, does it in JS
  or with `json_extract`.
- **Moving the old stores over.** On first open, the store imports
  `~/.mdview` and `~/.diffview` when they exist and leaves them in place.
  Thread ids are renumbered, so ids printed before the move are stale.

## Scope and wait

A scope is a list of selectors, which the core matches in SQL:

```js
[{ kind: "mdview.doc", keyPrefix: "/Users/me/notes/" }]                    // an mdview folder
[{ kind: "diffview.branch", key: "/r/.git#a" }, { kind: "diffview.description", key: "/r/.git#a" }]
[{ app: "diffview" }]                                                       // everything diffview has
```

Each app's CLI turns its arguments (paths and folders, or the current stack)
into a scope. Both apps get diffview's `wait --after <n>` cursor, which is
the highest sent message id, unique across the shared store.

## CLI

The core exports the verbs: `list`, `show`, `reply`, `suggest-resolve`,
`apply`, `resolve`, `reopen`, `wait`. The app supplies:

- `scope(args, env)`: its positional arguments and flags, turned into a
  scope.
- `add`: its anchor flags, turned into `{kind, key, anchorType, spec}`.
- `footer(thread)`: optional text after `show`, such as diffview's restack
  commands.

The conventions are settled once: a message is `-m <text>`, or
`--from <file|->` for long ones (diffview's positional text goes away);
every verb takes `--json`; `--human` acts as the human.

Identity comes from `MARGIN_USER`, `MARGIN_AUTHOR` and `MARGIN_SESSION`,
falling back to each app's existing variables and to Pi's and Cursor's
session ids.

## Server and UI

The core exports a request handler for `/api/comments/*` and a change stream
built on `changeToken()` / `onWrite()`, and the app mounts both. A thread as
JSON:

```js
{
  id, status, pending, waitingOn,
  document: { kind, key, label },
  anchorType, state,                  // "current" | "carried" | "outdated"
  place, label,                       // place: the anchor type's JSON; label: its words
  madeOn: { seq, place }, nowReads,   // nowReads: a place, or null
  quote, createdAt, statusBy, statusAt,
  messages: [{ id, author, authorKind, session, body, revisionSeq, createdAt, sentAt, pending }],
}
```

The shared front end (rail, cards, composer, the pending-batch bar) is the
last step. Its seam is a client-side counterpart of each anchor type that
maps a place to elements on the page.

## Plan

1. This doc, then the shapes: types, registry, schema, the two built-in
   anchor types.
2. The store, ported from diffview's, which already does more: `apply`, the
   `--after` cursor, more than one anchor kind.
3. diffview on margin, with its importer. This is the hard one, so it goes
   first.
4. mdview on margin.
5. The shared CLI verbs, used by both apps.
6. The shared front end.

## Open questions

1. **Statuses per app?** Code review might want "won't fix". I'd keep
   open / suggested / resolved fixed in the core, since that encodes the
   human-agent contract (agents propose, humans decide), and use a reply
   for nuance.
2. **A `margin` CLI across apps?** `margin wait` covering every app needs
   every app's kinds loaded in one process. It could store a module path per
   registered app. Today each app's CLI waits on its own kinds. Worth it?
3. **Threads on kinds whose app is not loaded.** Should a thread store its
   last label, so a CLI without that app can still list it?
4. **The name.** "margin" is a placeholder.
