/**
 * markdown.block: a thread on one block of a Markdown document (a heading,
 * paragraph, code block or table row), and optionally on a quote inside it.
 *
 * A thread follows its block's text, not its position: it attaches to the
 * block with the same kind and whitespace-collapsed text, so reflowing a
 * paragraph or moving a section keeps it. When the text is gone, the thread
 * is outdated, and successor() guesses what the block became.
 *
 * This is mdview's blocks.mjs, which diffview copied byte for byte for its
 * descriptions, plus the successor() both stores copied.
 */
import { createHash } from "node:crypto";
import { AnchorError } from "../errors.mjs";

const BLOCK_KIND_BY_TOKEN = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  fence: "code",
  code_block: "code",
  tr_open: "row",
};

// How alike (Dice coefficient over word sets) a new block must be to an
// outdated thread's block to count as that block, edited.
const SUCCESSOR_SIMILARITY = 0.5;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Collapses whitespace runs so reflowed text compares equal. */
export function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function blockText(tokens, i) {
  const token = tokens[i];
  if (token.type === "fence") return `${token.info}\n${token.content}`;
  if (token.type === "code_block") return token.content;
  if (token.type === "tr_open") {
    const cells = [];
    for (let j = i + 1; j < tokens.length && tokens[j].type !== "tr_close"; j++) {
      if (tokens[j].type === "inline") cells.push(tokens[j].content);
    }
    return cells.join(" | ");
  }
  return tokens[i + 1].content;
}

function enclosingListItem(tokens, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (tokens[j].type === "list_item_open" && tokens[j].level === tokens[i].level - 1) return tokens[j];
  }
  return tokens[i];
}

/**
 * Finds the commentable blocks in markdown-it tokens: headings, paragraphs,
 * code blocks and table rows. Tags the element that renders each block with
 * data-block="<index>" so the browser can map a selection to its block.
 *
 * A block's `sha` hashes its kind and whitespace-collapsed source text, so
 * reflowing a paragraph or renumbering a list keeps it. `ordinal` counts
 * earlier blocks with the same sha, telling apart two "TBD" paragraphs.
 * Lines are 1-based and inclusive in the file: `lineOffset` adds back the
 * front matter cut off before parsing.
 *
 * @returns {import("../types.mjs").Block[]}
 */
export function extractBlocks(tokens, lineOffset = 0) {
  const blocks = [];
  const seen = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const kind = BLOCK_KIND_BY_TOKEN[token.type];
    if (!kind || !token.map) continue;
    const text = normalizeText(blockText(tokens, i));
    const sha = sha256(`${kind}\n${text}`);
    const ordinal = seen.get(sha) ?? 0;
    seen.set(sha, ordinal + 1);
    // Paragraphs in tight lists render no <p>, so their list item carries the tag.
    const host = token.hidden ? enclosingListItem(tokens, i) : token;
    host.attrSet("data-block", String(blocks.length));
    blocks.push({
      index: blocks.length,
      kind,
      sha,
      ordinal,
      text,
      startLine: token.map[0] + lineOffset + 1,
      endLine: token.map[1] + lineOffset,
    });
  }
  return blocks;
}

/**
 * The block an anchor ({blockSha, ordinal}) lands on among one revision's
 * blocks: the one with the same text, or null when no block has it. Among
 * identical blocks it takes the same ordinal, or the last one when fewer
 * remain.
 */
export function findBlock(anchor, blocks) {
  const same = blocks.filter((b) => b.sha === anchor.blockSha);
  return same.length ? same[Math.min(anchor.ordinal, same.length - 1)] : null;
}

function headingAbove(blocks, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i].kind === "heading") return blocks[i].text;
  }
  return null;
}

function sourceLines(source, block) {
  return source.split("\n").slice(block.startLine - 1, block.endLine).join("\n");
}

function wordSet(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** A block as the UI and CLI see it: where it is, and what heading it sits under. */
function placeOf(markdown, block) {
  return {
    blockIndex: block.index,
    lines: [block.startLine, block.endLine],
    heading: headingAbove(markdown.blocks, block.index),
  };
}

/** @type {import("../types.mjs").AnchorType} */
export const anchorType = {
  name: "markdown.block",
  needs: ["markdown"],

  /** spec: {blockIndex, quote?, start?}: a block, and optionally the selected text in it and its offset. */
  create({ markdown }, { blockIndex, quote = "", start = null }) {
    const block = markdown.blocks[blockIndex];
    if (!block) throw new AnchorError(`There is no block ${blockIndex}; the doc has ${markdown.blocks.length}.`);
    return { anchor: { blockSha: block.sha, ordinal: block.ordinal, start }, quote };
  },

  locate(anchor, { markdown }) {
    const block = findBlock(anchor, markdown.blocks);
    return block && placeOf(markdown, block);
  },

  /**
   * Guesses what an outdated block became: the most similar block of the same
   * kind among those whose text is new since the thread's revision. Null
   * when nothing is similar enough, as when the block was removed or
   * rewritten from scratch.
   */
  successor(anchor, from, to) {
    const block = findBlock(anchor, from.markdown.blocks);
    if (!block) return null;
    const kept = new Set(from.markdown.blocks.map((b) => b.sha));
    const words = wordSet(block.text);
    let best = null;
    let bestScore = 0;
    for (const candidate of to.markdown.blocks) {
      if (candidate.kind !== block.kind || kept.has(candidate.sha)) continue;
      const other = wordSet(candidate.text);
      let shared = 0;
      for (const word of words) if (other.has(word)) shared++;
      const score = (2 * shared) / (words.size + other.size || 1);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return bestScore >= SUCCESSOR_SIMILARITY ? placeOf(to.markdown, best) : null;
  },

  label(_anchor, place) {
    if (!place) return "a block that is gone";
    const lines = place.lines[0] === place.lines[1] ? `line ${place.lines[0]}` : `lines ${place.lines[0]}-${place.lines[1]}`;
    return place.heading ? `under "${place.heading}", ${lines}` : lines;
  },

  excerpt(_anchor, place, { markdown }) {
    return sourceLines(markdown.source, markdown.blocks[place.blockIndex]);
  },
};
