import { describe, it, expect } from 'vitest'
import { MemoryService } from '../../MemoryService'
import { NotFoundError, NamespaceRequiredError } from '../../errors'
import { setupIntegrationTests } from './setup'

describe('MemoryService Integration', () => {
  const { prisma } = setupIntegrationTests()

  const createService = (defaultNamespace?: string) =>
    new MemoryService({
      prisma,
      embeddingApiKey: 'mock-key', // Using mocked fetch
      defaultNamespace,
    })

  describe('store()', () => {
    it('stores a memory with content and embedding', async () => {
      const service = createService('test')
      const memory = await service.store(undefined, 'Hello world')

      expect(memory.id).toBeDefined()
      expect(memory.content).toBe('Hello world')
      expect(memory.namespace).toBe('test')
      expect(memory.createdAt).toBeInstanceOf(Date)

      // Verify embedding was stored
      const raw = await prisma.$queryRaw<{ has_embedding: boolean }[]>`
        SELECT embedding IS NOT NULL as has_embedding FROM "Memory" WHERE id = ${memory.id}
      `
      expect(raw[0].has_embedding).toBe(true)
    })

    it('stores a memory with all metadata fields', async () => {
      const service = createService('test')
      const expiresAt = new Date('2025-12-31')

      const memory = await service.store(undefined, 'User likes coffee', {
        type: 'preference',
        tags: ['food', 'beverage'],
        source: 'conversation:123',
        importance: 0.8,
        expiresAt,
      })

      expect(memory.type).toBe('preference')
      expect(memory.tags).toEqual(['food', 'beverage'])
      expect(memory.source).toBe('conversation:123')
      expect(memory.importance).toBe(0.8)
      expect(memory.expiresAt).toEqual(expiresAt)
    })

    it('uses explicit namespace over default', async () => {
      const service = createService('default-ns')
      const memory = await service.store('explicit-ns', 'Content')

      expect(memory.namespace).toBe('explicit-ns')
    })

    it('throws NamespaceRequiredError when no namespace', async () => {
      const service = createService() // No default

      await expect(service.store(undefined, 'Content')).rejects.toThrow(
        NamespaceRequiredError
      )
    })
  })

  describe('storeMany()', () => {
    it('stores multiple memories', async () => {
      const service = createService('test')

      const memories = await service.storeMany(undefined, [
        { content: 'First memory' },
        { content: 'Second memory', metadata: { type: 'note' } },
        { content: 'Third memory', metadata: { tags: ['important'] } },
      ])

      expect(memories).toHaveLength(3)
      expect(memories[0].content).toBe('First memory')
      expect(memories[1].type).toBe('note')
      expect(memories[2].tags).toEqual(['important'])

      const count = await prisma.memory.count()
      expect(count).toBe(3)
    })

    it('returns empty array for empty input', async () => {
      const service = createService('test')
      const memories = await service.storeMany(undefined, [])

      expect(memories).toEqual([])
    })
  })

  describe('search()', () => {
    it('finds memories and returns distance scores', async () => {
      const service = createService('test')

      await service.store(undefined, 'User loves coffee and espresso drinks')
      await service.store(undefined, 'User enjoys hiking in the mountains')
      await service.store(undefined, 'User prefers tea over other beverages')

      const results = await service.search(undefined, 'coffee beverages', {
        maxDistance: 0.9,
      })

      // Should find some results (mock embeddings are deterministic but not semantically meaningful)
      expect(results.length).toBeGreaterThan(0)
      // Results should have distance scores
      expect(typeof results[0].distance).toBe('number')
      expect(results[0].distance).toBeGreaterThanOrEqual(0)
      expect(results[0].distance).toBeLessThan(0.9)
    })

    it('respects namespace isolation', async () => {
      const service = createService()

      await service.store('ns1', 'Coffee in namespace 1')
      await service.store('ns2', 'Coffee in namespace 2')

      const results = await service.search('ns1', 'coffee', { maxDistance: 0.9 })

      expect(results).toHaveLength(1)
      expect(results[0].content).toContain('namespace 1')
    })

    it('filters by type', async () => {
      const service = createService('test')

      await service.store(undefined, 'A fact about coffee', { type: 'fact' })
      await service.store(undefined, 'A preference for coffee', { type: 'preference' })

      const results = await service.search(undefined, 'coffee', {
        types: ['preference'],
        maxDistance: 0.9,
      })

      expect(results).toHaveLength(1)
      expect(results[0].type).toBe('preference')
    })

    it('filters by tags (requires all)', async () => {
      const service = createService('test')

      await service.store(undefined, 'Has both tags', { tags: ['a', 'b'] })
      await service.store(undefined, 'Has only tag a', { tags: ['a'] })
      await service.store(undefined, 'Has only tag b', { tags: ['b'] })

      const results = await service.search(undefined, 'tags', {
        tags: ['a', 'b'],
        maxDistance: 0.9,
      })

      expect(results).toHaveLength(1)
      expect(results[0].tags).toContain('a')
      expect(results[0].tags).toContain('b')
    })

    it('filters by minImportance', async () => {
      const service = createService('test')

      await service.store(undefined, 'High importance', { importance: 0.9 })
      await service.store(undefined, 'Low importance', { importance: 0.2 })

      const results = await service.search(undefined, 'importance', {
        minImportance: 0.5,
        maxDistance: 0.9,
      })

      expect(results).toHaveLength(1)
      expect(results[0].importance).toBeGreaterThanOrEqual(0.5)
    })

    it('excludes recently mentioned memories', async () => {
      const service = createService('test')

      const memory = await service.store(undefined, 'Recently mentioned')
      await service.recordMention(memory.id)

      const results = await service.search(undefined, 'recently mentioned', {
        excludeMentionedWithin: 1, // Exclude if mentioned within 1 hour
        maxDistance: 0.9,
      })

      expect(results.every((r) => r.id !== memory.id)).toBe(true)
    })

    it('excludes expired memories', async () => {
      const service = createService('test')

      const pastDate = new Date(Date.now() - 1000)
      await service.store(undefined, 'Expired content', { expiresAt: pastDate })
      await service.store(undefined, 'Valid content')

      const results = await service.search(undefined, 'content', {
        maxDistance: 0.9,
      })

      expect(results.every((r) => !r.content.includes('Expired'))).toBe(true)
    })

    it('respects limit', async () => {
      const service = createService('test')

      for (let i = 0; i < 10; i++) {
        await service.store(undefined, `Memory number ${i}`)
      }

      const results = await service.search(undefined, 'memory', {
        limit: 3,
        maxDistance: 0.9,
      })

      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('returns distance scores', async () => {
      const service = createService('test')

      await service.store(undefined, 'Coffee is great')

      const results = await service.search(undefined, 'coffee', {
        maxDistance: 0.9,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(typeof results[0].distance).toBe('number')
      expect(results[0].distance).toBeGreaterThanOrEqual(0)
      expect(results[0].distance).toBeLessThan(1)
    })
  })

  describe('get()', () => {
    it('returns memory by id', async () => {
      const service = createService('test')
      const stored = await service.store(undefined, 'Test content')

      const retrieved = await service.get(stored.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(stored.id)
      expect(retrieved!.content).toBe('Test content')
    })

    it('returns null for non-existent id', async () => {
      const service = createService('test')
      const result = await service.get('non-existent-id')

      expect(result).toBeNull()
    })
  })

  describe('update()', () => {
    it('updates memory metadata', async () => {
      const service = createService('test')
      const memory = await service.store(undefined, 'Content')

      const updated = await service.update(memory.id, {
        type: 'new-type',
        tags: ['tag1', 'tag2'],
        importance: 0.75,
      })

      expect(updated.type).toBe('new-type')
      expect(updated.tags).toEqual(['tag1', 'tag2'])
      expect(updated.importance).toBe(0.75)
    })

    it('can set expiresAt', async () => {
      const service = createService('test')
      const memory = await service.store(undefined, 'Content')
      const newExpiry = new Date('2026-06-15')

      const updated = await service.update(memory.id, { expiresAt: newExpiry })

      expect(updated.expiresAt).toEqual(newExpiry)
    })

    it('throws NotFoundError for non-existent id', async () => {
      const service = createService('test')

      await expect(service.update('non-existent', { type: 'x' })).rejects.toThrow(
        NotFoundError
      )
    })
  })

  describe('delete()', () => {
    it('removes memory by id', async () => {
      const service = createService('test')
      const memory = await service.store(undefined, 'To delete')

      await service.delete(memory.id)

      const result = await service.get(memory.id)
      expect(result).toBeNull()
    })
  })

  describe('recordMention()', () => {
    it('updates lastMentionedAt and increments mentionCount', async () => {
      const service = createService('test')
      const memory = await service.store(undefined, 'Content')

      expect(memory.mentionCount).toBe(0)
      expect(memory.lastMentionedAt).toBeNull()

      await service.recordMention(memory.id)

      const updated = await service.get(memory.id)
      expect(updated!.mentionCount).toBe(1)
      expect(updated!.lastMentionedAt).not.toBeNull()

      await service.recordMention(memory.id)

      const updated2 = await service.get(memory.id)
      expect(updated2!.mentionCount).toBe(2)
    })
  })

  describe('deleteByNamespace()', () => {
    it('deletes all memories in namespace', async () => {
      const service = createService()

      await service.store('ns1', 'Memory 1')
      await service.store('ns1', 'Memory 2')
      await service.store('ns2', 'Memory 3')

      const count = await service.deleteByNamespace('ns1')

      expect(count).toBe(2)

      const remaining = await prisma.memory.count()
      expect(remaining).toBe(1)
    })
  })

  describe('deleteBySource()', () => {
    it('deletes memories by namespace and source', async () => {
      const service = createService('test')

      await service.store(undefined, 'A', { source: 'doc:1' })
      await service.store(undefined, 'B', { source: 'doc:1' })
      await service.store(undefined, 'C', { source: 'doc:2' })

      const count = await service.deleteBySource('test', 'doc:1')

      expect(count).toBe(2)

      const remaining = await prisma.memory.count()
      expect(remaining).toBe(1)
    })
  })

  describe('pruneExpired()', () => {
    it('deletes expired memories', async () => {
      const service = createService('test')

      const past = new Date(Date.now() - 1000)
      const future = new Date(Date.now() + 100000)

      await service.store(undefined, 'Expired', { expiresAt: past })
      await service.store(undefined, 'Not expired', { expiresAt: future })
      await service.store(undefined, 'No expiry')

      const count = await service.pruneExpired()

      expect(count).toBe(1)

      const remaining = await prisma.memory.count()
      expect(remaining).toBe(2)
    })
  })

  describe('getStats()', () => {
    it('returns namespace statistics', async () => {
      const service = createService('stats-ns')

      await service.store(undefined, 'Fact 1', { type: 'fact' })
      await service.store(undefined, 'Fact 2', { type: 'fact' })
      await service.store(undefined, 'Preference', { type: 'preference' })
      await service.store(undefined, 'No type')

      const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      await service.store(undefined, 'Expiring soon', { expiresAt: inThreeDays })

      const stats = await service.getStats('stats-ns')

      expect(stats.totalMemories).toBe(5)
      expect(stats.byType).toEqual({
        fact: 2,
        preference: 1,
        null: 2,
      })
      expect(stats.oldestMemory).toBeInstanceOf(Date)
      expect(stats.newestMemory).toBeInstanceOf(Date)
      expect(stats.expiringWithin7Days).toBe(1)
    })

    it('handles empty namespace', async () => {
      const service = createService('test')
      const stats = await service.getStats('empty-ns')

      expect(stats.totalMemories).toBe(0)
      expect(stats.byType).toEqual({})
      expect(stats.oldestMemory).toBeNull()
      expect(stats.newestMemory).toBeNull()
    })
  })

  describe('SQL injection prevention', () => {
    it('safely handles malicious namespace input', async () => {
      const service = createService()

      // Store with safe namespace first
      await service.store('safe-ns', 'Safe content')

      // Try to search with injection attempt
      const maliciousNamespace = "'; DROP TABLE \"Memory\"; --"

      // This should not throw and should not find anything
      const results = await service.search(maliciousNamespace, 'test', {
        maxDistance: 0.99,
      })

      expect(results).toEqual([])

      // Verify table still exists
      const count = await prisma.memory.count()
      expect(count).toBe(1)
    })

    it('safely handles malicious type filter', async () => {
      const service = createService('test')

      await service.store(undefined, 'Content', { type: 'safe' })

      const maliciousTypes = ["'; DROP TABLE \"Memory\"; --"]

      const results = await service.search(undefined, 'content', {
        types: maliciousTypes,
        maxDistance: 0.99,
      })

      expect(results).toEqual([])

      const count = await prisma.memory.count()
      expect(count).toBe(1)
    })

    it('safely handles malicious tag filter', async () => {
      const service = createService('test')

      await service.store(undefined, 'Content', { tags: ['safe'] })

      const maliciousTags = ["'; DROP TABLE \"Memory\"; --"]

      const results = await service.search(undefined, 'content', {
        tags: maliciousTags,
        maxDistance: 0.99,
      })

      expect(results).toEqual([])

      const count = await prisma.memory.count()
      expect(count).toBe(1)
    })
  })
})
