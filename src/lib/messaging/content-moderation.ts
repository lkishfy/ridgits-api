import { normalizeMessage } from '@/lib/messaging/profanity'

export type DmModerationAction = 'allow' | 'flag' | 'block'

export interface DmTextAnalysis {
  action: DmModerationAction
  categories: string[]
  matches: string[]
  normalized: string
}

const URL_REGEX = /\b(https?:\/\/|www\.)[^\s]+/i
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const PHONE_REGEX = /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/

const SEXUAL_SERVICES =
  /\b(escort|escorts|full service|fs\b|incall|in call|outcall|out call|gfe|pse|qv|hh|hhr|overnight|quick meet|massage outcall)\b/i
const PAYMENT_CUES =
  /\b(ppm|pay per meet|roses|donation|donations|cash\s*app|cashapp|venmo|zelle|paypal|western union|gift card|gifts for time|crypto|bitcoin|usdt)\b/i
const MEET_SERVICE = /\b(meet|service|company|time|hour|hr|visit|session|date)\b/i
const ONLYFANS = /\b(onlyfans|only fans)\b/i
const RATE_LIST = /\b(\$\d+\s*(?:\/|per)\s*(?:hr|hour|h|visit|date|meet)|\d+\s*roses|\brate\s*list\b|\bmenu\b.*\$\d)/i
const ROMANCE_SCAM =
  /\b(wire transfer|bank account|routing number|gift cards? for|send money|financial help|stuck abroad|investment opportunity)\b/i

function normalizeForMatch(text: string): string {
  return normalizeMessage(text).toLowerCase()
}

/**
 * Dating-app DM classifier: keyword / pattern flagging on private text.
 * - `block` — solicitation, scams (reject + suspend)
 * - `flag` — contact info, payment cues (deliver + queue for review)
 * - `allow` — no hits
 */
export function analyzeDmText(text: string): DmTextAnalysis {
  const normalized = normalizeForMatch(text)
  const categories = new Set<string>()
  const matches = new Set<string>()

  if (!normalized) {
    return { action: 'allow', categories: [], matches: [], normalized }
  }

  if (SEXUAL_SERVICES.test(normalized)) {
    categories.add('sexual_solicitation')
    matches.add('sexual_services')
  }
  if (PAYMENT_CUES.test(normalized) && MEET_SERVICE.test(normalized)) {
    categories.add('sexual_solicitation')
    matches.add('payment_meet')
  }
  if (ONLYFANS.test(normalized)) {
    categories.add('sexual_solicitation')
    matches.add('onlyfans')
  }
  if (RATE_LIST.test(normalized)) {
    categories.add('sexual_solicitation')
    matches.add('rate_list')
  }
  if (ROMANCE_SCAM.test(normalized)) {
    categories.add('financial_scam')
    matches.add('romance_scam')
  }

  if (categories.has('sexual_solicitation') || categories.has('financial_scam')) {
    return {
      action: 'block',
      categories: Array.from(categories),
      matches: Array.from(matches),
      normalized,
    }
  }

  if (URL_REGEX.test(normalized)) {
    categories.add('external_link')
    matches.add('url')
  }
  if (EMAIL_REGEX.test(normalized)) {
    categories.add('contact_info')
    matches.add('email')
  }
  if (PHONE_REGEX.test(normalized)) {
    categories.add('contact_info')
    matches.add('phone')
  }
  if (PAYMENT_CUES.test(normalized)) {
    categories.add('payment_handle')
    matches.add('payment_cue')
  }

  if (categories.size > 0) {
    return {
      action: 'flag',
      categories: Array.from(categories),
      matches: Array.from(matches),
      normalized,
    }
  }

  return { action: 'allow', categories: [], matches: [], normalized }
}

/** Profile / bio signals (rate lists, payment handles in public text). */
export function analyzeProfileSolicitationSignals(...fields: Array<string | undefined | null>): DmTextAnalysis {
  const combined = fields.filter(Boolean).join(' ')
  return analyzeDmText(combined)
}
