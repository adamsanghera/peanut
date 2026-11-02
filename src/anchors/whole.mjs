/**
 * core.whole: a thread on a document as a whole. It reads nothing and
 * always attaches, so it is never outdated. diffview's "whole branch"
 * threads and threads on a stack are this.
 */

/** @type {import("../types.mjs").AnchorType} */
export const anchorType = {
  name: "core.whole",
  reads: [],
  create() {
    return { anchor: {}, quote: "" };
  },
  locate() {
    return {};
  },
  label(_anchor, _location, documentType) {
    return `the whole ${documentType.noun}`;
  },
};
