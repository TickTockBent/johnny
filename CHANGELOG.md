# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
