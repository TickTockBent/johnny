import { Sql, sqlJoin, sql } from './prisma-runtime-compat'
import type {
  MemoryServiceOptions,
  PrismaClientLike,
  Memory,
  MemoryMetadata,
  MemoryUpdate,
  CreateMemory,
  SearchOptions,
  MemorySearchResult,
  CrossNamespaceSearchResult,
  NamespaceStats,
  RawSearchResult,
  IMemoryService,
} from './types'
import type { EmbeddingProvider } from './EmbeddingProvider'
import { OpenAIEmbeddingProvider } from './EmbeddingProvider'
import {
  EmbeddingError,
  NotFoundError,
  NamespaceRequiredError,
  DatabaseError,
} from './errors'

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
export class MemoryService implements IMemoryService {
  private readonly prisma: PrismaClientLike
  private readonly embeddingProvider: EmbeddingProvider
  private readonly defaultNamespace?: string

  constructor(options: MemoryServiceOptions) {
    this.prisma = options.prisma
    this.defaultNamespace = options.defaultNamespace

    if (options.embeddingProvider) {
      this.embeddingProvider = options.embeddingProvider
    } else if (options.embeddingApiKey) {
      this.embeddingProvider = new OpenAIEmbeddingProvider({
        apiKey: options.embeddingApiKey,
        model: options.embeddingModel,
      })
    } else {
      throw new Error('Either embeddingProvider or embeddingApiKey must be provided')
    }
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

      // Chunk to respect Postgres ~65535 parameter limit (~13 params per row)
      const CHUNK_SIZE = 5000
      const allMemories: Memory[] = []

      for (let chunkStart = 0; chunkStart < items.length; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, items.length)

        // Build multi-row VALUES clause using sql template tags
        const valueRows = []
        for (let i = chunkStart; i < chunkEnd; i++) {
          const item = items[i]
          const embeddingStr = `[${embeddings[i].join(',')}]`

          valueRows.push(sql`(
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
          )`)
        }

        const result = await this.prisma.$queryRaw<Memory[]>`
          INSERT INTO "Memory" (
            id, namespace, content, embedding, type, tags, source,
            importance, "expiresAt", "lastMentionedAt", "mentionCount",
            "createdAt", "updatedAt"
          )
          VALUES ${sqlJoin(valueRows)}
          RETURNING id, namespace, content, type, tags, source, importance,
            "expiresAt", "lastMentionedAt", "mentionCount", "createdAt", "updatedAt"
        `

        allMemories.push(...result)
      }

      return allMemories
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

      // Build order expression — apply decay if configured
      let orderExpression: Sql
      if (options?.decayOptions) {
        const halfLife = options.decayOptions.halfLifeHours
        const ageReference = options.decayOptions.reinforceOnMention
          ? sql`COALESCE("lastMentionedAt", "createdAt")`
          : sql`"createdAt"`
        // adjusted_distance = distance * exp(ln(2) * age_hours / halfLife)
        // GREATEST(0, ...) guards against future timestamps
        orderExpression = sql`(embedding <=> ${embeddingStr}::vector) * exp(ln(2) * GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${ageReference})) / 3600.0) / ${halfLife})`
      } else {
        orderExpression = sql`embedding <=> ${embeddingStr}::vector`
      }

      // Perform vector similarity search with fully parameterized query
      const results = await this.prisma.$queryRaw<RawSearchResult[]>`
        SELECT
          id, content, type, tags, source, importance,
          embedding <=> ${embeddingStr}::vector as distance,
          "createdAt", "updatedAt", "lastMentionedAt", "mentionCount"
        FROM "Memory"
        WHERE ${whereClause}
          AND embedding <=> ${embeddingStr}::vector < ${maxDistance}
        ORDER BY ${orderExpression}
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
        updatedAt: r.updatedAt,
        lastMentionedAt: r.lastMentionedAt,
        mentionCount: r.mentionCount,
      }))
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('search', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Search across multiple namespaces in a single query.
   *
   * @param namespaces - Array of namespaces to search within
   * @param query - The text query to find similar memories for
   * @param options - Search options (limit, maxDistance, filters)
   * @returns Array of memories with similarity scores and namespace
   */
  async searchAcross(
    namespaces: string[],
    query: string,
    options?: SearchOptions
  ): Promise<CrossNamespaceSearchResult[]> {
    if (namespaces.length === 0) return []

    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
    const maxDistance = options?.maxDistance ?? DEFAULT_MAX_DISTANCE

    try {
      const embedding = await this.generateEmbedding(query)
      const embeddingStr = `[${embedding.join(',')}]`

      const conditions: Sql[] = [
        sql`namespace IN (${sqlJoin(namespaces)})`,
      ]

      if (options?.types?.length) {
        conditions.push(sql`type IN (${sqlJoin(options.types)})`)
      }

      if (options?.tags?.length) {
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

      conditions.push(sql`("expiresAt" IS NULL OR "expiresAt" > NOW())`)

      const whereClause = sqlJoin(conditions, ' AND ')

      // Build order expression — apply decay if configured
      let orderExpression: Sql
      if (options?.decayOptions) {
        const halfLife = options.decayOptions.halfLifeHours
        const ageReference = options.decayOptions.reinforceOnMention
          ? sql`COALESCE("lastMentionedAt", "createdAt")`
          : sql`"createdAt"`
        orderExpression = sql`(embedding <=> ${embeddingStr}::vector) * exp(ln(2) * GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${ageReference})) / 3600.0) / ${halfLife})`
      } else {
        orderExpression = sql`embedding <=> ${embeddingStr}::vector`
      }

      const results = await this.prisma.$queryRaw<(RawSearchResult & { namespace: string })[]>`
        SELECT
          id, namespace, content, type, tags, source, importance,
          embedding <=> ${embeddingStr}::vector as distance,
          "createdAt", "updatedAt", "lastMentionedAt", "mentionCount"
        FROM "Memory"
        WHERE ${whereClause}
          AND embedding <=> ${embeddingStr}::vector < ${maxDistance}
        ORDER BY ${orderExpression}
        LIMIT ${limit}
      `

      return results.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        content: r.content,
        type: r.type,
        tags: r.tags,
        source: r.source,
        importance: r.importance,
        distance: r.distance,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastMentionedAt: r.lastMentionedAt,
        mentionCount: r.mentionCount,
      }))
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('searchAcross', error instanceof Error ? error : undefined)
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
   * Update a memory's content with re-embedding, and optionally update metadata.
   * Preserves createdAt. Does not touch mentionCount or lastMentionedAt.
   *
   * @param id - The memory ID
   * @param content - New content text (will be re-embedded)
   * @param metadata - Optional metadata fields to update
   * @returns The updated memory
   * @throws NotFoundError if memory doesn't exist
   */
  async updateContent(
    id: string,
    content: string,
    metadata?: MemoryUpdate
  ): Promise<Memory> {
    try {
      const existing = await this.prisma.memory.findUnique({ where: { id } })
      if (!existing) {
        throw new NotFoundError(id)
      }

      const truncatedContent = this.truncateContent(content)
      const embedding = await this.generateEmbedding(truncatedContent)
      const embeddingStr = `[${embedding.join(',')}]`

      // Build SET clauses dynamically
      const setClauses: Sql[] = [
        sql`content = ${truncatedContent}`,
        sql`embedding = ${embeddingStr}::vector`,
        sql`"updatedAt" = NOW()`,
      ]

      if (metadata?.type !== undefined) {
        setClauses.push(sql`type = ${metadata.type}`)
      }
      if (metadata?.tags !== undefined) {
        setClauses.push(sql`tags = ${metadata.tags}::text[]`)
      }
      if (metadata?.importance !== undefined) {
        setClauses.push(sql`importance = ${metadata.importance}`)
      }
      if (metadata?.expiresAt !== undefined) {
        setClauses.push(sql`"expiresAt" = ${metadata.expiresAt}`)
      }

      const result = await this.prisma.$queryRaw<Memory[]>`
        UPDATE "Memory"
        SET ${sqlJoin(setClauses)}
        WHERE id = ${id}
        RETURNING id, namespace, content, type, tags, source, importance,
          "expiresAt", "lastMentionedAt", "mentionCount", "createdAt", "updatedAt"
      `

      return result[0]
    } catch (error) {
      if (error instanceof NotFoundError) throw error
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('updateContent', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Insert or update a memory by namespace + key.
   * The key maps to the `source` field. If a memory with the same
   * namespace and source exists, its content and embedding are replaced.
   * Metadata fields use COALESCE — only provided values overwrite existing ones.
   *
   * @param namespace - Isolation key
   * @param key - Deterministic identifier (stored as `source`)
   * @param content - The text content to store/update
   * @param metadata - Optional metadata (type, tags, importance, expiresAt)
   * @returns The created or updated Memory object
   */
  async upsert(
    namespace: string | undefined,
    key: string,
    content: string,
    metadata?: Omit<MemoryMetadata, 'source'>
  ): Promise<Memory> {
    const ns = this.resolveNamespace(namespace)
    const truncatedContent = this.truncateContent(content)

    try {
      const embedding = await this.generateEmbedding(truncatedContent)
      const embeddingStr = `[${embedding.join(',')}]`

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
          ${key},
          ${metadata?.importance ?? null},
          ${metadata?.expiresAt ?? null},
          NULL,
          0,
          NOW(),
          NOW()
        )
        ON CONFLICT (namespace, source)
        DO UPDATE SET
          content = EXCLUDED.content,
          embedding = EXCLUDED.embedding,
          type = COALESCE(EXCLUDED.type, "Memory".type),
          tags = CASE WHEN EXCLUDED.tags = '{}' THEN "Memory".tags ELSE EXCLUDED.tags END,
          importance = COALESCE(EXCLUDED.importance, "Memory".importance),
          "expiresAt" = COALESCE(EXCLUDED."expiresAt", "Memory"."expiresAt"),
          "updatedAt" = NOW()
        RETURNING id, namespace, content, type, tags, source, importance,
          "expiresAt", "lastMentionedAt", "mentionCount", "createdAt", "updatedAt"
      `

      return result[0]
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new DatabaseError('upsert', error instanceof Error ? error : undefined)
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
   * List distinct namespaces, optionally filtered by prefix.
   *
   * @param prefix - Optional prefix to filter namespaces (e.g., 'user:wes:')
   * @returns Array of namespace strings, sorted alphabetically
   */
  async listNamespaces(prefix?: string): Promise<string[]> {
    try {
      if (prefix) {
        const likePattern = `${prefix}%`
        const results = await this.prisma.$queryRaw<{ namespace: string }[]>`
          SELECT DISTINCT namespace
          FROM "Memory"
          WHERE namespace LIKE ${likePattern}
          ORDER BY namespace
        `
        return results.map((r) => r.namespace)
      } else {
        const results = await this.prisma.$queryRaw<{ namespace: string }[]>`
          SELECT DISTINCT namespace
          FROM "Memory"
          ORDER BY namespace
        `
        return results.map((r) => r.namespace)
      }
    } catch (error) {
      throw new DatabaseError('listNamespaces', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Get statistics for multiple namespaces in a single set of queries.
   *
   * @param namespaces - Array of namespace strings
   * @returns Map of namespace to stats
   */
  async getStatsMulti(namespaces: string[]): Promise<Map<string, NamespaceStats>> {
    if (namespaces.length === 0) return new Map()

    try {
      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      // Single grouped query for counts and date ranges
      const rawStats = await this.prisma.$queryRaw<Array<{
        namespace: string
        total: bigint
        oldest: Date | null
        newest: Date | null
        expiring: bigint
      }>>`
        SELECT
          namespace,
          COUNT(*) as total,
          MIN("createdAt") as oldest,
          MAX("createdAt") as newest,
          COUNT(*) FILTER (WHERE "expiresAt" < ${sevenDaysFromNow}) as expiring
        FROM "Memory"
        WHERE namespace IN (${sqlJoin(namespaces)})
        GROUP BY namespace
      `

      // Get type breakdowns per namespace
      const typeStats = await this.prisma.$queryRaw<Array<{
        namespace: string
        type: string | null
        count: bigint
      }>>`
        SELECT namespace, type, COUNT(*) as count
        FROM "Memory"
        WHERE namespace IN (${sqlJoin(namespaces)})
        GROUP BY namespace, type
      `

      // Assemble results — initialize all requested namespaces
      const result = new Map<string, NamespaceStats>()
      for (const ns of namespaces) {
        result.set(ns, {
          totalMemories: 0,
          byType: {},
          oldestMemory: null,
          newestMemory: null,
          expiringWithin7Days: 0,
        })
      }

      // Fill from raw stats
      for (const row of rawStats) {
        const stats = result.get(row.namespace)
        if (stats) {
          stats.totalMemories = Number(row.total)
          stats.oldestMemory = row.oldest
          stats.newestMemory = row.newest
          stats.expiringWithin7Days = Number(row.expiring)
        }
      }

      // Fill type breakdowns
      for (const row of typeStats) {
        const stats = result.get(row.namespace)
        if (stats) {
          const key = row.type ?? 'null'
          stats.byType[key] = Number(row.count)
        }
      }

      return result
    } catch (error) {
      throw new DatabaseError('getStatsMulti', error instanceof Error ? error : undefined)
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
    const embeddings = await this.embeddingProvider.generateEmbeddings([text])
    return embeddings[0]
  }

  /**
   * Generate embeddings for multiple texts in batch.
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return this.embeddingProvider.generateEmbeddings(texts)
  }
}
