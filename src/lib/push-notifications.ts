import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getMessaging, type Messaging } from 'firebase-admin/messaging'
import { getDb } from '@/lib/firebase-admin'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type EngagementCategory,
  type EngagementPushPayload,
  type NotificationPreferences,
} from '@/lib/engagement/types'

let _messaging: Messaging | null = null

function getMessagingInstance(): Messaging {
  if (!_messaging) _messaging = getMessaging()
  return _messaging
}

const CATEGORY_TO_PREFERENCE: Record<EngagementCategory, keyof NotificationPreferences> = {
  pokes: 'pokes',
  messages: 'messages',
  messageRequests: 'messageRequests',
  conversationExpiring: 'conversationExpiring',
  conversationApproved: 'conversationApproved',
  nearby: 'nearby',
  ridgits: 'ridgits',
  reEngagement: 'reEngagement',
  marketing: 'marketing',
}

export function preferencesDocRef(uid: string) {
  return getDb().collection('users').doc(uid).collection('notificationPreferences').doc('default')
}

export function deviceDocRef(uid: string, deviceId: string) {
  return getDb().collection('users').doc(uid).collection('devices').doc(deviceId)
}

export async function getNotificationPreferences(uid: string): Promise<NotificationPreferences> {
  const snap = await preferencesDocRef(uid).get()
  if (!snap.exists) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(snap.data() as Partial<NotificationPreferences>) }
}

export async function updateNotificationPreferences(
  uid: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const ref = preferencesDocRef(uid)
  await ref.set(
    {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  return getNotificationPreferences(uid)
}

export async function registerDeviceToken(input: {
  uid: string
  deviceId: string
  fcmToken: string
  platform: 'ios' | 'android' | 'web'
  appVersion?: string
  deviceModel?: string
}) {
  const { uid, deviceId, fcmToken, platform, appVersion, deviceModel } = input
  await deviceDocRef(uid, deviceId).set(
    {
      fcmToken,
      platform,
      appVersion: appVersion ?? null,
      deviceModel: deviceModel ?? null,
      updatedAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  return { registered: true, deviceId }
}

export async function unregisterDeviceToken(uid: string, deviceId: string) {
  await deviceDocRef(uid, deviceId).delete()
  return { unregistered: true }
}

async function listActiveDeviceTokens(uid: string): Promise<string[]> {
  const snap = await getDb().collection('users').doc(uid).collection('devices').get()
  const tokens = snap.docs
    .map((doc) => String(doc.data().fcmToken ?? '').trim())
    .filter(Boolean)
  return [...new Set(tokens)]
}

async function removeInvalidTokens(uid: string, tokens: string[]) {
  if (!tokens.length) return
  const snap = await getDb().collection('users').doc(uid).collection('devices').get()
  const batch = getDb().batch()
  let count = 0
  for (const doc of snap.docs) {
    const token = String(doc.data().fcmToken ?? '')
    if (tokens.includes(token)) {
      batch.delete(doc.ref)
      count += 1
    }
  }
  if (count > 0) await batch.commit()
}

function categoryAllowed(prefs: NotificationPreferences, category: EngagementCategory): boolean {
  if (!prefs.pushEnabled) return false
  const key = CATEGORY_TO_PREFERENCE[category]
  return prefs[key] !== false
}

function apnsCategoryForType(type: EngagementPushPayload['type']): string {
  switch (type) {
    case 'poke':
    case 'poke_reminder':
      return 'RIDGITS_POKE'
    case 'message':
      return 'RIDGITS_MESSAGE'
    case 'message_request':
    case 'message_request_reminder':
      return 'RIDGITS_MESSAGE_REQUEST'
    case 'conversation_expiring':
      return 'RIDGITS_CONVERSATION_EXPIRING'
    case 'conversation_approved':
      return 'RIDGITS_CONVERSATION_APPROVED'
    case 'nearby_match':
      return 'RIDGITS_NEARBY'
    case 'ridgit_passed':
      return 'RIDGITS_RIDGIT'
    default:
      return 'RIDGITS_GENERAL'
  }
}

export async function sendEngagementPush(payload: EngagementPushPayload): Promise<{ sent: number; skipped?: string }> {
  const prefs = await getNotificationPreferences(payload.userId)
  if (!categoryAllowed(prefs, payload.category)) {
    return { sent: 0, skipped: 'preferences' }
  }

  const tokens = await listActiveDeviceTokens(payload.userId)
  if (!tokens.length) return { sent: 0, skipped: 'no_tokens' }

  const data: Record<string, string> = {
    type: payload.type,
    route: payload.data?.route ?? 'home',
    ...(payload.data ?? {}),
  }

  const response = await getMessagingInstance().sendEachForMulticast({
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data,
    apns: {
      headers: payload.collapseKey ? { 'apns-collapse-id': payload.collapseKey } : undefined,
      payload: {
        aps: {
          sound: 'default',
          category: apnsCategoryForType(payload.type),
          'thread-id': payload.collapseKey ?? payload.type,
        },
      },
    },
  })

  const invalidTokens: string[] = []
  response.responses.forEach((result, index) => {
    if (result.success) return
    const code = result.error?.code
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      invalidTokens.push(tokens[index]!)
    }
  })

  if (invalidTokens.length) {
    await removeInvalidTokens(payload.userId, invalidTokens)
  }

  await getDb().collection('notificationEvents').add({
    userId: payload.userId,
    type: payload.type,
    category: payload.category,
    title: payload.title,
    body: payload.body,
    data,
    sentCount: response.successCount,
    failureCount: response.failureCount,
    createdAt: FieldValue.serverTimestamp(),
  })

  return { sent: response.successCount }
}

export async function recordPushOpened(uid: string, type: string, metadata?: Record<string, string>) {
  await getDb().collection('notificationEvents').add({
    userId: uid,
    type,
    event: 'opened',
    metadata: metadata ?? {},
    createdAt: FieldValue.serverTimestamp(),
  })
}

export function hoursFromNow(hours: number): Timestamp {
  return Timestamp.fromMillis(Date.now() + hours * 60 * 60 * 1000)
}
