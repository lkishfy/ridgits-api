import { describe, expect, it } from 'vitest'
import {
  assertAllowedProfilePhotoUrl,
  assertAllowedStripeIdentitySelfieUrl,
} from '@/lib/trust-safety/profile-photo-url'

describe('assertAllowedProfilePhotoUrl', () => {
  it('allows Firebase Storage URLs', async () => {
    const url = await assertAllowedProfilePhotoUrl(
      'https://firebasestorage.googleapis.com/v0/b/ridgits-24f2d.firebasestorage.app/o/profile_images%2Fuid%2Fphoto.jpg?alt=media',
    )
    expect(url.hostname).toBe('firebasestorage.googleapis.com')
  })

  it('rejects unknown hosts', async () => {
    await expect(assertAllowedProfilePhotoUrl('https://evil.example.com/photo.jpg')).rejects.toMatchObject({
      code: 'INVALID_PROFILE_PHOTO',
    })
  })

  it('rejects non-https URLs', async () => {
    await expect(
      assertAllowedProfilePhotoUrl('http://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media'),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE_PHOTO' })
  })

  it('rejects localhost', async () => {
    await expect(assertAllowedProfilePhotoUrl('https://localhost/photo.jpg')).rejects.toMatchObject({
      code: 'INVALID_PROFILE_PHOTO',
    })
  })
})

describe('assertAllowedStripeIdentitySelfieUrl', () => {
  it('allows Stripe file link URLs', async () => {
    const url = await assertAllowedStripeIdentitySelfieUrl(
      'https://files.stripe.com/v1/links/fl_test_abc123',
    )
    expect(url.hostname).toBe('files.stripe.com')
  })

  it('rejects non-Stripe hosts', async () => {
    await expect(
      assertAllowedStripeIdentitySelfieUrl('https://evil.example.com/selfie.jpg'),
    ).rejects.toMatchObject({ code: 'IDENTITY_SELFIE_UNAVAILABLE' })
  })

  it('rejects profile storage URLs', async () => {
    await expect(
      assertAllowedStripeIdentitySelfieUrl(
        'https://firebasestorage.googleapis.com/v0/b/ridgits/o/photo.jpg?alt=media',
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_SELFIE_UNAVAILABLE' })
  })
})
