# Johnny

A lightweight, project-agnostic semantic memory system for storing and retrieving text with vector embeddings.

Johnny provides the **retrieval** layer for RAG (Retrieval-Augmented Generation) applications. Store facts, conversations, or documents with auto-generated embeddings, then query by semantic similarity.

## Features

- **Vector embeddings** via OpenAI's `text-embedding-3-small` (1536 dimensions)
- **PostgreSQL + pgvector** for storage and similarity search
- **Namespace isolation** - separate memory spaces per user, project, or context
- **Flexible filtering** - by type, tags, importance, recency
- **Usage tracking** - mention counts and cooldowns to avoid repetition
- **TTL expiration** - automatic cleanup of stale memories
- **Prisma integration** - works with your existing Prisma client

## Installation

```bash
npm install @ticktockbent/johnny
```

### Peer Dependencies

Johnny requires these packages in your project:

```bash
npm install @prisma/client
```

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
  @@index([namespace, source])
  @@index([expiresAt])
}
```

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

## API Reference

### `MemoryService`

#### Constructor

```typescript
new MemoryService({
  prisma: PrismaClient,           // Your Prisma client instance
  embeddingApiKey: string,        // OpenAI API key
  embeddingModel?: string,        // Default: 'text-embedding-3-small'
  defaultNamespace?: string,      // Optional default namespace
})
```

#### Methods

##### `store(namespace, content, metadata?)`

Store a new memory with auto-generated embedding.

```typescript
const memory = await memory.store('user:123', 'Content to remember', {
  type: 'fact',              // App-defined category
  tags: ['tag1', 'tag2'],    // Flexible labels for filtering
  source: 'conversation:456', // Origin reference
  importance: 0.8,           // Ranking signal (0-1)
  expiresAt: new Date(),     // Auto-delete after this time
})
```

##### `storeMany(namespace, items[])`

Batch store multiple memories (more efficient for bulk operations).

```typescript
const memories = await memory.storeMany('user:123', [
  { content: 'First fact', metadata: { type: 'fact' } },
  { content: 'Second fact', metadata: { type: 'fact' } },
])
```

##### `search(namespace, query, options?)`

Find memories semantically similar to a query.

```typescript
const results = await memory.search('user:123', 'search query', {
  limit: 10,                    // Max results (default: 10)
  maxDistance: 0.5,             // Similarity threshold (default: 0.5, lower = stricter)
  types: ['fact', 'preference'], // Filter by type
  tags: ['important'],          // Must have ALL these tags
  minImportance: 0.5,           // Minimum importance score
  excludeMentionedWithin: 24,   // Exclude if mentioned within N hours
})

// Returns MemorySearchResult[]
// { id, content, type, tags, source, importance, distance, createdAt, lastMentionedAt, mentionCount }
```

##### `get(id)`

Retrieve a specific memory by ID.

```typescript
const memory = await memory.get('memory-id')
```

##### `update(id, updates)`

Update a memory's metadata (does not re-embed content).

```typescript
const updated = await memory.update('memory-id', {
  type: 'new-type',
  tags: ['new', 'tags'],
  importance: 0.9,
  expiresAt: null,  // Remove expiration
})
```

##### `delete(id)`

Delete a specific memory.

```typescript
await memory.delete('memory-id')
```

##### `recordMention(id)`

Track that a memory was used. Updates `lastMentionedAt` and increments `mentionCount`.

```typescript
await memory.recordMention('memory-id')
```

##### `deleteByNamespace(namespace)`

Delete all memories in a namespace.

```typescript
const count = await memory.deleteByNamespace('user:123')
```

##### `deleteBySource(namespace, source)`

Delete all memories from a specific source.

```typescript
const count = await memory.deleteBySource('user:123', 'document:456')
```

##### `pruneExpired()`

Delete all memories past their `expiresAt` timestamp.

```typescript
const count = await memory.pruneExpired()
```

##### `getStats(namespace)`

Get statistics for a namespace.

```typescript
const stats = await memory.getStats('user:123')
// { totalMemories, byType, oldestMemory, newestMemory, expiringWithin7Days }
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

// Same API as MemoryService
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
  EmbeddingError,        // OpenAI API failures
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
