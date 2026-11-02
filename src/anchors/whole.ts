/**
 * core.whole: a thread on a document as a whole. It parses nothing and is
 * always placed, so it is never outdated. diffview's "whole branch"
 * threads and threads on a stack are this.
 */
import type { AnchorType } from "../types.ts";

type Empty = Record<string, never>;

export const anchorType: AnchorType<Empty, Empty> = {
  name: "core.whole",
  create() {
    return { anchor: {}, quote: "" };
  },
  place() {
    return {};
  },
  label(_anchor, _placement, documentType) {
    return `the whole ${documentType.noun}`;
  },
};
