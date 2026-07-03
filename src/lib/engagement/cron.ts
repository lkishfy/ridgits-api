import { Timestamp } from 'firebase-admin/firestore'
import { sendEngagementPush } from '@/lib/push-notifications'
import { getDb } from '@/lib/firebase-admin'

const HOUR_MS = 60 * 60 * 1000

export interface EngagementCronResult {
  expiringConversations: number
  pendingRequestReminders: number
  pokeReminders: number
  reEngagementNudges: number
}

export async function runEngagementCron(): Promise<EngagementCronResult> {
  const [expiringConversations, pendingRequestReminders, pokeReminders, reEngagementNudges] =
    await Promise.all([
      notifyExpiringConversations(),
      notifyPendingMessageRequests(),
      notifyUnseenPokeReminders(),
      notifyIncompleteProfileNudges(),
    ])

  return {
    expiringConversations,
    pendingRequestReminders,
    pokeReminders,
    reEngagementNudges,
  }
}

async function notifyExpiringConversations(): Promise<number> {
  const db = getDb()
  const now = Timestamp.now()
  const soon = Timestamp.fromMillis(now.toMillis() + 2 * HOUR_MS)

  const snap = await db
    .collection('conversations')
    .where('status', '==', 'active')
    .where('expiresAt', '>', now)
    .where('expiresAt', '<=', soon)
    .limit(100)
    .get()

  let sent = 0
  for (const doc of snap.docs) {
    const convo = doc.data()
    const participantIds = convo.participantIds as string[] | undefined
    if (!participantIds?.length) continue

    for (const uid of participantIds) {
      const otherId = participantIds.find((id) => id !== uid)
      const otherName =
        String(convo.participants?.[otherId ?? '']?.displayName ?? '').trim() || 'Your match'

      const result = await sendEngagementPush({
        userId: uid,
        category: 'conversationExpiring',
        type: 'conversation_expiring',
        title: 'Chat ending soon',
        body: `Your conversation with ${otherName} expires in under 2 hours. Say hi before the timer runs out.`,
        collapseKey: `expiring-${doc.id}`,
        data: {
          route: 'messages',
          conversationId: doc.id,
        },
      })
      if (result.sent > 0) sent += 1
    }
  }
  return sent
}

async function notifyPendingMessageRequests(): Promise<number> {
  const db = getDb()
  const cutoff = Timestamp.fromMillis(Date.now() - 6 * HOUR_MS)

  const snap = await db
    .collection('conversations')
    .where('status', '==', 'pending')
    .where('createdAt', '<=', cutoff)
    .limit(100)
    .get()

  let sent = 0
  for (const doc of snap.docs) {
    const convo = doc.data()
    const recipientId = String(convo.recipientId ?? '')
    const initiatorId = String(convo.initiatorId ?? '')
    if (!recipientId || !initiatorId) continue

    const senderName =
      String(convo.participants?.[initiatorId]?.displayName ?? '').trim() || 'Someone on Ridgits'

    const result = await sendEngagementPush({
      userId: recipientId,
      category: 'messageRequests',
      type: 'message_request_reminder',
      title: 'Message waiting for you',
      body: `${senderName} is waiting for you to approve their message.`,
      collapseKey: `request-reminder-${doc.id}`,
      data: {
        route: 'messages',
        conversationId: doc.id,
        fromUserId: initiatorId,
      },
    })
    if (result.sent > 0) sent += 1
  }
  return sent
}

async function notifyUnseenPokeReminders(): Promise<number> {
  const db = getDb()
  const cutoff = Timestamp.fromMillis(Date.now() - 1 * HOUR_MS)

  const snap = await db
    .collection('pokes')
    .where('seen', '==', false)
    .where('createdAt', '<=', cutoff)
    .limit(100)
    .get()

  let sent = 0
  for (const doc of snap.docs) {
    const poke = doc.data()
    const toUserId = String(poke.toUserId ?? '')
    if (!toUserId) continue
    const fromName = String(poke.fromName ?? 'Someone on Ridgits')

    const result = await sendEngagementPush({
      userId: toUserId,
      category: 'pokes',
      type: 'poke_reminder',
      title: 'Still thinking about it?',
      body: `${fromName} poked you earlier. See who is nearby.`,
      collapseKey: `poke-reminder-${doc.id}`,
      data: {
        route: 'matches',
        pokeId: doc.id,
        fromUserId: String(poke.fromUserId ?? ''),
      },
    })
    if (result.sent > 0) sent += 1
  }
  return sent
}

async function notifyIncompleteProfileNudges(): Promise<number> {
  const db = getDb()
  const cutoff = Timestamp.fromMillis(Date.now() - 24 * HOUR_MS)

  const snap = await db
    .collection('users')
    .where('profileComplete', '==', false)
    .where('createdAt', '<=', cutoff)
    .limit(50)
    .get()

  let sent = 0
  for (const doc of snap.docs) {
    const result = await sendEngagementPush({
      userId: doc.id,
      category: 'reEngagement',
      type: 're_engagement',
      title: 'Finish your Ridgits profile',
      body: 'Complete your profile to unlock matches, messages, and nearby discovery.',
      collapseKey: `profile-nudge-${doc.id}`,
      data: { route: 'home' },
    })
    if (result.sent > 0) sent += 1
  }
  return sent
}
