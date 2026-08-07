import {
  COLORMAP_NAMES,
  COLORMAP_SIZE,
  getColormapGradientCss,
  getColormapLut,
} from '../colormap'

describe('getColormapLut', () => {
  it.each(COLORMAP_NAMES)('builds a full RGB table for %s', (name) => {
    const lut = getColormapLut(name)
    expect(lut).toHaveLength(COLORMAP_SIZE * 3)
    expect(lut.every((value) => value >= 0 && value <= 255)).toBe(true)
  })

  it('returns the same instance on repeated calls', () => {
    expect(getColormapLut('VIRIDIS')).toBe(getColormapLut('VIRIDIS'))
  })

  it('starts and ends on the control points of the ramp', () => {
    const lut = getColormapLut('VIRIDIS')
    expect(Array.from(lut.slice(0, 3))).toEqual([68, 1, 84])
    expect(Array.from(lut.slice(-3))).toEqual([253, 231, 37])
  })

  it('interpolates a two-point ramp monotonically', () => {
    const lut = getColormapLut('GRAY')
    for (let i = 1; i < COLORMAP_SIZE; i++) {
      expect(lut[i * 3]).toBeGreaterThanOrEqual(lut[(i - 1) * 3])
    }
    expect(Array.from(lut.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(lut.slice(-3))).toEqual([255, 255, 255])
  })
})

describe('getColormapGradientCss', () => {
  it('spans the full width of the swatch', () => {
    const gradient = getColormapGradientCss('GRAY')
    expect(gradient).toBe(
      'linear-gradient(to right, rgb(0,0,0) 0.0%, rgb(255,255,255) 100.0%)',
    )
  })
})
