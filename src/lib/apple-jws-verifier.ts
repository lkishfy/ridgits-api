import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
} from '@apple/app-store-server-library'
import { ApiError } from '@/lib/api-errors'
import { decodeAppleJwsPayload } from '@/lib/apple-jws'
import { RIDGITS_BUNDLE_ID } from '@/lib/ridgits-products'

const verifiers = new Map<Environment, SignedDataVerifier>()
let rootCAs: Buffer[] | null = null

function loadAppleRootCAs(): Buffer[] {
  if (rootCAs) return rootCAs
  const certDir = join(process.cwd(), 'certs')
  const files = ['AppleRootCA-G3.cer', 'AppleRootCA-G2.cer', 'AppleIncRootCertificate.cer']
  rootCAs = files.map((file) => readFileSync(join(certDir, file)))
  return rootCAs
}

function resolvePreferredEnvironment(): Environment {
  const raw = process.env.APP_STORE_ENVIRONMENT?.trim().toLowerCase()
  const appAppleId = process.env.APP_STORE_APP_APPLE_ID?.trim()
  if (raw === 'production' && appAppleId) return Environment.PRODUCTION
  return Environment.SANDBOX
}

function canVerifyProduction(): boolean {
  return Boolean(process.env.APP_STORE_APP_APPLE_ID?.trim())
}

function environmentHintFromJws(signedPayload: string): Environment | null {
  try {
    const payload = decodeAppleJwsPayload(signedPayload) as { environment?: string }
    if (payload.environment === 'Sandbox') return Environment.SANDBOX
    if (payload.environment === 'Production') return Environment.PRODUCTION
  } catch {
    // Ignore decode errors — verification will fail below if the JWS is invalid.
  }
  return null
}

function environmentsToTry(signedPayload: string): Environment[] {
  const preferred = resolvePreferredEnvironment()
  const alternate =
    preferred === Environment.PRODUCTION ? Environment.SANDBOX : Environment.PRODUCTION
  const hinted = environmentHintFromJws(signedPayload)
  const ordered = hinted ? [hinted, preferred, alternate] : [preferred, alternate]

  return [...new Set(ordered)].filter(
    (environment) => environment !== Environment.PRODUCTION || canVerifyProduction(),
  )
}

function getVerifier(environment: Environment): SignedDataVerifier {
  const cached = verifiers.get(environment)
  if (cached) return cached

  const appAppleIdRaw = process.env.APP_STORE_APP_APPLE_ID?.trim()
  const appAppleId = appAppleIdRaw ? Number(appAppleIdRaw) : undefined

  if (environment === Environment.PRODUCTION && !appAppleId) {
    throw new Error('APP_STORE_APP_APPLE_ID is required when APP_STORE_ENVIRONMENT=Production')
  }

  const verifier = new SignedDataVerifier(
    loadAppleRootCAs(),
    true,
    environment,
    RIDGITS_BUNDLE_ID,
    appAppleId,
  )
  verifiers.set(environment, verifier)
  return verifier
}

type VerifyFn = (verifier: SignedDataVerifier, signedPayload: string) => Promise<unknown>

async function verifyWithFallback(
  signedPayload: string,
  verify: VerifyFn,
  errorMessage: string,
): Promise<Record<string, unknown>> {
  const trimmed = signedPayload.trim()
  let lastVerificationError: VerificationException | null = null

  for (const environment of environmentsToTry(trimmed)) {
    try {
      const decoded = await verify(getVerifier(environment), trimmed)
      return decoded as Record<string, unknown>
    } catch (error) {
      if (error instanceof VerificationException) {
        lastVerificationError = error
        continue
      }
      throw error
    }
  }

  if (lastVerificationError) {
    console.warn('[apple-jws] verification failed for all environments', {
      status: lastVerificationError.status,
      bundleId: RIDGITS_BUNDLE_ID,
      tried: environmentsToTry(trimmed),
    })
    throw new ApiError(errorMessage, 400, 'INVALID_IAP_SIGNATURE')
  }

  throw new ApiError(errorMessage, 400, 'INVALID_IAP_SIGNATURE')
}

export async function verifyAppleTransactionJws(signedTransactionInfo: string): Promise<Record<string, unknown>> {
  return verifyWithFallback(
    signedTransactionInfo,
    (verifier, signed) => verifier.verifyAndDecodeTransaction(signed),
    'Invalid App Store transaction signature.',
  )
}

export async function verifyAppleNotificationJws(signedPayload: string): Promise<Record<string, unknown>> {
  return verifyWithFallback(
    signedPayload,
    (verifier, signed) => verifier.verifyAndDecodeNotification(signed),
    'Invalid App Store notification signature.',
  )
}

export async function verifyAppleRenewalJws(signedRenewalInfo: string): Promise<Record<string, unknown>> {
  return verifyWithFallback(
    signedRenewalInfo,
    (verifier, signed) => verifier.verifyAndDecodeRenewalInfo(signed),
    'Invalid App Store renewal signature.',
  )
}

/** @internal Test helper */
export function resetAppleJwsVerifiersForTests() {
  verifiers.clear()
  rootCAs = null
}
