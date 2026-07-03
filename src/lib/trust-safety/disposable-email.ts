// Maintained disposable-domain list (~120k+ domains, community maintained, updated via `npm update`).
// https://github.com/disposable-email-domains/disposable-email-domains
import disposableDomainsList from 'disposable-email-domains'
import disposableWildcardList from 'disposable-email-domains/wildcard.json'

function parseEnvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

const EXTRA_BLOCKED_DOMAINS = parseEnvList(process.env.RIDGITS_EXTRA_DISPOSABLE_DOMAINS)
const ALLOWED_DOMAINS = new Set(parseEnvList(process.env.RIDGITS_ALLOWED_EMAIL_DOMAINS))

const DISPOSABLE_DOMAINS = new Set<string>([...disposableDomainsList, ...EXTRA_BLOCKED_DOMAINS])
const DISPOSABLE_WILDCARDS: string[] = [...disposableWildcardList]

export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return null
  return trimmed.slice(at + 1)
}

/**
 * Returns true when the email's domain is a known disposable/temporary-inbox provider.
 * Backed by the community-maintained `disposable-email-domains` package (~120k domains)
 * plus a wildcard TLD list (e.g. `*.tk` throwaway registrars) and an optional env override list.
 */
export function isDisposableEmail(email: string | null | undefined): boolean {
  const domain = extractEmailDomain(email)
  if (!domain) return false
  if (ALLOWED_DOMAINS.has(domain)) return false

  if (DISPOSABLE_DOMAINS.has(domain)) return true

  // Subdomains of a blocked domain (e.g. `foo.mailinator.com`) are blocked too.
  for (const blocked of DISPOSABLE_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true
  }

  // The wildcard list covers registrable domains where *any* subdomain is disposable
  // (e.g. `foo.10mail.org`), so match exact + subdomain the same way as the main list.
  for (const wildcard of DISPOSABLE_WILDCARDS) {
    if (domain === wildcard || domain.endsWith(`.${wildcard}`)) return true
  }

  return false
}

export function assertValidEmailFormat(email: string | null | undefined): boolean {
  if (!email) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}
