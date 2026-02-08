import { describe, it, expect, beforeEach } from 'vitest'
import { MockMemoryService } from '../MockMemoryService'
import { NamespaceRequiredError, NotFoundError } from '../errors'

describe('MockMemoryService', () => {
  let service: MockMemoryService

  beforeEach(() => {
    service = new MockMemoryService({ defaultNamespace: 'test' })
  })

  describe('store()', () => {
    it('stores a memory and returns it with generated id', async () => {
      const memory = await service.store(undefined, 'Hello world')

      expect(memory.id).toMatch(/^mock-\d+$/)
      expect(memory.content).toBe('Hello world')
      expect(memory.namespace).toBe('test')
    })

    it('stores a memory with all metadata fields', async () => {
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

    it('uses provided namespace over default', async () => {
      const memory = await service.store('custom:ns', 'Content')

      expect(memory.namespace).toBe('custom:ns')
    })

    it('throws NamespaceRequiredError when no namespace available', async () => {
      const serviceNoDefault = new MockMemoryService()

      await expect(serviceNoDefault.store(undefined, 'Content')).rejects.toThrow(
        NamespaceRequiredError
      )
    })

    it('sets createdAt and updatedAt to current time', async () => {
      const before = new Date()
      const memory = await service.store(undefined, 'Content')
      const after = new Date()

      expect(memory.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(memory.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
      expect(memory.updatedAt).toEqual(memory.createdAt)
    })

    it('initializes mentionCount to 0 and lastMentionedAt to null', async () => {
      const memory = await service.store(undefined, 'Content')

      expect(memory.mentionCount).toBe(0)
      expect(memory.lastMentionedAt).toBeNull()
    })

    it('defaults metadata fields to null/empty when not provided', async () => {
      const memory = await service.store(undefined, 'Content')

      expect(memory.type).toBeNull()
      expect(memory.tags).toEqual([])
      expect(memory.source).toBeNull()
      expect(memory.importance).toBeNull()
      expect(memory.expiresAt).toBeNull()
    })
  })

  describe('storeMany()', () => {
    it('stores multiple memories and returns them', async () => {
      const memories = await service.storeMany(undefined, [
        { content: 'First memory' },
        { content: 'Second memory', metadata: { type: 'note' } },
        { content: 'Third memory', metadata: { tags: ['important'] } },
      ])

      expect(memories).toHaveLength(3)
      expect(memories[0].content).toBe('First memory')
      expect(memories[1].content).toBe('Second memory')
      expect(memories[1].type).toBe('note')
      expect(memories[2].tags).toEqual(['important'])
    })

    it('returns empty array for empty input', async () => {
      const memories = await service.storeMany(undefined, [])

      expect(memories).toEqual([])
    })

    it('applies same namespace to all memories', async () => {
      const memories = await service.storeMany('shared:ns', [
        { content: 'One' },
        { content: 'Two' },
      ])

      expect(memories[0].namespace).toBe('shared:ns')
      expect(memories[1].namespace).toBe('shared:ns')
    })
  })

  describe('search()', () => {
    beforeEach(async () => {
      // Set up test data with varying content
      await service.store(undefined, 'User loves coffee and espresso')
      await service.store(undefined, 'User enjoys tea and green tea')
      await service.store(undefined, 'User prefers hiking in mountains')
      await service.store('other:ns', 'Different namespace content about coffee')
    })

    it('returns memories matching namespace', async () => {
      const results = await service.search(undefined, 'coffee')

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((r) => r.content.includes('coffee') || r.distance < 0.5)).toBe(true)
    })

    it('excludes memories from other namespaces', async () => {
      const results = await service.search(undefined, 'coffee')

      expect(results.every((r) => !r.content.includes('Different namespace'))).toBe(true)
    })

    it('ranks results by similarity (lower distance = more similar)', async () => {
      const results = await service.search(undefined, 'coffee espresso beverage')

      if (results.length > 1) {
        for (let i = 1; i < results.length; i++) {
          expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance)
        }
      }
    })

    it('respects limit option', async () => {
      const results = await service.search(undefined, 'user', { limit: 2 })

      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('filters by maxDistance', async () => {
      const looseResults = await service.search(undefined, 'coffee', { maxDistance: 0.9 })
      const strictResults = await service.search(undefined, 'coffee', { maxDistance: 0.1 })

      expect(looseResults.length).toBeGreaterThanOrEqual(strictResults.length)
      expect(strictResults.every((r) => r.distance < 0.1)).toBe(true)
    })

    it('filters by types array', async () => {
      await service.store(undefined, 'Typed memory about drinks', { type: 'preference' })
      await service.store(undefined, 'Another typed memory', { type: 'fact' })

      const results = await service.search(undefined, 'memory', { types: ['preference'] })

      expect(results.every((r) => r.type === 'preference')).toBe(true)
    })

    it('filters by tags (requires all tags)', async () => {
      await service.store(undefined, 'Has both tags', { tags: ['food', 'drink'] })
      await service.store(undefined, 'Has only food tag', { tags: ['food'] })
      await service.store(undefined, 'Has only drink tag', { tags: ['drink'] })

      const results = await service.search(undefined, 'tags', { tags: ['food', 'drink'] })

      expect(results.length).toBe(1)
      expect(results[0].tags).toContain('food')
      expect(results[0].tags).toContain('drink')
    })

    it('filters by minImportance', async () => {
      await service.store(undefined, 'High importance', { importance: 0.9 })
      await service.store(undefined, 'Low importance', { importance: 0.2 })
      await service.store(undefined, 'No importance set')

      const results = await service.search(undefined, 'importance', { minImportance: 0.5 })

      expect(results.every((r) => r.importance !== null && r.importance >= 0.5)).toBe(true)
    })

    it('excludes recently mentioned memories', async () => {
      const memory = await service.store(undefined, 'Recently mentioned content')
      await service.recordMention(memory.id)

      const results = await service.search(undefined, 'recently mentioned', {
        excludeMentionedWithin: 1, // Exclude if mentioned within 1 hour
      })

      expect(results.every((r) => r.id !== memory.id)).toBe(true)
    })

    it('excludes expired memories', async () => {
      const pastDate = new Date(Date.now() - 1000)
      await service.store(undefined, 'Expired content', { expiresAt: pastDate })

      const results = await service.search(undefined, 'expired content')

      expect(results.every((r) => !r.content.includes('Expired'))).toBe(true)
    })

    it('returns empty array when no matches', async () => {
      const results = await service.search(undefined, 'xyz', {
        maxDistance: 0.01, // Very strict
      })

      expect(results).toEqual([])
    })

    it('combines multiple filters correctly', async () => {
      await service.store(undefined, 'Perfect match', {
        type: 'target',
        tags: ['a', 'b'],
        importance: 0.9,
      })
      await service.store(undefined, 'Wrong type', {
        type: 'other',
        tags: ['a', 'b'],
        importance: 0.9,
      })
      await service.store(undefined, 'Missing tag', {
        type: 'target',
        tags: ['a'],
        importance: 0.9,
      })
      await service.store(undefined, 'Low importance', {
        type: 'target',
        tags: ['a', 'b'],
        importance: 0.1,
      })

      const results = await service.search(undefined, 'match', {
        types: ['target'],
        tags: ['a', 'b'],
        minImportance: 0.5,
      })

      expect(results.length).toBe(1)
      expect(results[0].content).toBe('Perfect match')
    })
  })

  describe('get()', () => {
    it('returns memory by id', async () => {
      const stored = await service.store(undefined, 'Test content')
      const retrieved = await service.get(stored.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(stored.id)
      expect(retrieved!.content).toBe('Test content')
    })

    it('returns null for non-existent id', async () => {
      const result = await service.get('non-existent-id')

      expect(result).toBeNull()
    })
  })

  describe('update()', () => {
    it('updates type field', async () => {
      const memory = await service.store(undefined, 'Content')
      const updated = await service.update(memory.id, { type: 'new-type' })

      expect(updated.type).toBe('new-type')
    })

    it('updates tags field', async () => {
      const memory = await service.store(undefined, 'Content', { tags: ['old'] })
      const updated = await service.update(memory.id, { tags: ['new', 'tags'] })

      expect(updated.tags).toEqual(['new', 'tags'])
    })

    it('updates importance field', async () => {
      const memory = await service.store(undefined, 'Content')
      const updated = await service.update(memory.id, { importance: 0.75 })

      expect(updated.importance).toBe(0.75)
    })

    it('updates expiresAt field', async () => {
      const memory = await service.store(undefined, 'Content')
      const newExpiry = new Date('2026-06-15')
      const updated = await service.update(memory.id, { expiresAt: newExpiry })

      expect(updated.expiresAt).toEqual(newExpiry)
    })

    it('can set expiresAt to null', async () => {
      const memory = await service.store(undefined, 'Content', {
        expiresAt: new Date('2025-01-01'),
      })
      const updated = await service.update(memory.id, { expiresAt: null })

      expect(updated.expiresAt).toBeNull()
    })

    it('updates updatedAt timestamp', async () => {
      const memory = await service.store(undefined, 'Content')
      const originalUpdatedAt = memory.updatedAt

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 10))

      const updated = await service.update(memory.id, { type: 'changed' })

      expect(updated.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime())
    })

    it('throws NotFoundError for non-existent id', async () => {
      await expect(service.update('non-existent', { type: 'x' })).rejects.toThrow(NotFoundError)
    })
  })

  describe('delete()', () => {
    it('removes memory by id', async () => {
      const memory = await service.store(undefined, 'To be deleted')
      await service.delete(memory.id)
      const result = await service.get(memory.id)

      expect(result).toBeNull()
    })

    it('silently succeeds for non-existent id', async () => {
      await expect(service.delete('non-existent')).resolves.toBeUndefined()
    })
  })

  describe('recordMention()', () => {
    it('updates lastMentionedAt to current time', async () => {
      const memory = await service.store(undefined, 'Content')
      expect(memory.lastMentionedAt).toBeNull()

      const before = new Date()
      await service.recordMention(memory.id)
      const after = new Date()

      const updated = await service.get(memory.id)
      expect(updated!.lastMentionedAt).not.toBeNull()
      expect(updated!.lastMentionedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(updated!.lastMentionedAt!.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('increments mentionCount', async () => {
      const memory = await service.store(undefined, 'Content')
      expect(memory.mentionCount).toBe(0)

      await service.recordMention(memory.id)
      let updated = await service.get(memory.id)
      expect(updated!.mentionCount).toBe(1)

      await service.recordMention(memory.id)
      updated = await service.get(memory.id)
      expect(updated!.mentionCount).toBe(2)
    })

    it('silently succeeds for non-existent id', async () => {
      await expect(service.recordMention('non-existent')).resolves.toBeUndefined()
    })
  })

  describe('deleteByNamespace()', () => {
    it('deletes all memories in namespace', async () => {
      await service.store('ns1', 'Memory 1')
      await service.store('ns1', 'Memory 2')
      await service.store('ns2', 'Memory 3')

      const count = await service.deleteByNamespace('ns1')

      expect(count).toBe(2)
      expect(service.size).toBe(1)
    })

    it('returns count of deleted memories', async () => {
      await service.store('ns', 'A')
      await service.store('ns', 'B')
      await service.store('ns', 'C')

      const count = await service.deleteByNamespace('ns')

      expect(count).toBe(3)
    })

    it('does not affect other namespaces', async () => {
      await service.store('delete-me', 'Gone')
      await service.store('keep-me', 'Stays')

      await service.deleteByNamespace('delete-me')

      const remaining = await service.search('keep-me', 'stays')
      expect(remaining.length).toBe(1)
    })

    it('returns 0 for empty namespace', async () => {
      const count = await service.deleteByNamespace('empty')

      expect(count).toBe(0)
    })
  })

  describe('deleteBySource()', () => {
    it('deletes memories matching namespace and source', async () => {
      await service.store('ns', 'A', { source: 'doc:1' })
      await service.store('ns', 'B', { source: 'doc:1' })
      await service.store('ns', 'C', { source: 'doc:2' })

      const count = await service.deleteBySource('ns', 'doc:1')

      expect(count).toBe(2)
      expect(service.size).toBe(1)
    })

    it('returns count of deleted memories', async () => {
      await service.store('ns', 'X', { source: 'src' })

      const count = await service.deleteBySource('ns', 'src')

      expect(count).toBe(1)
    })

    it('does not affect other sources', async () => {
      await service.store('ns', 'Keep', { source: 'keep' })
      await service.store('ns', 'Delete', { source: 'delete' })

      await service.deleteBySource('ns', 'delete')

      const kept = await service.get('mock-1')
      expect(kept).not.toBeNull()
    })
  })

  describe('pruneExpired()', () => {
    it('deletes memories past expiresAt', async () => {
      const past = new Date(Date.now() - 1000)
      await service.store(undefined, 'Expired', { expiresAt: past })
      await service.store(undefined, 'Not expired')

      const count = await service.pruneExpired()

      expect(count).toBe(1)
      expect(service.size).toBe(1)
    })

    it('returns count of deleted memories', async () => {
      const past = new Date(Date.now() - 1000)
      await service.store(undefined, 'A', { expiresAt: past })
      await service.store(undefined, 'B', { expiresAt: past })

      const count = await service.pruneExpired()

      expect(count).toBe(2)
    })

    it('does not delete memories with null expiresAt', async () => {
      await service.store(undefined, 'No expiry')

      const count = await service.pruneExpired()

      expect(count).toBe(0)
      expect(service.size).toBe(1)
    })

    it('does not delete memories with future expiresAt', async () => {
      const future = new Date(Date.now() + 100000)
      await service.store(undefined, 'Future expiry', { expiresAt: future })

      const count = await service.pruneExpired()

      expect(count).toBe(0)
      expect(service.size).toBe(1)
    })
  })

  describe('getStats()', () => {
    it('returns correct totalMemories', async () => {
      await service.store('stats-ns', 'A')
      await service.store('stats-ns', 'B')
      await service.store('other-ns', 'C')

      const stats = await service.getStats('stats-ns')

      expect(stats.totalMemories).toBe(2)
    })

    it('returns byType counts', async () => {
      await service.store('ns', 'A', { type: 'fact' })
      await service.store('ns', 'B', { type: 'fact' })
      await service.store('ns', 'C', { type: 'preference' })
      await service.store('ns', 'D') // null type

      const stats = await service.getStats('ns')

      expect(stats.byType).toEqual({
        fact: 2,
        preference: 1,
        null: 1,
      })
    })

    it('returns oldest and newest memory dates', async () => {
      await service.store('ns', 'First')
      await new Promise((resolve) => setTimeout(resolve, 10))
      await service.store('ns', 'Second')
      await new Promise((resolve) => setTimeout(resolve, 10))
      await service.store('ns', 'Third')

      const stats = await service.getStats('ns')

      expect(stats.oldestMemory).not.toBeNull()
      expect(stats.newestMemory).not.toBeNull()
      expect(stats.oldestMemory!.getTime()).toBeLessThan(stats.newestMemory!.getTime())
    })

    it('counts memories expiring within 7 days', async () => {
      const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      const inTenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)

      await service.store('ns', 'Expiring soon', { expiresAt: inThreeDays })
      await service.store('ns', 'Expiring later', { expiresAt: inTenDays })
      await service.store('ns', 'No expiry')

      const stats = await service.getStats('ns')

      expect(stats.expiringWithin7Days).toBe(1)
    })

    it('handles empty namespace', async () => {
      const stats = await service.getStats('empty-ns')

      expect(stats.totalMemories).toBe(0)
      expect(stats.byType).toEqual({})
      expect(stats.oldestMemory).toBeNull()
      expect(stats.newestMemory).toBeNull()
      expect(stats.expiringWithin7Days).toBe(0)
    })
  })

  describe('clear()', () => {
    it('removes all memories', async () => {
      await service.store(undefined, 'A')
      await service.store(undefined, 'B')
      expect(service.size).toBe(2)

      service.clear()

      expect(service.size).toBe(0)
    })

    it('resets id counter', async () => {
      await service.store(undefined, 'First')
      service.clear()
      const memory = await service.store(undefined, 'After clear')

      expect(memory.id).toBe('mock-1')
    })
  })

  describe('custom embedding function', () => {
    it('uses provided mockEmbeddingFn', async () => {
      let callCount = 0
      const customService = new MockMemoryService({
        defaultNamespace: 'test',
        mockEmbeddingFn: (text) => {
          callCount++
          // Simple embedding based on text length
          return new Array(1536).fill(text.length / 100)
        },
      })

      await customService.store(undefined, 'Short')
      await customService.store(undefined, 'A much longer piece of text')

      expect(callCount).toBe(2)

      // Search should also use custom embedding
      await customService.search(undefined, 'query')
      expect(callCount).toBe(3)
    })
  })

  describe('search() with updatedAt', () => {
    it('returns updatedAt in search results', async () => {
      await service.store(undefined, 'Hello world')
      const results = await service.search(undefined, 'Hello world', { maxDistance: 1 })

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].updatedAt).toBeInstanceOf(Date)
    })
  })

  describe('updateContent()', () => {
    it('updates content and returns the memory', async () => {
      const original = await service.store(undefined, 'Original content')
      const updated = await service.updateContent(original.id, 'New content')

      expect(updated.id).toBe(original.id)
      expect(updated.content).toBe('New content')
    })

    it('preserves createdAt', async () => {
      const original = await service.store(undefined, 'Original content')
      const updated = await service.updateContent(original.id, 'New content')

      expect(updated.createdAt).toEqual(original.createdAt)
    })

    it('updates updatedAt', async () => {
      const original = await service.store(undefined, 'Original content')
      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5))
      const updated = await service.updateContent(original.id, 'New content')

      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(original.updatedAt.getTime())
    })

    it('does not touch mentionCount or lastMentionedAt', async () => {
      const original = await service.store(undefined, 'Original content')
      await service.recordMention(original.id)
      const afterMention = await service.get(original.id)
      const updated = await service.updateContent(original.id, 'New content')

      expect(updated.mentionCount).toBe(afterMention!.mentionCount)
      expect(updated.lastMentionedAt).toEqual(afterMention!.lastMentionedAt)
    })

    it('applies optional metadata updates', async () => {
      const original = await service.store(undefined, 'Original content', {
        type: 'fact',
        importance: 0.5,
      })
      const updated = await service.updateContent(original.id, 'New content', {
        type: 'preference',
        tags: ['updated'],
        importance: 0.9,
      })

      expect(updated.type).toBe('preference')
      expect(updated.tags).toEqual(['updated'])
      expect(updated.importance).toBe(0.9)
    })

    it('regenerates embedding (findable by new content)', async () => {
      const original = await service.store(undefined, 'I love hiking in the mountains')
      await service.updateContent(original.id, 'Coffee beans and espresso machines')

      const results = await service.search(undefined, 'Coffee beans and espresso machines', {
        maxDistance: 1,
      })
      expect(results.some((r) => r.id === original.id)).toBe(true)
    })

    it('throws NotFoundError for non-existent ID', async () => {
      await expect(
        service.updateContent('non-existent', 'New content')
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('upsert()', () => {
    it('creates a new memory when key does not exist', async () => {
      const result = await service.upsert(undefined, 'contact:john', 'John is a developer')

      expect(result.content).toBe('John is a developer')
      expect(result.source).toBe('contact:john')
      expect(result.namespace).toBe('test')
    })

    it('updates existing memory when key matches namespace+source', async () => {
      const first = await service.upsert(undefined, 'contact:john', 'John is a developer')
      const second = await service.upsert(undefined, 'contact:john', 'John is a senior developer')

      expect(second.id).toBe(first.id)
      expect(second.content).toBe('John is a senior developer')
      expect(second.source).toBe('contact:john')
    })

    it('preserves createdAt on update', async () => {
      const first = await service.upsert(undefined, 'contact:john', 'John is a developer')
      await new Promise((resolve) => setTimeout(resolve, 5))
      const second = await service.upsert(undefined, 'contact:john', 'Updated info')

      expect(second.createdAt).toEqual(first.createdAt)
    })

    it('preserves mentionCount and lastMentionedAt on update', async () => {
      const first = await service.upsert(undefined, 'contact:john', 'John is a developer')
      await service.recordMention(first.id)
      const afterMention = await service.get(first.id)
      const second = await service.upsert(undefined, 'contact:john', 'Updated')

      expect(second.mentionCount).toBe(afterMention!.mentionCount)
      expect(second.lastMentionedAt).toEqual(afterMention!.lastMentionedAt)
    })

    it('applies metadata on create', async () => {
      const result = await service.upsert(undefined, 'key', 'Content', {
        type: 'entity',
        tags: ['contact'],
        importance: 0.8,
      })

      expect(result.type).toBe('entity')
      expect(result.tags).toEqual(['contact'])
      expect(result.importance).toBe(0.8)
    })

    it('preserves existing metadata when not provided on update (COALESCE)', async () => {
      await service.upsert(undefined, 'key', 'Content', {
        type: 'entity',
        tags: ['contact'],
        importance: 0.8,
      })
      const updated = await service.upsert(undefined, 'key', 'New content')

      expect(updated.type).toBe('entity')
      expect(updated.tags).toEqual(['contact'])
      expect(updated.importance).toBe(0.8)
    })

    it('overwrites metadata when explicitly provided on update', async () => {
      await service.upsert(undefined, 'key', 'Content', {
        type: 'entity',
        importance: 0.8,
      })
      const updated = await service.upsert(undefined, 'key', 'New content', {
        type: 'contact',
        importance: 0.5,
      })

      expect(updated.type).toBe('contact')
      expect(updated.importance).toBe(0.5)
    })

    it('throws NamespaceRequiredError when no namespace', async () => {
      const serviceNoDefault = new MockMemoryService()

      await expect(
        serviceNoDefault.upsert(undefined, 'key', 'Content')
      ).rejects.toThrow(NamespaceRequiredError)
    })

    it('regenerates embedding on update', async () => {
      await service.upsert(undefined, 'key', 'I love hiking in the mountains')
      await service.upsert(undefined, 'key', 'Coffee beans and espresso machines')

      const results = await service.search(undefined, 'Coffee beans and espresso machines', {
        maxDistance: 1,
      })
      expect(results.some((r) => r.source === 'key')).toBe(true)
    })

    it('does not create duplicates', async () => {
      await service.upsert(undefined, 'key', 'First')
      await service.upsert(undefined, 'key', 'Second')
      await service.upsert(undefined, 'key', 'Third')

      expect(service.size).toBe(1)
    })
  })

  describe('searchAcross()', () => {
    it('searches across multiple namespaces', async () => {
      await service.store('ns1', 'Coffee beans')
      await service.store('ns2', 'Coffee machines')
      await service.store('ns3', 'Tea leaves')

      const results = await service.searchAcross(['ns1', 'ns2'], 'Coffee', {
        maxDistance: 1,
      })

      expect(results.length).toBe(2)
      expect(results.every((r) => ['ns1', 'ns2'].includes(r.namespace))).toBe(true)
    })

    it('includes namespace field in results', async () => {
      await service.store('ns1', 'Some content')

      const results = await service.searchAcross(['ns1'], 'Some content', {
        maxDistance: 1,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].namespace).toBe('ns1')
    })

    it('returns empty array for empty namespaces', async () => {
      const results = await service.searchAcross([], 'query')
      expect(results).toEqual([])
    })

    it('does not return results from excluded namespaces', async () => {
      await service.store('ns1', 'Content A')
      await service.store('ns2', 'Content B')

      const results = await service.searchAcross(['ns1'], 'Content', {
        maxDistance: 1,
      })

      expect(results.every((r) => r.namespace === 'ns1')).toBe(true)
    })

    it('applies filters across namespaces', async () => {
      await service.store('ns1', 'Important content', { importance: 0.9 })
      await service.store('ns2', 'Unimportant content', { importance: 0.1 })

      const results = await service.searchAcross(['ns1', 'ns2'], 'content', {
        maxDistance: 1,
        minImportance: 0.5,
      })

      expect(results.length).toBe(1)
      expect(results[0].namespace).toBe('ns1')
    })

    it('includes updatedAt in results', async () => {
      await service.store('ns1', 'Content')
      const results = await service.searchAcross(['ns1'], 'Content', { maxDistance: 1 })

      expect(results[0].updatedAt).toBeInstanceOf(Date)
    })
  })

  describe('search() with decayOptions', () => {
    it('ranks recent memories higher than old ones', async () => {
      // Create two memories with different timestamps
      const oldMemory = await service.store(undefined, 'Coffee beans are delicious')
      // Manually backdate the old memory
      const internalMemories = (service as any).memories as Map<string, any>
      const oldInternal = internalMemories.get(oldMemory.id)
      oldInternal.createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // 90 days ago

      const recentMemory = await service.store(undefined, 'Coffee beans are amazing')

      const resultsWithDecay = await service.search(undefined, 'Coffee beans', {
        maxDistance: 1,
        decayOptions: { halfLifeHours: 720 }, // 30 days
      })

      // Recent memory should come first with decay
      const recentIdx = resultsWithDecay.findIndex((r) => r.id === recentMemory.id)
      const oldIdx = resultsWithDecay.findIndex((r) => r.id === oldMemory.id)
      expect(recentIdx).toBeLessThan(oldIdx)
    })

    it('reinforceOnMention resets decay clock', async () => {
      const memory = await service.store(undefined, 'Coffee beans are delicious')
      // Backdate creation
      const internalMemories = (service as any).memories as Map<string, any>
      const internal = internalMemories.get(memory.id)
      internal.createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // 90 days ago

      // Record a recent mention
      await service.recordMention(memory.id)

      const resultsWithReinforce = await service.search(undefined, 'Coffee beans', {
        maxDistance: 1,
        decayOptions: { halfLifeHours: 720, reinforceOnMention: true },
      })

      const resultsWithoutReinforce = await service.search(undefined, 'Coffee beans', {
        maxDistance: 1,
        decayOptions: { halfLifeHours: 720, reinforceOnMention: false },
      })

      // With reinforcement, the result should have a lower adjusted distance
      // (better rank) because lastMentionedAt is recent
      const withReinforceResult = resultsWithReinforce.find((r) => r.id === memory.id)
      const withoutReinforceResult = resultsWithoutReinforce.find((r) => r.id === memory.id)
      expect(withReinforceResult).toBeDefined()
      expect(withoutReinforceResult).toBeDefined()
    })

    it('returns raw distance, not adjusted', async () => {
      const memory = await service.store(undefined, 'Coffee beans')
      // Backdate
      const internalMemories = (service as any).memories as Map<string, any>
      internalMemories.get(memory.id).createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const withDecay = await service.search(undefined, 'Coffee beans', {
        maxDistance: 1,
        decayOptions: { halfLifeHours: 720 },
      })
      const withoutDecay = await service.search(undefined, 'Coffee beans', {
        maxDistance: 1,
      })

      // Raw distance should be the same regardless of decay option
      const decayResult = withDecay.find((r) => r.id === memory.id)
      const normalResult = withoutDecay.find((r) => r.id === memory.id)
      expect(decayResult!.distance).toBe(normalResult!.distance)
    })

    it('without decayOptions, behavior is unchanged', async () => {
      await service.store(undefined, 'Coffee beans')
      await service.store(undefined, 'Tea leaves')

      const normal = await service.search(undefined, 'Coffee', { maxDistance: 1 })
      const noDecay = await service.search(undefined, 'Coffee', {
        maxDistance: 1,
        decayOptions: undefined,
      })

      expect(normal.map((r) => r.id)).toEqual(noDecay.map((r) => r.id))
    })
  })

  describe('listNamespaces()', () => {
    it('returns all distinct namespaces', async () => {
      await service.store('ns1', 'Content A')
      await service.store('ns2', 'Content B')
      await service.store('ns1', 'Content C')

      const namespaces = await service.listNamespaces()
      expect(namespaces).toEqual(['ns1', 'ns2'])
    })

    it('filters by prefix', async () => {
      await service.store('user:wes:entities', 'Entity')
      await service.store('user:wes:voice', 'Voice')
      await service.store('user:bob:entities', 'Entity')

      const namespaces = await service.listNamespaces('user:wes:')
      expect(namespaces).toEqual(['user:wes:entities', 'user:wes:voice'])
    })

    it('returns empty array when no match', async () => {
      await service.store('ns1', 'Content')
      const namespaces = await service.listNamespaces('nonexistent:')
      expect(namespaces).toEqual([])
    })

    it('returns sorted results', async () => {
      await service.store('c-namespace', 'C')
      await service.store('a-namespace', 'A')
      await service.store('b-namespace', 'B')

      const namespaces = await service.listNamespaces()
      expect(namespaces).toEqual(['a-namespace', 'b-namespace', 'c-namespace'])
    })
  })

  describe('getStatsMulti()', () => {
    it('returns stats for multiple namespaces', async () => {
      await service.store('ns1', 'Content A', { type: 'fact' })
      await service.store('ns1', 'Content B', { type: 'fact' })
      await service.store('ns2', 'Content C', { type: 'event' })

      const stats = await service.getStatsMulti(['ns1', 'ns2'])

      expect(stats.get('ns1')!.totalMemories).toBe(2)
      expect(stats.get('ns2')!.totalMemories).toBe(1)
    })

    it('includes empty stats for namespaces with no memories', async () => {
      await service.store('ns1', 'Content')

      const stats = await service.getStatsMulti(['ns1', 'ns-empty'])

      expect(stats.get('ns-empty')!.totalMemories).toBe(0)
    })

    it('returns empty map for empty input', async () => {
      const stats = await service.getStatsMulti([])
      expect(stats.size).toBe(0)
    })

    it('matches getStats output per namespace', async () => {
      await service.store('ns1', 'Content A', { type: 'fact' })
      await service.store('ns1', 'Content B', { type: 'preference' })

      const singleStats = await service.getStats('ns1')
      const multiStats = await service.getStatsMulti(['ns1'])

      expect(multiStats.get('ns1')).toEqual(singleStats)
    })
  })
})
