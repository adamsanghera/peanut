/**
 * The shapes an app hands peanut, as JSDoc. Nothing here runs; the registry
 * (registry.mjs) checks these shapes when an app registers.
 *
 * Names are namespaced: a document type or an anchor type is
 * "<namespace>.<name>", where the namespace is the app that defines it, or
 * "core" / "markdown" for the ones peanut ships.
 */

/**
 * An app: a namespace that registers document types, anchor types and its
 * own tables.
 *
 * @typedef {object} App
 * @property {string} name                       Lowercase, e.g. "diffview". Prefixes its types and tables.
 * @property {string} [folder]                   Names the folder its store lives in: ".<folder>" in a project, "~/.<folder>"
 *                                               at home. Defaults to the app's name.
 * @property {DocumentType[]} [documentTypes]
 * @property {AnchorType[]} [anchorTypes]
 * @property {string[]} [migrations]             SQL steps, run once each in order. Tables must be named "<app>_<table>".
 */

/**
 * What kind of document something is: what its document key means, how to
 * read its content, and how to parse a revision of it.
 *
 * @typedef {object} DocumentType
 * @property {string} name                       "<app>.<name>", e.g. "mdview.doc".
 * @property {string} noun                       What people call one: "doc", "branch". Used in "the whole branch".
 * @property {string[]} anchorTypes              Anchor types threads on it may use.
 * @property {(key: string) => RevisionInput | null} readContent
 *   The document's content as it reads now, or null when it is gone.
 * @property {(revision: Revision) => ParsedContent} parse
 *   Parses a revision into what its anchor types read, once per revision per process.
 * @property {(key: string) => string} displayName
 *   A short name for the document: "plan.md", "feat-x".
 */

/**
 * What a document type hands the store to record. A revision's identity is
 * the hash of `content` alone; `meta` rides along with the first revision
 * that has that content.
 *
 * @typedef {object} RevisionInput
 * @property {string} content
 * @property {object} [meta]
 */

/**
 * @typedef {object} Revision
 * @property {number} id
 * @property {number} documentId
 * @property {number} seq                        The "v3" people see.
 * @property {string} sha256                     Of `content`.
 * @property {string} content
 * @property {object} meta
 * @property {string} observedAt
 */

/**
 * A revision as parse() returns it. The core never looks inside: it only
 * hands it to anchor types, and what goes in it is an agreement between a
 * document type and the anchor types it lists. markdown.block reads
 * `parsed.markdown`; diffview's line anchors read `parsed.diff`. A value
 * may hold functions that do work only when called.
 *
 * @typedef {Record<string, any>} ParsedContent
 */

/**
 * `parsed.markdown`, which markdown.block reads. Apps build it
 * with extractBlocks() over tokens from their own markdown-it, so their
 * plugins decide the blocks.
 *
 * @typedef {object} MarkdownContent
 * @property {string} source                     The Markdown as the file reads.
 * @property {Block[]} blocks
 */

/**
 * @typedef {object} Block
 * @property {number} index
 * @property {"heading" | "paragraph" | "code" | "row"} kind
 * @property {string} sha                        Of the block's kind and whitespace-collapsed text.
 * @property {number} ordinal                    Earlier blocks with the same sha.
 * @property {string} text
 * @property {number} startLine                  1-based, inclusive, in the file.
 * @property {number} endLine
 */

/**
 * A way of pinning a thread to part of a document and finding that part
 * again in a later revision.
 *
 * An anchor is stored when the thread is made and never changes: it records
 * what was commented on. An anchor placement is where the anchor is placed
 * in one revision, computed on every read: what the UI highlights and the
 * CLI prints. Both are JSON the anchor type owns.
 *
 * The store derives a thread's state from place(): current when the thread
 * was made on the revision shown, carried when made earlier and still
 * placed, outdated when place() returns null.
 *
 * Every method is synchronous: the store runs them inside reads and
 * transactions.
 *
 * @typedef {object} AnchorType
 * @property {string} name                       "<namespace>.<name>", e.g. "markdown.block".
 * @property {(parsed: ParsedContent, spec: object) => { anchor: object, quote: string }} create
 *   Pins a new thread from a spec the app's UI or CLI built. Throws AnchorError, worded for the user.
 * @property {(anchor: object, parsed: ParsedContent) => object | null} place
 *   The anchor's placement in a revision, or null when its text is gone.
 * @property {(anchor: object, from: ParsedContent, to: ParsedContent) => object | null} [successor]
 *   For an outdated anchor: the placement in `to` most likely to be what its text became.
 * @property {(anchor: object, placement: object | null, documentType: DocumentType) => string} label
 *   Where the thread sits, in words: 'under "How", line 12', "src/a.js lines 4-6".
 * @property {(anchor: object, placement: object, parsed: ParsedContent) => string} [excerpt]
 *   Source text at the placement, for the CLI's `show`.
 */

/**
 * @typedef {object} Author
 * @property {string} name
 * @property {"human" | "agent"} kind
 * @property {string} [session]                  For agents: the start of their session id.
 */

/**
 * Which documents a list or wait covers. A document is included when it
 * matches any condition.
 *
 * @typedef {Condition[]} DocumentFilter
 * @typedef {{ app: string } | { type: string, key: string } | { type: string, keyPrefix: string }} Condition
 */

export {};
