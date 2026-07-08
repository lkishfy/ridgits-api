import {
  sanitizeCustomerFacingMessage,
} from '@/lib/customer-facing-errors'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code?: string,
    /** Present on 429 responses — number of seconds the client should wait before retrying. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiErrorResponse(error: unknown): {
  message: string
  status: number
  code?: string
  retryAfterSeconds?: number
} {
  if (error instanceof ApiError) {
    logMissingFirestoreIndex(error.message, 'ApiError')
    return {
      message: sanitizeCustomerFacingMessage(error.message, error.code),
      status: error.status,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  if (error instanceof Error) {
    logMissingFirestoreIndex(error.message, error.name)
    return {
      message: sanitizeCustomerFacingMessage(error.message),
      status: 500,
    }
  }
  return { message: sanitizeCustomerFacingMessage('Unexpected error'), status: 500 }
}

function logMissingFirestoreIndex(message: string, context: string) {
  if (!/requires an index|failed_precondition/i.test(message)) return

  const match = message.match(/https:\/\/console\.firebase\.google\.com[^\s\]]+/)
  if (match) {
    console.error(`[FirestoreIndex][${context}] Missing index — create it here: ${match[0]}`)
    return
  }

  console.error(`[FirestoreIndex][${context}] Missing index: ${message}`)
}
