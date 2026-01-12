# Memory Service Primitive

A lightweight, project-agnostic semantic memory system for storing and retrieving text with embeddings.

## Overview

This package provides a simple memory primitive that any application can use for RAG-style context retrieval. It handles:

- Storing text content with vector embeddings
- Semantic similarity search
- Metadata filtering (types, tags)
- Usage tracking (mention counts, cooldowns)
- TTL-based expiration

The package is intentionally "dumb"—it doesn't know what memories mean or how they should be used. That's the consuming application's responsibility.

---

## Installation

```bash
npm install @ticktockbent/johnny
```

### Peer Dependencies

```bash
npm install @prisma/client openai
```

### Database Setup

The consuming application must:
1. Enable pgvector extension in their Postgres database
2. Include the Memory model in their Prisma schema (or run migrations provided)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Quick Start

```typescript
import { MemoryService } from '@ticktockbent/johnny'

const memory = new MemoryService({
  prisma: prismaClient,           // Your existing Prisma client
  embeddingApiKey: process.env.OPENAI_API_KEY,
  defaultNamespace: 'my-app'      // Optional default
})

// Store a memory
const mem = await memory.store('user:123', 'User loves hiking and photography', {
  type: 'interest',
  tags: ['hobby', 'outdoor'],
  expiresAt: addDays(new Date(), 90)
})

// Search for relevant memories
const results = await memory.search('user:123', 'outdoor activities', {
  limit: 5,
  maxDistance: 0.5
})

// Record that a memory was used
await memory.recordMention(mem.id)
```

---

## API Reference

### Constructor

```typescript
new MemoryService(options: MemoryServiceOptions)
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `prisma` | `PrismaClient` | Yes | Your application's Prisma client |
| `embeddingApiKey` | `string` | Yes | OpenAI API key for embeddings |
| `embeddingModel` | `string` | No | Default: `text-embedding-3-small` |
| `defaultNamespace` | `string` | No | Default namespace if not specified per-call |

---

### Core Methods

#### `store(namespace, content, metadata?)`

Store a new memory with auto-generated embedding.

```typescript
async store(
  namespace: string,
  content: string,
  metadata?: MemoryMetadata
): Promise<Memory>
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `namespace` | `string` | Isolation key (e.g., `user:123`, `project:456`) |
| `content` | `string` | The text content to store and embed |
| `metadata` | `MemoryMetadata` | Optional metadata (see below) |

**MemoryMetadata:**

```typescript
interface MemoryMetadata {
  type?: string           // App-defined category
  tags?: string[]         // Flexible labels
  source?: string         // Origin reference (entryId, docId, etc.)
  importance?: number     // Ranking signal (0-1)
  expiresAt?: Date        // Auto-delete after this time
}
```

**Returns:** The created `Memory` object.

**Example:**

```typescript
await memory.store('jeorge:user:abc', 'User is planning a trip to Japan in March', {
  type: 'event',
  tags: ['travel', 'planning'],
  source: 'entry:xyz',
  expiresAt: new Date('2025-04-01')
})
```

---

#### `search(namespace, query, options?)`

Find memories semantically similar to a query.

```typescript
async search(
  namespace: string,
  query: string,
  options?: SearchOptions
): Promise<MemorySearchResult[]>
```

**SearchOptions:**

```typescript
interface SearchOptions {
  limit?: number            // Max results (default: 10)
  maxDistance?: number      // Similarity threshold 0-1 (default: 0.5, lower = more similar)
  types?: string[]          // Filter to specific types
  tags?: string[]           // Filter to memories with these tags
  excludeMentionedWithin?: number  // Exclude if mentioned within N hours (cooldown)
  minImportance?: number    // Filter by importance threshold
}
```

**Returns:** Array of `MemorySearchResult`:

```typescript
interface MemorySearchResult {
  id: string
  content: string
  type: string | null
  tags: string[]
  source: string | null
  importance: number | null
  distance: number          // Semantic distance (lower = more similar)
  createdAt: Date
  lastMentionedAt: Date | null
  mentionCount: number
}
```

**Example:**

```typescript
const results = await memory.search('jeorge:user:abc', 'vacation plans', {
  limit: 5,
  types: ['event', 'goal'],
  excludeMentionedWithin: 18  // Don't return if mentioned in last 18 hours
})
```

---

#### `get(id)`

Retrieve a specific memory by ID.

```typescript
async get(id: string): Promise<Memory | null>
```

---

#### `update(id, updates)`

Update a memory's metadata (does not re-embed content).

```typescript
async update(id: string, updates: MemoryUpdate): Promise<Memory>
```

**MemoryUpdate:**

```typescript
interface MemoryUpdate {
  type?: string
  tags?: string[]
  importance?: number
  expiresAt?: Date | null   // null to remove expiry
}
```

**Note:** To update content, delete and re-create the memory (embedding must be regenerated).

---

#### `delete(id)`

Delete a specific memory.

```typescript
async delete(id: string): Promise<void>
```

---

#### `recordMention(id)`

Record that a memory was used/mentioned. Updates `lastMentionedAt` and increments `mentionCount`.

```typescript
async recordMention(id: string): Promise<void>
```

Use this for cooldown tracking—memories recently mentioned can be excluded from search results.

---

### Bulk Operations

#### `storeMany(namespace, items)`

Store multiple memories in a batch (more efficient than individual calls).

```typescript
async storeMany(
  namespace: string,
  items: CreateMemory[]
): Promise<Memory[]>
```

**CreateMemory:**

```typescript
interface CreateMemory {
  content: string
  metadata?: MemoryMetadata
}
```

---

#### `deleteByNamespace(namespace)`

Delete all memories in a namespace. Use for user deletion, project cleanup, etc.

```typescript
async deleteByNamespace(namespace: string): Promise<number>
```

**Returns:** Count of deleted memories.

---

#### `deleteBySource(namespace, source)`

Delete all memories from a specific source (e.g., when an entry is deleted).

```typescript
async deleteBySource(namespace: string, source: string): Promise<number>
```

---

### Maintenance

#### `pruneExpired()`

Delete all memories past their `expiresAt` timestamp.

```typescript
async pruneExpired(): Promise<number>
```

**Returns:** Count of deleted memories.

Call this on a schedule (daily cron job) or opportunistically.

---

#### `getStats(namespace)`

Get statistics for a namespace.

```typescript
async getStats(namespace: string): Promise<NamespaceStats>
```

**NamespaceStats:**

```typescript
interface NamespaceStats {
  totalMemories: number
  byType: Record<string, number>
  oldestMemory: Date | null
  newestMemory: Date | null
  expiringWithin7Days: number
}
```

---

## Prisma Schema

Add this to your application's `schema.prisma`:

```prisma
model Memory {
  id              String    @id @default(cuid())
  namespace       String
  content         String    @db.Text
  embedding       Unsupported("vector(1536)")?
  
  // Flexible metadata
  type            String?
  tags            String[]  @default([])
  source          String?
  importance      Float?
  
  // Lifecycle
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

After adding, run:

```bash
npx prisma db push
```

Then create the vector index:

```sql
CREATE INDEX memory_embedding_idx ON "Memory" 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

---

## Embedding Provider

The package uses OpenAI's `text-embedding-3-small` by default:
- 1536 dimensions
- ~$0.02 per 1M tokens (essentially free)
- Fast and reliable

### Using a Different Model

```typescript
const memory = new MemoryService({
  prisma,
  embeddingApiKey: process.env.OPENAI_API_KEY,
  embeddingModel: 'text-embedding-3-large'  // 3072 dimensions, more accurate
})
```

**Note:** If you change embedding models, you must re-embed all existing memories. Different models produce incompatible vector spaces.

### Future: Pluggable Providers

A future version may support pluggable embedding providers (Voyage, Cohere, local models). For now, OpenAI is hardcoded but abstracted internally for easy refactoring.

---

## Usage Patterns

### Pattern: User Memory (Jeorge-style)

```typescript
// Namespace per user
const ns = `jeorge:user:${userId}`

// Store memories extracted from conversations
await memory.store(ns, 'User has two cats named Luna and Mochi', {
  type: 'fact',
  source: `entry:${entryId}`,
  expiresAt: addDays(new Date(), 90)
})

// Retrieve for conversation context
const relevant = await memory.search(ns, userMessage, {
  limit: 5,
  excludeMentionedWithin: 18
})

// Format for prompt (app's responsibility)
const context = relevant.map(m => `[${m.type}] ${m.content}`).join('\n')
```

### Pattern: Project Memory (Wieland-style)

```typescript
// Namespace per project
const ns = `wieland:project:${projectId}`

// Store context from project documents
await memory.store(ns, 'API must use OAuth2 for authentication', {
  type: 'requirement',
  source: `doc:${docId}`,
  tags: ['security', 'api'],
  importance: 0.9
})

// Retrieve for job context
const context = await memory.search(ns, jobDescription, {
  limit: 10,
  minImportance: 0.5
})
```

### Pattern: Cooldown Management

```typescript
// Search excluding recently mentioned memories
const results = await memory.search(ns, query, {
  excludeMentionedWithin: 24  // hours
})

// After using a memory in a response
for (const mem of usedMemories) {
  await memory.recordMention(mem.id)
}
```

### Pattern: Cleanup on Deletion

```typescript
// When a user deletes their account
await memory.deleteByNamespace(`jeorge:user:${userId}`)

// When a single entry is deleted
await memory.deleteBySource(`jeorge:user:${userId}`, `entry:${entryId}`)
```

---

## Error Handling

The service throws typed errors:

```typescript
import { MemoryError, EmbeddingError, NotFoundError } from '@ticktockbent/johnny'

try {
  await memory.store(ns, content)
} catch (err) {
  if (err instanceof EmbeddingError) {
    // OpenAI API failed
  } else if (err instanceof MemoryError) {
    // Database operation failed
  }
}
```

---

## Performance Considerations

### Embedding Latency
- Each `store()` call requires an embedding API call (~100-300ms)
- Use `storeMany()` for batch operations (embeddings are batched)

### Search Latency
- Vector search is fast with proper indexing (<50ms for 100k memories)
- The `ivfflat` index is efficient up to ~1M vectors
- For larger scale, consider `hnsw` index or dedicated vector DB

### Token Limits
- Content is truncated to 8000 tokens before embedding
- Store concise memories, not full documents

---

## Testing

The package exports a mock for testing:

```typescript
import { MockMemoryService } from '@ticktockbent/johnny/testing'

const memory = new MockMemoryService()

// Stores in memory, no DB or API calls
await memory.store('test', 'content')

// Search returns exact matches (no semantic similarity in mock)
const results = await memory.search('test', 'content')
```

---

## License

MIT

---

## Roadmap

- [ ] Pluggable embedding providers (Voyage, Cohere, local)
- [ ] Pluggable storage backends (Pinecone, Weaviate)
- [ ] Memory consolidation (merge similar memories)
- [ ] Importance decay over time
- [ ] Batch search operations
