#!/usr/bin/env tsx
/**
 * One-time production cleanup: remove coordinates and other server-only fields
 * from publicProfiles documents. Run with Firebase Admin credentials:
 *   npx tsx scripts/strip-public-profile-coordinates.ts
 */
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '../src/lib/firebase-admin'
import { assertFirebaseAdminEnv, loadEnvFile } from '../src/lib/load-env-file'

loadEnvFile('.env.local')
loadEnvFile('.env')
assertFirebaseAdminEnv()

const SERVER_ONLY_FIELDS = [
  'coordinates',
  'coordinatesUpdatedAt',
  'geocodedFromLocation',
  'subscriptionTier',
  'subscriptionStatus',
  'hasVerifiedBadge',
]

async function main() {
  const db = getDb()
  const snapshot = await db.collection('publicProfiles').get()
  let updated = 0

  for (const doc of snapshot.docs) {
    const data = doc.data()
    const hasServerField = SERVER_ONLY_FIELDS.some((field) => field in data)
    if (!hasServerField) continue

    const patch: Record<string, unknown> = {}
    for (const field of SERVER_ONLY_FIELDS) {
      if (field in data) patch[field] = FieldValue.delete()
    }
    await doc.ref.update(patch)
    updated += 1
  }

  console.log(`Stripped server-only fields from ${updated} publicProfiles documents.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
