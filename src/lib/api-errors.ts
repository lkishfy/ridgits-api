export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiErrorResponse(error: unknown): { message: string; status: number } {
  if (error instanceof ApiError) {
    return { message: error.message, status: error.status }
  }
  if (error instanceof Error) {
    return { message: error.message, status: 500 }
  }
  return { message: 'Unexpected error', status: 500 }
}
