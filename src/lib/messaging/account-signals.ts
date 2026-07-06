import { createHash } from 'crypto'
import { FieldValue, Timestamp, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import { analyzeProfileSolicitationSignals } from '@/lib/messaging/content-moderation'

export interface MessagingAccountSignals {
  /** Hard block — do not allow send */
  restricted: boolean
  /** Soft signal — allow but log for review */
  flagged: boolean
  reasons: string[]
}

const DUPLICATE_BROADCAST_WINDOW_MS = 24 * 60 * 60 * 1000
const DUPLICATE_BROADCAST_MIN_RECIPIENTS = 3
const RAPID_START_WINDOW_MS = 60 * 60 * 1000
const RAPID_START_THRESHOLD = 8

function hashMessage(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 32)
}

const RAPID_START_SCAN_LIMIT = 100

function isMissingFirestoreIndexError(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code
  return code === 9 || code === 'failed-precondition'
}

function countRecentConversationStarts(
  docs: QueryDocumentSnapshot[],
  cutoffMs: number,
): number {
  let count = 0
  for (const doc of docs) {
    const createdAt = doc.data().createdAt as Timestamp | undefined
    const ms = typeof createdAt?.toMillis === 'function' ? createdAt.toMillis() : 0
    if (ms >= cutoffMs) count++
    if (count >= RAPID_START_THRESHOLD) break
  }
  return count
}

async function countRecentConversationStartsByInitiator(
  db: Firestore,
  uid: string,
  cutoffMs: number,
): Promise<number> {
  const since = Timestamp.fromMillis(cutoffMs)
  try {
    const recentStarts = await db
      .collection('conversations')
      .where('initiatorId', '==', uid)
      .where('createdAt', '>=', since)
      .limit(RAPID_START_THRESHOLD + 1)
      .get()
    return recentStarts.size
  } catch (error) {
    if (!isMissingFirestoreIndexError(error)) throw error
  }

  const recentStarts = await db
    .collection('conversations')
    .where('initiatorId', '==', uid)
    .limit(RAPID_START_SCAN_LIMIT)
    .get()
  return countRecentConversationStarts(recentStarts.docs, cutoffMs)
}

/**
 * Account-level trust signals for messaging (bio, broadcast spam, rapid starts).
 * User reports are handled separately and weighted higher in `flagConversation`.
 */
export async function evaluateMessagingAccountSignals(uid: string): Promise<MessagingAccountSignals> {
  const db = getDb()
  const reasons: string[] = []
  let restricted = false
  let flagged = false

  const [userSnap, profileSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])

  const userData = userSnap.data() ?? {}
  const profile = profileSnap.data() ?? {}

  const trustFlags = Array.isArray(userData.trustSafetyFlags) ? (userData.trustSafetyFlags as string[]) : []
  if (trustFlags.includes('multi_account_device')) {
    flagged = true
    reasons.push('multi_account_device')
  }
  if (trustFlags.includes('messaging_review_required')) {
    restricted = true
    reasons.push('messaging_review_required')
  }

  const profileScan = analyzeProfileSolicitationSignals(
    profile.about as string | undefined,
    profile.aspirations as string | undefined,
    Array.isArray(profile.interests) ? (profile.interests as string[]).join(' ') : undefined,
  )
  if (profileScan.action === 'block') {
    restricted = true
    reasons.push('profile_solicitation')
  } else if (profileScan.action === 'flag') {
    flagged = true
    reasons.push('profile_payment_or_contact')
  }

  const cutoffMs = Date.now() - RAPID_START_WINDOW_MS
  const recentStartCount = await countRecentConversationStartsByInitiator(db, uid, cutoffMs)

  if (recentStartCount >= RAPID_START_THRESHOLD) {
    flagged = true
    reasons.push('rapid_conversation_starts')
  }

  return { restricted, flagged, reasons }
}

/** Detect same message body sent to many recipients (broadcast spam). */
export async function checkDuplicateBroadcast(
  senderId: string,
  messageText: string,
): Promise<{ isBroadcast: boolean; recipientCount: number }> {
  const db = getDb()
  const digest = hashMessage(messageText)
  const since = Timestamp.fromMillis(Date.now() - DUPLICATE_BROADCAST_WINDOW_MS)

  const recent = await db
    .collection('messagingModerationEvents')
    .where('userId', '==', senderId)
    .where('type', '==', 'dm_sent')
    .where('createdAt', '>=', since)
    .limit(50)
    .get()

  const recipientIds = new Set<string>()
  recent.docs.forEach((doc) => {
    const data = doc.data()
    if (data.messageDigest !== digest) return
    const rid = data.recipientId as string | undefined
    if (rid) recipientIds.add(rid)
  })

  return {
    isBroadcast: recipientIds.size >= DUPLICATE_BROADCAST_MIN_RECIPIENTS - 1,
    recipientCount: recipientIds.size + 1,
  }
}

export async function logDmSentEvent(params: {
  userId: string
  recipientId: string
  conversationId: string
  messageId: string
  messageDigest: string
  moderationAction: string
  categories?: string[]
}) {
  await getDb().collection('messagingModerationEvents').add({
    type: 'dm_sent',
    userId: params.userId,
    recipientId: params.recipientId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    messageDigest: params.messageDigest,
    moderationAction: params.moderationAction,
    categories: params.categories ?? [],
    createdAt: FieldValue.serverTimestamp(),
  })
}

export function messageDigest(text: string): string {
  return hashMessage(text)
}
