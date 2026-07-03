const CUSTOM_PROFANITY = [
  'anal', 'anus', 'asshole', 'bastard', 'bitch', 'blowjob', 'clit', 'cock', 'cum', 'cunt',
  'deepthroat', 'dick', 'dildo', 'facial', 'faggot', 'fuck', 'gangbang', 'handjob', 'hentai',
  'jerkoff', 'jizz', 'kike', 'labia', 'masturbat', 'milf', 'motherfucker', 'nazi', 'negro',
  'nigga', 'nigger', 'pecker', 'penis', 'porn', 'pussy', 'rimjob', 'rape', 'shemale', 'shit',
  'slut', 'spic', 'titty', 'twat', 'vagina',
]

const PROFANITY_SET = new Set(CUSTOM_PROFANITY)

export function normalizeMessage(text: string): string {
  if (!text) return ''
  return text.trim().replace(/\s+/g, ' ')
}

export function checkProfanity(text: string) {
  const normalized = normalizeMessage(text)
  const matches = new Set<string>()
  if (!normalized) return { isProfane: false, matches: [] as string[], normalized }

  const tokens = normalized.toLowerCase().split(/\b/)
  for (const token of tokens) {
    if (PROFANITY_SET.has(token)) matches.add(token)
  }

  const patterns = [
    { regex: /(f+[\W_]*u+[\W_]*c+[\W_]*k+)/i, label: 'fuck' },
    { regex: /(s+[\W_]*h+[\W_]*i+[\W_]*t+)/i, label: 'shit' },
    { regex: /(b+[\W_]*i+[\W_]*t+[\W_]*c+[\W_]*h+)/i, label: 'bitch' },
    { regex: /(c+[\W_]*u+[\W_]*n+[\W_]*t+)/i, label: 'cunt' },
    { regex: /(n+[\W_]*i+[\W_]*g+[\W_]*g+[\W_]*a+)/i, label: 'nigga' },
    { regex: /(p+[\W_]*o+[\W_]*r+[\W_]*n+)/i, label: 'porn' },
  ]
  for (const { regex, label } of patterns) {
    if (regex.test(normalized)) matches.add(label)
  }

  return { isProfane: matches.size > 0, matches: Array.from(matches), normalized }
}

export function previewText(text: string, maxLength = 180) {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return `${text.substring(0, maxLength)}…`
}

export function conversationIdForUsers(userA: string, userB: string) {
  return [userA, userB].sort().join('_')
}
