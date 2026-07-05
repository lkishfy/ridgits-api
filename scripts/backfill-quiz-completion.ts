/**
 * Backfill quizProgress.completed for legacy users who meet matching eligibility
 * but never received the literal completed=true flag.
 *
 * Usage (from ridgits-api/):
 *   npm run backfill:quiz-completion
 *   npm run backfill:quiz-completion -- --dry-run
 *   npm run backfill:quiz-completion -- --limit 100
 *   npm run backfill:quiz-completion -- --uid YOUR_FIREBASE_UID
 *
 * Requires Firebase Admin credentials in .env.local (same as `npm run dev`).
 * Note: `vercel env pull` leaves sensitive Firebase vars empty — copy them from the
 * Vercel dashboard, or run on production:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://<your-domain>/api/admin/backfill-quiz-completion?dryRun=1"
 */

import { backfillQuizCompletion } from '../src/lib/admin/backfill-quiz-completion'
import { assertFirebaseAdminEnv, loadEnvFile } from '../src/lib/load-env-file'

loadEnvFile('.env.local')
loadEnvFile('.env')

type Options = {
  dryRun: boolean
  limit: number | null
  uid: string | null
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    limit: null,
    uid: null,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--limit') {
      options.limit = parseInt(argv[i + 1] ?? '', 10)
      i += 1
      continue
    }
    if (arg === '--uid') {
      options.uid = String(argv[i + 1] ?? '').trim() || null
      i += 1
    }
  }

  return options
}

async function main(): Promise<void> {
  assertFirebaseAdminEnv()

  const options = parseArgs(process.argv.slice(2))
  console.log(
    `Backfill quiz completion (dryRun=${options.dryRun}, limit=${options.limit ?? 'none'})`,
  )

  const result = await backfillQuizCompletion({
    dryRun: options.dryRun,
    limit: options.limit,
    uid: options.uid,
  })

  console.log(`Found ${result.candidates} eligible profile(s) missing completed=true.`)

  if (options.dryRun) {
    for (const uid of result.candidateUids.slice(0, 50)) {
      console.log(`[dry-run] would mark completed: ${uid}`)
    }
    if (result.candidateUids.length > 50) {
      console.log(`... and ${result.candidateUids.length - 50} more`)
    }
  }

  console.log(`Done. updated=${result.updated}, failed=${result.failed}, skipped=${result.skipped}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
