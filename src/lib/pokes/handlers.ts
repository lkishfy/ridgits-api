import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { sendEngagementPush } from '@/lib/push-notifications'
import { getDb } from '@/lib/firebase-admin'
import { isVisibleInCommunity } from '@/lib/matching/compatibility'

async function getDisplayName(uid: string): Promise<string> {
  const snap = await getDb().collection('publicProfiles').doc(uid).get()
  const name = String(snap.data()?.name ?? '').trim()
  return name || 'Someone on Ridgits'
}

async function ensureNoMutualBlocks(senderId: string, recipientId: string) {
  const db = getDb()
  const [senderBlockedSnap, recipientBlockedSnap] = await Promise.all([
    db.collection('users').doc(senderId).collection('blocked').doc(recipientId).get(),
    db.collection('users').doc(recipientId).collection('blocked').doc(senderId).get(),
  ])
  if (senderBlockedSnap.exists) throw new ApiError('You have blocked this user.', 412)
  if (recipientBlockedSnap.exists) throw new ApiError('This user is not accepting pokes from you.', 403)
}

export async function sendPoke(senderId: string, toUserId: string) {
  if (senderId === toUserId) throw new ApiError('You cannot poke yourself.', 400)

  const db = getDb()
  const [senderSnap, recipientSnap, senderPublicSnap, recipientPublicSnap] = await Promise.all([
    db.collection('users').doc(senderId).get(),
    db.collection('users').doc(toUserId).get(),
    db.collection('publicProfiles').doc(senderId).get(),
    db.collection('publicProfiles').doc(toUserId).get(),
  ])
  if (!senderSnap.exists) throw new ApiError('Complete your profile before poking.', 412)
  if (!recipientSnap.exists) throw new ApiError('Recipient not found.', 404)
  if (!isVisibleInCommunity(senderSnap.data()) || !isVisibleInCommunity(senderPublicSnap.data())) {
    throw new ApiError('Turn on community visibility in your profile to send pokes.', 412)
  }
  if (!isVisibleInCommunity(recipientSnap.data()) || !isVisibleInCommunity(recipientPublicSnap.data())) {
    throw new ApiError('This user is not visible in the community.', 403)
  }

  await ensureNoMutualBlocks(senderId, toUserId)

  const existing = await db
    .collection('pokes')
    .where('fromUserId', '==', senderId)
    .where('toUserId', '==', toUserId)
    .limit(1)
    .get()

  if (!existing.empty) {
    return { pokeId: existing.docs[0]!.id, alreadySent: true }
  }

  const [fromName, toName] = await Promise.all([getDisplayName(senderId), getDisplayName(toUserId)])
  const ref = await db.collection('pokes').add({
    fromUserId: senderId,
    toUserId,
    fromName,
    toName,
    createdAt: FieldValue.serverTimestamp(),
    status: 'sent',
    seen: false,
    profileVisited: false,
  })

  await sendEngagementPush({
    userId: toUserId,
    category: 'pokes',
    type: 'poke',
    title: `${fromName} poked you`,
    body: 'Tap to see who is interested nearby.',
    collapseKey: `poke-${senderId}`,
    data: {
      route: 'matches',
      pokeId: ref.id,
      fromUserId: senderId,
    },
  })

  return { pokeId: ref.id, alreadySent: false }
}

export async function markPokeSeen(userId: string, pokeId: string) {
  const db = getDb()
  const ref = db.collection('pokes').doc(pokeId)
  const snap = await ref.get()
  if (!snap.exists) throw new ApiError('Poke not found.', 404)
  const data = snap.data() ?? {}
  if (data.toUserId !== userId) throw new ApiError('Not allowed.', 403)

  await ref.set({ seen: true, seenAt: FieldValue.serverTimestamp() }, { merge: true })
  return { pokeId, seen: true }
}

export async function markPokeProfileVisited(userId: string, pokeId: string) {
  const db = getDb()
  const ref = db.collection('pokes').doc(pokeId)
  const snap = await ref.get()
  if (!snap.exists) throw new ApiError('Poke not found.', 404)
  const data = snap.data() ?? {}
  if (data.toUserId !== userId) throw new ApiError('Not allowed.', 403)

  await ref.set(
    {
      seen: true,
      profileVisited: true,
      profileVisitedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  return { pokeId, profileVisited: true }
}

export async function unpoke(senderId: string, pokeId: string) {
  const db = getDb()
  const ref = db.collection('pokes').doc(pokeId)
  const snap = await ref.get()
  if (!snap.exists) throw new ApiError('Poke not found.', 404)
  const data = snap.data() ?? {}
  if (data.fromUserId !== senderId) throw new ApiError('Not allowed.', 403)
  await ref.delete()
  return { pokeId, removed: true }
}
