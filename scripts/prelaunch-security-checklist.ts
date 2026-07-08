#!/usr/bin/env tsx
/**
 * Pre-launch security verification checklist (static + local checks).
 * Run: npx tsx scripts/prelaunch-security-checklist.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd())
const failures: string[] = []
const passes: string[] = []

function pass(msg: string) {
  passes.push(msg)
}

function fail(msg: string) {
  failures.push(msg)
}

function read(rel: string) {
  return readFileSync(join(root, rel), 'utf8')
}

// 1. Firestore rules deny server-only fields
const firestoreRules = read('../Ridgits/ridgits/firestore.rules')
if (firestoreRules.includes('serverOnlyUserFields()') && firestoreRules.includes('noServerOnlyUserFieldsOnUpdate()')) {
  pass('Firestore rules include server-only field denylist')
} else {
  fail('Firestore rules missing server-only field denylist')
}

// 2. Storage delete rules closed
const storageRules = read('../Ridgits/ridgits/storage.rules')
if (storageRules.includes('allow delete: if false')) {
  pass('Storage rules deny client deletes')
} else {
  fail('Storage rules still allow open deletes')
}

// 3. Apple JWS verification wired
const iap = read('src/lib/ridgits-iap.ts')
if (iap.includes('verifyAppleTransactionJws') && !iap.includes('decodeAppleJwsPayload(signed)')) {
  pass('IAP link-purchase uses verified Apple JWS')
} else {
  fail('IAP may still decode Apple JWS without verification')
}

const webhook = read('src/app/api/webhooks/app-store/route.ts')
if (webhook.includes('verifyAppleNotificationJws')) {
  pass('App Store webhook verifies notification JWS')
} else {
  fail('App Store webhook missing JWS verification')
}

// 4. SSRF allowlist
const photoUrl = read('src/lib/trust-safety/profile-photo-url.ts')
if (photoUrl.includes('firebasestorage.googleapis.com')) {
  pass('Profile photo URL host allowlist present')
} else {
  fail('Profile photo SSRF allowlist missing')
}

// 5. Email verification enforcement
const nearbyRoute = read('src/app/api/matches/nearby/route.ts')
if (nearbyRoute.includes('requireVerifiedEmail')) {
  pass('Nearby route enforces email verification')
} else {
  fail('Nearby route missing email verification')
}

// 6. Social relationship gate
const socialRoute = read('src/app/api/profile/social/route.ts')
if (socialRoute.includes('assertSocialProfileAccess')) {
  pass('Social profile route requires relationship')
} else {
  fail('Social profile route missing relationship gate')
}

// 7. iOS APNs production entitlements
const entitlements = read('../Ridgits-iOS/Ridgits/Ridgits.entitlements')
if (entitlements.includes('<string>production</string>')) {
  pass('iOS entitlements use production APNs environment')
} else {
  fail('iOS entitlements still use development APNs')
}

console.log('\n=== Pre-launch security checklist ===\n')
for (const msg of passes) console.log(`PASS  ${msg}`)
for (const msg of failures) console.log(`FAIL  ${msg}`)
console.log(`\n${passes.length} passed, ${failures.length} failed\n`)
process.exit(failures.length > 0 ? 1 : 0)
