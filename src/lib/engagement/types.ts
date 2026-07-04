export type EngagementCategory =
  | 'pokes'
  | 'messages'
  | 'messageRequests'
  | 'conversationExpiring'
  | 'conversationApproved'
  | 'nearby'
  | 'ridgits'
  | 'reEngagement'
  | 'marketing'

export type EngagementPushType =
  | 'poke'
  | 'poke_reminder'
  | 'message'
  | 'message_request'
  | 'message_request_reminder'
  | 'message_request_declined'
  | 'conversation_expiring'
  | 'conversation_approved'
  | 'nearby_match'
  | 'ridgit_passed'
  | 're_engagement'
  | 'marketing'

export interface NotificationPreferences {
  pushEnabled: boolean
  pokes: boolean
  messages: boolean
  messageRequests: boolean
  conversationExpiring: boolean
  conversationApproved: boolean
  nearby: boolean
  ridgits: boolean
  reEngagement: boolean
  marketing: boolean
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  pokes: true,
  messages: true,
  messageRequests: true,
  conversationExpiring: true,
  conversationApproved: true,
  nearby: true,
  ridgits: true,
  reEngagement: true,
  marketing: false,
}

export interface EngagementPushPayload {
  userId: string
  category: EngagementCategory
  type: EngagementPushType
  title: string
  body: string
  data?: Record<string, string>
  collapseKey?: string
}
