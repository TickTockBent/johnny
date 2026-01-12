/**
 * Base error class for all Johnny memory service errors
 */
export class MemoryError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message)
    this.name = 'MemoryError'
    Error.captureStackTrace?.(this, this.constructor)
  }
}

/**
 * Error thrown when embedding generation fails
 */
export class EmbeddingError extends MemoryError {
  constructor(message: string, cause?: Error) {
    super(message, cause)
    this.name = 'EmbeddingError'
  }
}

/**
 * Error thrown when a requested memory is not found
 */
export class NotFoundError extends MemoryError {
  constructor(public readonly id: string) {
    super(`Memory not found: ${id}`)
    this.name = 'NotFoundError'
  }
}

/**
 * Error thrown when a namespace is required but not provided
 */
export class NamespaceRequiredError extends MemoryError {
  constructor() {
    super('Namespace is required. Provide it in the method call or set defaultNamespace in constructor.')
    this.name = 'NamespaceRequiredError'
  }
}

/**
 * Error thrown when database operations fail
 */
export class DatabaseError extends MemoryError {
  constructor(operation: string, cause?: Error) {
    super(`Database operation failed: ${operation}`, cause)
    this.name = 'DatabaseError'
  }
}
