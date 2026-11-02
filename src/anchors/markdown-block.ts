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
 * descriptions, plus the successor() both stores copied. An app registers
 * the one markdownBlock() makes for it, with its own markdown-it setup.
 */
import { createHash } from "node:crypto";
import { AnchorError } from "../errors.ts";
import type { AnchorType, Revision } from "../types.ts";

/** The parts of a markdown-it token blocks are found from, so peanut needs no markdown-it of its own. */
export interface MarkdownToken {
  type: string;
  content: string;
  info: string;
  level: number;
  hidden: boolean;
  map: [number, number] | null;
  attrSet(name: string, value: string): void;
}

export type BlockKind = "heading" | "paragraph" | "code" | "row";

export interface Block {
  index: number;
  kind: BlockKind;
  /** Of the block's kind and whitespace-collapsed text. */
  sha: string;
  /** Earlier blocks with the same sha. */
  ordinal: number;
  text: string;
  /** 1-based, inclusive, in the file. */
  startLine: number;
  endLine: number;
}

/** What a markdown.block thread stores: its block's hash and which repeat of it, and where in it the quote starts. */
export type BlockAnchor = { blockSha: string; ordinal: number; start: number | null };

/** Where a markdown.block thread sits in one revision. */
export type BlockPlacement = { blockIndex: number; lines: [number, number]; heading: string | null };

/** How a UI or CLI names the block for a new thread: see create(). */
export interface BlockSpec {
  blockIndex?: number;
  line?: number;
  quote?: string;
  start?: number;
}

export interface MarkdownBlockOptions {
  /**
   * Parses a revision's content with the app's markdown-it. `lineOffset`
   * counts front matter lines cut off first. `source` is the Markdown the
   * blocks' lines count in, when the content is not that Markdown itself
   * (diffview's descriptions store a title and a body together).
   */
  tokenize(content: string): { tokens: MarkdownToken[]; lineOffset?: number; source?: string };
}

const BLOCK_KIND_BY_TOKEN: Record<string, BlockKind> = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  fence: "code",
  code_block: "code",
  tr_open: "row",
};

// How alike (Dice coefficient over word sets) a new block must be to an
// outdated thread's block to count as that block, edited.
const SUCCESSOR_SIMILARITY = 0.5;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Collapses whitespace runs so reflowed text compares equal. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function blockText(tokens: MarkdownToken[], i: number): string {
  const token = tokens[i]!;
  if (token.type === "fence") return `${token.info}\n${token.content}`;
  if (token.type === "code_block") return token.content;
  if (token.type === "tr_open") {
    const cells: string[] = [];
    for (let j = i + 1; j < tokens.length && tokens[j]!.type !== "tr_close"; j++) {
      if (tokens[j]!.type === "inline") cells.push(tokens[j]!.content);
    }
    return cells.join(" | ");
  }
  // Headings and paragraphs: their text is the inline token that follows the opening one.
  return tokens[i + 1]?.content ?? "";
}

function enclosingListItem(tokens: MarkdownToken[], i: number): MarkdownToken {
  const token = tokens[i]!;
  for (let j = i - 1; j >= 0; j--) {
    if (tokens[j]!.type === "list_item_open" && tokens[j]!.level === token.level - 1) return tokens[j]!;
  }
  return token;
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
 */
export function extractBlocks(tokens: MarkdownToken[], lineOffset = 0): Block[] {
  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
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
export function findBlock(anchor: Pick<BlockAnchor, "blockSha" | "ordinal">, blocks: Block[]): Block | null {
  const same = blocks.filter((b) => b.sha === anchor.blockSha);
  return same[Math.min(anchor.ordinal, same.length - 1)] ?? null;
}

function headingAbove(blocks: Block[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i]!.kind === "heading") return blocks[i]!.text;
  }
  return null;
}

function sourceLines(source: string, block: Block): string {
  return source.split("\n").slice(block.startLine - 1, block.endLine).join("\n");
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** A block's placement: which block, its lines, and the heading it sits under. */
function placementOf(blocks: Block[], block: Block): BlockPlacement {
  return {
    blockIndex: block.index,
    lines: [block.startLine, block.endLine],
    heading: headingAbove(blocks, block.index),
  };
}

/** The block a spec names (see create()), or an AnchorError saying why there is none. */
function pickBlock(blocks: Block[], { blockIndex, line, quote }: BlockSpec): Block {
  if (typeof blockIndex === "number" && Number.isInteger(blockIndex)) {
    const block = blocks[blockIndex];
    if (!block) throw new AnchorError(`There is no block ${blockIndex}; the doc has ${blocks.length}.`);
    return block;
  }
  if (typeof line === "number" && Number.isInteger(line)) {
    const block = blocks.find((b) => b.startLine <= line && line <= b.endLine);
    if (!block) throw new AnchorError(`Line ${line} is not in a heading, paragraph, code block or table row. Pick a line with text on it.`);
    return block;
  }
  const needle = normalizeText(quote ?? "");
  if (!needle) throw new AnchorError("Name the block by a line in it, or by a quote from it.");
  const hits = blocks.filter((b) => b.text.includes(needle));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new AnchorError("The quote is not in the doc. Quote it as it reads, ignoring line breaks.");
  throw new AnchorError(`The quote appears in ${hits.length} blocks. Quote more of it.`);
}

// Revisions parsed per anchor type, newest last. Placing every thread on a
// page touches one or two revisions, so a few dozen covers any read.
const PARSED_REVISIONS = 32;

/**
 * Makes the markdown.block anchor type for an app, parsing revisions with
 * the app's own markdown-it setup: `tokenize(content)` returns
 * `{tokens, lineOffset}`, where `lineOffset` counts front matter lines cut
 * off before parsing. Each app makes its own because which plugins run
 * changes the tokens, and so the blocks' hashes.
 */
export function markdownBlock({ tokenize }: MarkdownBlockOptions): AnchorType<BlockAnchor, BlockPlacement, BlockSpec> {
  const cache = new Map<string, { blocks: Block[]; source: string }>();
  const parsedOf = (revision: Revision): { blocks: Block[]; source: string } => {
    let parsed = cache.get(revision.sha256);
    if (parsed) return parsed;
    const { tokens, lineOffset = 0, source = revision.content } = tokenize(revision.content);
    parsed = { blocks: extractBlocks(tokens, lineOffset), source };
    cache.set(revision.sha256, parsed);
    if (cache.size > PARSED_REVISIONS) cache.delete(cache.keys().next().value!);
    return parsed;
  };
  const blocksOf = (revision: Revision): Block[] => parsedOf(revision).blocks;

  return {
    name: "markdown.block",

    /**
     * spec names the block one of three ways: {blockIndex} (the viewer's
     * selection), {line} (the block holding that line of the file), or
     * {quote} alone (the one block containing that text). `quote` and
     * `start` may ride along with the first two: the selected text and its
     * offset in the block.
     */
    create(revision, spec) {
      const block = pickBlock(blocksOf(revision), spec);
      const quote = spec.quote ?? "";
      const start = typeof spec.start === "number" && Number.isInteger(spec.start) ? spec.start : quote ? Math.max(0, block.text.indexOf(normalizeText(quote))) : null;
      return { anchor: { blockSha: block.sha, ordinal: block.ordinal, start }, quote };
    },

    place(anchor, revision) {
      const blocks = blocksOf(revision);
      const block = findBlock(anchor, blocks);
      return block && placementOf(blocks, block);
    },

    /**
     * Guesses what an outdated block became: the most similar block of the
     * same kind among those whose text is new since the thread's revision.
     * Null when nothing is similar enough, as when the block was removed or
     * rewritten from scratch.
     */
    successor(anchor, from, to) {
      const before = blocksOf(from);
      const after = blocksOf(to);
      const block = findBlock(anchor, before);
      if (!block) return null;
      const kept = new Set(before.map((b) => b.sha));
      const words = wordSet(block.text);
      let best: Block | null = null;
      let bestScore = 0;
      for (const candidate of after) {
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
      return best && bestScore >= SUCCESSOR_SIMILARITY ? placementOf(after, best) : null;
    },

    label(_anchor, placement) {
      if (!placement) return "a block that is gone";
      const [start, end] = placement.lines;
      const lines = start === end ? `line ${start}` : `lines ${start}-${end}`;
      return placement.heading ? `under "${placement.heading}", ${lines}` : lines;
    },

    excerpt(_anchor, placement, revision) {
      const { blocks, source } = parsedOf(revision);
      const block = blocks[placement.blockIndex];
      return block ? sourceLines(source, block) : "";
    },
  };
}
