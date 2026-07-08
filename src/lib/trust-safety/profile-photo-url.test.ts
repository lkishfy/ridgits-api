import { describe, expect, it } from 'vitest'
import { assertAllowedProfilePhotoUrl } from '@/lib/trust-safety/profile-photo-url'

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
