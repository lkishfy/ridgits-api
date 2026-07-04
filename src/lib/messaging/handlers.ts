import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { effectiveSubscriptionTier } from '@/lib/subscription-badge'
import { sendEngagementPush } from '@/lib/push-notifications'
import { getDb } from '@/lib/firebase-admin'
import {
  normalizeMessage,
  previewText,
  conversationIdForUsers,
} from '@/lib/messaging/profanity'
import {
  MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_SUSPENSION_MINUTES,
} from '@/lib/messaging/constants'
import { isVisibleInCommunity } from '@/lib/matching/compatibility'
import { requireAccountCooldownElapsed } from '@/lib/trust-safety/account-age'
import { requireUserBirthYearOnFile } from '@/lib/trust-safety/age'
import { requireActiveSubscription } from '@/lib/trust-safety/subscription-gate'
import { validateProfilePhotoUrl } from '@/lib/trust-safety/profile-photo'
import {
  getMonthlyMessageQuota,
} from '@/lib/messaging/monthly-quota'
import {
  enforceDmTextBeforeSend,
  flagConversationForReview,
  recordSentMessageModeration,
} from '@/lib/messaging/moderation-enforcement'

export { getMonthlyMessageQuota }
export { MAX_MESSAGE_LENGTH, DEFAULT_MAX_MESSAGES, DEFAULT_SUSPENSION_MINUTES } from '@/lib/messaging/constants'

function getParticipantDisplayName(data: Record<string, unknown>, publicProfile?: Record<string, unknown>) {
  const publicName = String(publicProfile?.name ?? '').trim()
  if (publicName) return publicName
  const username = String(data.username ?? '').trim()
  return username || 'Anonymous'
}

function getParticipantImageUrl(data: Record<string, unknown>, publicProfile?: Record<string, unknown>) {
  return (
    publicProfile?.image ||
    data.image ||
    data.photoUrl ||
    data.photoURL ||
    data.avatarUrl ||
    data.avatar ||
    null
  )
}

async function ensureUserExists(uid: string) {
  const snap = await getDb().collection('users').doc(uid).get()
  return snap.exists ? snap : null
}

interface MessagingActor {
  emailVerified: boolean
  email?: string | null
}

async function ensureMessagingAllowed(uid: string, actor: MessagingActor) {
  if (!actor.emailVerified) {
    throw new ApiError(
      'Please verify your email address before messaging. Check your inbox for the verification link, or resend it from Settings.',
      403,
      'EMAIL_NOT_VERIFIED',
    )
  }

  const userSnap = await ensureUserExists(uid)
  if (!userSnap) throw new ApiError('You must complete your profile before messaging.', 412, 'USER_NOT_FOUND')

  await requireUserBirthYearOnFile(uid)

  const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
  if (!profileSnap.exists) throw new ApiError('You must complete your profile before messaging.', 412)

  const profile = profileSnap.data() ?? {}
  if (!isVisibleInCommunity(profile) || !isVisibleInCommunity(userSnap.data())) {
    throw new ApiError(
      'Turn on community visibility in your profile to send messages.',
      412,
    )
  }

  const name = String(profile.name ?? '').trim()
  const image = String(profile.image ?? '').trim()
  const about = String(profile.about ?? '').trim()
  const interests = profile.interests
  if (
    !name ||
    name.toLowerCase() === 'anonymous' ||
    !image ||
    !about ||
    !Array.isArray(interests) ||
    interests.length === 0 ||
    !String(profile.aspirations ?? '').trim()
  ) {
    throw new ApiError(
      'You must complete your profile before messaging. Please fill out all required fields.',
      412,
    )
  }

  const photoCheck = await validateProfilePhotoUrl(image)
  if (!photoCheck.ok) {
    throw new ApiError(photoCheck.reason ?? 'A valid profile photo is required to message.', 412, 'INVALID_PROFILE_PHOTO')
  }

  await requireActiveSubscription(uid, actor.email)

  const data = userSnap.data() ?? {}
  if (data.messagingSuspended) {
    const suspendedUntil = data.messagingSuspendedUntil as Timestamp | undefined
    if (suspendedUntil && suspendedUntil.toMillis() <= Date.now()) {
      await getDb().collection('users').doc(uid).set(
        {
          messagingSuspended: false,
          messagingSuspendedAt: FieldValue.delete(),
          messagingSuspendedUntil: FieldValue.delete(),
          messagingSuspendedDurationMinutes: FieldValue.delete(),
          messagingSuspendedReason: FieldValue.delete(),
        },
        { merge: true },
      )
    } else {
      const reason =
        (data.messagingSuspendedReason as { summary?: string } | undefined)?.summary ||
        'Messaging is currently disabled for your account.'
      throw new ApiError(String(data.messagingSuspendedMessage ?? reason), 412, 'USER_SUSPENDED')
    }
  }

  return { snapshot: userSnap, data }
}

async function suspendMessagingForUser(
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
) {
  const db = getDb()
  const durationMinutes = context.durationMinutes ?? DEFAULT_SUSPENSION_MINUTES
  const nowTimestamp = Timestamp.now()
  const suspensionEndsAt = Timestamp.fromMillis(nowTimestamp.toMillis() + durationMinutes * 60 * 1000)

  await db.collection('users').doc(uid).set(
    {
      messagingSuspended: true,
      messagingSuspendedAt: FieldValue.serverTimestamp(),
      messagingSuspendedUntil: suspensionEndsAt,
      messagingSuspendedDurationMinutes: durationMinutes,
      messagingSuspendedReason: {
        summary:
          context.summary ??
          `Messaging disabled due to policy violation. Temporary suspension for ${durationMinutes} minute(s).`,
        matches: context.matches ?? [],
        source: context.source ?? 'profanity_filter',
        preview: context.preview ?? '',
      },
    },
    { merge: true },
  )

  await db.collection('messagingModerationEvents').add({
    userId: uid,
    type: context.source ?? 'profanity_filter',
    summary: context.summary ?? 'Messaging disabled due to policy violation.',
    matches: context.matches ?? [],
    preview: context.preview ?? '',
    createdAt: FieldValue.serverTimestamp(),
    conversationId: context.conversationId ?? null,
    messageId: context.messageId ?? null,
    durationMinutes,
    suspendedUntil: suspensionEndsAt,
  })
}

async function ensureNoMutualBlocks(senderId: string, recipientId: string) {
  const db = getDb()
  const [senderBlockedSnap, recipientBlockedSnap] = await Promise.all([
    db.collection('users').doc(senderId).collection('blocked').doc(recipientId).get(),
    db.collection('users').doc(recipientId).collection('blocked').doc(senderId).get(),
  ])
  if (senderBlockedSnap.exists) throw new ApiError('You have blocked this user.', 412)
  if (recipientBlockedSnap.exists) throw new ApiError('This user is not accepting messages from you.', 403)
}

function buildParticipantsMetadata(
  senderId: string,
  senderData: Record<string, unknown>,
  recipientId: string,
  recipientData: Record<string, unknown>,
  now: FieldValue,
  senderPublic?: Record<string, unknown>,
  recipientPublic?: Record<string, unknown>,
) {
  const tier = (data: Record<string, unknown>) => effectiveSubscriptionTier(data)

  return {
    [senderId]: {
      displayName: getParticipantDisplayName(senderData, senderPublic),
      imageUrl: getParticipantImageUrl(senderData, senderPublic),
      approved: true,
      lastReadAt: now,
      lastSentAt: now,
      subscriptionStatus: senderData.subscriptionStatus ?? null,
      subscriptionTier: tier(senderData),
    },
    [recipientId]: {
      displayName: getParticipantDisplayName(recipientData, recipientPublic),
      imageUrl: getParticipantImageUrl(recipientData, recipientPublic),
      approved: false,
      lastReadAt: null,
      lastSentAt: null,
      subscriptionStatus: recipientData.subscriptionStatus ?? null,
      subscriptionTier: tier(recipientData),
    },
  }
}

export async function startConversation(senderId: string, toUserId: string, message: string, actor: MessagingActor) {
  if (toUserId === senderId) throw new ApiError('You cannot message yourself.', 400)

  const normalizedMessage = normalizeMessage(message)
  if (!normalizedMessage) throw new ApiError('Message cannot be empty.', 400)
  if (normalizedMessage.length > MAX_MESSAGE_LENGTH) throw new ApiError('Message is too long.', 400)

  const dmAnalysis = await enforceDmTextBeforeSend(
    senderId,
    normalizedMessage,
    suspendMessagingForUser,
    { recipientId: toUserId },
  )

  const { data: senderData } = await ensureMessagingAllowed(senderId, actor)
  requireAccountCooldownElapsed(senderData)
  const recipientSnap = await ensureUserExists(toUserId)
  if (!recipientSnap) throw new ApiError('Recipient not found.', 404)
  const recipientData = recipientSnap.data() ?? {}
  const recipientPublicSnap = await getDb().collection('publicProfiles').doc(toUserId).get()
  if (
    !isVisibleInCommunity(recipientData) ||
    !isVisibleInCommunity(recipientPublicSnap.data())
  ) {
    throw new ApiError('This user is not accepting messages right now.', 403)
  }

  await ensureNoMutualBlocks(senderId, toUserId)

  const db = getDb()
  const senderPublicSnap = await db.collection('publicProfiles').doc(senderId).get()

  const conversationId = conversationIdForUsers(senderId, toUserId)
  const conversationRef = db.collection('conversations').doc(conversationId)
  const messageRef = conversationRef.collection('messages').doc()

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(conversationRef)
    const now = FieldValue.serverTimestamp()

    if (existing.exists) {
      const convo = existing.data() ?? {}
      if (
        Array.isArray(convo.participantIds) &&
        convo.participantIds.includes(senderId) &&
        convo.participantIds.includes(toUserId)
      ) {
        if (convo.status === 'pending') {
          throw new ApiError('Conversation is awaiting approval.', 412)
        }
        if (convo.status === 'blocked') throw new ApiError('This conversation is blocked.', 403)
        if (convo.status === 'active') {
          throw new ApiError('Conversation already exists. Send your message in the existing thread.', 412)
        }
        if (convo.status === 'declined') {
          const messagesSnap = await tx.get(conversationRef.collection('messages'))
          messagesSnap.forEach((doc) => tx.delete(doc.ref))
          tx.delete(conversationRef)
        } else {
          throw new ApiError('Conversation already exists.', 412)
        }
      } else {
        throw new ApiError('Conversation already exists.', 412)
      }
    }

    tx.set(conversationRef, {
      participantIds: [senderId, toUserId],
      participants: buildParticipantsMetadata(
        senderId,
        senderData,
        toUserId,
        recipientData,
        now,
        senderPublicSnap.data(),
        recipientPublicSnap.data(),
      ),
      approvals: { [senderId]: true, [toUserId]: false },
      status: 'pending',
      initiatorId: senderId,
      recipientId: toUserId,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      lastMessagePreview: previewText(normalizedMessage),
      lastMessageSenderId: senderId,
      unreadCounts: { [senderId]: 0, [toUserId]: 1 },
      pendingApprovalsFor: [toUserId],
      firstMessageId: messageRef.id,
      messageCount: 0,
      expiresAt: null,
      isExpired: false,
      maxMessages: DEFAULT_MAX_MESSAGES,
    })

    tx.set(messageRef, {
      senderId,
      text: normalizedMessage,
      createdAt: now,
      status: 'sent',
      requiresApproval: true,
    })
  })

  await recordSentMessageModeration({
    senderId,
    recipientId: toUserId,
    conversationId,
    messageId: messageRef.id,
    text: normalizedMessage,
    analysis: dmAnalysis,
  })

  const senderName = getParticipantDisplayName(senderData, senderPublicSnap.data())
  await sendEngagementPush({
    userId: toUserId,
    category: 'messageRequests',
    type: 'message_request',
    title: `${senderName} wants to message you`,
    body: previewText(normalizedMessage),
    collapseKey: `message-request-${conversationId}`,
    data: {
      route: 'messages',
      conversationId,
      fromUserId: senderId,
    },
  })

  return { conversationId }
}

export async function approveConversation(userId: string, conversationId: string, actor: MessagingActor) {
  await ensureMessagingAllowed(userId, actor)
  const db = getDb()
  const conversationRef = db.collection('conversations').doc(conversationId)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(conversationRef)
    if (!snap.exists) throw new ApiError('Conversation not found.', 404)
    const convo = snap.data() ?? {}

    if (!Array.isArray(convo.participantIds) || !convo.participantIds.includes(userId)) {
      throw new ApiError('You are not part of this conversation.', 403)
    }
    if (convo.status === 'blocked') throw new ApiError('This conversation is blocked.', 403)
    if (convo.status === 'active') throw new ApiError('Conversation already active.', 412)
    if (convo.status !== 'pending') throw new ApiError('Conversation is not pending approval.', 412)
    if (convo.approvals?.[userId]) throw new ApiError('You have already approved this conversation.', 412)

    const now = FieldValue.serverTimestamp()
    const nowTimestamp = Timestamp.now()
    const expiresAtTimestamp = Timestamp.fromMillis(nowTimestamp.toMillis() + 24 * 60 * 60 * 1000)

    const messageQuery = conversationRef.collection('messages').orderBy('createdAt', 'asc').limit(1)
    const messageSnap = await tx.get(messageQuery)

    const pendingList = Array.isArray(convo.pendingApprovalsFor)
      ? convo.pendingApprovalsFor.filter((id: string) => id !== userId)
      : []
    const isBecomingActive = pendingList.length === 0

    const updates: Record<string, unknown> = {
      [`approvals.${userId}`]: true,
      [`participants.${userId}.approved`]: true,
      [`participants.${userId}.approvedAt`]: now,
      [`participants.${userId}.lastReadAt`]: now,
      status: isBecomingActive ? 'active' : convo.status,
      updatedAt: now,
      pendingApprovalsFor: pendingList,
    }
    if (isBecomingActive) {
      updates.expiresAt = expiresAtTimestamp
      updates.messageCount = 1
    }

    tx.update(conversationRef, updates)
    messageSnap.forEach((doc) => {
      tx.update(doc.ref, { requiresApproval: false, releasedAt: now })
    })
  })

  const snap = await conversationRef.get()
  const convo = snap.data() ?? {}
  const initiatorId = String(convo.initiatorId ?? '')
  const approverName = String(convo.participants?.[userId]?.displayName ?? 'Your match')
  if (initiatorId && initiatorId !== userId) {
    await sendEngagementPush({
      userId: initiatorId,
      category: 'conversationApproved',
      type: 'conversation_approved',
      title: `${approverName} approved your message`,
      body: 'You have 24 hours and 16 messages to connect. Make it count.',
      collapseKey: `approved-${conversationId}`,
      data: {
        route: 'messages',
        conversationId,
      },
    })
  }

  return { conversationId, status: 'active' }
}

export async function sendMessage(senderId: string, conversationId: string, message: string, actor: MessagingActor) {
  const normalizedMessage = normalizeMessage(message)
  if (!normalizedMessage) throw new ApiError('Message cannot be empty.', 400)
  if (normalizedMessage.length > MAX_MESSAGE_LENGTH) throw new ApiError('Message is too long.', 400)

  const db = getDb()
  const conversationRef = db.collection('conversations').doc(conversationId)
  const preSnap = await conversationRef.get()
  if (!preSnap.exists) throw new ApiError('Conversation not found.', 404)
  const preConvo = preSnap.data() ?? {}
  const preRecipientId = (preConvo.participantIds as string[] | undefined)?.find((id) => id !== senderId)

  const dmAnalysis = await enforceDmTextBeforeSend(
    senderId,
    normalizedMessage,
    suspendMessagingForUser,
    { conversationId, recipientId: preRecipientId },
  )

  const { data: senderData } = await ensureMessagingAllowed(senderId, actor)
  const senderPublicSnap = await db.collection('publicProfiles').doc(senderId).get()
  const senderPublic = senderPublicSnap.data()

  const messageRef = conversationRef.collection('messages').doc()

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(conversationRef)
    if (!snap.exists) throw new ApiError('Conversation not found.', 404)
    const convo = snap.data() ?? {}

    if (!Array.isArray(convo.participantIds) || !convo.participantIds.includes(senderId)) {
      throw new ApiError('You are not part of this conversation.', 403)
    }
    if (convo.status !== 'active') throw new ApiError('Conversation is not active.', 412)
    if (Array.isArray(convo.blockedBy) && convo.blockedBy.length) {
      throw new ApiError('Conversation is blocked.', 403)
    }

    const expiresAt = convo.expiresAt as Timestamp | undefined
    if (expiresAt && Timestamp.now().seconds >= expiresAt.seconds) {
      tx.update(conversationRef, { isExpired: true, status: 'expired' })
      throw new ApiError(
        'This conversation has expired. Conversations are limited to 24 hours to encourage meeting in real life!',
        412,
      )
    }

    const messageCount = (convo.messageCount as number) ?? 0
    const maxMessages = Math.min(
      typeof convo.maxMessages === 'number' && convo.maxMessages > 0 ? convo.maxMessages : DEFAULT_MAX_MESSAGES,
      DEFAULT_MAX_MESSAGES,
    )
    if (messageCount >= maxMessages) {
      throw new ApiError(
        `Message limit reached. Conversations are limited to ${maxMessages} messages to encourage meeting in real life!`,
        412,
      )
    }

    const recipientId = (convo.participantIds as string[]).find((id) => id !== senderId)
    if (!recipientId) throw new ApiError('Conversation participants are invalid.', 412)

    const now = FieldValue.serverTimestamp()
    tx.set(messageRef, {
      senderId,
      text: normalizedMessage,
      createdAt: now,
      status: 'sent',
      requiresApproval: false,
    })

    tx.update(conversationRef, {
      updatedAt: now,
      lastMessageAt: now,
      lastMessagePreview: previewText(normalizedMessage),
      lastMessageSenderId: senderId,
      [`participants.${senderId}.lastSentAt`]: now,
      [`participants.${senderId}.displayName`]: getParticipantDisplayName(senderData, senderPublic),
      [`participants.${senderId}.imageUrl`]: getParticipantImageUrl(senderData, senderPublic),
      [`participants.${senderId}.lastReadAt`]: now,
      [`unreadCounts.${recipientId}`]: FieldValue.increment(1),
      [`unreadCounts.${senderId}`]: 0,
      messageCount: FieldValue.increment(1),
    })
  })

  const snap = await conversationRef.get()
  const convo = snap.data() ?? {}
  const recipientId = (convo.participantIds as string[] | undefined)?.find((id) => id !== senderId)
  const senderName = getParticipantDisplayName(senderData, senderPublic)
  if (recipientId) {
    await sendEngagementPush({
      userId: recipientId,
      category: 'messages',
      type: 'message',
      title: `New message from ${senderName}`,
      body: previewText(normalizedMessage),
      collapseKey: `message-${conversationId}`,
      data: {
        route: 'messages',
        conversationId,
        fromUserId: senderId,
      },
    })

    await recordSentMessageModeration({
      senderId,
      recipientId,
      conversationId,
      messageId: messageRef.id,
      text: normalizedMessage,
      analysis: dmAnalysis,
    })
  }

  return { conversationId, messageId: messageRef.id }
}

export { flagConversationForReview as flagConversation }

async function deleteConversationAndMessages(conversationRef: DocumentReference) {
  const db = getDb()
  const messagesSnap = await conversationRef.collection('messages').get()
  const batch = db.batch()
  messagesSnap.docs.forEach((doc) => batch.delete(doc.ref))
  batch.delete(conversationRef)
  await batch.commit()
}

export async function declineConversation(userId: string, conversationId: string) {
  const userSnap = await ensureUserExists(userId)
  if (!userSnap) throw new ApiError('User not found.', 404)

  const db = getDb()
  const conversationRef = db.collection('conversations').doc(conversationId)
  const now = FieldValue.serverTimestamp()

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(conversationRef)
    if (!snap.exists) throw new ApiError('Conversation not found.', 404)
    const convo = snap.data() ?? {}

    if (!Array.isArray(convo.participantIds) || !convo.participantIds.includes(userId)) {
      throw new ApiError('You are not part of this conversation.', 403)
    }
    if (convo.status === 'blocked') throw new ApiError('This conversation is blocked.', 403)
    if (convo.status === 'active') throw new ApiError('Conversation is already active.', 412)
    if (convo.status === 'declined') throw new ApiError('Conversation was already declined.', 412)

    const initiatorId = String(convo.initiatorId ?? '')
    if (initiatorId === userId) {
      throw new ApiError('You cannot decline your own message request.', 400)
    }
    if (convo.status !== 'pending') {
      throw new ApiError('Conversation is not pending approval.', 412)
    }

    const deletedBy = Array.isArray(convo.deletedBy) ? convo.deletedBy : []
    if (deletedBy.includes(userId)) {
      return
    }

    tx.update(conversationRef, {
      status: 'declined',
      declinedBy: userId,
      declinedAt: now,
      deletedBy: FieldValue.arrayUnion(userId),
      pendingApprovalsFor: [],
      updatedAt: now,
      [`participants.${userId}.declinedAt`]: now,
    })
  })

  const snap = await conversationRef.get()
  const convo = snap.data() ?? {}
  const initiatorId = String(convo.initiatorId ?? '')
  const declinerName = String(convo.participants?.[userId]?.displayName ?? 'Your match')
  if (initiatorId && initiatorId !== userId) {
    await sendEngagementPush({
      userId: initiatorId,
      category: 'messageRequests',
      type: 'message_request_declined',
      title: `${declinerName} declined your message`,
      body: 'You can send a new request later if you like.',
      collapseKey: `declined-${conversationId}`,
      data: {
        route: 'messages',
        conversationId,
      },
    })
  }

  return { conversationId, status: 'declined' }
}

export async function withdrawConversation(userId: string, conversationId: string) {
  const userSnap = await ensureUserExists(userId)
  if (!userSnap) throw new ApiError('User not found.', 404)

  const db = getDb()
  const conversationRef = db.collection('conversations').doc(conversationId)

  const snap = await conversationRef.get()
  if (!snap.exists) throw new ApiError('Conversation not found.', 404)
  const convo = snap.data() ?? {}

  if (!Array.isArray(convo.participantIds) || !convo.participantIds.includes(userId)) {
    throw new ApiError('You are not part of this conversation.', 403)
  }

  const initiatorId = String(convo.initiatorId ?? '')
  if (initiatorId !== userId) {
    throw new ApiError('Only the sender can withdraw a pending message request.', 403)
  }

  const status = String(convo.status ?? '')
  if (status !== 'pending' && status !== 'declined') {
    throw new ApiError('Only pending message requests can be withdrawn.', 412)
  }

  await deleteConversationAndMessages(conversationRef)

  return { conversationId, status: 'withdrawn' }
}

export async function markConversationRead(userId: string, conversationId: string) {
  const userSnap = await ensureUserExists(userId)
  if (!userSnap) throw new ApiError('User not found.', 404)

  const db = getDb()
  const conversationRef = db.collection('conversations').doc(conversationId)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(conversationRef)
    if (!snap.exists) throw new ApiError('Conversation not found.', 404)
    const convo = snap.data() ?? {}
    if (!Array.isArray(convo.participantIds) || !convo.participantIds.includes(userId)) {
      throw new ApiError('You are not part of this conversation.', 403)
    }

    const now = FieldValue.serverTimestamp()
    tx.update(conversationRef, {
      [`participants.${userId}.lastReadAt`]: now,
      [`unreadCounts.${userId}`]: 0,
      updatedAt: now,
    })
  })

  return { conversationId }
}
