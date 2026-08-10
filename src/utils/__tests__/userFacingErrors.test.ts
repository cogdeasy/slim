import { CustomError, errorTypes } from '../CustomError'
import {
  describeError,
  ErrorImpact,
  getImpactStatement,
} from '../userFacingErrors'

describe('describeError', () => {
  it('describes a missing resource as not found', () => {
    const described = describeError({ status: 404, message: 'request failed' })
    expect(described.title).toBe('Data not found on the server')
    expect(described.impact).toBe(ErrorImpact.BLOCKED)
  })

  it('describes an unreachable server as a connection problem', () => {
    const described = describeError({ status: 0, message: 'request failed' })
    expect(described.title).toBe('Cannot reach the image server')
    expect(described.isTransient).toBe(true)
  })

  it('describes server errors as transient and degrading', () => {
    const described = describeError({ status: 503, message: 'request failed' })
    expect(described.impact).toBe(ErrorImpact.DEGRADED)
    expect(described.isTransient).toBe(true)
  })

  it('describes a failing ICC profile as a colour accuracy problem', () => {
    const described = describeError(
      new Error('Failed to fetch ICC profiles for optical path "1"'),
    )
    expect(described.title).toBe('Colour profile could not be loaded')
    expect(described.impact).toBe(ErrorImpact.DEGRADED)
  })

  it('prefers the content of the message over the status code', () => {
    const error = Object.assign(
      new Error('Failed to fetch ICC profiles for optical path "1"'),
      { status: 404 },
    )
    expect(describeError(error).title).toBe('Colour profile could not be loaded')
  })

  it('describes an inconsistent pyramid as invalid data', () => {
    const described = describeError(
      new Error('Pyramid of optical path "1" is different from reference pyramid.'),
    )
    expect(described.title).toBe('Slide images are inconsistent')
    expect(described.impact).toBe(ErrorImpact.BLOCKED)
  })

  it('falls back to the category of a custom error', () => {
    const described = describeError(
      new CustomError(errorTypes.AUTHENTICATION, 'oidc handshake broke'),
    )
    expect(described.title).toBe('Sign-in problem')
  })

  it('never exposes the technical message to the user', () => {
    const described = describeError(new Error('ENOTSUP raised in module xyz'))
    expect(described.description).not.toContain('ENOTSUP')
  })
})

describe('getImpactStatement', () => {
  it('says nothing when the display is unaffected', () => {
    expect(getImpactStatement(ErrorImpact.NONE)).toBe('')
  })

  it('warns that the displayed slide may be incomplete', () => {
    expect(getImpactStatement(ErrorImpact.DEGRADED)).toContain('still displayed')
  })
})
