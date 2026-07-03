interface AppleJwsPayload {
  transactionId?: string | number
  originalTransactionId?: string | number
  productId?: string
  bundleId?: string
  expiresDate?: string | number
}

export function decodeAppleJwsPayload(signedPayload: string): AppleJwsPayload {
  const parts = signedPayload.trim().split('.')
  if (parts.length < 2) {
    throw new Error('Invalid Apple signed payload')
  }
  const segment = parts[1]!
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const decoded = Buffer.from(padded, 'base64').toString('utf8')
  return JSON.parse(decoded) as AppleJwsPayload
}

export function resolveTransactionId(
  payload: AppleJwsPayload,
  fallback?: string,
): string {
  const raw = payload.transactionId ?? payload.originalTransactionId ?? fallback
  const value = String(raw ?? '').trim()
  if (!value) throw new Error('Missing transaction id')
  return value
}

export function resolveOriginalTransactionId(
  payload: AppleJwsPayload,
  transactionId: string,
): string {
  const raw = payload.originalTransactionId ?? payload.transactionId ?? transactionId
  return String(raw ?? '').trim() || transactionId
}

export function resolveExpiresIso(payload: AppleJwsPayload): string | null {
  const raw = payload.expiresDate
  if (raw == null || String(raw).trim() === '') return null
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString()
  }
  const parsed = Date.parse(String(raw))
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString()
  }
  return null
}
