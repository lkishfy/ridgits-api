import { describe, expect, it } from 'vitest'
import { normalizeUSLocation, stripTrailingCountryParts } from '@/lib/location/normalize'
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
