import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { findNearbyMatches } from '../src/lib/matching/nearby'
import { getTopNationwideMatches } from '../src/lib/matching/nationwide'
import { getDb } from '../src/lib/firebase-admin'

function loadEnvFile(filename: string): void {
  const path = resolve(process.cwd(), filename)
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

async function main() {
  const uid = process.argv[2]?.trim()
  if (!uid) {
    console.error('Usage: npx tsx scripts/check-user-matches.ts UID')
    process.exit(1)
  }

  const userSnap = await getDb().collection('users').doc(uid).get()
  const data = userSnap.data() ?? {}
  console.log('ageRange:', data.ageRangeMin, '-', data.ageRangeMax)
  console.log('age:', data.age)

  for (const radius of [0, 10, 25, 50, 150]) {
    const result = await findNearbyMatches(uid, radius, 5, { includeCloseCount: true })
    console.log(
      `\nradius=${radius}mi -> ${result.matches.length} matches, closeCount=${result.closeMatchCount}`,
    )
    for (const match of result.matches.slice(0, 15)) {
      console.log(
        `  - ${match.name} | ${match.location} | ${match.distance}mi | ${match.overall}%`,
      )
    }
  }

  const nationwide = await getTopNationwideMatches(uid, 50, true)
  console.log(`\nnationwide (force refresh): ${nationwide.length}`)
  for (const match of nationwide.slice(0, 15)) {
    const m = match as Record<string, unknown>
    console.log(`  - ${m.name} | ${m.location} | ${m.overall}%`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
