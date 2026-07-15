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

if (firestoreRules.includes('publicProfileServerOnlyFields()')) {
  pass('Firestore rules block publicProfiles server-only fields')
} else {
  fail('Firestore rules missing publicProfiles allowlist')
}

if (firestoreRules.includes('quizProgressCannotSelfGrant()') && firestoreRules.includes('allow list: if false')) {
  pass('Firestore rules block quiz self-grant and list harvest')
} else {
  fail('Firestore rules missing quiz anti-spoof protections')
}

if (firestoreRules.includes('match /pokes/{pokeId}') && firestoreRules.includes('allow create: if false')) {
  pass('Firestore rules deny client poke creates')
} else {
  fail('Firestore rules still allow client poke creates')
}

if (firestoreRules.includes('match /iapOwnership/{transactionId}')) {
  pass('Firestore rules deny client iapOwnership access')
} else {
  fail('Firestore rules missing iapOwnership deny block')
}

// 2. Storage delete rules closed + owner-scoped private reads
const storageRules = read('../Ridgits/ridgits/storage.rules')
if (storageRules.includes('allow delete: if false')) {
  pass('Storage rules deny client deletes')
} else {
  fail('Storage rules still allow open deletes')
}

if (storageRules.includes('profile_images/{userId}/additional/{fileName}')) {
  pass('Storage rules include additional profile image path')
} else {
  fail('Storage rules missing additional profile image path')
}

if (storageRules.includes('profile_analyses/{userId}/{fileName}') && storageRules.includes('isOwner(userId)')) {
  pass('Storage rules owner-scope private analysis reads')
} else {
  fail('Storage rules missing owner-scoped private reads')
}

// 3. Apple JWS verification wired
const iap = read('src/lib/ridgits-iap.ts')
if (iap.includes('IAP_OWNERSHIP_COLLECTION') && iap.includes('IAP_ALREADY_CLAIMED')) {
  pass('IAP global ownership collection wired')
} else {
  fail('IAP global ownership missing')
}

if (iap.includes('verifyAppleTransactionJws') && !iap.includes('decodeAppleJwsPayload(signed)')) {
  pass('IAP link-purchase uses verified Apple JWS')
} else {
  fail('IAP may still decode Apple JWS without verification')
}

if (iap.includes('signedRenewalInfo') && iap.includes('INVALID_IAP_SIGNATURE')) {
  pass('IAP sync-renewal requires signedRenewalInfo')
} else {
  fail('IAP sync-renewal missing JWS requirement')
}

const webhook = read('src/app/api/webhooks/app-store/route.ts')
if (webhook.includes('verifyAppleNotificationJws')) {
  pass('App Store webhook verifies notification JWS')
} else {
  fail('App Store webhook missing JWS verification')
}

const stripeWebhook = read('src/app/api/webhooks/stripe-identity/route.ts')
if (stripeWebhook.includes('Webhook verification failed') && !stripeWebhook.includes('error.message')) {
  pass('Stripe identity webhook sanitizes error responses')
} else {
  fail('Stripe identity webhook may leak error details')
}

// 4. SSRF allowlist
const photoUrl = read('src/lib/trust-safety/profile-photo-url.ts')
if (photoUrl.includes('firebasestorage.googleapis.com')) {
  pass('Profile photo URL host allowlist present')
} else {
  fail('Profile photo SSRF allowlist missing')
}

const profilePhoto = read('src/lib/trust-safety/profile-photo.ts')
if (
  profilePhoto.includes('moderation is temporarily unavailable') &&
  profilePhoto.includes('approved: false')
) {
  pass('NSFW moderation fails closed when configured')
} else {
  fail('NSFW moderation may fail open on errors')
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

// 7. App Check library present (flag off until clients ship)
const appCheckLib = read('src/lib/ridgits-app-check.ts')
if (appCheckLib.includes('RIDGITS_REQUIRE_APP_CHECK')) {
  pass('App Check verification library present with env flag')
} else {
  fail('App Check library missing')
}

// 8. Zod schemas for high-risk routes
const schemas = read('src/lib/schemas/ridgits-bodies.ts')
if (
  schemas.includes('linkPurchaseBodySchema') &&
  schemas.includes('pokeSendBodySchema') &&
  schemas.includes('referralRedeemBodySchema')
) {
  pass('Zod schemas present for high-risk routes')
} else {
  fail('Zod schemas missing for high-risk routes')
}

// 9. Account deletion expanded
const deleteAccount = read('src/lib/account/delete-account.ts')
if (deleteAccount.includes('deleteStorageForUser') && deleteAccount.includes('iapOwnership')) {
  pass('Account deletion sweeps storage and iapOwnership')
} else {
  fail('Account deletion missing expanded cleanup')
}

// 10. iOS hardening
const entitlements = read('../Ridgits-iOS/Ridgits/Ridgits.entitlements')
if (entitlements.includes('<string>production</string>')) {
  pass('iOS entitlements use production APNs environment')
} else {
  fail('iOS entitlements still use development APNs')
}

if (entitlements.includes('applinks:ridgits.com')) {
  pass('iOS Universal Links entitlement configured')
} else {
  fail('iOS Universal Links entitlement missing')
}

const apiClient = read('../Ridgits-iOS/Ridgits/Services/RidgitsAPIClient.swift')
if (apiClient.includes('X-Firebase-AppCheck')) {
  pass('iOS API client sends App Check header')
} else {
  fail('iOS API client missing App Check header')
}

const functionsIndex = read('../Ridgits/ridgits/functions/index.js')
if (!functionsIndex.includes('exports.migrateConversations')) {
  pass('Exposed migrateConversations callable removed')
} else {
  fail('migrateConversations callable still exported')
}

console.log('\n=== Pre-launch security checklist ===\n')
for (const msg of passes) console.log(`PASS  ${msg}`)
for (const msg of failures) console.log(`FAIL  ${msg}`)
console.log(`\n${passes.length} passed, ${failures.length} failed\n`)
console.log('Manual deploy steps (not auto-verified):')
console.log('  1. Deploy ridgits-api (App Check flag OFF)')
console.log('  2. Deploy Firestore + Storage rules')
console.log('  3. Deploy Cloud Functions')
console.log('  4. Deploy web client')
console.log('  5. Ship iOS build')
console.log('  6. Enable RIDGITS_REQUIRE_APP_CHECK=true in Vercel')
console.log('  7. Run npx tsx scripts/strip-public-profile-coordinates.ts in production')
console.log('  8. Run npx tsx scripts/audit-production-env.ts')
console.log('  9. Enforce App Check in Firebase Console; restrict API key in GCP')
process.exit(failures.length > 0 ? 1 : 0)
