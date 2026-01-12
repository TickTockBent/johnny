import { PrismaClient } from '@prisma/client'
import { beforeAll, afterAll, beforeEach } from 'vitest'

export const prisma = new PrismaClient()

/**
 * Generate a deterministic mock embedding for testing.
 * Uses a simple hash-based approach to create consistent 1536-dim vectors.
 */
export function generateMockEmbedding(text: string): number[] {
  const embedding = new Array(1536).fill(0)
  const normalizedText = text.toLowerCase()

  for (let i = 0; i < normalizedText.length; i++) {
    const charCode = normalizedText.charCodeAt(i)
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
 * Create a mock fetch that intercepts OpenAI embedding requests.
 */
export function createMockFetch() {
  const originalFetch = global.fetch

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()

    if (url.includes('api.openai.com/v1/embeddings')) {
      const body = JSON.parse(init?.body as string)
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input]

      const data = inputs.map((text, index) => ({
        embedding: generateMockEmbedding(text),
        index,
      }))

      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return originalFetch(input, init)
  }

  return {
    install: () => {
      global.fetch = mockFetch as typeof fetch
    },
    restore: () => {
      global.fetch = originalFetch
    },
  }
}

/**
 * Clean up all memories in the test database.
 */
export async function cleanDatabase() {
  await prisma.memory.deleteMany({})
}

/**
 * Standard test setup hooks.
 */
export function setupIntegrationTests() {
  const mockFetch = createMockFetch()

  beforeAll(async () => {
    mockFetch.install()
    await prisma.$connect()
  })

  afterAll(async () => {
    mockFetch.restore()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await cleanDatabase()
  })

  return { prisma, mockFetch }
}
