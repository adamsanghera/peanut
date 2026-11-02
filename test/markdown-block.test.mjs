import assert from "node:assert/strict";
import { test } from "node:test";
import MarkdownIt from "markdown-it";
import { AnchorError } from "../src/index.mjs";
import { anchorType as block, extractBlocks } from "../src/anchors/markdown-block.mjs";
import { anchorType as whole } from "../src/anchors/whole.mjs";

const md = new MarkdownIt();

function parsed(source) {
  return { markdown: { source, blocks: extractBlocks(md.parse(source, {})) } };
}

const V1 = `# Plan

## Why

The two stores drifted apart.

## How

TBD

TBD
`;

test("blocks are headings, paragraphs, code and rows, with their lines", () => {
  const { blocks } = parsed(V1).markdown;
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
  assert.deepEqual(block.locate(anchor, moved), { blockIndex: 4, lines: [9, 10], heading: "Why" });
  assert.equal(block.label(anchor, block.locate(anchor, moved)), 'under "Why", lines 9-10');
});

test("identical blocks keep their ordinal, or take the last when fewer remain", () => {
  const second = block.create(parsed(V1), { blockIndex: 5 }).anchor;
  assert.equal(block.locate(second, parsed(V1)).lines[0], 11);
  assert.equal(block.locate(second, parsed("## How\n\nTBD\n")).lines[0], 3);
});

test("an edited block is outdated, and its successor is found", () => {
  const { anchor } = block.create(parsed(V1), { blockIndex: 2 });
  const edited = parsed(V1.replace("The two stores drifted apart.", "The two stores drifted apart over a month."));
  assert.equal(block.locate(anchor, edited), null);
  assert.deepEqual(block.successor(anchor, parsed(V1), edited), { blockIndex: 2, lines: [5, 5], heading: "Why" });
  const rewritten = parsed(V1.replace("The two stores drifted apart.", "Something else entirely."));
  assert.equal(block.successor(anchor, parsed(V1), rewritten), null);
});

test("the excerpt is the block's source as written", () => {
  const v = parsed("Some *emphasis*\nacross lines.\n");
  const { anchor } = block.create(v, { blockIndex: 0 });
  assert.equal(block.excerpt(anchor, block.locate(anchor, v), v), "Some *emphasis*\nacross lines.");
});

test("a block that is not there is an AnchorError", () => {
  assert.throws(() => block.create(parsed(V1), { blockIndex: 99 }), AnchorError);
});

test("a whole-document thread always attaches and is named by its document type's noun", () => {
  const { anchor } = whole.create({}, {});
  assert.deepEqual(whole.locate(anchor, {}), {});
  assert.equal(whole.label(anchor, {}, { noun: "branch" }), "the whole branch");
});
