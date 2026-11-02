import assert from "node:assert/strict";
import { test } from "node:test";
import MarkdownIt from "markdown-it";
import { AnchorError } from "../src/index.ts";
import { createHash } from "node:crypto";
import { type BlockAnchor, type BlockPlacement, extractBlocks, markdownBlock } from "../src/anchors/markdown-block.ts";
import type { DocumentType, Revision } from "../src/types.ts";
import { anchorType as whole } from "../src/anchors/whole.ts";

const md = new MarkdownIt();

let tokenized = 0;
const block = markdownBlock({
  tokenize(content) {
    tokenized++;
    return { tokens: md.parse(content, {}) };
  },
});

// A document type for labels, which markdown.block does not read.
const PAGE: DocumentType = { name: "notes.page", noun: "page", anchorTypes: ["markdown.block"], readContent: () => null, displayName: (key) => key };

/** Where `anchor` is placed in `revision`, failing the test when it is not. */
function placed(anchor: BlockAnchor, revision: Revision, type = block): BlockPlacement {
  const placement = type.place(anchor, revision);
  assert.ok(placement, "the anchor is placed");
  return placement;
}

function parsed(source: string): Revision {
  return { seq: 1, sha256: createHash("sha256").update(source).digest("hex"), content: source, meta: {} };
}

const V1 = `# Plan

## Why

The two stores drifted apart.

## How

TBD

TBD
`;

test("blocks are headings, paragraphs, code and rows, with their lines", () => {
  const blocks = extractBlocks(md.parse(V1, {}));
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.text, b.startLine, b.endLine, b.ordinal]),
    [
      ["heading", "Plan", 1, 1, 0],
      ["heading", "Why", 3, 3, 0],
      ["paragraph", "The two stores drifted apart.", 5, 5, 0],
      ["heading", "How", 7, 7, 0],
      ["paragraph", "TBD", 9, 9, 0],
      ["paragraph", "TBD", 11, 11, 1],
    ],
  );
});

test("a thread follows its block through a reflow and a move", () => {
  const { anchor, quote } = block.create(parsed(V1), { blockIndex: 2, quote: "drifted", start: 15 });
  assert.equal(quote, "drifted");
  const moved = parsed("# Plan\n\n## How\n\nTBD\n\n## Why\n\nThe two   stores\ndrifted apart.\n");
  assert.deepEqual(block.place(anchor, moved), { blockIndex: 4, lines: [9, 10], heading: "Why" });
  assert.equal(block.label(anchor, placed(anchor, moved), PAGE), 'under "Why", lines 9-10');
});

test("identical blocks keep their ordinal, or take the last when fewer remain", () => {
  const second = block.create(parsed(V1), { blockIndex: 5 }).anchor;
  assert.equal(placed(second, parsed(V1)).lines[0], 11);
  assert.equal(placed(second, parsed("## How\n\nTBD\n")).lines[0], 3);
});

test("an edited block is outdated, and its successor is found", () => {
  const { anchor } = block.create(parsed(V1), { blockIndex: 2 });
  const edited = parsed(V1.replace("The two stores drifted apart.", "The two stores drifted apart over a month."));
  assert.equal(block.place(anchor, edited), null);
  assert.deepEqual(block.successor!(anchor, parsed(V1), edited), { blockIndex: 2, lines: [5, 5], heading: "Why" });
  const rewritten = parsed(V1.replace("The two stores drifted apart.", "Something else entirely."));
  assert.equal(block.successor!(anchor, parsed(V1), rewritten), null);
});

test("the excerpt is the block's source as written", () => {
  const v = parsed("Some *emphasis*\nacross lines.\n");
  const { anchor } = block.create(v, { blockIndex: 0 });
  assert.equal(block.excerpt!(anchor, placed(anchor, v), v), "Some *emphasis*\nacross lines.");
});

test("a block that is not there is an AnchorError", () => {
  assert.throws(() => block.create(parsed(V1), { blockIndex: 99 }), AnchorError);
});

test("a revision is parsed once, however many threads are placed in it", () => {
  const v = parsed("# Once\n\nOnly once.\n");
  const before = tokenized;
  const { anchor } = block.create(v, { blockIndex: 1 });
  for (let i = 0; i < 50; i++) block.place(anchor, v);
  assert.equal(tokenized - before, 1);
});

test("front matter cut before parsing is added back to the lines", () => {
  const withFrontMatter = markdownBlock({ tokenize: (content) => ({ tokens: md.parse(content.split("---\n")[2] ?? "", {}), lineOffset: 3 }) });
  const v = parsed("---\ntitle: x\n---\n# Heading\n");
  const { anchor } = withFrontMatter.create(v, { blockIndex: 0 });
  assert.deepEqual(placed(anchor, v, withFrontMatter).lines, [4, 4]);
});

test("a whole-document thread is always placed and is named by its document type's noun", () => {
  const empty = parsed("");
  const { anchor } = whole.create(empty, {});
  assert.deepEqual(whole.place(anchor, empty), {});
  assert.equal(whole.label(anchor, {}, { ...PAGE, noun: "branch" }), "the whole branch");
});

test("a line or a quote picks the block, and ambiguity is refused", () => {
  const v = parsed(V1);
  assert.equal(placed(block.create(v, { line: 5 }).anchor, v).blockIndex, 2);
  assert.throws(() => block.create(v, { line: 2 }), /not in a heading, paragraph/);

  const quoted = block.create(v, { quote: "stores   drifted" });
  assert.equal(placed(quoted.anchor, v).blockIndex, 2, "whitespace in a quote is collapsed");
  assert.equal(quoted.anchor.start, 8, "the quote's offset in its block");
  assert.throws(() => block.create(v, { quote: "TBD" }), /appears in 2 blocks/);
  assert.throws(() => block.create(v, { quote: "absent" }), /not in the doc/);
  assert.throws(() => block.create(v, {}), /by a line in it, or by a quote/);
});
