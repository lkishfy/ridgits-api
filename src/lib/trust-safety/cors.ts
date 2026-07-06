import { NextRequest, NextResponse } from 'next/server'

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ridgits.com',
  'https://www.ridgits.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

function allowedOrigins(): Set<string> {
  const extra = (process.env.RIDGITS_WEB_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])
}

/** CORS headers for Ridgits web → ridgits-api calls. */
export function publicApiCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!origin || !allowedOrigins().has(origin)) {
    return {}
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  }
}

export function applyWebCors(response: NextResponse, request: NextRequest): NextResponse {
  for (const [key, value] of Object.entries(publicApiCorsHeaders(request))) {
    response.headers.set(key, value)
  }
  return response
}

export function webCorsJson(
  request: NextRequest,
  body: unknown,
  init?: ResponseInit,
): NextResponse {
  const headers = new Headers(init?.headers)
  for (const [key, value] of Object.entries(publicApiCorsHeaders(request))) {
    headers.set(key, value)
  }
  return NextResponse.json(body, { ...init, headers })
}
