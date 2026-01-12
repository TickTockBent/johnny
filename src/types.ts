/**
 * Configuration options for initializing MemoryService
 */
export interface MemoryServiceOptions {
  /** Your application's Prisma client instance */
  prisma: PrismaClientLike
  /** OpenAI API key for generating embeddings */
  embeddingApiKey: string
  /** Embedding model to use (default: text-embedding-3-small) */
  embeddingModel?: string
  /** Default namespace if not specified per-call */
  defaultNamespace?: string
}

/**
 * Minimal Prisma client interface for type compatibility
 * This allows any Prisma client with a Memory model to work
 */
export interface PrismaClientLike {
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>
  memory: {
    create: (args: { data: MemoryCreateInput }) => Promise<MemoryRecord>
    createMany: (args: { data: MemoryCreateInput[] }) => Promise<{ count: number }>
    findUnique: (args: { where: { id: string } }) => Promise<MemoryRecord | null>
    findMany: (args: MemoryFindManyArgs) => Promise<MemoryRecord[]>
    update: (args: { where: { id: string }; data: Partial<MemoryCreateInput> }) => Promise<MemoryRecord>
    delete: (args: { where: { id: string } }) => Promise<MemoryRecord>
    deleteMany: (args: { where: MemoryWhereInput }) => Promise<{ count: number }>
    count: (args?: { where?: MemoryWhereInput }) => Promise<number>
    groupBy: <T extends MemoryGroupByArgs>(args: T) => Promise<MemoryGroupByResult[]>
  }
}

/** Internal Prisma query types */
export interface MemoryCreateInput {
  id?: string
  namespace: string
  content: string
  type?: string | null
  tags?: string[]
  source?: string | null
  importance?: number | null
  expiresAt?: Date | null
  lastMentionedAt?: Date | null
  mentionCount?: number
}

export interface MemoryWhereInput {
  namespace?: string
  source?: string
  expiresAt?: { lt?: Date }
  id?: { in?: string[] }
}

export interface MemoryFindManyArgs {
  where?: MemoryWhereInput
  orderBy?: Record<string, 'asc' | 'desc'>
  take?: number
}

export interface MemoryGroupByArgs {
  by: string[]
  where?: MemoryWhereInput
  _count?: { _all?: boolean }
  _min?: Record<string, boolean>
  _max?: Record<string, boolean>
}

export interface MemoryGroupByResult {
  type: string | null
  _count: { _all: number }
  _min?: { createdAt?: Date }
  _max?: { createdAt?: Date }
}

/**
 * Raw memory record from database
 */
export interface MemoryRecord {
  id: string
  namespace: string
  content: string
  type: string | null
  tags: string[]
  source: string | null
  importance: number | null
  expiresAt: Date | null
  lastMentionedAt: Date | null
  mentionCount: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Public Memory type returned to consumers
 */
export interface Memory {
  id: string
  namespace: string
  content: string
  type: string | null
  tags: string[]
  source: string | null
  importance: number | null
  expiresAt: Date | null
  lastMentionedAt: Date | null
  mentionCount: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Metadata for creating a new memory
 */
export interface MemoryMetadata {
  /** App-defined category (e.g., 'fact', 'event', 'preference') */
  type?: string
  /** Flexible labels for filtering */
  tags?: string[]
  /** Origin reference (e.g., entryId, docId) */
  source?: string
  /** Ranking signal (0-1) */
  importance?: number
  /** Auto-delete after this time */
  expiresAt?: Date
}

/**
 * Input for creating a memory in bulk operations
 */
export interface CreateMemory {
  content: string
  metadata?: MemoryMetadata
}

/**
 * Fields that can be updated on an existing memory
 */
export interface MemoryUpdate {
  type?: string
  tags?: string[]
  importance?: number
  /** Set to null to remove expiry */
  expiresAt?: Date | null
}

/**
 * Options for searching memories
 */
export interface SearchOptions {
  /** Max results (default: 10) */
  limit?: number
  /** Similarity threshold 0-1 (default: 0.5, lower = more similar) */
  maxDistance?: number
  /** Filter to specific types */
  types?: string[]
  /** Filter to memories with ALL of these tags */
  tags?: string[]
  /** Exclude if mentioned within N hours */
  excludeMentionedWithin?: number
  /** Filter by minimum importance threshold */
  minImportance?: number
}

/**
 * Memory with similarity score from search results
 */
export interface MemorySearchResult {
  id: string
  content: string
  type: string | null
  tags: string[]
  source: string | null
  importance: number | null
  /** Semantic distance (lower = more similar) */
  distance: number
  createdAt: Date
  lastMentionedAt: Date | null
  mentionCount: number
}

/**
 * Statistics for a namespace
 */
export interface NamespaceStats {
  totalMemories: number
  byType: Record<string, number>
  oldestMemory: Date | null
  newestMemory: Date | null
  expiringWithin7Days: number
}

/**
 * Raw search result from pgvector query
 */
export interface RawSearchResult {
  id: string
  content: string
  type: string | null
  tags: string[]
  source: string | null
  importance: number | null
  distance: number
  createdAt: Date
  lastMentionedAt: Date | null
  mentionCount: number
}
