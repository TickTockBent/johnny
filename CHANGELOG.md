# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-27

### Added
- **`list(namespace, options?)`** - Non-semantic browse/enumerate within a namespace. Returns `Memory[]` (no embedding call, no query, no `distance`) for admin/inspection/export use cases. Supports the familiar filter vocabulary (`types`, `tags` ALL-of, `minImportance`, plus a new `source` exact-match filter and `includeExpired`), ordering by `createdAt`/`updatedAt`/`importance`/`lastMentionedAt` (NULLS LAST, `id` tiebreak) in either direction, and offset-based pagination (`limit` default 50, clamped to 1000; `offset` default 0). Non-finite pagination input (`NaN`, `Infinity`) falls back to the default rather than reaching Postgres as `LIMIT NULL`, which would return the entire namespace; fractional values are truncated. Additive — no schema migration.
- New exported type: `ListOptions`

### Changed
- Internal: extracted a shared `buildFilterConditions()` helper in `MemoryService` used by `search()`, `searchAcross()`, and `list()` to keep filter semantics identical across all read paths (no behavioral change to existing methods)
- Internal: new `src/pagination.ts` holds the `list()` pagination defaults and sanitization, imported by both `MemoryService` and `MockMemoryService` so the clamping the mock's parity guarantee depends on cannot drift between them

## [0.3.0] - 2026-02-07

### Added
- **Custom embedding providers** - New `EmbeddingProvider` interface and `OpenAIEmbeddingProvider` class. Pass any provider via the `embeddingProvider` constructor option to use Ollama, Cohere, local models, etc.
- **IMemoryService interface** - Shared contract implemented by both `MemoryService` and `MockMemoryService`, ensuring both stay in sync
- **`updateContent(id, content, metadata?)`** - Update a memory's content and automatically regenerate its embedding
- **`upsert(namespace, key, content, metadata?)`** - Atomic insert-or-update using `source` as the unique key within a namespace. Uses COALESCE semantics to preserve existing metadata for omitted fields
- **`searchAcross(namespaces, query, options?)`** - Search across multiple namespaces in a single call. Returns `CrossNamespaceSearchResult` with a `namespace` field
- **`listNamespaces(prefix?)`** - List all distinct namespaces, optionally filtered by prefix
- **`getStatsMulti(namespaces)`** - Get statistics for multiple namespaces in one call
- **Relevance decay** - New `decayOptions` parameter on `search()` and `searchAcross()` with configurable `halfLifeHours` and `reinforceOnMention`. Uses exponential decay with `GREATEST(0, ...)` guard against clock skew
- **`updatedAt` in search results** - `MemorySearchResult` now includes the `updatedAt` field
- New exported types: `CrossNamespaceSearchResult`, `DecayOptions`, `IMemoryService`, `EmbeddingProvider`

### Changed
- **Schema: `@@index([namespace, source])` → `@@unique([namespace, source])`** - Required for `upsert()` ON CONFLICT. This is a **schema migration** — see [MIGRATION.md](MIGRATION.md) for upgrade instructions
- `storeMany()` now uses efficient multi-row INSERT (chunked at 5000 rows) instead of individual inserts
- `embeddingApiKey` is now optional in `MemoryServiceOptions` (not needed when `embeddingProvider` is set)
- Constructor validates that at least one of `embeddingApiKey` or `embeddingProvider` is provided

### Fixed
- N/A

## [0.2.0] - 2026-01-20

### Added
- Prisma 7 compatibility via runtime module resolution fallback
- Maintains full backward compatibility with Prisma 5.x

### Changed
- Internal: Prisma runtime imports now use compatibility layer (`src/prisma-runtime-compat.ts`)
- No breaking changes to public API

### Fixed
- Resolved import error when using Prisma 7 (`@prisma/client/runtime/library` no longer exists)

## [0.1.0] - 2025-01-12

### Added

- Initial release of Johnny memory service
- `MemoryService` class with full CRUD operations
  - `store()` / `storeMany()` - Store memories with auto-generated embeddings
  - `search()` - Semantic similarity search with filtering options
  - `get()` / `update()` / `delete()` - Basic CRUD operations
  - `recordMention()` - Usage tracking for cooldown logic
  - `deleteByNamespace()` / `deleteBySource()` - Bulk deletion
  - `pruneExpired()` - TTL-based cleanup
  - `getStats()` - Namespace statistics
- `MockMemoryService` for unit testing without database
- Full TypeScript support with exported types
- Custom error classes (`MemoryError`, `EmbeddingError`, `NotFoundError`, etc.)
- PostgreSQL + pgvector integration via Prisma
- OpenAI embedding generation (`text-embedding-3-small`)
- Search filtering by type, tags, importance, and mention recency
- Namespace isolation for multi-tenant applications
- SQL injection protection using Prisma's parameterized queries

### Security

- All database queries use parameterized statements to prevent SQL injection
