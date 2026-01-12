import type {
  Memory,
  MemoryMetadata,
  MemoryUpdate,
  CreateMemory,
  SearchOptions,
  MemorySearchResult,
  NamespaceStats,
} from './types'
import { NotFoundError, NamespaceRequiredError } from './errors'

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
export class MockMemoryService {
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
        return { memory, distance }
      })
      .filter((result) => result.distance < maxDistance)
      .sort((a, b) => a.distance - b.distance)
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
      lastMentionedAt: memory.lastMentionedAt,
      mentionCount: memory.mentionCount,
    }))
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
