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
    return {
      message: error.message,
      status: error.status,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  if (error instanceof Error) {
    return { message: error.message, status: 500 }
  }
  return { message: 'Unexpected error', status: 500 }
}
