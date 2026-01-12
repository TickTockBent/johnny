// Core service
export { MemoryService } from './MemoryService'

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
  MemorySearchResult,
  NamespaceStats,
} from './types'

// Errors
export {
  MemoryError,
  EmbeddingError,
  NotFoundError,
  NamespaceRequiredError,
  DatabaseError,
} from './errors'
