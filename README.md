# Johnny

A lightweight, project-agnostic semantic memory system for storing and retrieving text with vector embeddings.

Johnny provides the **retrieval** layer for RAG (Retrieval-Augmented Generation) applications. Store facts, conversations, or documents with auto-generated embeddings, then query by semantic similarity.

## Features

- **Vector embeddings** via OpenAI's `text-embedding-3-small` (1536 dimensions) or any custom provider
- **PostgreSQL + pgvector** for storage and similarity search
- **Namespace isolation** - separate memory spaces per user, project, or context
- **Cross-namespace search** - search across multiple namespaces in one call
- **Flexible filtering** - by type, tags, importance, recency
- **Relevance decay** - time-based decay with configurable half-life
- **Upsert support** - atomic insert-or-update by key with metadata preservation
- **Content re-embedding** - update content and automatically regenerate embeddings
- **Usage tracking** - mention counts and cooldowns to avoid repetition
- **TTL expiration** - automatic cleanup of stale memories
- **Prisma integration** - works with your existing Prisma client
- **IMemoryService interface** - shared contract for real and mock implementations

## Installation

```bash
npm install @ticktockbent/johnny
```

### Peer Dependencies

Johnny requires these packages in your project:

```bash
npm install @prisma/client
```

Johnny is compatible with Prisma versions 5 and 7. Install the version that matches your project:

```bash
npm install @prisma/client@^5.0.0  # Prisma 5.x (fully tested)
npm install @prisma/client@^7.0.0  # Prisma 7.x (fully tested)
```

**Note:** Prisma 6.x support is untested and may have compatibility issues. We recommend using Prisma 5.x or upgrading to 7.x.

## Quick Start

### 1. Add the Memory model to your Prisma schema

```prisma
// schema.prisma

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

model Memory {
  id              String    @id @default(cuid())
  namespace       String
  content         String    @db.Text
  embedding       Unsupported("vector(1536)")?
  type            String?
  tags            String[]  @default([])
  source          String?
  importance      Float?
  expiresAt       DateTime?
  lastMentionedAt DateTime?
  mentionCount    Int       @default(0)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([namespace])
  @@index([namespace, type])
  @@unique([namespace, source])
  @@index([expiresAt])
}
```

> **Note:** The `@@unique([namespace, source])` constraint is required for `upsert()` to work. If upgrading from v0.2.0, see the [Migration Guide](MIGRATION.md).

### 2. Set up the database

```bash
# Push schema to database
npx prisma db push

# Create the vector similarity index (run via psql or database console)
psql $DATABASE_URL -c "CREATE INDEX memory_embedding_idx ON \"Memory\" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);"
```

### 3. Initialize and use

```typescript
import { PrismaClient } from '@prisma/client'
import { MemoryService } from '@ticktockbent/johnny'

const prisma = new PrismaClient()

const memory = new MemoryService({
  prisma,
  embeddingApiKey: process.env.OPENAI_API_KEY!,
  defaultNamespace: 'my-app',
})

// Store a memory
await memory.store('user:123', 'User loves hiking in the mountains', {
  type: 'preference',
  tags: ['hobby', 'outdoors'],
  importance: 0.8,
})

// Search by semantic similarity
const results = await memory.search('user:123', 'outdoor activities', {
  limit: 5,
  maxDistance: 0.7,
})

// Results include distance scores (lower = more similar)
console.log(results[0].content)   // "User loves hiking in the mountains"
console.log(results[0].distance)  // 0.42
```

## Custom Embedding Providers

By default Johnny uses OpenAI, but you can supply any embedding provider:

```typescript
import { MemoryService, OpenAIEmbeddingProvider } from '@ticktockbent/johnny'
import type { EmbeddingProvider } from '@ticktockbent/johnny'

// Use the built-in OpenAI provider explicitly
const openai = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',  // default
  dimensions: 1536,                  // default
})

// Or implement your own
const customProvider: EmbeddingProvider = {
  dimensions: 768,
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    // Call Ollama, Cohere, a local model, etc.
    return texts.map(text => computeEmbedding(text))
  },
}

const memory = new MemoryService({
  prisma,
  embeddingProvider: customProvider,
  defaultNamespace: 'my-app',
})
```

> **Note:** The vector dimension in your Prisma schema (`vector(1536)`) must match your provider's `dimensions` value. See `prisma/memory.prisma` for common dimension values.

## API Reference

### `MemoryService`

Both `MemoryService` and `MockMemoryService` implement the `IMemoryService` interface.

#### Constructor

```typescript
new MemoryService({
  prisma: PrismaClient,           // Your Prisma client instance
  embeddingApiKey?: string,       // OpenAI API key (not needed if embeddingProvider is set)
  embeddingModel?: string,        // Default: 'text-embedding-3-small'
  embeddingProvider?: EmbeddingProvider,  // Custom embedding provider (takes precedence)
  defaultNamespace?: string,      // Optional default namespace
})
```

#### Methods

##### `store(namespace, content, metadata?)`

Store a new memory with auto-generated embedding.

```typescript
const memory = await service.store('user:123', 'Content to remember', {
  type: 'fact',              // App-defined category
  tags: ['tag1', 'tag2'],    // Flexible labels for filtering
  source: 'conversation:456', // Origin reference
  importance: 0.8,           // Ranking signal (0-1)
  expiresAt: new Date(),     // Auto-delete after this time
})
```

##### `storeMany(namespace, items[])`

Batch store multiple memories using an efficient multi-row INSERT.

```typescript
const memories = await service.storeMany('user:123', [
  { content: 'First fact', metadata: { type: 'fact' } },
  { content: 'Second fact', metadata: { type: 'fact' } },
])
```

##### `search(namespace, query, options?)`

Find memories semantically similar to a query.

```typescript
const results = await service.search('user:123', 'search query', {
  limit: 10,                    // Max results (default: 10)
  maxDistance: 0.5,             // Similarity threshold (default: 0.5, lower = stricter)
  types: ['fact', 'preference'], // Filter by type
  tags: ['important'],          // Must have ALL these tags
  minImportance: 0.5,           // Minimum importance score
  excludeMentionedWithin: 24,   // Exclude if mentioned within N hours
  decayOptions: {               // Optional time-based relevance decay
    halfLifeHours: 168,         // Half-life in hours (168 = 1 week)
    reinforceOnMention: true,   // Reset decay clock on mention
  },
})

// Returns MemorySearchResult[]
// { id, content, type, tags, source, importance, distance, createdAt, updatedAt, lastMentionedAt, mentionCount }
```

##### `searchAcross(namespaces, query, options?)`

Search across multiple namespaces in a single call. Results include the `namespace` field.

```typescript
const results = await service.searchAcross(
  ['user:123', 'shared', 'global'],
  'search query',
  { limit: 10 }
)

// Returns CrossNamespaceSearchResult[] (MemorySearchResult + namespace)
console.log(results[0].namespace)  // "shared"
console.log(results[0].content)    // "Some shared memory"
```

##### `list(namespace, options?)`

Non-semantic browse/enumerate within a single namespace. Unlike `search()`, this makes **no embedding call** and takes **no query** — use it for admin/inspection/export (e.g. "show me everything in `user:123`", "the 20 most recently updated `preference` memories"). Returns the public `Memory[]` type (has `namespace`, **no** `distance`).

```typescript
const memories = await service.list('user:123', {
  types: ['preference'],   // Filter by type (type IN ...)
  tags: ['important'],     // Must have ALL these tags
  minImportance: 0.5,      // Minimum importance (rows with null importance excluded)
  source: 'doc:42',        // Exact source match (source is the upsert key)
  includeExpired: false,   // Include expired rows (default: false)
  orderBy: 'createdAt',    // 'createdAt' | 'updatedAt' | 'importance' | 'lastMentionedAt' (default: 'createdAt')
  direction: 'desc',       // 'asc' | 'desc' (default: 'desc')
  limit: 50,               // Max results (default: 50, clamped to 1000)
  offset: 0,               // Offset for pagination (default: 0)
})

// Returns Memory[]
// { id, namespace, content, type, tags, source, importance, expiresAt, lastMentionedAt, mentionCount, createdAt, updatedAt }
```

**Ordering:** `importance` and `lastMentionedAt` are nullable; NULLs always sort **last** regardless of direction (overriding Postgres's default of NULLS FIRST on DESC). Ties break on `id` ascending for deterministic ordering.

**Pagination:** offset-based (intended for an admin/export path, not a hot loop). `limit` is clamped to 1000 and non-finite values (`NaN`, `Infinity`) fall back to the default, so a stray `parseInt()` can't turn a page request into a full-namespace scan. There is no total-count companion: `getStats(namespace).totalMemories` counts *every* row in the namespace — including expired ones — and ignores the filters above, so it is only a valid page count for an unfiltered list with no expired rows.

##### `get(id)`

Retrieve a specific memory by ID.

```typescript
const memory = await service.get('memory-id')
```

##### `update(id, updates)`

Update a memory's metadata (does not re-embed content).

```typescript
const updated = await service.update('memory-id', {
  type: 'new-type',
  tags: ['new', 'tags'],
  importance: 0.9,
  expiresAt: null,  // Remove expiration
})
```

##### `updateContent(id, content, metadata?)`

Update a memory's content and automatically regenerate its embedding. Optionally update metadata at the same time.

```typescript
const updated = await service.updateContent('memory-id', 'New content text', {
  importance: 0.9,
})
```

##### `upsert(namespace, key, content, metadata?)`

Atomic insert-or-update using the `source` field as the unique key within a namespace. If a memory with the same `(namespace, source)` pair exists, its content and embedding are updated. Metadata fields use COALESCE semantics — only explicitly provided fields are overwritten; omitted fields preserve their existing values.

```typescript
// First call creates the memory
await service.upsert('user:123', 'user-bio', 'Likes hiking', {
  type: 'preference',
  importance: 0.8,
})

// Second call updates content + embedding, preserves importance
await service.upsert('user:123', 'user-bio', 'Likes hiking and kayaking')
```

##### `delete(id)`

Delete a specific memory.

```typescript
await service.delete('memory-id')
```

##### `recordMention(id)`

Track that a memory was used. Updates `lastMentionedAt` and increments `mentionCount`.

```typescript
await service.recordMention('memory-id')
```

##### `deleteByNamespace(namespace)`

Delete all memories in a namespace.

```typescript
const count = await service.deleteByNamespace('user:123')
```

##### `deleteBySource(namespace, source)`

Delete all memories from a specific source within a namespace.

```typescript
const count = await service.deleteBySource('user:123', 'document:456')
```

##### `pruneExpired()`

Delete all memories past their `expiresAt` timestamp.

```typescript
const count = await service.pruneExpired()
```

##### `getStats(namespace)`

Get statistics for a namespace.

```typescript
const stats = await service.getStats('user:123')
// { totalMemories, byType, oldestMemory, newestMemory, expiringWithin7Days }
```

##### `listNamespaces(prefix?)`

List all distinct namespaces, optionally filtered by prefix.

```typescript
const all = await service.listNamespaces()
// ['global', 'user:123', 'user:456']

const userOnly = await service.listNamespaces('user:')
// ['user:123', 'user:456']
```

##### `getStatsMulti(namespaces)`

Get statistics for multiple namespaces in a single call.

```typescript
const statsMap = await service.getStatsMulti(['user:123', 'user:456'])
// Map<string, NamespaceStats>

statsMap.get('user:123')?.totalMemories  // 42
```

## Testing

Johnny includes a `MockMemoryService` for unit testing without a database or API calls:

```typescript
import { MockMemoryService } from '@ticktockbent/johnny'
// or
import { MockMemoryService } from '@ticktockbent/johnny/testing'

const memory = new MockMemoryService({
  defaultNamespace: 'test',
})

// Same API as MemoryService (both implement IMemoryService)
await memory.store(undefined, 'Test content')
const results = await memory.search(undefined, 'test')

// Reset between tests
memory.clear()
```

The mock uses deterministic hash-based embeddings and cosine similarity, so search results are consistent but not semantically meaningful.

## Error Handling

Johnny exports typed errors for specific failure cases:

```typescript
import {
  MemoryError,           // Base error class
  EmbeddingError,        // Embedding provider failures
  NotFoundError,         // Memory not found
  NamespaceRequiredError, // Missing namespace
  DatabaseError,         // Database operation failures
} from '@ticktockbent/johnny'

try {
  await memory.update('nonexistent', { type: 'x' })
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log(`Memory ${error.id} not found`)
  }
}
```

## Deployment

### Vercel + Vercel Postgres

Vercel Postgres (powered by Neon) supports pgvector:

1. Enable the extension in your database:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. Add the Memory model to your schema and push

3. Create the vector index via Vercel's SQL console

4. Use with your existing Prisma client

### Other Providers

Any PostgreSQL database with pgvector works:
- **Neon** - Serverless, pgvector built-in
- **Supabase** - pgvector built-in
- **Railway** - pgvector available
- **AWS RDS** - Enable pgvector extension

## Design Philosophy

Johnny is intentionally "dumb" - it stores and retrieves without interpreting what memories mean. The consuming application decides:

- What content to store as memories
- How to chunk documents
- What namespace scheme to use
- How to incorporate retrieved memories into prompts
- What similarity thresholds make sense

This keeps Johnny focused and flexible across different use cases.

## License

MIT
---

*Part of a growing suite of literary-named MCP servers. See more at [github.com/TickTockBent](https://github.com/TickTockBent).*
