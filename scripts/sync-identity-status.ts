import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getDb } from '../src/lib/firebase-admin'
import { getIdentityStatus } from '../src/lib/trust-safety/stripe-identity'

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
  const uid = process.argv[2]
  if (!uid) {
    console.error('Usage: npx tsx scripts/sync-identity-status.ts <uid>')
    process.exit(1)
  }

  const before = (await getDb().collection('users').doc(uid).get()).data() ?? {}
  console.log('Before:', {
    stripeVerificationSessionId: before.stripeVerificationSessionId ?? null,
    identityVerificationStatus: before.identityVerificationStatus ?? 'none',
    phoneVerificationStatus: before.phoneVerificationStatus ?? 'none',
  })

  const status = await getIdentityStatus(uid)
  console.log('After sync:', status)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
