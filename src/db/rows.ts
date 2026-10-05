/**
 * Coercion helpers for rows read through the raw seam.
 *
 * The seam returns `Record<string, unknown>` because the two drivers do not
 * agree on a single JS type per SQL type, and because the code that consumes a
 * row needs a declared shape rather than a bag of unknowns.
 */

/**
 * Coerce one raw cell into the `string | null` a nullable text column is
 * typed as.
 *
 * `String(value)` alone would be wrong: it turns SQL `null` into the
 * two-character string `'null'`, which `safeJSON` then parses into JSON `null`
 * and hands to a `.map()` — a crash that only appears on rows where a value is
 * absent. Nullability is therefore preserved, not flattened.
 */
export function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/**
 * Declare the shape of rows the caller selected by naming their columns.
 *
 * `unknown` is the honest type for the seam as a whole, and useless at a call
 * site that just wrote out the column list itself. This is where that
 * knowledge is asserted — once, with the reason — rather than at every
 * consumer. The assertion holds because every column in the neutral contract
 * (AL-1-1) is `text` or `integer`, which both drivers hand back as the same JS
 * value drizzle produced for that column; adding a column to the table cannot
 * change what a named `SELECT` returns.
 */
export function asRows<T>(rows: Record<string, unknown>[]): T[] {
  // SAFETY: the caller's explicit column list is the contract being asserted.
  return rows as unknown as T[]
}
