import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import {
  analyzeDmText,
  type DmTextAnalysis,
} from '@/lib/messaging/content-moderation'
import {
  checkDuplicateBroadcast,
  evaluateMessagingAccountSignals,
  logDmSentEvent,
  messageDigest,
} from '@/lib/messaging/account-signals'
import { checkProfanity, previewText } from '@/lib/messaging/profanity'
import { DEFAULT_SUSPENSION_MINUTES } from '@/lib/messaging/constants'

type SuspendFn = (
  uid: string,
  context: {
    summary?: string
    matches?: string[]
    preview?: string
    source?: string
    durationMinutes?: number
    conversationId?: string | null
    messageId?: string | null
  },
) => Promise<void>

async function logModerationEvent(payload: Record<string, unknown>) {
  await getDb().collection('messagingModerationEvents').add({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  })
}

async function flagMessageDocument(
  conversationId: string,
  messageId: string,
  analysis: DmTextAnalysis,
  extra?: Record<string, unknown>,
) {
  await getDb()
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .doc(messageId)
    .set(
      {
        moderationFlag: true,
        moderationCategories: analysis.categories,
        moderationMatches: analysis.matches,
        ...extra,
      },
      { merge: true },
    )
}

export async function enforceDmTextBeforeSend(
  senderId: string,
  text: string,
  suspendMessagingForUser: SuspendFn,
  options?: { conversationId?: string; recipientId?: string },
): Promise<DmTextAnalysis> {
  const accountSignals = await evaluateMessagingAccountSignals(senderId)
  if (accountSignals.restricted) {
    await logModerationEvent({
      type: 'account_restricted',
      userId: senderId,
      reasons: accountSignals.reasons,
      conversationId: options?.conversationId ?? null,
    })
    throw new ApiError(
      'Messaging is temporarily unavailable on your account while we complete a safety review.',
      412,
      'MESSAGING_REVIEW_REQUIRED',
    )
  }

  if (accountSignals.flagged) {
    await logModerationEvent({
      type: 'account_flagged',
      userId: senderId,
      reasons: accountSignals.reasons,
      conversationId: options?.conversationId ?? null,
    })
  }

  const profanityCheck = checkProfanity(text)
  if (profanityCheck.isProfane) {
    await suspendMessagingForUser(senderId, {
      summary: 'Messaging suspended due to inappropriate language.',
      matches: profanityCheck.matches,
      preview: previewText(profanityCheck.normalized),
      source: 'profanity_filter',
      durationMinutes: DEFAULT_SUSPENSION_MINUTES,
      conversationId: options?.conversationId ?? null,
    })
    throw new ApiError('Messaging has been disabled for your account due to a policy violation.', 412)
  }

  const analysis = analyzeDmText(text)

  if (analysis.action === 'block') {
    await suspendMessagingForUser(senderId, {
      summary: 'Messaging suspended due to prohibited solicitation or scam content.',
      matches: analysis.matches,
      preview: previewText(analysis.normalized),
      source: 'dm_solicitation_filter',
      durationMinutes: DEFAULT_SUSPENSION_MINUTES,
      conversationId: options?.conversationId ?? null,
    })
    throw new ApiError('Messaging has been disabled for your account due to a policy violation.', 412)
  }

  if (options?.recipientId) {
    const broadcast = await checkDuplicateBroadcast(senderId, text)
    if (broadcast.isBroadcast) {
      await suspendMessagingForUser(senderId, {
        summary: 'Messaging suspended for sending duplicate messages to many users.',
        matches: ['duplicate_broadcast'],
        preview: previewText(analysis.normalized),
        source: 'duplicate_broadcast',
        durationMinutes: DEFAULT_SUSPENSION_MINUTES,
        conversationId: options.conversationId ?? null,
      })
      throw new ApiError('Messaging has been disabled for your account due to a policy violation.', 412)
    }
  }

  return analysis
}

export async function recordSentMessageModeration(params: {
  senderId: string
  recipientId: string
  conversationId: string
  messageId: string
  text: string
  analysis: DmTextAnalysis
}) {
  const digest = messageDigest(params.text)

  await logDmSentEvent({
    userId: params.senderId,
    recipientId: params.recipientId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    messageDigest: digest,
    moderationAction: params.analysis.action,
    categories: params.analysis.categories,
  })

  if (params.analysis.action === 'flag') {
    await flagMessageDocument(params.conversationId, params.messageId, params.analysis)
    await logModerationEvent({
      type: 'dm_keyword_flag',
      userId: params.senderId,
      recipientId: params.recipientId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      categories: params.analysis.categories,
      matches: params.analysis.matches,
      preview: previewText(params.analysis.normalized),
    })
  }
}

const USER_REPORT_SUSPEND_THRESHOLD = 2
const USER_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** User reports carry more weight than automated keyword flags. */
export async function flagConversationForReview(
  reporterId: string,
  conversationId: string,
  reason: string,
) {
  const db = getDb()
  const conversationRef = db.collection('conversations').doc(conversationId)
  const snap = await conversationRef.get()
  if (!snap.exists) throw new ApiError('Conversation not found.', 404)

  const convo = snap.data() ?? {}
  if (!Array.isArray(convo.participantIds) || !convo.participantIds.includes(reporterId)) {
    throw new ApiError('You are not part of this conversation.', 403)
  }

  const reportedUserId = (convo.participantIds as string[]).find((id) => id !== reporterId)
  if (!reportedUserId) throw new ApiError('Invalid conversation participants.', 412)

  const now = FieldValue.serverTimestamp()

  await db.collection('conversationFlags').add({
    conversationId,
    reportedBy: reporterId,
    reportedUser: reportedUserId,
    reason: reason.trim(),
    source: 'user_report',
    priority: 'high',
    createdAt: now,
    status: 'pending',
  })

  await conversationRef.update({
    flaggedBy: FieldValue.arrayUnion(reporterId),
    reportPriority: 'high',
    updatedAt: now,
  })

  await db
    .collection('users')
    .doc(reportedUserId)
    .set(
      {
        messagingReportCount: FieldValue.increment(1),
        lastMessagingReportAt: now,
      },
      { merge: true },
    )

  await logModerationEvent({
    type: 'user_report',
    userId: reportedUserId,
    reportedBy: reporterId,
    conversationId,
    reason: reason.trim(),
    priority: 'high',
  })

  const since = Timestamp.fromMillis(Date.now() - USER_REPORT_WINDOW_MS)
  const recentReports = await db
    .collection('conversationFlags')
    .where('reportedUser', '==', reportedUserId)
    .where('createdAt', '>=', since)
    .get()

  const distinctReporters = new Set(
    recentReports.docs
      .filter((d) => d.data().source === 'user_report')
      .map((d) => d.data().reportedBy as string),
  )

  if (distinctReporters.size >= USER_REPORT_SUSPEND_THRESHOLD) {
    await db.collection('users').doc(reportedUserId).set(
      {
        messagingSuspended: true,
        messagingSuspendedAt: now,
        messagingSuspendedReason: {
          summary: 'Messaging paused pending review after multiple user reports.',
          source: 'user_reports',
          matches: [],
          preview: '',
        },
        trustSafetyFlags: FieldValue.arrayUnion('messaging_review_required'),
      },
      { merge: true },
    )

    await logModerationEvent({
      type: 'user_report_suspend',
      userId: reportedUserId,
      distinctReporters: distinctReporters.size,
      conversationId,
    })
  }

  return { success: true, conversationId }
}
