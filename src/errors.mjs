/** An app registered something peanut cannot use. A programming error, not a user's. */
export class RegistryError extends Error {}

/** A thread cannot be pinned where it was asked for. Worded for the person or agent who asked. */
export class AnchorError extends Error {}
