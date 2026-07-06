export type NormalizedUSLocation = {
  city: string
  stateCode: string
  display: string
  geocodeQuery: string
}

export const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
])

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
}

export const US_STATES = Object.entries(US_STATE_NAME_TO_CODE)
  .map(([name, code]) => ({ code, name: titleCaseWords(name) }))
  .sort((a, b) => a.name.localeCompare(b.name))

function titleCaseWords(value: string): string {
  return value
    .split(' ')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function titleCaseCity(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (!part) return part
      if (part.length <= 3 && part === part.toUpperCase()) return part
      return part[0]!.toUpperCase() + part.slice(1).toLowerCase()
    })
    .join(' ')
}

export function resolveStateCode(token: string): string | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase()
    return US_STATE_CODES.has(code) ? code : null
  }

  return US_STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null
}

function buildNormalized(city: string, stateCode: string): NormalizedUSLocation {
  const normalizedCity = titleCaseCity(city)
  const normalizedState = stateCode.toUpperCase()
  const display = `${normalizedCity}, ${normalizedState}`
  return {
    city: normalizedCity,
    stateCode: normalizedState,
    display,
    geocodeQuery: `${display}, United States`,
  }
}

const US_COUNTRY_TOKENS = new Set([
  'usa',
  'u.s.a.',
  'u.s.a',
  'us',
  'united states',
  'united states of america',
  'america',
])

/** Bare city names that uniquely resolve to a US state when no comma/state is present. */
const STANDALONE_US_CITIES: Record<string, string> = {
  'new york': 'NY',
  'new york city': 'NY',
  nyc: 'NY',
  brooklyn: 'NY',
  manhattan: 'NY',
  queens: 'NY',
  bronx: 'NY',
  'staten island': 'NY',
  'long island': 'NY',
}

/** Strip trailing country suffixes from comma-separated location parts. */
export function stripTrailingCountryParts(parts: string[]): string[] {
  if (parts.length === 0) return parts
  const last = parts[parts.length - 1]!.trim().toLowerCase()
  if (US_COUNTRY_TOKENS.has(last)) {
    return stripTrailingCountryParts(parts.slice(0, -1))
  }
  return parts
}

function dedupeCityParts(parts: string[]): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!
  const first = parts[0]!.trim()
  const allSame = parts.every((part) => part.trim().toLowerCase() === first.toLowerCase())
  return allSame ? first : parts[0]!.trim()
}

export function normalizeUSLocation(
  input: string,
  structured?: { city?: string | null; stateCode?: string | null },
): NormalizedUSLocation | null {
  const structuredCity = String(structured?.city ?? '').trim()
  const structuredState = String(structured?.stateCode ?? '').trim()
  if (structuredCity && structuredState) {
    const stateCode = resolveStateCode(structuredState)
    if (!stateCode) return null
    return buildNormalized(structuredCity, stateCode)
  }

  const trimmed = input.trim()
  if (!trimmed) return null

  const commaParts = stripTrailingCountryParts(
    trimmed.split(',').map((part) => part.trim()).filter(Boolean),
  )
  if (commaParts.length >= 2) {
    const stateCode = resolveStateCode(commaParts[commaParts.length - 1]!)
    if (stateCode) {
      const city = dedupeCityParts(commaParts.slice(0, -1))
      if (city) return buildNormalized(city, stateCode)
    }
  }

  const trailingStateCode = trimmed.match(/^(.+?)[,\s]+([A-Za-z]{2})$/i)
  if (trailingStateCode) {
    const stateCode = resolveStateCode(trailingStateCode[2]!)
    if (stateCode) {
      const city = trailingStateCode[1]!.replace(/,\s*$/, '').trim()
      if (city) return buildNormalized(city, stateCode)
    }
  }

  const trailingStateName = trimmed.match(/^(.+?)[,\s]+([A-Za-z][A-Za-z\s.'-]+)$/i)
  if (trailingStateName) {
    const stateCode = resolveStateCode(trailingStateName[2]!)
    if (stateCode) {
      const city = trailingStateName[1]!.replace(/,\s*$/, '').trim()
      if (city) return buildNormalized(city, stateCode)
    }
  }

  const standaloneState = STANDALONE_US_CITIES[trimmed.toLowerCase()]
  if (standaloneState) {
    return buildNormalized(trimmed, standaloneState)
  }

  return null
}

export function readProfileLocationFields(profile: Record<string, unknown>): {
  location: string
  city: string
  stateCode: string
} {
  return {
    location: String(profile.location ?? '').trim(),
    city: String(profile.locationCity ?? '').trim(),
    stateCode: String(profile.locationStateCode ?? '').trim(),
  }
}

export function resolveProfileLocation(profile: Record<string, unknown>): NormalizedUSLocation | null {
  const fields = readProfileLocationFields(profile)
  return normalizeUSLocation(fields.location, {
    city: fields.city,
    stateCode: fields.stateCode,
  })
}

export function locationCacheKey(profile: Record<string, unknown>): string {
  const normalized = resolveProfileLocation(profile)
  if (normalized) return normalized.display
  return readProfileLocationFields(profile).location
}

const NON_US_COUNTRY_TOKENS = new Set([
  'uk',
  'united kingdom',
  'england',
  'scotland',
  'wales',
  'northern ireland',
  'ireland',
  'canada',
  'mexico',
  'australia',
  'new zealand',
  'france',
  'germany',
  'spain',
  'italy',
  'portugal',
  'netherlands',
  'belgium',
  'switzerland',
  'austria',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'poland',
  'czech republic',
  'czechia',
  'hungary',
  'romania',
  'greece',
  'turkey',
  'israel',
  'uae',
  'united arab emirates',
  'india',
  'pakistan',
  'china',
  'japan',
  'south korea',
  'korea',
  'singapore',
  'hong kong',
  'taiwan',
  'thailand',
  'vietnam',
  'philippines',
  'indonesia',
  'brazil',
  'argentina',
  'colombia',
  'chile',
  'peru',
  'south africa',
  'nigeria',
  'egypt',
  'russia',
  'ukraine',
])

/** Rough bounding box for US states and territories commonly geocoded for members. */
export function isCoordinateInUnitedStates(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  const inLower48 = lat >= 24.0 && lat <= 49.5 && lng >= -125.0 && lng <= -66.0
  const inAlaska = lat >= 51.0 && lat <= 72.0 && lng >= -179.0 && lng <= -129.0
  const inHawaii = lat >= 18.0 && lat <= 23.0 && lng >= -161.0 && lng <= -154.0
  const inPuertoRico = lat >= 17.5 && lat <= 18.6 && lng >= -67.5 && lng <= -65.0
  return inLower48 || inAlaska || inHawaii || inPuertoRico
}

function hasExplicitNonUSCountryLocation(location: string): boolean {
  const trimmed = location.trim()
  if (!trimmed) return false

  const commaParts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (commaParts.length >= 2) {
    const last = commaParts[commaParts.length - 1]!.toLowerCase()
    if (NON_US_COUNTRY_TOKENS.has(last)) return true
    if (!US_COUNTRY_TOKENS.has(last) && !resolveStateCode(commaParts[commaParts.length - 1]!)) {
      // Trailing token is neither US country nor US state — treat as non-US.
      if (commaParts.length >= 3 || last.length > 3) return true
    }
  }

  return false
}

/** True when a profile location resolves to the United States. */
export function isProfileInUnitedStates(profile: Record<string, unknown>): boolean {
  const fields = readProfileLocationFields(profile)
  if (fields.stateCode && US_STATE_CODES.has(fields.stateCode.toUpperCase())) {
    return true
  }
  if (fields.location && hasExplicitNonUSCountryLocation(fields.location)) {
    return false
  }
  if (resolveProfileLocation(profile)) {
    return true
  }

  const coords = profile.coordinates as { lat?: unknown; lng?: unknown } | undefined
  const lat = typeof coords?.lat === 'number' ? coords.lat : null
  const lng = typeof coords?.lng === 'number' ? coords.lng : null
  if (lat != null && lng != null && isCoordinateInUnitedStates(lat, lng)) {
    return true
  }

  return false
}
