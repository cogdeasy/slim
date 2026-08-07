import {
  computeGridDimensions,
  computeHeatmapGrid,
  gaussianBlur,
  MAX_GRID_DIMENSION,
  sampleGrid,
} from '../binning'
import type { BinningRequest, HeatmapGrid } from '../types'

/** A 4x4 unit extent, so that a bin size of 1 gives a 4x4 grid. */
const EXTENT: [number, number, number, number] = [0, 0, 4, 4]

/**
 * Build a binning request with the defaults most tests want.
 *
 * @param overrides - Fields to change
 *
 * @returns The request
 */
function buildRequest(overrides: Partial<BinningRequest> = {}): BinningRequest {
  return {
    requestId: 1,
    xy: new Float32Array([]),
    metric: 'density',
    extent: EXTENT,
    binSizeUnits: 1,
    smoothingSigmaBins: 0,
    ...overrides,
  }
}

describe('computeGridDimensions', () => {
  it('covers the extent with the requested bin size', () => {
    expect(
      computeGridDimensions({ extent: [0, 0, 10, 6], binSizeUnits: 2 }),
    ).toEqual({ binSizeUnits: 2, width: 5, height: 3 })
  })

  it('rounds partial bins up', () => {
    const { width, height } = computeGridDimensions({
      extent: [0, 0, 10, 5],
      binSizeUnits: 3,
    })
    expect([width, height]).toEqual([4, 2])
  })

  it('enlarges the bin size rather than exceeding the dimension cap', () => {
    const extent: [number, number, number, number] = [0, 0, 1e6, 1e6]
    const dimensions = computeGridDimensions({ extent, binSizeUnits: 1 })
    expect(dimensions.width).toBeLessThanOrEqual(MAX_GRID_DIMENSION)
    expect(dimensions.height).toBeLessThanOrEqual(MAX_GRID_DIMENSION)
    expect(dimensions.binSizeUnits).toBeCloseTo(1e6 / MAX_GRID_DIMENSION)
  })
})

describe('computeHeatmapGrid', () => {
  it('counts annotations per bin for the density metric', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        /** Three in the top left bin, one in the bottom right bin. */
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8, 0.3, 3.7, 3.5, 0.5]),
      }),
    )
    expect([response.width, response.height]).toEqual([4, 4])
    expect(response.values[0]).toBe(3)
    expect(response.values[15]).toBe(1)
    expect(response.includedCount).toBe(4)
    expect([response.minValue, response.maxValue]).toEqual([1, 3])
  })

  it('places annotations by a downward-increasing row index', () => {
    /*
     * Projection y increases upwards while grid rows increase downwards. A
     * single annotation near the top of the extent must therefore land in row
     * 0, not in the last row - the mistake that mirrors the heatmap.
     */
    const response = computeHeatmapGrid(
      buildRequest({ xy: new Float32Array([0.5, 3.5]) }),
    )
    expect(response.values[0]).toBe(1)
    expect(response.values[12]).toBe(0)

    const bottom = computeHeatmapGrid(
      buildRequest({ xy: new Float32Array([0.5, 0.5]) }),
    )
    expect(bottom.values[12]).toBe(1)
    expect(bottom.values[0]).toBe(0)
  })

  it('averages measurement values for the mean metric', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8, 3.5, 0.5]),
        values: new Float32Array([10, 20, 7]),
        metric: 'mean',
      }),
    )
    expect(response.values[0]).toBeCloseTo(15)
    expect(response.values[15]).toBeCloseTo(7)
  })

  it('takes the largest measurement value for the max metric', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8]),
        values: new Float32Array([10, 20]),
        metric: 'max',
      }),
    )
    expect(response.values[0]).toBeCloseTo(20)
  })

  it('adds up measurement values for the sum metric', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8]),
        values: new Float32Array([10, 20]),
        metric: 'sum',
      }),
    )
    expect(response.values[0]).toBeCloseTo(30)
  })

  it('skips annotations whose value is not finite', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8]),
        values: new Float32Array([Number.NaN, 20]),
        metric: 'mean',
      }),
    )
    expect(response.values[0]).toBeCloseTo(20)
    expect(response.includedCount).toBe(1)
  })

  it('excludes annotations outside the filter range, inclusively', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8, 0.3, 3.7]),
        values: new Float32Array([5, 10, 15]),
        metric: 'density',
        filterRange: [10, 15],
      }),
    )
    expect(response.values[0]).toBe(2)
    expect(response.includedCount).toBe(2)
  })

  it('ignores annotations outside the extent', () => {
    const response = computeHeatmapGrid(
      buildRequest({ xy: new Float32Array([-5, 2, 9, 2, 2, 9]) }),
    )
    expect(response.includedCount).toBe(0)
  })

  it('ignores annotations whose position is not a number', () => {
    /*
     * An empty region of interest has no coordinates to transform. Indexing a
     * typed array with the resulting `NaN` is silently ignored, so such an
     * annotation must not be counted as having contributed to a bin either.
     */
    const response = computeHeatmapGrid(
      buildRequest({ xy: new Float32Array([Number.NaN, Number.NaN, 2.5, 2.5]) }),
    )
    expect(response.includedCount).toBe(1)
  })

  it('reports the bin size it actually used, not the requested one', () => {
    /*
     * Consumers place the overlay and sample the hover readout with this
     * value, so reporting the requested size would mis-register the heatmap
     * whenever the dimension cap forces a coarser grid.
     */
    const response = computeHeatmapGrid(
      buildRequest({ extent: [0, 0, 1e6, 1e6], binSizeUnits: 1 }),
    )
    expect(response.binSizeUnits).toBeCloseTo(1e6 / MAX_GRID_DIMENSION)
    expect(response.width).toBe(MAX_GRID_DIMENSION)
  })

  it('returns an empty grid for empty input', () => {
    const response = computeHeatmapGrid(buildRequest())
    expect(response.includedCount).toBe(0)
    expect([response.minValue, response.maxValue]).toEqual([0, 0])
    expect(response.values.every((value) => value === 0)).toBe(true)
  })

  it('leaves the annotation count unchanged by smoothing', () => {
    const xy = new Float32Array([2.5, 2.5])
    const sharp = computeHeatmapGrid(buildRequest({ xy }))
    const smooth = computeHeatmapGrid(
      buildRequest({ xy, smoothingSigmaBins: 1 }),
    )
    expect(smooth.includedCount).toBe(sharp.includedCount)
    /** Smoothing spreads the single count over neighbouring bins. */
    expect(smooth.maxValue).toBeLessThan(sharp.maxValue)
  })

  it('keeps smoothed means in the range of the values they came from', () => {
    /*
     * Empty bins hold no measurement, not a measurement of zero, so an
     * ordinary blur would report a mean far below anything on the slide
     * wherever the neighbourhood is sparse - and smoothing is on by default.
     */
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.5, 3.5, 1.5, 3.5]),
        values: new Float32Array([100, 200]),
        metric: 'mean',
        smoothingSigmaBins: 1,
      }),
    )
    expect(response.minValue).toBeGreaterThanOrEqual(100)
    expect(response.maxValue).toBeLessThanOrEqual(200)
  })

  it('weights a smoothed mean by how many annotations each bin holds', () => {
    /*
     * Smoothing a mean is the mean over a wider area, so a bin speaking for
     * three annotations has to pull harder than one speaking for a single
     * annotation.
     */
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.5, 3.5, 0.6, 3.4, 0.7, 3.3, 1.5, 3.5]),
        values: new Float32Array([100, 100, 100, 200]),
        metric: 'mean',
        smoothingSigmaBins: 1,
      }),
    )
    expect(response.values[1]).toBeLessThan(150)
  })

  it('keeps smoothed maxima in the range of the values they came from', () => {
    const response = computeHeatmapGrid(
      buildRequest({
        xy: new Float32Array([0.5, 3.5, 1.5, 3.5]),
        values: new Float32Array([100, 200]),
        metric: 'max',
        smoothingSigmaBins: 1,
      }),
    )
    expect(response.minValue).toBeGreaterThanOrEqual(100)
    expect(response.maxValue).toBeLessThanOrEqual(200)
  })

  it('still spreads the mass of an extensive metric', () => {
    /*
     * A count is shared out between the bins rather than describing each of
     * them, so its blur has to stay the mass preserving one.
     */
    const response = computeHeatmapGrid(
      buildRequest({
        /** Wide enough that the kernel does not reach over the edge. */
        extent: [0, 0, 9, 9],
        xy: new Float32Array([4.5, 4.5]),
        metric: 'density',
        smoothingSigmaBins: 1,
      }),
    )
    const total = response.values.reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 3)
  })
})

describe('gaussianBlur', () => {
  it('preserves total mass', () => {
    const source = new Float32Array(9 * 9)
    source[4 * 9 + 4] = 100
    const blurred = gaussianBlur({
      source,
      width: 9,
      height: 9,
      sigma: 1,
    })
    const total = blurred.reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(100, 3)
  })

  it('spreads a spike over its neighbours', () => {
    const source = new Float32Array(9 * 9)
    source[4 * 9 + 4] = 100
    const blurred = gaussianBlur({ source, width: 9, height: 9, sigma: 1 })
    expect(blurred[4 * 9 + 4]).toBeLessThan(100)
    expect(blurred[4 * 9 + 5]).toBeGreaterThan(0)
    expect(blurred[3 * 9 + 4]).toBeGreaterThan(0)
  })
})

describe('sampleGrid', () => {
  const grid: HeatmapGrid = {
    values: Float32Array.from([1, 2, 3, 4]),
    counts: Uint32Array.from([1, 1, 0, 1]),
    width: 2,
    height: 2,
    binSizeUnits: 1,
    extent: [0, 0, 2, 2],
    minValue: 1,
    maxValue: 4,
    includedCount: 3,
  }

  it('samples the bin the coordinate falls into', () => {
    expect(sampleGrid(grid, [0.5, 1.5])).toBe(1)
    expect(sampleGrid(grid, [1.5, 1.5])).toBe(2)
    expect(sampleGrid(grid, [1.5, 0.5])).toBe(4)
  })

  it('treats bin boundaries as belonging to the higher column and row', () => {
    expect(sampleGrid(grid, [1, 1.5])).toBe(2)
    expect(sampleGrid(grid, [1.5, 1])).toBe(4)
  })

  it('returns null outside the grid', () => {
    expect(sampleGrid(grid, [-0.1, 1])).toBeNull()
    expect(sampleGrid(grid, [2.1, 1])).toBeNull()
    expect(sampleGrid(grid, [1, -0.1])).toBeNull()
    expect(sampleGrid(grid, [1, 2.1])).toBeNull()
  })

  it('returns null for an empty bin', () => {
    expect(sampleGrid(grid, [0.5, 0.5])).toBeNull()
  })
})
