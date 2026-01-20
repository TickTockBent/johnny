/**
 * Compatibility layer for Prisma runtime exports across versions 5, 6, and 7.
 *
 * Prisma 5-6: @prisma/client/runtime/library
 * Prisma 7:   @prisma/client/runtime/client
 *
 * This module attempts to import from both locations with fallback,
 * providing a stable API for SQL template tag operations.
 */

// Define the Sql type inline to avoid import path issues
// Both Prisma versions expose identical Sql type definitions
export type Sql = {
  strings: string[]
  values: unknown[]
}

interface PrismaRuntimeModule {
  join: (...args: any[]) => Sql
  sqltag: (strings: TemplateStringsArray, ...values: any[]) => Sql
  Sql?: any
}

let runtimeExports: PrismaRuntimeModule

// Try both import paths with fallback
try {
  // Prisma 7 path
  runtimeExports = require('@prisma/client/runtime/client') as PrismaRuntimeModule
} catch (e1) {
  try {
    // Prisma 5-6 path
    runtimeExports = require('@prisma/client/runtime/library') as PrismaRuntimeModule
  } catch (e2) {
    throw new Error(
      'Failed to import Prisma runtime. Ensure @prisma/client (v5, v6, or v7) is installed.\n' +
      `Tried:\n  - @prisma/client/runtime/client (Prisma 7)\n  - @prisma/client/runtime/library (Prisma 5-6)`
    )
  }
}

/**
 * Join multiple SQL fragments with a separator.
 * Used for building dynamic WHERE clauses safely.
 */
export const sqlJoin = runtimeExports.join

/**
 * SQL template tag for parameterized queries.
 * Provides SQL injection protection.
 */
export const sql = runtimeExports.sqltag
