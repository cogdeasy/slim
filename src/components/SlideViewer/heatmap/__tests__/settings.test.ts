import { getMillimeterPerUnit } from '../affine'
import { createNormalizer, isLogScaleApplicable } from '../scaling'
import {
  applySettingsPatch,
  normalizeFilterRange,
  requiresMeasurement,
} from '../settings'
import { DEFAULT_HEATMAP_SETTINGS, type HeatmapSettings } from '../types'

const AREA = {
  CodeValue: '42798000',
  CodingSchemeDesignator: 'SCT',
  CodeMeaning: 'Area',
} as unknown as HeatmapSettings['measurement']

describe('requiresMeasurement', () => {
  it('is false only for the density metric', () => {
    expect(requiresMeasurement('density')).toBe(false)
    expect(requiresMeasurement('mean')).toBe(true)
    expect(requiresMeasurement('max')).toBe(true)
    expect(requiresMeasurement('sum')).toBe(true)
  })
})

describe('applySettingsPatch', () => {
  const settings: HeatmapSettings = {
    ...DEFAULT_HEATMAP_SETTINGS,
    annotationGroupUID: 'group-a',
    metric: 'mean',
    measurement: AREA,
    clampRange: [0, 10],
    filterRange: [1, 5],
  }

  it('applies the patch', () => {
    expect(applySettingsPatch(settings, { opacity: 0.2 }).opacity).toBe(0.2)
  })

  it('keeps the clamp when only the rendering changes', () => {
    expect(applySettingsPatch(settings, { colormap: 'HOT' }).clampRange).toEqual(
      [0, 10],
    )
  })

  it('drops the clamp when the aggregated quantity changes', () => {
    expect(applySettingsPatch(settings, { metric: 'sum' }).clampRange).toBeUndefined()
    expect(
      applySettingsPatch(settings, { binSizeMicrometer: 50 }).clampRange,
    ).toBeUndefined()
  })

  it('drops the measurement and the filter when the group changes', () => {
    const updated = applySettingsPatch(settings, {
      annotationGroupUID: 'group-b',
    })
    expect(updated.measurement).toBeUndefined()
    expect(updated.filterRange).toBeUndefined()
  })

  it('keeps the filter while only the clamp is dragged', () => {
    expect(
      applySettingsPatch(settings, { clampRange: [2, 8] }).filterRange,
    ).toEqual([1, 5])
  })

  it('drops the filter when the metric stops using a measurement', () => {
    /*
     * The filter slider is hidden for the density metric, so a surviving
     * filter would keep annotations hidden with nothing left to restore them.
     */
    expect(
      applySettingsPatch(settings, { metric: 'density' }).filterRange,
    ).toBeUndefined()
  })

  it('falls back to density when the source becomes regions of interest', () => {
    /*
     * Regions of interest carry no per-annotation measurements, so a metric
     * kept from an annotation group would leave the panel asking for a
     * measurement that the source cannot offer.
     */
    const updated = applySettingsPatch(settings, { sourceKind: 'rois' })
    expect(updated.metric).toBe('density')
    expect(updated.measurement).toBeUndefined()
  })

  it('drops the filter and the clamp when the measurement is cleared', () => {
    /*
     * Clearing the measurement changes what is aggregated just as much as
     * picking another one does, so a patch that sets it to `undefined` has to
     * invalidate the ranges expressed in the units of the old measurement.
     */
    const updated = applySettingsPatch(settings, { measurement: undefined })
    expect(updated.measurement).toBeUndefined()
    expect(updated.filterRange).toBeUndefined()
    expect(updated.clampRange).toBeUndefined()
  })

  it('keeps the filter across a switch between measurement metrics', () => {
    expect(applySettingsPatch(settings, { metric: 'max' }).filterRange).toEqual(
      [1, 5],
    )
  })
})

describe('normalizeFilterRange', () => {
  it('treats a range covering the whole measurement as no filter', () => {
    expect(
      normalizeFilterRange({ range: [0, 100], bounds: [0, 100] }),
    ).toBeUndefined()
  })

  it('absorbs slider rounding at the extremes', () => {
    expect(
      normalizeFilterRange({ range: [0.01, 99.99], bounds: [0, 100] }),
    ).toBeUndefined()
  })

  it('keeps a range that excludes part of the measurement', () => {
    expect(normalizeFilterRange({ range: [10, 90], bounds: [0, 100] })).toEqual([
      10, 90,
    ])
  })

  it('passes the range through when the bounds are unknown', () => {
    expect(normalizeFilterRange({ range: [10, 90], bounds: null })).toEqual([
      10, 90,
    ])
  })
})

describe('isLogScaleApplicable', () => {
  it('requires a strictly positive lower bound', () => {
    expect(isLogScaleApplicable(1)).toBe(true)
    expect(isLogScaleApplicable(0)).toBe(false)
    expect(isLogScaleApplicable(-1)).toBe(false)
    expect(isLogScaleApplicable(Number.NaN)).toBe(false)
  })
})

describe('createNormalizer', () => {
  it('maps the range onto the unit interval and clamps outside it', () => {
    const normalize = createNormalizer({ low: 10, high: 20, useLogScale: false })
    expect(normalize(10)).toBeCloseTo(0)
    expect(normalize(15)).toBeCloseTo(0.5)
    expect(normalize(20)).toBeCloseTo(1)
    expect(normalize(5)).toBe(0)
    expect(normalize(25)).toBe(1)
  })

  it('spaces values logarithmically for a positive range', () => {
    const normalize = createNormalizer({ low: 1, high: 100, useLogScale: true })
    expect(normalize(10)).toBeCloseTo(0.5)
  })

  it('falls back to a linear scale for a non-positive range', () => {
    const normalize = createNormalizer({ low: 0, high: 100, useLogScale: true })
    expect(normalize(50)).toBeCloseTo(0.5)
  })

  it('maps a degenerate range to the top of the ramp', () => {
    const normalize = createNormalizer({ low: 7, high: 7, useLogScale: false })
    expect(normalize(7)).toBe(1)
  })
})

describe('getMillimeterPerUnit', () => {
  it('reads the pixel spacing off the column norms of the affine', () => {
    const viewer = {
      getAffine: () => [
        [0.0005, 0, 1],
        [0, -0.0004, 2],
        [0, 0, 1],
      ],
    }
    const spacing = getMillimeterPerUnit(viewer)
    expect(spacing.x).toBeCloseTo(0.0005)
    expect(spacing.y).toBeCloseTo(0.0004)
  })

  it('stays correct when the slide is rotated', () => {
    const angle = Math.PI / 6
    const spacing = 0.00025
    const viewer = {
      getAffine: () => [
        [spacing * Math.cos(angle), -spacing * Math.sin(angle), 0],
        [spacing * Math.sin(angle), spacing * Math.cos(angle), 0],
        [0, 0, 1],
      ],
    }
    const result = getMillimeterPerUnit(viewer)
    expect(result.x).toBeCloseTo(spacing)
    expect(result.y).toBeCloseTo(spacing)
  })
})
