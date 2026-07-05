import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

/** Load KEY=VALUE lines from a dotenv file. Skips empty values and does not override non-empty env. */
export function loadEnvFile(filename: string): void {
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
    if (!value) continue

    const existing = process.env[key]
    if (existing === undefined || existing === '') {
      process.env[key] = value
    }
  }
}

export function assertFirebaseAdminEnv(): void {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim()
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim()
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim()

  if (projectId && clientEmail && privateKey) return

  throw new Error(
    'Firebase Admin env vars are missing or empty. ' +
      'Vercel `env pull` omits sensitive values — copy FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY from the Vercel dashboard into .env.local, ' +
      'or run the backfill via POST /api/admin/backfill-quiz-completion on production (Bearer CRON_SECRET).',
  )
}
