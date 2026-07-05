import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getDb } from '../src/lib/firebase-admin'
import { findNearbyMatches } from '../src/lib/matching/nearby'
import { isNYMetroArea, sharedMetroArea } from '../src/lib/location/metro-areas'
import { resolveProfileLocation } from '../src/lib/location/normalize'
import { readStoredCoords } from '../src/lib/matching/geocode-cache'

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
  const uid = process.argv[2] ?? '8WLgCiKj73cEHj5LecmMBvvq31Z2'
  const searchName = (process.argv[3] ?? 'Shally').toLowerCase()

  const db = getDb()
  const [viewerSnap, viewerPublicSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])
  const viewer = { ...(viewerSnap.data() ?? {}), ...(viewerPublicSnap.data() ?? {}) }

  const result = await findNearbyMatches(uid, 50, 5, { closeCountOnly: true })
  console.log('closeMatchCount:', result.closeMatchCount)
  console.log('previews:', result.closeMatches)

  const completed = await db.collection('quizProgress').where('completed', '==', true).get()
  for (const doc of completed.docs) {
    const [userSnap, publicSnap] = await Promise.all([
      db.collection('users').doc(doc.id).get(),
      db.collection('publicProfiles').doc(doc.id).get(),
    ])
    const merged = { ...(userSnap.data() ?? {}), ...(publicSnap.data() ?? {}) }
    const name = String(publicSnap.data()?.name ?? '').trim()
    if (!name.toLowerCase().includes(searchName)) continue

    console.log('\n=== Candidate:', name, doc.id, '===')
    console.log('location:', merged.location)
    console.log('normalized:', resolveProfileLocation(merged)?.display ?? 'unparsed')
    console.log('inMetro:', isNYMetroArea(merged))
    console.log('sharedMetro:', sharedMetroArea(viewer, merged))
    console.log('coords:', readStoredCoords(merged))
    console.log('in previews:', result.closeMatches.some((p) => p.userId === doc.id))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
