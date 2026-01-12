import { Sql, join as sqlJoin, sqltag as sql } from '@prisma/client/runtime/library'
import type {
  MemoryServiceOptions,
  PrismaClientLike,
  Memory,
  MemoryMetadata,
  MemoryUpdate,
  CreateMemory,
  SearchOptions,
  MemorySearchResult,
  NamespaceStats,
  RawSearchResult,
} from './types'
import {
  EmbeddingError,
  NotFoundError,
  NamespaceRequiredError,
  DatabaseError,
} from './errors'

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_MAX_DISTANCE = 0.5
const MAX_CONTENT_TOKENS = 8000

/**
 * A lightweight semantic memory service for storing and retrieving text with embeddings.
 *
 * @example
 * ```typescript
 * const memory = new MemoryService({
 *   prisma: prismaClient,
 *   embeddingApiKey: process.env.OPENAI_API_KEY,
 *   defaultNamespace: 'my-app'
 * })
 *
 * await memory.store('user:123', 'User loves hiking', { type: 'interest' })
 * const results = await memory.search('user:123', 'outdoor activities')
 * ```
 */
export class MemoryService {
  private readonly prisma: PrismaClientLike
  private readonly embeddingApiKey: string
  private readonly embeddingModel: string
  private readonly defaultNamespace?: string

  constructor(options: MemoryServiceOptions) {
    this.prisma = options.prisma
    this.embeddingApiKey = options.embeddingApiKey
    this.embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.defaultNamespace = options.defaultNamespace
  }

  /**
   * Store a new memory with auto-generated embedding.
   *
   * @param namespace - Isolation key (e.g., 'user:123', 'project:456')
   * @param content - The text content to store and embed
   * @param metadata - Optional metadata (type, tags, source, importance, expiresAt)
   * @returns The created Memory object
   */
  async store(
    namespace: string | undefined,
    content: string,
    metadata?: MemoryMetadata
  ): Promise<Memory> {
    const ns = this.resolveNamespace(namespace)
    const truncatedContent = this.truncateContent(content)

    try {
      const embedding = await this.generateEmbedding(truncatedContent)
      const embeddingStr = `[${embedding.join(',')}]`

      // Use raw query to insert with vector - all values are parameterized
      const result = await this.prisma.$queryRaw<Memory[]>`
        INSERT INTO "Memory" (
          id, namespace, content, embedding, type, tags, source,
          importance, "expiresAt", "lastMentionedAt", "mentionCount",
          "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text,
          ${ns},
          ${truncatedContent},
          ${embeddingStr}::vector,
          ${metadata?.type ?? null},
          ${metadata?.tags ?? []},
          ${metadata?.source ?? null},
          ${metadata?.importance ?? null},
          ${metadata?.expiresAt ?? null},
          NULL,
          0,
          NOW(),
          NOW()
        )
        RETURNING id, namespace, content, type, tags, source, importance,
          "expiresAt", "lastMentionedAt", "mentionCount", "createdAt", "updatedAt"
      `

      return result[0]
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('store', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Store multiple memories in a batch (more efficient than individual calls).
   *
   * @param namespace - Isolation key for all memories
   * @param items - Array of content and metadata to store
   * @returns Array of created Memory objects
   */
  async storeMany(
    namespace: string | undefined,
    items: CreateMemory[]
  ): Promise<Memory[]> {
    const ns = this.resolveNamespace(namespace)

    if (items.length === 0) return []

    try {
      // Generate all embeddings in batch
      const contents = items.map((item) => this.truncateContent(item.content))
      const embeddings = await this.generateEmbeddings(contents)

      // Insert all memories
      const memories: Memory[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const embeddingStr = `[${embeddings[i].join(',')}]`

        const result = await this.prisma.$queryRaw<Memory[]>`
          INSERT INTO "Memory" (
            id, namespace, content, embedding, type, tags, source,
            importance, "expiresAt", "lastMentionedAt", "mentionCount",
            "createdAt", "updatedAt"
          )
          VALUES (
            gen_random_uuid()::text,
            ${ns},
            ${contents[i]},
            ${embeddingStr}::vector,
            ${item.metadata?.type ?? null},
            ${item.metadata?.tags ?? []},
            ${item.metadata?.source ?? null},
            ${item.metadata?.importance ?? null},
            ${item.metadata?.expiresAt ?? null},
            NULL,
            0,
            NOW(),
            NOW()
          )
          RETURNING id, namespace, content, type, tags, source, importance,
            "expiresAt", "lastMentionedAt", "mentionCount", "createdAt", "updatedAt"
        `
        memories.push(result[0])
      }

      return memories
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('storeMany', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Find memories semantically similar to a query.
   *
   * @param namespace - Isolation key to search within
   * @param query - The text query to find similar memories for
   * @param options - Search options (limit, maxDistance, filters)
   * @returns Array of memories with similarity scores
   */
  async search(
    namespace: string | undefined,
    query: string,
    options?: SearchOptions
  ): Promise<MemorySearchResult[]> {
    const ns = this.resolveNamespace(namespace)
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
    const maxDistance = options?.maxDistance ?? DEFAULT_MAX_DISTANCE

    try {
      const embedding = await this.generateEmbedding(query)
      const embeddingStr = `[${embedding.join(',')}]`

      // Build WHERE conditions using sql tagged template for safe parameterization
      const conditions: Sql[] = [
        sql`namespace = ${ns}`,
      ]

      if (options?.types?.length) {
        // Use sqlJoin for safe IN clause
        conditions.push(sql`type IN (${sqlJoin(options.types)})`)
      }

      if (options?.tags?.length) {
        // PostgreSQL array containment - cast the parameter array to text[]
        conditions.push(sql`tags @> ${options.tags}::text[]`)
      }

      if (options?.minImportance !== undefined) {
        conditions.push(sql`importance >= ${options.minImportance}`)
      }

      if (options?.excludeMentionedWithin !== undefined) {
        const hoursAgo = new Date(Date.now() - options.excludeMentionedWithin * 60 * 60 * 1000)
        conditions.push(
          sql`("lastMentionedAt" IS NULL OR "lastMentionedAt" < ${hoursAgo})`
        )
      }

      // Exclude expired memories
      conditions.push(sql`("expiresAt" IS NULL OR "expiresAt" > NOW())`)

      // Join all conditions with AND using sqlJoin
      const whereClause = sqlJoin(conditions, ' AND ')

      // Perform vector similarity search with fully parameterized query
      const results = await this.prisma.$queryRaw<RawSearchResult[]>`
        SELECT
          id, content, type, tags, source, importance,
          embedding <=> ${embeddingStr}::vector as distance,
          "createdAt", "lastMentionedAt", "mentionCount"
        FROM "Memory"
        WHERE ${whereClause}
          AND embedding <=> ${embeddingStr}::vector < ${maxDistance}
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
      `

      return results.map((r) => ({
        id: r.id,
        content: r.content,
        type: r.type,
        tags: r.tags,
        source: r.source,
        importance: r.importance,
        distance: r.distance,
        createdAt: r.createdAt,
        lastMentionedAt: r.lastMentionedAt,
        mentionCount: r.mentionCount,
      }))
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('search', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Retrieve a specific memory by ID.
   *
   * @param id - The memory ID
   * @returns The memory or null if not found
   */
  async get(id: string): Promise<Memory | null> {
    try {
      return await this.prisma.memory.findUnique({ where: { id } })
    } catch (error) {
      throw new DatabaseError('get', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Update a memory's metadata (does not re-embed content).
   *
   * @param id - The memory ID
   * @param updates - Fields to update
   * @returns The updated memory
   * @throws NotFoundError if memory doesn't exist
   */
  async update(id: string, updates: MemoryUpdate): Promise<Memory> {
    try {
      const existing = await this.prisma.memory.findUnique({ where: { id } })
      if (!existing) {
        throw new NotFoundError(id)
      }

      return await this.prisma.memory.update({
        where: { id },
        data: {
          type: updates.type,
          tags: updates.tags,
          importance: updates.importance,
          expiresAt: updates.expiresAt,
        },
      })
    } catch (error) {
      if (error instanceof NotFoundError) throw error
      throw new DatabaseError('update', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Delete a specific memory.
   *
   * @param id - The memory ID
   */
  async delete(id: string): Promise<void> {
    try {
      await this.prisma.memory.delete({ where: { id } })
    } catch (error) {
      throw new DatabaseError('delete', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Record that a memory was used/mentioned.
   * Updates lastMentionedAt and increments mentionCount.
   *
   * @param id - The memory ID
   */
  async recordMention(id: string): Promise<void> {
    try {
      await this.prisma.$queryRaw`
        UPDATE "Memory"
        SET "lastMentionedAt" = NOW(),
            "mentionCount" = "mentionCount" + 1,
            "updatedAt" = NOW()
        WHERE id = ${id}
      `
    } catch (error) {
      throw new DatabaseError('recordMention', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Delete all memories in a namespace.
   *
   * @param namespace - The namespace to clear
   * @returns Count of deleted memories
   */
  async deleteByNamespace(namespace: string): Promise<number> {
    try {
      const result = await this.prisma.memory.deleteMany({
        where: { namespace },
      })
      return result.count
    } catch (error) {
      throw new DatabaseError('deleteByNamespace', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Delete all memories from a specific source.
   *
   * @param namespace - The namespace
   * @param source - The source identifier
   * @returns Count of deleted memories
   */
  async deleteBySource(namespace: string, source: string): Promise<number> {
    try {
      const result = await this.prisma.memory.deleteMany({
        where: { namespace, source },
      })
      return result.count
    } catch (error) {
      throw new DatabaseError('deleteBySource', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Delete all memories past their expiresAt timestamp.
   *
   * @returns Count of deleted memories
   */
  async pruneExpired(): Promise<number> {
    try {
      const result = await this.prisma.memory.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
        },
      })
      return result.count
    } catch (error) {
      throw new DatabaseError('pruneExpired', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Get statistics for a namespace.
   *
   * @param namespace - The namespace
   * @returns Statistics about the memories
   */
  async getStats(namespace: string): Promise<NamespaceStats> {
    try {
      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      // Get total count
      const totalMemories = await this.prisma.memory.count({
        where: { namespace },
      })

      // Get counts by type
      const typeGroups = await this.prisma.memory.groupBy({
        by: ['type'],
        where: { namespace },
        _count: { _all: true },
      })

      const byType: Record<string, number> = {}
      for (const group of typeGroups) {
        const key = group.type ?? 'null'
        byType[key] = group._count._all
      }

      // Get date range
      const memories = await this.prisma.memory.findMany({
        where: { namespace },
        orderBy: { createdAt: 'asc' },
        take: 1,
      })
      const oldestMemory = memories[0]?.createdAt ?? null

      const newestMemories = await this.prisma.memory.findMany({
        where: { namespace },
        orderBy: { createdAt: 'desc' },
        take: 1,
      })
      const newestMemory = newestMemories[0]?.createdAt ?? null

      // Count expiring within 7 days
      const expiringWithin7Days = await this.prisma.memory.count({
        where: {
          namespace,
          expiresAt: { lt: sevenDaysFromNow },
        },
      })

      return {
        totalMemories,
        byType,
        oldestMemory,
        newestMemory,
        expiringWithin7Days,
      }
    } catch (error) {
      throw new DatabaseError('getStats', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Resolve namespace, using default if not provided.
   */
  private resolveNamespace(namespace: string | undefined): string {
    const ns = namespace ?? this.defaultNamespace
    if (!ns) {
      throw new NamespaceRequiredError()
    }
    return ns
  }

  /**
   * Truncate content to max token limit (rough approximation).
   */
  private truncateContent(content: string): string {
    // Rough estimate: 1 token ~= 4 characters for English text
    const maxChars = MAX_CONTENT_TOKENS * 4
    if (content.length <= maxChars) return content
    return content.slice(0, maxChars)
  }

  /**
   * Generate embedding for a single text.
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text])
    return embeddings[0]
  }

  /**
   * Generate embeddings for multiple texts in batch.
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.embeddingApiKey}`,
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: texts,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new EmbeddingError(`OpenAI API error: ${response.status} - ${errorText}`)
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>
      }

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index)
      return sorted.map((d) => d.embedding)
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new EmbeddingError(
        'Failed to generate embedding',
        error instanceof Error ? error : undefined
      )
    }
  }
}
