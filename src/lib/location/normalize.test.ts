import { describe, expect, it } from 'vitest'
import {
  isCoordinateInUnitedStates,
  isProfileInUnitedStates,
  normalizeUSLocation,
  stripTrailingCountryParts,
} from '@/lib/location/normalize'
import { isNYMetroArea, sharedMetroArea } from '@/lib/location/metro-areas'

describe('stripTrailingCountryParts', () => {
  it('removes trailing USA suffix', () => {
    expect(stripTrailingCountryParts(['Brooklyn', 'NY', 'USA'])).toEqual(['Brooklyn', 'NY'])
  })

  it('removes trailing United States suffix', () => {
    expect(stripTrailingCountryParts(['Brooklyn', 'New York', 'United States'])).toEqual([
      'Brooklyn',
      'New York',
    ])
  })

  it('leaves city/state-only parts unchanged', () => {
    expect(stripTrailingCountryParts(['Brooklyn', 'NY'])).toEqual(['Brooklyn', 'NY'])
  })
})

describe('normalizeUSLocation', () => {
  it('parses Brooklyn, NY, USA', () => {
    const result = normalizeUSLocation('Brooklyn, NY, USA')
    expect(result).toEqual({
      city: 'Brooklyn',
      stateCode: 'NY',
      display: 'Brooklyn, NY',
      geocodeQuery: 'Brooklyn, NY, United States',
    })
  })

  it('parses Brooklyn, New York, United States', () => {
    const result = normalizeUSLocation('Brooklyn, New York, United States')
    expect(result?.city).toBe('Brooklyn')
    expect(result?.stateCode).toBe('NY')
    expect(result?.display).toBe('Brooklyn, NY')
  })

  it('parses Brooklyn NY without comma', () => {
    const result = normalizeUSLocation('Brooklyn NY')
    expect(result?.display).toBe('Brooklyn, NY')
  })

  it('parses NYC as city with state', () => {
    const result = normalizeUSLocation('NYC, NY')
    expect(result?.city).toBe('NYC')
    expect(result?.stateCode).toBe('NY')
  })

  it('parses bare New York as New York, NY', () => {
    const result = normalizeUSLocation('New York')
    expect(result?.display).toBe('New York, NY')
  })

  it('parses bare NYC as NYC, NY', () => {
    const result = normalizeUSLocation('NYC')
    expect(result?.display).toBe('NYC, NY')
  })

  it('parses bare Brooklyn as Brooklyn, NY', () => {
    const result = normalizeUSLocation('Brooklyn')
    expect(result?.display).toBe('Brooklyn, NY')
  })
})

describe('metro area detection', () => {
  it('detects NYC abbreviation in location string', () => {
    expect(isNYMetroArea({ location: 'NYC, NY' })).toBe(true)
  })

  it('detects new york city token', () => {
    expect(isNYMetroArea({ location: 'New York City, NY' })).toBe(true)
  })

  it('treats two NYC metro profiles as shared metro', () => {
    const brooklyn = { location: 'Brooklyn, NY' }
    const queens = { location: 'Queens, NY' }
    expect(sharedMetroArea(brooklyn, queens)).toBe(true)
  })

  it('does not match Brooklyn to Tacoma', () => {
    expect(sharedMetroArea({ location: 'Brooklyn, NY' }, { location: 'Tacoma, WA' })).toBe(false)
  })

  it('does not treat Rochester, New York as NYC metro', () => {
    expect(isNYMetroArea({ location: 'Rochester, New York' })).toBe(false)
  })

  it('detects bare New York as NYC metro', () => {
    expect(isNYMetroArea({ location: 'New York' })).toBe(true)
  })
})

describe('isProfileInUnitedStates', () => {
  it('accepts US city and state profiles', () => {
    expect(isProfileInUnitedStates({ location: 'Brooklyn, NY' })).toBe(true)
    expect(isProfileInUnitedStates({ locationCity: 'Austin', locationStateCode: 'TX' })).toBe(true)
  })

  it('rejects explicit non-US countries', () => {
    expect(isProfileInUnitedStates({ location: 'London, UK' })).toBe(false)
    expect(isProfileInUnitedStates({ location: 'Toronto, ON, Canada' })).toBe(false)
    expect(isProfileInUnitedStates({ location: 'Paris, France' })).toBe(false)
  })

  it('accepts stored US coordinates when location text is sparse', () => {
    expect(
      isProfileInUnitedStates({
        location: 'Brooklyn',
        coordinates: { lat: 40.6782, lng: -73.9442 },
      }),
    ).toBe(true)
  })

  it('rejects coordinates outside the United States', () => {
    expect(
      isProfileInUnitedStates({
        location: 'London',
        coordinates: { lat: 51.5074, lng: -0.1278 },
      }),
    ).toBe(false)
  })
})

describe('isCoordinateInUnitedStates', () => {
  it('includes lower 48, Alaska, Hawaii, and Puerto Rico', () => {
    expect(isCoordinateInUnitedStates(40.7128, -74.006)).toBe(true)
    expect(isCoordinateInUnitedStates(61.2181, -149.9003)).toBe(true)
    expect(isCoordinateInUnitedStates(21.3069, -157.8583)).toBe(true)
    expect(isCoordinateInUnitedStates(18.4655, -66.1057)).toBe(true)
    expect(isCoordinateInUnitedStates(51.5074, -0.1278)).toBe(false)
  })
})
