import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'

/** One-time grant when a user first checks poke balance (no IAP required to try). */
export const STARTER_POKE_CREDITS = 3

export type PokeCreditBalance = {
  balance: number
  starterGrantApplied: boolean
}

function readBalance(data: Record<string, unknown> | undefined): number {
  return typeof data?.pokeCreditBalance === 'number' ? Math.max(0, data.pokeCreditBalance) : 0
}

/** Returns balance, applying the starter grant once per account. */
export async function getPokeCreditBalance(uid: string): Promise<PokeCreditBalance> {
  const db = getDb()
  const userRef = db.collection('users').doc(uid)

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef)
    const data = snap.data() ?? {}
    const starterGrantApplied = data.pokeStarterGrantApplied === true
    let balance = readBalance(data)

    if (!starterGrantApplied) {
      balance += STARTER_POKE_CREDITS
      tx.set(
        userRef,
        {
          pokeCreditBalance: balance,
          pokeStarterGrantApplied: true,
        },
        { merge: true },
      )
      return { balance, starterGrantApplied: true }
    }

    return { balance, starterGrantApplied: true }
  })
}

/** Atomically spend one poke credit. */
export async function reservePokeCreditWithTransaction(tx: Transaction, uid: string): Promise<number> {
  const userRef = getDb().collection('users').doc(uid)
  const snap = await tx.get(userRef)
  const data = snap.data() ?? {}

  let balance = readBalance(data)
  if (!data.pokeStarterGrantApplied) {
    balance += STARTER_POKE_CREDITS
  }

  if (balance < 1) {
    throw new ApiError(
      'You need poke credits to send a poke. Get a poke pack to continue.',
      402,
      'POKE_CREDITS_REQUIRED',
    )
  }

  const nextBalance = balance - 1
  tx.set(
    userRef,
    {
      pokeCreditBalance: nextBalance,
      pokeStarterGrantApplied: true,
    },
    { merge: true },
  )
  return nextBalance
}

export async function addPokeCredits(uid: string, amount: number): Promise<number> {
  if (amount <= 0) throw new Error('Invalid poke credit amount')
  const userRef = getDb().collection('users').doc(uid)
  await userRef.set({ pokeCreditBalance: FieldValue.increment(amount) }, { merge: true })
  const snap = await userRef.get()
  return readBalance(snap.data())
}
