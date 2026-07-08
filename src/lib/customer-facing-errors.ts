export const RIDGITS_SUPPORT_EMAIL = 'support@ridgits.com'

const VENDOR_OR_INTERNAL_PATTERNS = [
  /stripe\.com/i,
  /sensitive verification results/i,
  /restricted api key/i,
  /api key/i,
  /ip[- ]?restrict/i,
  /allowlist/i,
  /48 hours ago/i,
  /rekognition/i,
  /aws/i,
  /firebase\.google\.com/i,
  /failed_precondition/i,
  /requires an index/i,
]

/** True when a message looks like a vendor/integration error that should not be shown to members. */
export function isVendorOrInternalErrorMessage(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  return VENDOR_OR_INTERNAL_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export function customerFacingSupportMessage(
  detail = "We couldn't complete this step right now.",
): string {
  return `${detail} Email ${RIDGITS_SUPPORT_EMAIL} and we'll help you get verified.`
}

const CODE_MESSAGES: Record<string, string> = {
  IDENTITY_SELFIE_UNAVAILABLE: customerFacingSupportMessage(
    "We couldn't verify your profile photo against your ID.",
  ),
  FACE_MATCH_UNAVAILABLE: customerFacingSupportMessage(
    "Profile photo verification is not available right now.",
  ),
  IDENTITY_UNAVAILABLE: customerFacingSupportMessage(
    "Identity verification is not available right now.",
  ),
  PROFILE_PHOTO_REQUIRED:
    'Add a profile photo on your profile before starting identity verification. Your photo must match your ID selfie within 48 hours of verifying.',
  INVALID_PROFILE_PHOTO: 'A valid profile photo is required.',
  IDENTITY_VERIFICATION_REQUIRED: 'Verify your identity before messaging.',
  IDENTITY_REVERIFICATION_REQUIRED:
    'Re-verify your identity before matching a new profile photo.',
  PROFILE_PHOTO_IDENTITY_MISMATCH:
    'Your profile photo must match your verified ID selfie to message.',
}

export function customerFacingMessageForCode(code: string | undefined): string | null {
  if (!code) return null
  return CODE_MESSAGES[code] ?? null
}

/** Map vendor/internal errors to member-safe copy; pass through normal product messages. */
export function sanitizeCustomerFacingMessage(
  message: string,
  code?: string,
): string {
  const coded = customerFacingMessageForCode(code)
  if (coded && (isVendorOrInternalErrorMessage(message) || !message.trim())) {
    return coded
  }
  if (isVendorOrInternalErrorMessage(message)) {
    return customerFacingSupportMessage()
  }
  return message.trim() || customerFacingSupportMessage()
}

export function errorMessageText(error: unknown): string {
  if (!error) return ''
  if (error instanceof Error) {
    const stripeLike = error as Error & { raw?: { message?: string } }
    return stripeLike.raw?.message?.trim() || error.message.trim()
  }
  if (typeof error === 'object') {
    const record = error as { message?: string; raw?: { message?: string } }
    return record.raw?.message?.trim() || record.message?.trim() || String(error)
  }
  return String(error)
}

export function isStripeSensitiveVerificationError(error: unknown): boolean {
  return isVendorOrInternalErrorMessage(errorMessageText(error))
}
