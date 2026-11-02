/**
 * core.whole: a thread on a document as a whole. It reads nothing and is
 * always placed, so it is never outdated. diffview's "whole branch"
 * threads and threads on a stack are this.
 */

/** @type {import("../types.mjs").AnchorType} */
export const anchorType = {
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
