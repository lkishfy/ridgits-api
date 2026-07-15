import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api-errors'

vi.mock('@/lib/firebase-admin', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/apple-jws-verifier', () => ({
  verifyAppleTransactionJws: vi.fn(),
  verifyAppleRenewalJws: vi.fn(),
}))

vi.mock('@/lib/subscription-badge', () => ({
  syncSubscriptionBadge: vi.fn(),
  revokeSubscriptionBadge: vi.fn(),
}))

vi.mock('@/lib/ridgits-pack-access', () => ({
  purgeLockedPackQuizData: vi.fn(),
}))

vi.mock('@/lib/profile-complete', () => ({
  assertProfileCompleteForPurchase: vi.fn(),
}))

describe('syncRenewalPreference', () => {
  it('rejects upgrade without signedRenewalInfo', async () => {
    const { syncRenewalPreference } = await import('@/lib/ridgits-iap')
    await expect(
      syncRenewalPreference({
        uid: 'uid-1',
        renewalProductId: 'RidgitsPlusMonthly999',
        signedRenewalInfo: '',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_IAP_SIGNATURE',
      status: 400,
    })
  })
})

describe('IAP ownership helpers', () => {
  it('findIapOwnerUid returns null when claim doc is missing', async () => {
    const { getDb } = await import('@/lib/firebase-admin')
    const get = vi.fn().mockResolvedValue({ exists: false })
    vi.mocked(getDb).mockReturnValue({
      collection: vi.fn().mockReturnValue({
        doc: vi.fn().mockReturnValue({ get }),
      }),
    } as never)

    const { findIapOwnerUid } = await import('@/lib/ridgits-iap')
    await expect(findIapOwnerUid('txn-123')).resolves.toBeNull()
  })

  it('findIapOwnerUid returns uid from claim doc', async () => {
    const { getDb } = await import('@/lib/firebase-admin')
    const get = vi.fn().mockResolvedValue({
      exists: true,
      get: (field: string) => (field === 'uid' ? 'user-abc' : undefined),
    })
    vi.mocked(getDb).mockReturnValue({
      collection: vi.fn().mockReturnValue({
        doc: vi.fn().mockReturnValue({ get }),
      }),
    } as never)

    const { findIapOwnerUid } = await import('@/lib/ridgits-iap')
    await expect(findIapOwnerUid('txn-456')).resolves.toBe('user-abc')
  })
})

describe('linkPurchase ownership conflict', () => {
  it('throws IAP_ALREADY_CLAIMED when transaction belongs to another uid', async () => {
    const { getDb } = await import('@/lib/firebase-admin')
    const { verifyAppleTransactionJws } = await import('@/lib/apple-jws-verifier')

    vi.mocked(verifyAppleTransactionJws).mockResolvedValue({
      productId: 'RidgitsPlusMonthly999',
      transactionId: 'txn-owned',
      originalTransactionId: 'orig-1',
      bundleId: 'com.ridgits.app',
      expiresDate: Date.now() + 86_400_000,
    } as never)

    const ownershipGet = vi.fn().mockResolvedValue({
      exists: true,
      get: (field: string) => (field === 'uid' ? 'other-user' : undefined),
    })
    const userGet = vi.fn().mockResolvedValue({
      exists: true,
      get: (field: string) => {
        if (field === 'processedTransactions') return []
        if (field === 'subscriptionTier') return 'free'
        return undefined
      },
      data: () => ({ subscriptionTier: 'free' }),
    })

    const runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: vi.fn(async (ref: { path?: string }) => {
          if (ref && typeof ref === 'object' && 'path' in ref && String(ref.path).includes('iapOwnership')) {
            return ownershipGet()
          }
          return userGet()
        }),
        set: vi.fn(),
      }
      return fn(tx)
    })

    vi.mocked(getDb).mockReturnValue({
      collection: vi.fn((name: string) => ({
        doc: vi.fn((id: string) => ({ path: `${name}/${id}` })),
      })),
      runTransaction,
    } as never)

    const { linkPurchase } = await import('@/lib/ridgits-iap')
    await expect(
      linkPurchase({
        uid: 'my-user',
        signedTransactionInfo: 'header.payload.sig',
      }),
    ).rejects.toBeInstanceOf(ApiError)

    await expect(
      linkPurchase({
        uid: 'my-user',
        signedTransactionInfo: 'header.payload.sig',
      }),
    ).rejects.toMatchObject({ code: 'IAP_ALREADY_CLAIMED', status: 409 })
  })
})
