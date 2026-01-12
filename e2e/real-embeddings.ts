/**
 * End-to-end test with real OpenAI embeddings
 *
 * This script demonstrates Johnny's semantic search capabilities
 * using actual vector embeddings from OpenAI.
 *
 * Prerequisites:
 *   1. PostgreSQL + pgvector running (npm run db:up)
 *   2. Database schema pushed (npm run db:push)
 *   3. OPENAI_API_KEY environment variable set
 *
 * Run with:
 *   npx tsx e2e/real-embeddings.ts
 */

import { PrismaClient } from '@prisma/client'
import { MemoryService } from '../dist/index.js'

const prisma = new PrismaClient()

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is required')
  console.error('Run with: OPENAI_API_KEY=sk-... npx tsx e2e/real-embeddings.ts')
  process.exit(1)
}

const memory = new MemoryService({
  prisma,
  embeddingApiKey: OPENAI_API_KEY,
  defaultNamespace: 'e2e-test',
})

// Test data - facts about a fictional user
const userFacts = [
  // Preferences
  { content: 'User prefers dark roast coffee, especially Ethiopian single-origin beans', type: 'preference', tags: ['food', 'coffee'] },
  { content: 'User is vegetarian and enjoys trying new plant-based restaurants', type: 'preference', tags: ['food', 'diet'] },
  { content: 'User likes hiking and has visited 12 national parks in the US', type: 'preference', tags: ['hobby', 'outdoors'] },
  { content: 'User prefers working in the morning and takes afternoon breaks', type: 'preference', tags: ['work', 'schedule'] },

  // Facts
  { content: 'User works as a software engineer at a startup in Austin, Texas', type: 'fact', tags: ['work', 'location'] },
  { content: 'User has a golden retriever named Max who is 3 years old', type: 'fact', tags: ['pet', 'family'] },
  { content: 'User learned to play piano as a child but hasn\'t practiced in years', type: 'fact', tags: ['hobby', 'music'] },
  { content: 'User is planning a trip to Japan next spring to see cherry blossoms', type: 'fact', tags: ['travel', 'plans'] },

  // Events
  { content: 'User mentioned being stressed about an upcoming product launch deadline', type: 'event', tags: ['work', 'stress'] },
  { content: 'User celebrated their 30th birthday last month with friends', type: 'event', tags: ['personal', 'milestone'] },

  // Context
  { content: 'User mentioned they have been learning Japanese for 6 months using Duolingo', type: 'fact', tags: ['learning', 'language'] },
  { content: 'User expressed interest in getting better at public speaking', type: 'preference', tags: ['growth', 'communication'] },
]

// Test queries - things a user might ask that should retrieve relevant memories
const testQueries = [
  {
    query: 'What does the user like to drink?',
    expectedTopics: ['coffee', 'Ethiopian'],
    description: 'Should retrieve coffee preferences',
  },
  {
    query: 'Tell me about their outdoor activities',
    expectedTopics: ['hiking', 'national parks'],
    description: 'Should retrieve hiking/outdoor info',
  },
  {
    query: 'What pet do they have?',
    expectedTopics: ['golden retriever', 'Max'],
    description: 'Should retrieve pet information',
  },
  {
    query: 'What are they stressed about?',
    expectedTopics: ['product launch', 'deadline'],
    description: 'Should retrieve work stress event',
  },
  {
    query: 'Where are they traveling soon?',
    expectedTopics: ['Japan', 'cherry blossoms'],
    description: 'Should retrieve travel plans',
  },
  {
    query: 'What language are they studying?',
    expectedTopics: ['Japanese', 'Duolingo'],
    description: 'Should retrieve language learning',
  },
  {
    query: 'What kind of food do they eat?',
    expectedTopics: ['vegetarian', 'plant-based'],
    description: 'Should retrieve diet preferences',
  },
  {
    query: 'musical background',
    expectedTopics: ['piano'],
    description: 'Should retrieve music history',
  },
]

async function cleanupTestData() {
  console.log('\n🧹 Cleaning up previous test data...')
  const deleted = await memory.deleteByNamespace('e2e-test')
  console.log(`   Deleted ${deleted} existing memories`)
}

async function storeTestData() {
  console.log('\n📝 Storing test memories with real embeddings...')
  console.log('   (This will make API calls to OpenAI)\n')

  const stored = await memory.storeMany(
    undefined,
    userFacts.map((fact) => ({
      content: fact.content,
      metadata: {
        type: fact.type,
        tags: fact.tags,
        importance: fact.type === 'preference' ? 0.8 : 0.5,
      },
    }))
  )

  console.log(`   ✅ Stored ${stored.length} memories`)
  return stored
}

async function runSearchTests() {
  console.log('\n🔍 Running semantic search tests...\n')
  console.log('=' .repeat(70))

  let passed = 0
  let failed = 0

  for (const test of testQueries) {
    console.log(`\nQuery: "${test.query}"`)
    console.log(`Expected: ${test.description}`)

    const results = await memory.search(undefined, test.query, {
      limit: 3,
      maxDistance: 0.7,
    })

    if (results.length === 0) {
      console.log(`❌ FAIL: No results found`)
      failed++
      continue
    }

    const topResult = results[0]
    const foundExpected = test.expectedTopics.some((topic) =>
      topResult.content.toLowerCase().includes(topic.toLowerCase())
    )

    if (foundExpected) {
      console.log(`✅ PASS: Top result (distance: ${topResult.distance.toFixed(4)})`)
      console.log(`   "${topResult.content.slice(0, 80)}..."`)
      passed++
    } else {
      console.log(`❌ FAIL: Top result didn't match expected topics`)
      console.log(`   Got: "${topResult.content.slice(0, 80)}..."`)
      console.log(`   Expected topics: ${test.expectedTopics.join(', ')}`)
      failed++
    }

    // Show all results for context
    if (results.length > 1) {
      console.log(`   Other results:`)
      for (let i = 1; i < results.length; i++) {
        console.log(`   ${i + 1}. (${results[i].distance.toFixed(4)}) ${results[i].content.slice(0, 50)}...`)
      }
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${testQueries.length} tests`)

  return { passed, failed }
}

async function testFilteredSearch() {
  console.log('\n🎯 Testing filtered searches...\n')

  // Search only preferences
  console.log('Searching for "activities" with type filter: preference')
  const preferences = await memory.search(undefined, 'activities', {
    types: ['preference'],
    limit: 3,
    maxDistance: 0.8,
  })
  console.log(`   Found ${preferences.length} preference memories`)
  preferences.forEach((r, i) => {
    console.log(`   ${i + 1}. [${r.type}] ${r.content.slice(0, 60)}...`)
  })

  // Search with tag filter
  console.log('\nSearching for "daily routine" with tags filter: [work]')
  const workRelated = await memory.search(undefined, 'daily routine', {
    tags: ['work'],
    limit: 3,
    maxDistance: 0.8,
  })
  console.log(`   Found ${workRelated.length} work-tagged memories`)
  workRelated.forEach((r, i) => {
    console.log(`   ${i + 1}. [tags: ${r.tags.join(', ')}] ${r.content.slice(0, 50)}...`)
  })

  // Search with importance filter
  console.log('\nSearching for "user info" with minImportance: 0.7')
  const important = await memory.search(undefined, 'user info', {
    minImportance: 0.7,
    limit: 5,
    maxDistance: 0.9,
  })
  console.log(`   Found ${important.length} high-importance memories`)
  important.forEach((r, i) => {
    console.log(`   ${i + 1}. [importance: ${r.importance}] ${r.content.slice(0, 50)}...`)
  })
}

async function testMentionCooldown() {
  console.log('\n⏰ Testing mention cooldown...\n')

  // Record a mention on the first result
  const results = await memory.search(undefined, 'coffee', { limit: 1, maxDistance: 0.8 })
  if (results.length > 0) {
    console.log(`Recording mention for: "${results[0].content.slice(0, 50)}..."`)
    await memory.recordMention(results[0].id)

    // Search again excluding recently mentioned
    const resultsExcluding = await memory.search(undefined, 'coffee', {
      limit: 1,
      maxDistance: 0.8,
      excludeMentionedWithin: 1, // Exclude if mentioned in last hour
    })

    if (resultsExcluding.length === 0 || resultsExcluding[0].id !== results[0].id) {
      console.log('✅ Recently mentioned memory was correctly excluded')
    } else {
      console.log('❌ Recently mentioned memory was NOT excluded')
    }
  }
}

async function showStats() {
  console.log('\n📈 Namespace statistics...\n')
  const stats = await memory.getStats('e2e-test')
  console.log(`   Total memories: ${stats.totalMemories}`)
  console.log(`   By type:`)
  Object.entries(stats.byType).forEach(([type, count]) => {
    console.log(`     - ${type}: ${count}`)
  })
  console.log(`   Oldest: ${stats.oldestMemory?.toISOString()}`)
  console.log(`   Newest: ${stats.newestMemory?.toISOString()}`)
}

async function main() {
  console.log('🧠 Johnny Memory Service - E2E Test with Real Embeddings')
  console.log('='.repeat(70))

  try {
    await cleanupTestData()
    await storeTestData()
    const { passed, failed } = await runSearchTests()
    await testFilteredSearch()
    await testMentionCooldown()
    await showStats()

    console.log('\n' + '='.repeat(70))
    if (failed === 0) {
      console.log('🎉 All tests passed! Semantic search is working correctly.')
    } else {
      console.log(`⚠️  ${failed} test(s) failed. Review results above.`)
    }

  } catch (error) {
    console.error('\n❌ Error:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
