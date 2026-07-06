import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getDb } from '../src/lib/firebase-admin'
import {
  calculateCompatibility,
  toArrayOrEmpty,
  arraysOverlap,
  isVisibleInCommunity,
} from '../src/lib/matching/compatibility'
import {
  areDemographicsCompatible,
  readDemoAnswer,
  viewerHasDemographics,
} from '../src/lib/matching/demographics'
import { isNYMetroArea, sharedMetroArea } from '../src/lib/location/metro-areas'
import { getVerifiedEmailMap } from '../src/lib/trust-safety/email-verification'
import { normalizeQuizProgress } from '../src/lib/matching/quiz-normalize'

function loadEnvFile(filename: string): void {
  const path = resolve(process.cwd(), filename)
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

const uid = '8WLgCiKj73cEHj5LecmMBvvq31Z2'

function demoAnswer(
  quiz: ReturnType<typeof normalizeQuizProgress>,
  key: string,
  fallbackIndex: number,
) {
  return readDemoAnswer(quiz.answers, key, fallbackIndex, quiz.preferredAnswers)
}

async function main(): Promise<void> {
  const db = getDb()
  const [viewerQuizSnap, viewerUserSnap, viewerPublicSnap, completedSnap] = await Promise.all([
    db.collection('quizProgress').doc(uid).get(),
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
    db.collection('quizProgress').where('completed', '==', true).get(),
  ])
  const viewerUser = viewerUserSnap.data() ?? {}
  const viewerPublic = viewerPublicSnap.data() ?? {}
  const mergedViewer = { ...viewerUser, ...viewerPublic }
  const userQuiz = normalizeQuizProgress(viewerQuizSnap.data() ?? {})
  const myGender = demoAnswer(userQuiz, 'demo_000', 0)
  const myInterestedIn = demoAnswer(userQuiz, 'demo_001', 1)
  const myIntent = toArrayOrEmpty(demoAnswer(userQuiz, 'demo_002', 2))
  const viewerDemographicsSet = viewerHasDemographics(myGender, myInterestedIn)
  const ageMin = parseInt(String(viewerUser.ageRangeMin), 10)
  const ageMax = parseInt(String(viewerUser.ageRangeMax), 10)

  const eligible: string[] = []

  for (const doc of completedSnap.docs) {
    if (doc.id === uid) continue
    const raw = doc.data() ?? {}
    const otherQuiz = normalizeQuizProgress(raw)
    if (viewerDemographicsSet) {
      const otherGender = demoAnswer(otherQuiz, 'demo_000', 0)
      const otherInterestedIn = demoAnswer(otherQuiz, 'demo_001', 1)
      if (!areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)) continue
    }
    const otherIntent = toArrayOrEmpty(demoAnswer(otherQuiz, 'demo_002', 2))
    if (myIntent.length > 0 && otherIntent.length > 0 && !arraysOverlap(myIntent, otherIntent)) continue
    const compat = calculateCompatibility(userQuiz, otherQuiz)
    if (compat.overall < 5) continue

    const [userSnap, publicSnap] = await Promise.all([
      db.collection('users').doc(doc.id).get(),
      db.collection('publicProfiles').doc(doc.id).get(),
    ])
    const user = userSnap.data() ?? {}
    const pub = publicSnap.data() ?? {}
    const merged = { ...user, ...pub }
    if (!isNYMetroArea(merged) || !sharedMetroArea(mergedViewer, merged)) continue

    const emailMap = await getVerifiedEmailMap([doc.id])
    if (emailMap.get(doc.id) !== true) continue
    if (!isVisibleInCommunity(pub) || !isVisibleInCommunity(user)) continue

    const name = String(pub.name ?? '').trim()
    const image = String(pub.image ?? '').trim()
    const about = String(pub.about ?? '').trim()
    const location = String(pub.location ?? '').trim()
    if (!name || name.toLowerCase() === 'anonymous' || !image || !about || !location) continue

    const age = user.age ? parseInt(String(user.age), 10) : null
    if (age === null || Number.isNaN(age) || age < ageMin || age > ageMax) continue

    eligible.push(`${name} (${age}) @ ${location} compat=${compat.overall}`)
  }

  console.log(`Age range: ${ageMin}-${ageMax}`)
  console.log(`Eligible NYC metro matches: ${eligible.length}`)
  eligible.sort().forEach((line) => console.log(' ', line))
}

main().catch(console.error)
