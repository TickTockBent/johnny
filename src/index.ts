// Core service
export { MemoryService } from './MemoryService'

// Embedding providers
export { OpenAIEmbeddingProvider } from './EmbeddingProvider'
export type { EmbeddingProvider } from './EmbeddingProvider'

// Mock service (also available via '@wes/johnny/testing')
export { MockMemoryService } from './MockMemoryService'
export type { MockMemoryServiceOptions } from './MockMemoryService'

// Types
export type {
  MemoryServiceOptions,
  PrismaClientLike,
  Memory,
  MemoryMetadata,
  MemoryUpdate,
  CreateMemory,
  SearchOptions,
  ListOptions,
  MemorySearchResult,
  CrossNamespaceSearchResult,
  DecayOptions,
  NamespaceStats,
  IMemoryService,
} from './types'

// Errors
export {
  MemoryError,
  EmbeddingError,
  NotFoundError,
  NamespaceRequiredError,
  DatabaseError,
} from './errors'
