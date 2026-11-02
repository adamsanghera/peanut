# peanut

Comment threads between humans and agents, anchored in documents that change. Shared by mdview and diffview.

TypeScript, run directly by Node 24 with no build step: Node strips the types. `npm run typecheck` checks them, and `npm test` runs the tests.

Apps depend on it by path (`"peanut": "file:../peanut"`). npm links that as a symlink, and Node resolves the link to this folder, outside `node_modules`, which is the only place Node strips types from.
