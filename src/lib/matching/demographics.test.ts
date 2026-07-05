import { describe, expect, it } from 'vitest'
import {
  DEMO_GENDER_MAN,
  DEMO_GENDER_WOMAN,
  DEMO_INTERESTED_ANYONE,
  areDemographicsCompatible,
} from '@/lib/matching/demographics'

describe('areDemographicsCompatible', () => {
  const womanSeekingWomen = {
    myGender: [DEMO_GENDER_WOMAN],
    myInterestedIn: [DEMO_GENDER_WOMAN],
  }

  it('excludes men when the viewer only wants women', () => {
    expect(
      areDemographicsCompatible(
        womanSeekingWomen.myGender,
        womanSeekingWomen.myInterestedIn,
        [DEMO_GENDER_MAN],
        [DEMO_GENDER_WOMAN],
      ),
    ).toBe(false)
  })

  it('excludes profiles with missing gender when the viewer only wants women', () => {
    expect(
      areDemographicsCompatible(
        womanSeekingWomen.myGender,
        womanSeekingWomen.myInterestedIn,
        [],
        [DEMO_GENDER_WOMAN],
      ),
    ).toBe(false)
  })

  it('includes women when the viewer only wants women', () => {
    expect(
      areDemographicsCompatible(
        womanSeekingWomen.myGender,
        womanSeekingWomen.myInterestedIn,
        [DEMO_GENDER_WOMAN],
        [DEMO_GENDER_WOMAN],
      ),
    ).toBe(true)
  })

  it('excludes people open to anyone when the viewer only wants women', () => {
    expect(
      areDemographicsCompatible(
        womanSeekingWomen.myGender,
        womanSeekingWomen.myInterestedIn,
        [DEMO_GENDER_WOMAN],
        [DEMO_INTERESTED_ANYONE],
      ),
    ).toBe(false)
  })
})
