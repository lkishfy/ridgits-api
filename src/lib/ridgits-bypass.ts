/** QA / App Review emails from `RIDGITS_BYPASS_EMAILS` (comma-separated, Vercel env). */
function parseBypassEmails(): Set<string> {
  const raw = process.env.RIDGITS_BYPASS_EMAILS ?? ''
  return new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isRidgitsBypassEmail(email: string | null | undefined): boolean {
  if (!email?.trim()) return false
  return parseBypassEmails().has(email.trim().toLowerCase())
}
