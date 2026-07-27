/**
 * Shared pagination defaults and sanitization for `list()`.
 *
 * `MemoryService` and `MockMemoryService` both import from here so their
 * pagination semantics cannot drift — the mock's parity guarantee depends on
 * the clamping being identical, and duplicated constants would silently break
 * that.
 */

/** Default number of rows returned by `list()` when `limit` is omitted. */
export const DEFAULT_LIST_LIMIT = 50

/** Hard upper bound on `list()` results, regardless of the requested limit. */
export const MAX_LIST_LIMIT = 1000

/**
 * Coerce a caller-supplied pagination value to a non-negative integer.
 *
 * Non-finite input (`NaN`, `Infinity`) falls back to the default rather than
 * propagating: `Math.max(NaN, 0)` is `NaN`, which the Prisma driver serializes
 * as SQL NULL, and Postgres reads `LIMIT NULL` as *no limit at all* — turning a
 * bounded query into a full-namespace scan. `NaN` reaches us easily via the
 * usual `parseInt(req.query.limit)` in an admin endpoint, so it must be caught
 * here rather than trusted.
 *
 * Fractional input is truncated so both implementations agree; Postgres rounds
 * `LIMIT 1.5` up to 2 while `Array.slice` would take 1.
 */
function toBoundedInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 0), max)
}

/**
 * Resolve `limit`/`offset` from caller options into safe, bounded integers.
 *
 * @param options - Raw pagination options as supplied by the caller
 * @returns Sanitized `limit` (0..MAX_LIST_LIMIT) and `offset` (>= 0)
 */
export function resolveListPagination(options?: {
  limit?: number
  offset?: number
}): { limit: number; offset: number } {
  return {
    limit: toBoundedInt(options?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    offset: toBoundedInt(options?.offset, 0, Number.MAX_SAFE_INTEGER),
  }
}
