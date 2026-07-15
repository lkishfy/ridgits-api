#!/usr/bin/env tsx
/**
 * Verify FIREBASE_PRIVATE_KEY parses correctly before deploying to Vercel.
 *   npx tsx scripts/verify-firebase-admin-key.ts
 */
import { loadEnvFile } from '../src/lib/load-env-file'
import {
  assertFirebasePrivateKeyFormat,
  getFirebaseApp,
  normalizeFirebasePrivateKey,
} from '../src/lib/firebase-admin'

loadEnvFile('.env.local')
loadEnvFile('.env')

const raw = process.env.FIREBASE_PRIVATE_KEY?.trim()
if (!raw) {
  console.error('FIREBASE_PRIVATE_KEY is not set in .env.local')
  process.exit(1)
}

try {
  const normalized = normalizeFirebasePrivateKey(raw)
  assertFirebasePrivateKeyFormat(normalized)
  getFirebaseApp()
  console.log('OK — Firebase Admin private key parses successfully.')
} catch (error) {
  console.error('FAIL — Firebase Admin private key is invalid:')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
