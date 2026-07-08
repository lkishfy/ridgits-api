import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
} from '@apple/app-store-server-library'
import { ApiError } from '@/lib/api-errors'
import { RIDGITS_BUNDLE_ID } from '@/lib/ridgits-products'

let verifier: SignedDataVerifier | null = null

function loadAppleRootCAs(): Buffer[] {
  const certDir = join(process.cwd(), 'certs')
  const files = ['AppleRootCA-G3.cer', 'AppleRootCA-G2.cer', 'AppleIncRootCertificate.cer']
  return files.map((file) => readFileSync(join(certDir, file)))
}

function resolveEnvironment(): Environment {
  const raw = process.env.APP_STORE_ENVIRONMENT?.trim().toLowerCase()
  const appAppleId = process.env.APP_STORE_APP_APPLE_ID?.trim()
  if (raw === 'production' && appAppleId) return Environment.PRODUCTION
  return Environment.SANDBOX
}

function getVerifier(): SignedDataVerifier {
  if (verifier) return verifier

  const appAppleIdRaw = process.env.APP_STORE_APP_APPLE_ID?.trim()
  const appAppleId = appAppleIdRaw ? Number(appAppleIdRaw) : undefined
  const environment = resolveEnvironment()

  if (environment === Environment.PRODUCTION && !appAppleId) {
    throw new Error('APP_STORE_APP_APPLE_ID is required when APP_STORE_ENVIRONMENT=Production')
  }

  verifier = new SignedDataVerifier(
    loadAppleRootCAs(),
    true,
    environment,
    RIDGITS_BUNDLE_ID,
    appAppleId,
  )
  return verifier
}

export async function verifyAppleTransactionJws(signedTransactionInfo: string): Promise<Record<string, unknown>> {
  try {
    const decoded = await getVerifier().verifyAndDecodeTransaction(signedTransactionInfo.trim())
    return decoded as unknown as Record<string, unknown>
  } catch (error) {
    if (error instanceof VerificationException) {
      throw new ApiError('Invalid App Store transaction signature.', 400, 'INVALID_IAP_SIGNATURE')
    }
    throw error
  }
}

export async function verifyAppleNotificationJws(signedPayload: string): Promise<Record<string, unknown>> {
  try {
    const decoded = await getVerifier().verifyAndDecodeNotification(signedPayload.trim())
    return decoded as unknown as Record<string, unknown>
  } catch (error) {
    if (error instanceof VerificationException) {
      throw new ApiError('Invalid App Store notification signature.', 400, 'INVALID_IAP_SIGNATURE')
    }
    throw error
  }
}

export async function verifyAppleRenewalJws(signedRenewalInfo: string): Promise<Record<string, unknown>> {
  try {
    const decoded = await getVerifier().verifyAndDecodeRenewalInfo(signedRenewalInfo.trim())
    return decoded as unknown as Record<string, unknown>
  } catch (error) {
    if (error instanceof VerificationException) {
      throw new ApiError('Invalid App Store renewal signature.', 400, 'INVALID_IAP_SIGNATURE')
    }
    throw error
  }
}
