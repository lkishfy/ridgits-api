/** demo_001 / interested-in preference value for "Anyone/Everyone". */
export const DEMO_INTERESTED_ANYONE = 4

/** demo_000 gender value for "Prefer to self-describe". */
export const DEMO_GENDER_SELF_DESCRIBE = 4

export function toDemoNumberArray(value: unknown): number[] {
  if (value === undefined || value === null) return []

  let raw: unknown[] = Array.isArray(value) ? value : [value]
  if (
    raw.length === 1 &&
    raw[0] &&
    typeof raw[0] === 'object' &&
    !Array.isArray(raw[0])
  ) {
    const record = raw[0] as Record<string, unknown>
    if (record.answer !== undefined) raw = Array.isArray(record.answer) ? record.answer : [record.answer]
    else if (Array.isArray(record.answers)) raw = record.answers
  }

  const nums: number[] = []
  for (const item of raw) {
    if (typeof item === 'number' && !Number.isNaN(item)) nums.push(item)
    else if (typeof item === 'string') {
      const parsed = parseInt(item, 10)
      if (!Number.isNaN(parsed)) nums.push(parsed)
    }
  }
  return nums
}

const LEGACY_DEMO_KEY_BY_ID: Record<string, string> = {
  demo_000: '0',
  demo_001: '1',
  demo_002: '2',
}

export function readDemoAnswer(
  answers: Record<string, unknown> | undefined,
  key: string,
  fallbackIndex: number,
  preferredAnswers?: Record<string, unknown>,
): unknown {
  if (!answers) answers = {}

  let value = answers[key]
  if (value === undefined && key.startsWith('demo_')) {
    const legacyKey = LEGACY_DEMO_KEY_BY_ID[key]
    if (legacyKey) value = answers[legacyKey]
  }
  if (value === undefined) {
    value = answers[String(fallbackIndex)]
  }

  if (value === undefined && preferredAnswers) {
    value = preferredAnswers[key]
    if (value === undefined && key.startsWith('demo_')) {
      const legacyKey = LEGACY_DEMO_KEY_BY_ID[key]
      if (legacyKey) value = preferredAnswers[legacyKey]
    }
    if (value === undefined) {
      value = preferredAnswers[String(fallbackIndex)]
    }
  }

  return value
}

export function hasSpecificGenderInterest(interestedIn: unknown): boolean {
  const values = toDemoNumberArray(interestedIn)
  return values.length > 0 && !values.includes(DEMO_INTERESTED_ANYONE)
}

export function isOpenToAnyone(interestedIn: unknown): boolean {
  return toDemoNumberArray(interestedIn).includes(DEMO_INTERESTED_ANYONE)
}

export function viewerHasDemographics(myGender: unknown, myInterestedIn: unknown): boolean {
  return toDemoNumberArray(myGender).length > 0 && toDemoNumberArray(myInterestedIn).length > 0
}

export function checkGenderMatch(userGender: unknown, lookingForPreference: unknown): boolean {
  const userGenderArray = toDemoNumberArray(userGender)
  const lookingForArray = toDemoNumberArray(lookingForPreference)

  if (userGenderArray.length === 0 || lookingForArray.length === 0) return false

  // Interested-in "Anyone/Everyone" accepts all genders.
  if (lookingForArray.includes(DEMO_INTERESTED_ANYONE)) return true

  for (const gender of userGenderArray) {
    if (lookingForArray.includes(gender)) return true
    if (gender === DEMO_GENDER_SELF_DESCRIBE) return true
  }

  return false
}

/** Mutual gender compatibility with stricter rules for specific seekers. */
export function areDemographicsCompatible(
  myGender: unknown,
  myInterestedIn: unknown,
  otherGender: unknown,
  otherInterestedIn: unknown,
): boolean {
  if (!viewerHasDemographics(myGender, myInterestedIn)) return true
  if (!viewerHasDemographics(otherGender, otherInterestedIn)) return false

  if (!checkGenderMatch(myGender, otherInterestedIn)) return false
  if (!checkGenderMatch(otherGender, myInterestedIn)) return false

  // Women-only seekers shouldn't see people open to "Anyone/Everyone".
  if (hasSpecificGenderInterest(myInterestedIn) && isOpenToAnyone(otherInterestedIn)) {
    return false
  }

  return true
}
