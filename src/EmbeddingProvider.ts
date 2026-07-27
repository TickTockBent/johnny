import { EmbeddingError } from './errors'

/**
 * Interface for embedding generation providers.
 * Implement this to use custom embedding models (Ollama, Cohere, local models, etc.)
 *
 * @example
 * ```typescript
 * const provider: EmbeddingProvider = {
 *   dimensions: 768,
 *   async generateEmbeddings(texts) {
 *     // Call your embedding API here
 *     return texts.map(text => computeEmbedding(text))
 *   }
 * }
 * ```
 */
export interface EmbeddingProvider {
  /** Generate embeddings for multiple texts in a single batch call. */
  generateEmbeddings(texts: string[]): Promise<number[][]>
  /** The dimensionality of vectors produced by this provider. */
  readonly dimensions: number
}

/**
 * Built-in OpenAI embedding provider.
 * Uses the OpenAI /v1/embeddings REST API.
 *
 * @example
 * ```typescript
 * const provider = new OpenAIEmbeddingProvider({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'text-embedding-3-small',
 * })
 * ```
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number
  private readonly apiKey: string
  private readonly model: string

  constructor(options: {
    apiKey: string
    /** Embedding model to use (default: text-embedding-3-small) */
    model?: string
    /** Vector dimensions (default: 1536) */
    dimensions?: number
  }) {
    this.apiKey = options.apiKey
    this.model = options.model ?? 'text-embedding-3-small'
    this.dimensions = options.dimensions ?? 1536
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
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
