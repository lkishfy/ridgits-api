import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage, type Storage } from 'firebase-admin/storage'

let _app: App | null = null
let _auth: Auth | null = null
let _db: Firestore | null = null
let _storage: Storage | null = null

/** Normalize FIREBASE_PRIVATE_KEY from Vercel / .env / JSON service-account paste. */
export function normalizeFirebasePrivateKey(raw: string): string {
  let key = raw.trim()

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim()
  }

  key = key.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n')
  if (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n')
  }

  return key.trim()
}

export function assertFirebasePrivateKeyFormat(privateKey: string): void {
  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY must include -----BEGIN PRIVATE KEY-----. ' +
        'Copy the private_key field from the Firebase service-account JSON.',
    )
  }
  if (!privateKey.includes('-----END PRIVATE KEY-----')) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY is truncated or missing -----END PRIVATE KEY-----. ' +
        'Re-paste the full key in Vercel as one line with \\n between PEM lines.',
    )
  }
}

export function getFirebaseApp(): App {
  if (_app) return _app

  if (getApps().length > 0) {
    _app = getApps()[0]!
    return _app
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim()
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim()
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY

  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error('Firebase Admin env vars are required')
  }

  const privateKey = normalizeFirebasePrivateKey(privateKeyRaw)
  assertFirebasePrivateKeyFormat(privateKey)

  try {
    _app = initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Firebase Admin credential failed to initialize (${message}). ` +
        'Fix FIREBASE_PRIVATE_KEY in Vercel: paste the service-account private_key as one line with literal \\n characters, without extra quotes.',
    )
  }
  return _app
}

export function getAuthInstance(): Auth {
  if (!_auth) _auth = getAuth(getFirebaseApp())
  return _auth
}

export function getDb(): Firestore {
  if (!_db) _db = getFirestore(getFirebaseApp())
  return _db
}

export function getStorageInstance(): Storage {
  if (!_storage) _storage = getStorage(getFirebaseApp())
  return _storage
}

export async function verifyIdToken(token: string) {
  return getAuthInstance().verifyIdToken(token)
}
