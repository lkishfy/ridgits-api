import type { CollectionReference, DocumentReference, Firestore, Query } from 'firebase-admin/firestore'
import { getAuthInstance, getDb } from '@/lib/firebase-admin'

const BATCH_SIZE = 400

async function deleteCollection(db: Firestore, collectionRef: CollectionReference): Promise<void> {
  while (true) {
    const snapshot = await collectionRef.limit(BATCH_SIZE).get()
    if (snapshot.empty) return

    const batch = db.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
}

async function deleteSubcollections(parentRef: DocumentReference, names: string[]): Promise<void> {
  const db = getDb()
  for (const name of names) {
    await deleteCollection(db, parentRef.collection(name))
  }
}

async function deleteQueryMatches(
  db: Firestore,
  query: Query,
): Promise<void> {
  while (true) {
    const snapshot = await query.limit(BATCH_SIZE).get()
    if (snapshot.empty) return

    for (const doc of snapshot.docs) {
      await deleteSubcollections(doc.ref, ['messages'])
    }

    const batch = db.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
}

export async function deleteRidgitsAccount(uid: string): Promise<void> {
  const db = getDb()
  const userDocRef = db.collection('users').doc(uid)

  await deleteSubcollections(userDocRef, [
    'agentConversations',
    'journalEntries',
    'datePlans',
    'devices',
    'notificationPreferences',
    'blocked',
  ])

  const topLevelCollections = [
    'quizProgress',
    'profileAnalysis',
    'messageAnalysis',
    'vibeCheckAnalysis',
    'marketingPreferences',
    'publicProfiles',
    'topNationwideMatches',
  ]

  const primaryBatch = db.batch()
  primaryBatch.delete(userDocRef)
  for (const collectionName of topLevelCollections) {
    primaryBatch.delete(db.collection(collectionName).doc(uid))
  }
  await primaryBatch.commit()

  await deleteQueryMatches(db, db.collection('ridgits').where('userId', '==', uid))
  await deleteQueryMatches(
    db,
    db.collection('bulletinBoardWalkieTalkie').where('userId', '==', uid),
  )
  await deleteQueryMatches(db, db.collection('pokes').where('fromUserId', '==', uid))
  await deleteQueryMatches(db, db.collection('pokes').where('toUserId', '==', uid))
  await deleteQueryMatches(db, db.collection('profileCodes').where('userId', '==', uid))
  await deleteQueryMatches(
    db,
    db.collection('conversations').where('participantIds', 'array-contains', uid),
  )

  await getAuthInstance().deleteUser(uid)
}
