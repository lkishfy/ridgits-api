import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { conversationIdForUsers } from '@/lib/messaging/profanity'

/** Social handles are private until viewer and target have an existing relationship. */
export async function assertSocialProfileAccess(viewerUid: string, targetUid: string): Promise<void> {
  if (viewerUid === targetUid) return

  const db = getDb()
  const conversationId = conversationIdForUsers(viewerUid, targetUid)

  const [pokeSnap, conversationSnap] = await Promise.all([
    db
      .collection('pokes')
      .where('fromUserId', 'in', [viewerUid, targetUid])
      .where('toUserId', 'in', [viewerUid, targetUid])
      .limit(1)
      .get(),
    db.collection('conversations').doc(conversationId).get(),
  ])

  if (!pokeSnap.empty) return

  if (conversationSnap.exists) {
    const participantIds = conversationSnap.get('participantIds')
    if (Array.isArray(participantIds) && participantIds.includes(viewerUid) && participantIds.includes(targetUid)) {
      return
    }
  }

  throw new ApiError(
    'Social info unlocks after you match, poke, or message this person.',
    403,
    'SOCIAL_ACCESS_DENIED',
  )
}
