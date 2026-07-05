import { describe, expect, it } from 'vitest'
import { isProfileCompleteForMatching } from '@/lib/profile-complete'

const completeProfile = {
  name: 'Alex',
  locationCity: 'Brooklyn',
  locationStateCode: 'NY',
  age: 28,
  image: 'https://cdn.example.com/photo.jpg',
  about: 'Coffee and long walks.',
  interests: ['hiking'],
  aspirations: 'Build something meaningful.',
}

describe('isProfileCompleteForMatching', () => {
  it('accepts a complete profile', () => {
    expect(isProfileCompleteForMatching(completeProfile)).toBe(true)
  })

  it('rejects missing photo', () => {
    expect(isProfileCompleteForMatching({ ...completeProfile, image: '' })).toBe(false)
  })

  it('rejects missing interests', () => {
    expect(isProfileCompleteForMatching({ ...completeProfile, interests: [] })).toBe(false)
  })

  it('accepts legacy location string without city/state', () => {
    expect(
      isProfileCompleteForMatching({
        ...completeProfile,
        location: 'Brooklyn, NY',
        locationCity: '',
        locationStateCode: '',
      }),
    ).toBe(true)
  })
})
