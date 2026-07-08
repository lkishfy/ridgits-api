import { describe, expect, it } from 'vitest'
import { decodeAppleJwsPayload } from '@/lib/apple-jws'

describe('Apple IAP security', () => {
  it('rejects forged JWS without valid signature at verifier layer', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: ['fake'] })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        productId: 'RidgitsPremiumMonthly',
        transactionId: '999999',
        bundleId: 'com.ridgits.app',
        expiresDate: Date.now() + 86_400_000,
      }),
    ).toString('base64url')
    const forged = `${header}.${payload}.forged-signature`

    const { verifyAppleTransactionJws } = await import('@/lib/apple-jws-verifier')
    await expect(verifyAppleTransactionJws(forged)).rejects.toMatchObject({
      code: 'INVALID_IAP_SIGNATURE',
    })
  })

  it('decode-only path still parses payload (legacy helper — must not be used for grants)', () => {
    const payload = Buffer.from(JSON.stringify({ productId: 'test' })).toString('base64url')
    const decoded = decodeAppleJwsPayload(`x.${payload}.y`)
    expect(decoded.productId).toBe('test')
  })
})
