import type {
  Memory,
  MemoryMetadata,
  MemoryUpdate,
  CreateMemory,
  SearchOptions,
  ListOptions,
  MemorySearchResult,
  CrossNamespaceSearchResult,
  NamespaceStats,
  IMemoryService,
} from './types'
import { NotFoundError, NamespaceRequiredError } from './errors'
import { resolveListPagination } from './pagination'

/**
 * Configuration options for MockMemoryService
 */
export interface MockMemoryServiceOptions {
  /** Default namespace if not specified per-call */
  defaultNamespace?: string
  /** Optional: provide custom mock embedding function for testing vector search behavior */
  mockEmbeddingFn?: (text: string) => number[]
}

interface InternalMemory extends Memory {
  embedding: number[]
}

/**
 * In-memory implementation of MemoryService for unit testing.
 *
 * This mock uses a deterministic hash-based embedding function and cosine
 * similarity for search ranking, allowing tests to verify search behavior
 * without requiring a real database or OpenAI API.
 *
 * @example
 * ```typescript
 * const memory = new MockMemoryService({ defaultNamespace: 'test' })
 * await memory.store(undefined, 'User likes coffee')
 * const results = await memory.search(undefined, 'coffee preferences')
 * memory.clear() // Reset between tests
 * ```
 */
export class MockMemoryService implements IMemoryService {
  private memories: Map<string, InternalMemory> = new Map()
  private idCounter = 0
  private readonly defaultNamespace?: string
  private readonly mockEmbeddingFn: (text: string) => number[]

  constructor(options: MockMemoryServiceOptions = {}) {
    this.defaultNamespace = options.defaultNamespace
    this.mockEmbeddingFn = options.mockEmbeddingFn ?? this.defaultMockEmbedding.bind(this)
  }

  /**
   * Simple deterministic embedding based on character codes.
   * Produces consistent embeddings for the same input text.
   */
  private defaultMockEmbedding(text: string): number[] {
    const embedding = new Array(1536).fill(0)
    const normalizedText = text.toLowerCase()

    for (let i = 0; i < normalizedText.length; i++) {
      const charCode = normalizedText.charCodeAt(i)
      // Distribute character influence across embedding dimensions
      const baseIdx = (charCode * 7) % 1536
      embedding[baseIdx] += charCode / 1000
      embedding[(baseIdx + 1) % 1536] += charCode / 2000
      embedding[(baseIdx + 2) % 1536] += charCode / 3000
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)) || 1
    return embedding.map((v) => v / magnitude)
  }

  /**
   * Calculate cosine similarity between two vectors.
   * Returns value between -1 and 1 (1 = identical).
   */
  private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i]
      normA += vectorA[i] * vectorA[i]
      normB += vectorB[i] * vectorB[i]
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB)
    return denominator === 0 ? 0 : dotProduct / denominator
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
   * Generate a unique mock ID.
   */
  private generateId(): string {
    return `mock-${++this.idCounter}`
  }

  /**
   * Convert internal memory to public Memory type (strips embedding).
   */
  private toPublicMemory(internal: InternalMemory): Memory {
    const { embedding: _embedding, ...memory } = internal
    return memory
  }

  /**
   * Store a new memory with mock embedding.
   */
  async store(
    namespace: string | undefined,
    content: string,
    metadata?: MemoryMetadata
  ): Promise<Memory> {
    const ns = this.resolveNamespace(namespace)
    const now = new Date()
    const id = this.generateId()
    const embedding = this.mockEmbeddingFn(content)

    const memory: InternalMemory = {
      id,
      namespace: ns,
      content,
      embedding,
      type: metadata?.type ?? null,
      tags: metadata?.tags ?? [],
      source: metadata?.source ?? null,
      importance: metadata?.importance ?? null,
      expiresAt: metadata?.expiresAt ?? null,
      lastMentionedAt: null,
      mentionCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    this.memories.set(id, memory)
    return this.toPublicMemory(memory)
  }

  /**
   * Store multiple memories in a batch.
   */
  async storeMany(
    namespace: string | undefined,
    items: CreateMemory[]
  ): Promise<Memory[]> {
    const results: Memory[] = []
    for (const item of items) {
      results.push(await this.store(namespace, item.content, item.metadata))
    }
    return results
  }

  /**
   * Find memories semantically similar to a query.
   */
  async search(
    namespace: string | undefined,
    query: string,
    options?: SearchOptions
  ): Promise<MemorySearchResult[]> {
    const ns = this.resolveNamespace(namespace)
    const limit = options?.limit ?? 10
    const maxDistance = options?.maxDistance ?? 0.5
    const queryEmbedding = this.mockEmbeddingFn(query)
    const now = new Date()

    const candidates = Array.from(this.memories.values())
      .filter((memory) => {
        // Namespace filter
        if (memory.namespace !== ns) return false

        // Type filter
        if (options?.types?.length) {
          if (memory.type === null || !options.types.includes(memory.type)) {
            return false
          }
        }

        // Tags filter (must have ALL specified tags)
        if (options?.tags?.length) {
          if (!options.tags.every((tag) => memory.tags.includes(tag))) {
            return false
          }
        }

        // Importance filter
        if (options?.minImportance !== undefined) {
          if (memory.importance === null || memory.importance < options.minImportance) {
            return false
          }
        }

        // Exclude recently mentioned
        if (options?.excludeMentionedWithin !== undefined && memory.lastMentionedAt) {
          const hoursAgo = new Date(
            now.getTime() - options.excludeMentionedWithin * 60 * 60 * 1000
          )
          if (memory.lastMentionedAt >= hoursAgo) {
            return false
          }
        }

        // Exclude expired
        if (memory.expiresAt && memory.expiresAt < now) {
          return false
        }

        return true
      })
      .map((memory) => {
        // Convert cosine similarity to distance (lower = more similar)
        const similarity = this.cosineSimilarity(queryEmbedding, memory.embedding)
        const distance = 1 - similarity

        // Compute decay multiplier if configured
        let adjustedDistance = distance
        if (options?.decayOptions) {
          const halfLifeMs = options.decayOptions.halfLifeHours * 60 * 60 * 1000
          const referenceTime = options.decayOptions.reinforceOnMention && memory.lastMentionedAt
            ? memory.lastMentionedAt
            : memory.createdAt
          const ageMs = Math.max(0, now.getTime() - referenceTime.getTime())
          // Matches SQL: distance * exp(ln(2) * age / halfLife)
          adjustedDistance = distance * Math.exp(Math.LN2 * ageMs / halfLifeMs)
        }

        return { memory, distance, adjustedDistance }
      })
      .filter((result) => result.distance < maxDistance)
      .sort((a, b) => a.adjustedDistance - b.adjustedDistance)
      .slice(0, limit)

    return candidates.map(({ memory, distance }) => ({
      id: memory.id,
      content: memory.content,
      type: memory.type,
      tags: memory.tags,
      source: memory.source,
      importance: memory.importance,
      distance,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      lastMentionedAt: memory.lastMentionedAt,
      mentionCount: memory.mentionCount,
    }))
  }

  /**
   * Search across multiple namespaces in a single pass.
   * Note: mock uses deterministic hash-based embeddings, so cross-namespace
   * ordering is consistent but semantically meaningless.
   */
  async searchAcross(
    namespaces: string[],
    query: string,
    options?: SearchOptions
  ): Promise<CrossNamespaceSearchResult[]> {
    if (namespaces.length === 0) return []

    const limit = options?.limit ?? 10
    const maxDistance = options?.maxDistance ?? 0.5
    const queryEmbedding = this.mockEmbeddingFn(query)
    const now = new Date()

    const candidates = Array.from(this.memories.values())
      .filter((memory) => {
        if (!namespaces.includes(memory.namespace)) return false

        if (options?.types?.length) {
          if (memory.type === null || !options.types.includes(memory.type)) return false
        }

        if (options?.tags?.length) {
          if (!options.tags.every((tag) => memory.tags.includes(tag))) return false
        }

        if (options?.minImportance !== undefined) {
          if (memory.importance === null || memory.importance < options.minImportance) return false
        }

        if (options?.excludeMentionedWithin !== undefined && memory.lastMentionedAt) {
          const hoursAgo = new Date(
            now.getTime() - options.excludeMentionedWithin * 60 * 60 * 1000
          )
          if (memory.lastMentionedAt >= hoursAgo) return false
        }

        if (memory.expiresAt && memory.expiresAt < now) return false

        return true
      })
      .map((memory) => {
        const similarity = this.cosineSimilarity(queryEmbedding, memory.embedding)
        const distance = 1 - similarity

        let adjustedDistance = distance
        if (options?.decayOptions) {
          const halfLifeMs = options.decayOptions.halfLifeHours * 60 * 60 * 1000
          const referenceTime = options.decayOptions.reinforceOnMention && memory.lastMentionedAt
            ? memory.lastMentionedAt
            : memory.createdAt
          const ageMs = Math.max(0, now.getTime() - referenceTime.getTime())
          adjustedDistance = distance * Math.exp(Math.LN2 * ageMs / halfLifeMs)
        }

        return { memory, distance, adjustedDistance }
      })
      .filter((result) => result.distance < maxDistance)
      .sort((a, b) => a.adjustedDistance - b.adjustedDistance)
      .slice(0, limit)

    return candidates.map(({ memory, distance }) => ({
      id: memory.id,
      namespace: memory.namespace,
      content: memory.content,
      type: memory.type,
      tags: memory.tags,
      source: memory.source,
      importance: memory.importance,
      distance,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      lastMentionedAt: memory.lastMentionedAt,
      mentionCount: memory.mentionCount,
    }))
  }

  /**
   * Non-semantic browse/enumerate within a single namespace.
   *
   * Mirrors {@link MemoryService.list}: same tag ALL-of rule, same expiry
   * exclusion, same NULLS LAST ordering, and the same pagination clamping
   * (shared via `resolveListPagination`). Returns the public `Memory` type
   * (no `distance`).
   *
   * One deliberate limit on that parity: ties on the sort key break on `id`
   * ascending, which makes each implementation deterministic across repeated
   * calls but not identical to the other — real ids are `gen_random_uuid()`
   * while mock ids are `mock-N`, so tied rows can order differently here than
   * in Postgres. Don't assert cross-implementation ordering on tied keys.
   */
  async list(
    namespace: string | undefined,
    options?: ListOptions
  ): Promise<Memory[]> {
    const ns = this.resolveNamespace(namespace)
    const now = new Date()

    // Filter with the same predicates as the real WHERE clause.
    const filtered = Array.from(this.memories.values()).filter((memory) => {
      if (memory.namespace !== ns) return false

      if (options?.types?.length) {
        if (memory.type === null || !options.types.includes(memory.type)) return false
      }

      if (options?.tags?.length) {
        if (!options.tags.every((tag) => memory.tags.includes(tag))) return false
      }

      if (options?.minImportance !== undefined) {
        if (memory.importance === null || memory.importance < options.minImportance) return false
      }

      if (options?.source !== undefined) {
        if (memory.source !== options.source) return false
      }

      // Exclude expired unless explicitly requested
      if (!options?.includeExpired && memory.expiresAt && memory.expiresAt < now) {
        return false
      }

      return true
    })

    // Resolve the sort key for a row. Dates are compared by their numeric value.
    const orderBy = options?.orderBy ?? 'createdAt'
    const sortKey = (memory: InternalMemory): number | null => {
      switch (orderBy) {
        case 'importance':
          return memory.importance
        case 'lastMentionedAt':
          return memory.lastMentionedAt ? memory.lastMentionedAt.getTime() : null
        case 'updatedAt':
          return memory.updatedAt.getTime()
        case 'createdAt':
        default:
          return memory.createdAt.getTime()
      }
    }

    const ascending = options?.direction === 'asc'

    const sorted = filtered.sort((a, b) => {
      const keyA = sortKey(a)
      const keyB = sortKey(b)

      // NULLS LAST: null always sorts after non-null, regardless of direction.
      if (keyA === null && keyB === null) {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      }
      if (keyA === null) return 1
      if (keyB === null) return -1

      if (keyA !== keyB) {
        return ascending ? keyA - keyB : keyB - keyA
      }

      // Stable tiebreak: id ascending (string compare).
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    // Shared with the real service so clamping cannot drift between the two
    const { limit, offset } = resolveListPagination(options)

    return sorted.slice(offset, offset + limit).map((memory) => this.toPublicMemory(memory))
  }

  /**
   * Retrieve a specific memory by ID.
   */
  async get(id: string): Promise<Memory | null> {
    const memory = this.memories.get(id)
    return memory ? this.toPublicMemory(memory) : null
  }

  /**
   * Update a memory's metadata.
   */
  async update(id: string, updates: MemoryUpdate): Promise<Memory> {
    const memory = this.memories.get(id)
    if (!memory) {
      throw new NotFoundError(id)
    }

    if (updates.type !== undefined) memory.type = updates.type
    if (updates.tags !== undefined) memory.tags = updates.tags
    if (updates.importance !== undefined) memory.importance = updates.importance
    if (updates.expiresAt !== undefined) memory.expiresAt = updates.expiresAt
    memory.updatedAt = new Date()

    return this.toPublicMemory(memory)
  }

  /**
   * Update a memory's content with re-embedding, and optionally update metadata.
   * Preserves createdAt. Does not touch mentionCount or lastMentionedAt.
   */
  async updateContent(
    id: string,
    content: string,
    metadata?: MemoryUpdate
  ): Promise<Memory> {
    const memory = this.memories.get(id)
    if (!memory) {
      throw new NotFoundError(id)
    }

    memory.content = content
    memory.embedding = this.mockEmbeddingFn(content)
    memory.updatedAt = new Date()

    if (metadata?.type !== undefined) memory.type = metadata.type
    if (metadata?.tags !== undefined) memory.tags = metadata.tags
    if (metadata?.importance !== undefined) memory.importance = metadata.importance
    if (metadata?.expiresAt !== undefined) memory.expiresAt = metadata.expiresAt

    return this.toPublicMemory(memory)
  }

  /**
   * Insert or update a memory by namespace + key.
   * The key maps to the `source` field. Uses COALESCE logic for metadata.
   */
  async upsert(
    namespace: string | undefined,
    key: string,
    content: string,
    metadata?: Omit<MemoryMetadata, 'source'>
  ): Promise<Memory> {
    const ns = this.resolveNamespace(namespace)

    // Find existing by namespace + source (key)
    const existing = Array.from(this.memories.values()).find(
      (m) => m.namespace === ns && m.source === key
    )

    if (existing) {
      // Update in place — COALESCE: only overwrite if provided
      existing.content = content
      existing.embedding = this.mockEmbeddingFn(content)
      if (metadata?.type !== undefined) existing.type = metadata.type
      if (metadata?.tags !== undefined && metadata.tags.length > 0) existing.tags = metadata.tags
      if (metadata?.importance !== undefined) existing.importance = metadata.importance
      if (metadata?.expiresAt !== undefined) existing.expiresAt = metadata.expiresAt
      existing.updatedAt = new Date()
      // Preserve: id, createdAt, mentionCount, lastMentionedAt
      return this.toPublicMemory(existing)
    } else {
      // Create new
      return this.store(ns, content, {
        ...metadata,
        source: key,
      })
    }
  }

  /**
   * Delete a specific memory.
   */
  async delete(id: string): Promise<void> {
    this.memories.delete(id)
  }

  /**
   * Record that a memory was used/mentioned.
   */
  async recordMention(id: string): Promise<void> {
    const memory = this.memories.get(id)
    if (memory) {
      memory.lastMentionedAt = new Date()
      memory.mentionCount++
      memory.updatedAt = new Date()
    }
  }

  /**
   * Delete all memories in a namespace.
   */
  async deleteByNamespace(namespace: string): Promise<number> {
    let count = 0
    for (const [id, memory] of this.memories) {
      if (memory.namespace === namespace) {
        this.memories.delete(id)
        count++
      }
    }
    return count
  }

  /**
   * Delete all memories from a specific source.
   */
  async deleteBySource(namespace: string, source: string): Promise<number> {
    let count = 0
    for (const [id, memory] of this.memories) {
      if (memory.namespace === namespace && memory.source === source) {
        this.memories.delete(id)
        count++
      }
    }
    return count
  }

  /**
   * Delete all memories past their expiresAt timestamp.
   */
  async pruneExpired(): Promise<number> {
    const now = new Date()
    let count = 0
    for (const [id, memory] of this.memories) {
      if (memory.expiresAt && memory.expiresAt < now) {
        this.memories.delete(id)
        count++
      }
    }
    return count
  }

  /**
   * Get statistics for a namespace.
   */
  async getStats(namespace: string): Promise<NamespaceStats> {
    const namespaceMemories = Array.from(this.memories.values()).filter(
      (m) => m.namespace === namespace
    )
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const byType: Record<string, number> = {}
    let oldest: Date | null = null
    let newest: Date | null = null
    let expiringCount = 0

    for (const memory of namespaceMemories) {
      const key = memory.type ?? 'null'
      byType[key] = (byType[key] ?? 0) + 1

      if (!oldest || memory.createdAt < oldest) oldest = memory.createdAt
      if (!newest || memory.createdAt > newest) newest = memory.createdAt

      if (memory.expiresAt && memory.expiresAt < sevenDaysFromNow) {
        expiringCount++
      }
    }

    return {
      totalMemories: namespaceMemories.length,
      byType,
      oldestMemory: oldest,
      newestMemory: newest,
      expiringWithin7Days: expiringCount,
    }
  }

  /**
   * List distinct namespaces, optionally filtered by prefix.
   */
  async listNamespaces(prefix?: string): Promise<string[]> {
    const namespaces = new Set<string>()
    for (const memory of this.memories.values()) {
      if (!prefix || memory.namespace.startsWith(prefix)) {
        namespaces.add(memory.namespace)
      }
    }
    return Array.from(namespaces).sort()
  }

  /**
   * Get statistics for multiple namespaces in a single call.
   */
  async getStatsMulti(namespaces: string[]): Promise<Map<string, NamespaceStats>> {
    const result = new Map<string, NamespaceStats>()
    for (const ns of namespaces) {
      result.set(ns, await this.getStats(ns))
    }
    return result
  }

  /**
   * Clear all memories. Useful for test cleanup.
   */
  clear(): void {
    this.memories.clear()
    this.idCounter = 0
  }

  /**
   * Get total count of memories (useful for test assertions).
   */
  get size(): number {
    return this.memories.size
  }
}
