import { createHash } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import type Stripe from 'stripe'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'

const IDENTITY_DOCUMENT_HASH_SALT =
  process.env.RIDGITS_IDENTITY_DOCUMENT_HASH_SALT ?? 'ridgits-identity-document-salt-v1'

export function hashIdentityDocument(input: {
  documentNumber?: string
  issuingCountry?: string
  documentType?: string
  idNumber?: string
  idNumberType?: string
  nameDob?: string
}): string | null {
  const documentNumber = input.documentNumber?.trim().replace(/\s+/g, '').toUpperCase()
  if (documentNumber) {
    const country = (input.issuingCountry ?? '').trim().toUpperCase()
    const docType = (input.documentType ?? '').trim().toLowerCase()
    const raw = `doc:${country}:${docType}:${documentNumber}`
    return createHash('sha256').update(`${IDENTITY_DOCUMENT_HASH_SALT}:${raw}`).digest('hex')
  }

  const idNumber = input.idNumber?.trim().replace(/\s+/g, '')
  if (idNumber) {
    const idType = (input.idNumberType ?? '').trim().toLowerCase()
    const raw = `id:${idType}:${idNumber}`
    return createHash('sha256').update(`${IDENTITY_DOCUMENT_HASH_SALT}:${raw}`).digest('hex')
  }

  const nameDob = input.nameDob?.trim().toLowerCase()
  if (nameDob) {
    return createHash('sha256').update(`${IDENTITY_DOCUMENT_HASH_SALT}:name-dob:${nameDob}`).digest('hex')
  }

  return null
}

export async function findExistingIdentityDocumentOwner(documentHash: string): Promise<string | null> {
  const snap = await getDb().collection('identityDocumentHashes').doc(documentHash).get()
  if (!snap.exists) return null
  const uid = snap.data()?.uid
  return typeof uid === 'string' ? uid : null
}

export async function assertIdentityDocumentNotAlreadyClaimed(
  documentHash: string,
  uid: string,
): Promise<void> {
  const existing = await findExistingIdentityDocumentOwner(documentHash)
  if (existing && existing !== uid) {
    throw new ApiError(
      'This government ID is already linked to another Ridgits account.',
      409,
      'IDENTITY_DOCUMENT_ALREADY_CLAIMED',
    )
  }
}

export async function claimIdentityDocumentForUser(uid: string, documentHash: string): Promise<void> {
  const db = getDb()
  await db.collection('identityDocumentHashes').doc(documentHash).set(
    { uid, claimedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  await db.collection('users').doc(uid).set({ identityDocumentHash: documentHash }, { merge: true })
}

export async function resolveIdentityDocumentFingerprint(
  stripe: Stripe,
  session: Stripe.Identity.VerificationSession,
): Promise<string | null> {
  const idNumber = session.verified_outputs?.id_number?.trim()
  const idNumberType = session.verified_outputs?.id_number_type ?? undefined

  let report = session.last_verification_report
  if (typeof report === 'string' && report.trim()) {
    report = await stripe.identity.verificationReports.retrieve(report.trim())
  }

  if (report && typeof report === 'object' && 'document' in report) {
    const doc = (report as Stripe.Identity.VerificationReport).document
    if (doc?.status === 'verified' && doc.number?.trim()) {
      return hashIdentityDocument({
        documentNumber: doc.number.trim(),
        issuingCountry: doc.issuing_country ?? undefined,
        documentType: doc.type ?? undefined,
      })
    }
  }

  if (idNumber) {
    return hashIdentityDocument({ idNumber, idNumberType })
  }

  const first = session.verified_outputs?.first_name?.trim()
  const last = session.verified_outputs?.last_name?.trim()
  const dob = session.verified_outputs?.dob
  if (first && last && dob?.year) {
    return hashIdentityDocument({
      nameDob: `${first}|${last}|${dob.year}-${dob.month ?? 0}-${dob.day ?? 0}`,
    })
  }

  return null
}
