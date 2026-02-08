# Migration Guide

## Upgrading from 0.2.x to 0.3.0

Version 0.3.0 is **fully backward compatible** at the API level — all existing method signatures and behavior are unchanged. However, there is one **schema change** that requires a database migration.

### Schema Migration: `@@unique([namespace, source])`

The `@@index([namespace, source])` has been upgraded to `@@unique([namespace, source])` to support the new `upsert()` method's `ON CONFLICT` clause.

#### What This Means

- Each `(namespace, source)` pair must now be unique across the `Memory` table
- If you have existing rows with duplicate `(namespace, source)` combinations, the migration will fail until duplicates are resolved

#### Step 1: Check for Duplicates

Run this query against your database to find any duplicate `(namespace, source)` pairs:

```sql
SELECT namespace, source, COUNT(*) as cnt
FROM "Memory"
WHERE source IS NOT NULL
GROUP BY namespace, source
HAVING COUNT(*) > 1;
```

If this returns no rows, you can skip to Step 3.

#### Step 2: Resolve Duplicates

For each duplicate group, decide which row to keep and delete the others. For example, to keep only the most recent:

```sql
DELETE FROM "Memory" a
USING "Memory" b
WHERE a.namespace = b.namespace
  AND a.source = b.source
  AND a.source IS NOT NULL
  AND a."createdAt" < b."createdAt";
```

#### Step 3: Update Your Prisma Schema

Change the index to a unique constraint in your `schema.prisma`:

```diff
  model Memory {
    // ... fields ...

    @@index([namespace])
    @@index([namespace, type])
-   @@index([namespace, source])
+   @@unique([namespace, source])
    @@index([expiresAt])
  }
```

#### Step 4: Apply the Migration

```bash
# Generate and apply a Prisma migration
npx prisma migrate dev --name unique-namespace-source

# Or if you use db push
npx prisma db push
```

### New Constructor Option: `embeddingProvider`

The existing constructor signature still works unchanged:

```typescript
// This still works exactly as before
const service = new MemoryService({
  prisma,
  embeddingApiKey: process.env.OPENAI_API_KEY!,
  defaultNamespace: 'my-app',
})
```

You can optionally switch to the new `embeddingProvider` option to use a custom provider:

```typescript
import { MemoryService, OpenAIEmbeddingProvider } from '@ticktockbent/johnny'

const service = new MemoryService({
  prisma,
  embeddingProvider: new OpenAIEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY!,
  }),
  defaultNamespace: 'my-app',
})
```

If both `embeddingProvider` and `embeddingApiKey` are provided, the provider takes precedence.

### New Methods

All new methods are purely additive. Existing code requires no changes.

| Method | Description |
|--------|-------------|
| `updateContent(id, content, metadata?)` | Update content and regenerate embedding |
| `upsert(namespace, key, content, metadata?)` | Atomic insert-or-update by `(namespace, source)` key |
| `searchAcross(namespaces, query, options?)` | Search across multiple namespaces |
| `listNamespaces(prefix?)` | List distinct namespaces |
| `getStatsMulti(namespaces)` | Stats for multiple namespaces in one call |

### New Search Option: `decayOptions`

The `search()` and `searchAcross()` methods now accept an optional `decayOptions` parameter:

```typescript
const results = await service.search('user:123', 'query', {
  decayOptions: {
    halfLifeHours: 168,         // Importance halves every 7 days
    reinforceOnMention: true,   // Mentioning a memory resets the decay clock
  },
})
```

This does not change the default behavior — without `decayOptions`, search ordering is purely by cosine distance as before.

### New Types

The following types are now exported:

- `IMemoryService` — shared interface for `MemoryService` and `MockMemoryService`
- `EmbeddingProvider` — interface for custom embedding providers
- `CrossNamespaceSearchResult` — extends `MemorySearchResult` with `namespace`
- `DecayOptions` — configuration for relevance decay

### `updatedAt` in Search Results

`MemorySearchResult` now includes `updatedAt: Date`. This is additive and should not affect existing code that destructures search results.
