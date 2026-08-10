import { computeHeatmapGrid, MAX_GRID_DIMENSION } from '../binning'
import type { BinningRequest } from '../types'

/**
 * A 4 x 4 unit extent. Note that OpenLayers projection y increases upward,
 * so `maxY` is the *top* of the image and lands in row 0.
 */
const EXTENT: [number, number, number, number] = [0, 0, 4, 4]

function request(overrides: Partial<BinningRequest> = {}): BinningRequest {
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

describe('computeHeatmapGrid', () => {
  it('bins counts into a grid of the expected shape', () => {
    const response = computeHeatmapGrid(
      request({ xy: new Float32Array([0.5, 3.5, 0.9, 3.1, 2.5, 1.5]) }),
    )
    expect(response.width).toBe(4)
    expect(response.height).toBe(4)
    expect(response.includedCount).toBe(3)
    expect(response.counts[0]).toBe(2)
    expect(response.maxValue).toBe(2)
  })

  it('places a point near the top of the extent in row 0', () => {
    /*
     * Guards the y flip. Getting this wrong mirrors the heatmap vertically,
     * which looks plausible on a roughly symmetric slide.
     */
    const top = computeHeatmapGrid(request({ xy: new Float32Array([0.5, 3.9]) }))
    expect(top.values[0]).toBe(1)

    const bottom = computeHeatmapGrid(
      request({ xy: new Float32Array([0.5, 0.1]) }),
    )
    const lastRowStart = (bottom.height - 1) * bottom.width
    expect(bottom.values[lastRowStart]).toBe(1)
    expect(bottom.values[0]).toBe(0)
  })

  it('drops points outside the extent', () => {
    const response = computeHeatmapGrid(
      request({ xy: new Float32Array([-1, 2, 9, 2, 2, 9]) }),
    )
    expect(response.includedCount).toBe(0)
  })

  describe('metrics', () => {
    /** Three points in the same bin with values 1, 2 and 6. */
    const xy = new Float32Array([0.1, 3.9, 0.2, 3.8, 0.3, 3.7])
    const values = new Float32Array([1, 2, 6])

    it('averages for "mean"', () => {
      const response = computeHeatmapGrid(
        request({ xy, values, metric: 'mean' }),
      )
      expect(response.values[0]).toBeCloseTo(3)
    })

    it('takes the largest for "max"', () => {
      const response = computeHeatmapGrid(request({ xy, values, metric: 'max' }))
      expect(response.values[0]).toBe(6)
    })

    it('totals for "sum"', () => {
      const response = computeHeatmapGrid(request({ xy, values, metric: 'sum' }))
      expect(response.values[0]).toBe(9)
    })

    it('counts for "density", ignoring the values', () => {
      const response = computeHeatmapGrid(
        request({ xy, values, metric: 'density' }),
      )
      expect(response.values[0]).toBe(3)
    })
  })

  it('excludes annotations outside the filter range', () => {
    const response = computeHeatmapGrid(
      request({
        xy: new Float32Array([0.1, 3.9, 0.2, 3.8, 0.3, 3.7]),
        values: new Float32Array([1, 2, 6]),
        metric: 'sum',
        filterRange: [2, 10],
      }),
    )
    expect(response.includedCount).toBe(2)
    expect(response.values[0]).toBe(8)
  })

  it('clamps the grid so tiny bin sizes cannot allocate unbounded memory', () => {
    const response = computeHeatmapGrid(
      request({ binSizeUnits: 1e-9, xy: new Float32Array([2, 2]) }),
    )
    expect(response.width).toBeLessThanOrEqual(MAX_GRID_DIMENSION)
    expect(response.height).toBeLessThanOrEqual(MAX_GRID_DIMENSION)
  })

  it('preserves total mass when smoothing a sum', () => {
    /*
     * The extent has to be comfortably larger than the kernel radius: the
     * blur clamps at the grid edge, so a peak close to the border loses its
     * tails.
     */
    const point = {
      xy: new Float32Array([20.5, 20.5]),
      values: new Float32Array([10]),
      metric: 'sum' as const,
      extent: [0, 0, 40, 40] as [number, number, number, number],
    }
    const unsmoothed = computeHeatmapGrid(request(point))
    const smoothed = computeHeatmapGrid(
      request({ ...point, smoothingSigmaBins: 1 }),
    )
    const total = (grid: Float32Array): number =>
      grid.reduce((accumulator, value) => accumulator + value, 0)
    expect(total(smoothed.values)).toBeCloseTo(total(unsmoothed.values), 3)
    /** Smoothing must actually spread the peak out. */
    expect(smoothed.maxValue).toBeLessThan(unsmoothed.maxValue)
  })

  it('handles an empty input', () => {
    const response = computeHeatmapGrid(request())
    expect(response.includedCount).toBe(0)
    expect(response.minValue).toBe(0)
    expect(response.maxValue).toBe(0)
  })
})
