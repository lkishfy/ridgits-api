import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

let _app: App | null = null
let _auth: Auth | null = null
let _db: Firestore | null = null

function getFirebaseApp(): App {
  if (_app) return _app

  if (getApps().length > 0) {
    _app = getApps()[0]!
    return _app
  }

  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin env vars are required')
  }

  _app = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
  })
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

export async function verifyIdToken(token: string) {
  return getAuthInstance().verifyIdToken(token)
}
