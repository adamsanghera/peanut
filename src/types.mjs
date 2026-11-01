/**
 * The shapes an app hands margin, as JSDoc. Nothing here runs; the registry
 * (registry.mjs) checks these shapes when an app registers.
 *
 * Names are namespaced: a kind or an anchor type is "<namespace>.<name>",
 * where the namespace is the app that defines it, or "core" / "markdown"
 * for the ones margin ships.
 */

/**
 * An app: a namespace that registers kinds, anchor types and its own tables.
 *
 * @typedef {object} App
 * @property {string} name                 Lowercase, e.g. "diffview". Prefixes its kinds, anchor types and tables.
 * @property {Kind[]} [kinds]
 * @property {AnchorType[]} [anchorTypes]
 * @property {string[]} [migrations]       SQL steps, run once each in order. Tables must be named "<app>_<table>".
 */

/**
 * A type of document.
 *
 * @typedef {object} Kind
 * @property {string} name                 "<app>.<name>", e.g. "mdview.doc".
 * @property {string} noun                 What people call one: "doc", "branch". Used in "the whole branch".
 * @property {string[]} facets             The facets view() returns.
 * @property {string[]} anchors            Anchor types threads on it may use. Each one's needs must be among the facets.
 * @property {(key: string) => RevisionInput | null} current
 *   The document's content as it reads now, or null when it is gone.
 * @property {(revision: Revision) => View} view
 *   Parses a revision into facets. Called once per revision per process.
 * @property {(key: string) => string} label
 *   A short name for the document: "notes.md", "feat-x".
 */

/**
 * What a kind hands the store to record. A revision's identity is the hash
 * of `content` alone; `meta` rides along with the first revision that has
 * that content.
 *
 * @typedef {object} RevisionInput
 * @property {string} content
 * @property {object} [meta]
 */

/**
 * @typedef {object} Revision
 * @property {number} id
 * @property {number} documentId
 * @property {number} seq                  The "v3" people see.
 * @property {string} sha256               Of `content`.
 * @property {string} content
 * @property {object} meta
 * @property {string} observedAt
 */

/**
 * A revision parsed for anchor types: an object of facets, such as
 * `{ markdown: MarkdownFacet }` or diffview's `{ diff: { files, fileText } }`.
 * A facet may hold functions that do work only when asked.
 *
 * @typedef {Record<string, any>} View
 */

/**
 * The facet markdown.block reads. Apps build it with extractBlocks() over
 * tokens from their own markdown-it, so their plugins decide the blocks.
 *
 * @typedef {object} MarkdownFacet
 * @property {string} source               The Markdown as the file reads.
 * @property {Block[]} blocks
 */

/**
 * @typedef {object} Block
 * @property {number} index
 * @property {"heading" | "paragraph" | "code" | "row"} kind
 * @property {string} sha                  Of the kind and whitespace-collapsed text.
 * @property {number} ordinal              Earlier blocks with the same sha.
 * @property {string} text
 * @property {number} startLine            1-based, inclusive, in the file.
 * @property {number} endLine
 */

/**
 * A way of pinning a thread to part of a document and finding that part
 * again in a later revision. Every method is synchronous: the store runs
 * them inside reads and transactions.
 *
 * The store derives a thread's state from locate(): current when the thread
 * was made on the revision shown, carried when made earlier and still
 * located, outdated when locate() returns null.
 *
 * @typedef {object} AnchorType
 * @property {string} name                 "<namespace>.<name>", e.g. "markdown.block".
 * @property {string[]} needs              Facets it reads.
 * @property {(view: View, spec: object) => { anchor: object, quote: string }} create
 *   Pins a new thread from a spec the app's UI or CLI built. Throws AnchorError, worded for the user.
 * @property {(anchor: object, view: View) => object | null} locate
 *   Where the anchor lands in a view (a place, JSON the UI reads), or null when its text is gone.
 * @property {(anchor: object, from: View, to: View) => object | null} [successor]
 *   For an outdated anchor: the place in `to` that most likely is what it became.
 * @property {(anchor: object, place: object | null, kind: Kind) => string} label
 *   Where the thread sits, in words: 'under "How"', "src/a.js lines 4-6".
 * @property {(anchor: object, place: object, view: View) => string} [excerpt]
 *   Source text around the place, for the CLI's `show`.
 */

/**
 * @typedef {object} Author
 * @property {string} name
 * @property {"human" | "agent"} kind
 * @property {string} [session]            For agents: the start of their session id.
 */

/**
 * Which documents a read or a wait covers. A document matches when it
 * matches any selector.
 *
 * @typedef {Selector[]} Scope
 * @typedef {{ app: string } | { kind: string, key: string } | { kind: string, keyPrefix: string }} Selector
 */

export {};
