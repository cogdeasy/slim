import { sampleGrid } from '../binning'
import type { HeatmapGrid } from '../types'

/** 2 x 2 grid of unit bins over the extent [0, 0, 2, 2]. */
function grid(values: number[], counts: number[]): HeatmapGrid {
  return {
    values: Float32Array.from(values),
    counts: Uint32Array.from(counts),
    width: 2,
    height: 2,
    binSizeUnits: 1,
    extent: [0, 0, 2, 2],
    minValue: Math.min(...values),
    maxValue: Math.max(...values),
    includedCount: counts.reduce((a, b) => a + b, 0),
  }
}

describe('sampleGrid', () => {
  const g = grid([10, 20, 30, 40], [1, 1, 1, 1])

  it('samples the top-left bin for a coordinate at the top of the extent', () => {
    /** Projection y grows upward, so y near maxY is row 0. */
    expect(sampleGrid(g, [0.5, 1.5])).toBe(10)
    expect(sampleGrid(g, [1.5, 1.5])).toBe(20)
  })

  it('samples the bottom row for a coordinate near minY', () => {
    expect(sampleGrid(g, [0.5, 0.5])).toBe(30)
    expect(sampleGrid(g, [1.5, 0.5])).toBe(40)
  })

  it('returns null outside the grid', () => {
    expect(sampleGrid(g, [-0.1, 1])).toBeNull()
    expect(sampleGrid(g, [2.1, 1])).toBeNull()
    expect(sampleGrid(g, [1, -0.1])).toBeNull()
    expect(sampleGrid(g, [1, 2.1])).toBeNull()
  })

  it('returns null for an empty bin rather than a misleading zero', () => {
    expect(sampleGrid(grid([0, 20, 30, 40], [0, 1, 1, 1]), [0.5, 1.5])).toBeNull()
  })
})
