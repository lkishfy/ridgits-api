import { getAppCheck } from 'firebase-admin/app-check'
import { ApiError } from '@/lib/api-errors'
import { getFirebaseApp } from '@/lib/firebase-admin'

function getAdminAppCheck() {
  return getAppCheck(getFirebaseApp())
}

export function isAppCheckRequired(): boolean {
  return process.env.RIDGITS_REQUIRE_APP_CHECK === 'true'
}

export async function verifyAppCheckToken(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new ApiError('Missing App Check token', 401, 'APP_CHECK_REQUIRED')
  }

  try {
    await getAdminAppCheck().verifyToken(trimmed)
  } catch (error) {
    console.error('[app-check] verification failed', error)
    throw new ApiError('Invalid App Check token', 401, 'APP_CHECK_INVALID')
  }
}
