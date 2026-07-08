#!/usr/bin/env tsx
/**
 * Pre-launch production env audit. Run against Vercel env or local .env.local:
 *   npx tsx scripts/audit-production-env.ts
 */
import { loadEnvFile } from '../src/lib/load-env-file'

loadEnvFile('.env.local')

type Finding = { level: 'error' | 'warn' | 'ok'; message: string }

const findings: Finding[] = []

function check(name: string, ok: boolean, errorMessage: string, warnMessage?: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    findings.push({ level: 'error', message: `${name} is not set — ${errorMessage}` })
    return
  }
  if (warnMessage) {
    findings.push({ level: 'warn', message: `${name}=${value} — ${warnMessage}` })
  } else {
    findings.push({ level: 'ok', message: `${name} is set` })
  }
}

check('FIREBASE_PRIVATE_KEY', Boolean(process.env.FIREBASE_PRIVATE_KEY?.trim()), 'Firebase Admin will not work')
check('CRON_SECRET', Boolean(process.env.CRON_SECRET?.trim()), 'Cron/admin routes are unprotected', 'Use a long random secret (32+ chars)')
check('RIDGITS_PHONE_HASH_SALT', Boolean(process.env.RIDGITS_PHONE_HASH_SALT?.trim()), 'Phone hashes use predictable default salt')
check('RIDGITS_PROFILE_PHOTO_HASH_SALT', Boolean(process.env.RIDGITS_PROFILE_PHOTO_HASH_SALT?.trim()), 'Photo hashes use predictable default salt')
check('RIDGITS_IDENTITY_DOCUMENT_HASH_SALT', Boolean(process.env.RIDGITS_IDENTITY_DOCUMENT_HASH_SALT?.trim()), 'Document hashes use predictable default salt')

const bypass = process.env.RIDGITS_BYPASS_EMAILS?.trim() ?? ''
if (!bypass) {
  findings.push({ level: 'ok', message: 'RIDGITS_BYPASS_EMAILS is empty (good for production)' })
} else if (bypass.includes('example.com') || bypass.includes('qa@')) {
  findings.push({
    level: 'error',
    message: `RIDGITS_BYPASS_EMAILS contains example/QA addresses: ${bypass}`,
  })
} else {
  findings.push({
    level: 'warn',
    message: `RIDGITS_BYPASS_EMAILS is set (${bypass.split(',').length} emails) — confirm each is intentional`,
  })
}

if (!process.env.APP_STORE_APP_APPLE_ID?.trim() && process.env.APP_STORE_ENVIRONMENT !== 'Sandbox') {
  findings.push({
    level: 'warn',
    message: 'APP_STORE_APP_APPLE_ID is unset — required for Production IAP JWS verification',
  })
}

console.log('\n=== Ridgits production env audit ===\n')
for (const finding of findings) {
  const prefix = finding.level === 'error' ? 'ERROR' : finding.level === 'warn' ? 'WARN ' : 'OK   '
  console.log(`${prefix}  ${finding.message}`)
}

const errors = findings.filter((f) => f.level === 'error').length
const warns = findings.filter((f) => f.level === 'warn').length
console.log(`\nSummary: ${errors} error(s), ${warns} warning(s)\n`)
process.exit(errors > 0 ? 1 : 0)
