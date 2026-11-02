/**
 * Document filters: which documents a list or a wait covers, as one SQL
 * condition on the `documents` table. See DocumentFilter in types.mjs.
 *
 * A document is included when it matches any condition. `null` means every
 * document; an empty list means none, so an app that resolves its arguments
 * to nothing gets nothing, not everything.
 */
import { StoreError } from "./errors.mjs";

/** `LIKE` treats % and _ as wildcards; app names have neither, but keys can. */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Returns {sql, params} for a WHERE clause over documents aliased `alias`.
 * Throws StoreError on a condition it does not understand, so a typo never
 * widens a wait to every document.
 */
export function filterSql(filter, alias = "d") {
  if (filter === null || filter === undefined) return { sql: "1", params: [] };
  if (!Array.isArray(filter)) throw new StoreError("A document filter is a list of conditions.");
  if (!filter.length) return { sql: "0", params: [] };
  const parts = [];
  const params = [];
  for (const condition of filter) {
    const keys = Object.keys(condition ?? {}).sort().join(",");
    if (keys === "app") {
      parts.push(`${alias}.type LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(condition.app)}.%`);
    } else if (keys === "key,type") {
      parts.push(`(${alias}.type = ? AND ${alias}.key = ?)`);
      params.push(condition.type, condition.key);
    } else if (keys === "keyPrefix,type") {
      parts.push(`(${alias}.type = ? AND substr(${alias}.key, 1, length(?)) = ?)`);
      params.push(condition.type, condition.keyPrefix, condition.keyPrefix);
    } else {
      throw new StoreError(`A filter condition is {app}, {type, key} or {type, keyPrefix}, not ${JSON.stringify(condition)}.`);
    }
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}
