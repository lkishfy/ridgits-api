import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ApiError } from '@/lib/api-errors'

const DEFAULT_ALLOWED_HOSTS = [
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
]

/** Temporary URLs from Stripe Identity `fileLinks.create` (ID verification selfie). */
const STRIPE_IDENTITY_FILE_HOSTS = new Set(['files.stripe.com'])

function allowedHosts(): Set<string> {
  const fromEnv = (process.env.RIDGITS_PROFILE_PHOTO_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...fromEnv])
}

function isPrivateOrLocalIp(address: string): boolean {
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  if (address.startsWith('fc') || address.startsWith('fd')) return true
  if (address.startsWith('fe80:')) return true

  const ipVersion = isIP(address)
  if (ipVersion === 4) {
    const parts = address.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true
    const [a, b] = parts
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  if (ipVersion === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized.startsWith('::ffff:127.')) return true
  }

  return false
}

async function assertResolvedHostSafe(hostname: string): Promise<void> {
  const lower = hostname.trim().toLowerCase()
  if (!lower || lower === 'localhost') {
    throw new ApiError('Profile photo URL host is not allowed.', 412, 'INVALID_PROFILE_PHOTO')
  }

  const ipVersion = isIP(lower)
  if (ipVersion) {
    if (isPrivateOrLocalIp(lower)) {
      throw new ApiError('Profile photo URL host is not allowed.', 412, 'INVALID_PROFILE_PHOTO')
    }
    return
  }

  let records: Array<{ address: string }>
  try {
    records = await lookup(lower, { all: true, verbatim: true })
  } catch {
    throw new ApiError('Profile photo URL could not be resolved.', 412, 'INVALID_PROFILE_PHOTO')
  }

  if (!records.length) {
    throw new ApiError('Profile photo URL could not be resolved.', 412, 'INVALID_PROFILE_PHOTO')
  }

  for (const record of records) {
    if (isPrivateOrLocalIp(record.address)) {
      throw new ApiError('Profile photo URL host is not allowed.', 412, 'INVALID_PROFILE_PHOTO')
    }
  }
}

/** Restrict profile photo fetches to trusted storage hosts and block private/link-local IPs. */
export async function assertAllowedProfilePhotoUrl(url: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new ApiError('Profile photo URL is invalid.', 412, 'INVALID_PROFILE_PHOTO')
  }

  if (parsed.protocol !== 'https:') {
    throw new ApiError('Profile photo URL must use https.', 412, 'INVALID_PROFILE_PHOTO')
  }

  const hostname = parsed.hostname.toLowerCase()
  const allowed = allowedHosts()
  const hostAllowed =
    allowed.has(hostname) ||
    hostname.endsWith('.firebasestorage.app') ||
    hostname.endsWith('.appspot.com')

  if (!hostAllowed) {
    throw new ApiError(
      'Profile photo must be hosted on Ridgits storage. Re-upload your photo from the app.',
      412,
      'INVALID_PROFILE_PHOTO',
    )
  }

  const skipDnsCheck =
    allowed.has(hostname) ||
    hostname.endsWith('.firebasestorage.app') ||
    hostname.endsWith('.appspot.com')

  if (!skipDnsCheck) {
    await assertResolvedHostSafe(hostname)
  }
  return parsed
}

/** Restrict Stripe Identity selfie fetches to short-lived file link URLs only. */
export async function assertAllowedStripeIdentitySelfieUrl(url: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new ApiError(
      "We couldn't verify your profile photo against your ID.",
      502,
      'IDENTITY_SELFIE_UNAVAILABLE',
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new ApiError(
      "We couldn't verify your profile photo against your ID.",
      502,
      'IDENTITY_SELFIE_UNAVAILABLE',
    )
  }

  const hostname = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  const hostAllowed =
    STRIPE_IDENTITY_FILE_HOSTS.has(hostname) ||
    (hostname.endsWith('.stripe.com') && path.startsWith('/v1/links/'))

  if (!hostAllowed) {
    throw new ApiError(
      "We couldn't verify your profile photo against your ID.",
      502,
      'IDENTITY_SELFIE_UNAVAILABLE',
    )
  }

  return parsed
}
