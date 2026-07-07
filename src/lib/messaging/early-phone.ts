import { ApiError } from '@/lib/api-errors'
import {
  EARLY_PHONE_MESSAGE,
  EARLY_PHONE_MESSAGE_THRESHOLD,
} from '@/lib/messaging/constants'

const PHONE_REGEX = /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/i
const GENERIC_PHONE_REGEX = /\b(?:\d[\s.\-()]*){7,}\d\b/

export function containsPhoneNumber(text: string): boolean {
  return PHONE_REGEX.test(text) || GENERIC_PHONE_REGEX.test(text)
}

export function assertPhoneNumberNotTooEarly(messageCount: number, text: string): void {
  if (messageCount < EARLY_PHONE_MESSAGE_THRESHOLD && containsPhoneNumber(text)) {
    throw new ApiError(EARLY_PHONE_MESSAGE, 412, 'EARLY_PHONE_NUMBER')
  }
}
