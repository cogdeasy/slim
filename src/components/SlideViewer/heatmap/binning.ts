import type { BinningRequest, BinningResponse, HeatmapGrid } from './types'

/**
 * Largest grid dimension we are willing to allocate. Small bin sizes on a
 * whole-slide extent otherwise produce grids of 10^8 bins.
 */
export const MAX_GRID_DIMENSION = 2048

/**
 * Bin annotation positions into a regular grid and aggregate a value per bin.
 *
 * Runs over flat typed arrays in a single pass so that it can be executed
 * inside a Web Worker on a transferred buffer.
 */
export function computeHeatmapGrid(request: BinningRequest): BinningResponse {
  const start = performance.now()
  const { xy, values, metric, extent, smoothingSigmaBins, filterRange } =
    request
  const [minX, minY, maxX, maxY] = extent

  const binSizeUnits = Math.max(
    request.binSizeUnits,
    (maxX - minX) / MAX_GRID_DIMENSION,
    (maxY - minY) / MAX_GRID_DIMENSION,
  )
  const width = Math.max(1, Math.ceil((maxX - minX) / binSizeUnits))
  const height = Math.max(1, Math.ceil((maxY - minY) / binSizeUnits))
  const numBins = width * height

  const counts = new Uint32Array(numBins)
  const sums = metric === 'density' ? null : new Float32Array(numBins)
  const maxima = metric === 'max' ? new Float32Array(numBins) : null
  if (maxima !== null) {
    maxima.fill(Number.NEGATIVE_INFINITY)
  }

  const count = xy.length >>> 1
  const lowerBound = filterRange?.[0] ?? Number.NEGATIVE_INFINITY
  const upperBound = filterRange?.[1] ?? Number.POSITIVE_INFINITY
  let includedCount = 0

  for (let i = 0; i < count; i++) {
    const value = values !== undefined ? values[i] : 1
    if (values !== undefined && (value < lowerBound || value > upperBound)) {
      continue
    }
    const x = xy[i * 2]
    const y = xy[i * 2 + 1]
    if (x < minX || x >= maxX || y < minY || y >= maxY) {
      continue
    }
    const column = ((x - minX) / binSizeUnits) | 0
    /*
     * Rows are flipped so that row 0 is the top of the image, matching the
     * orientation `putImageData` expects.
     */
    const row = ((maxY - y) / binSizeUnits) | 0
    const bin = row * width + column
    counts[bin] += 1
    includedCount += 1
    if (sums !== null) {
      sums[bin] += value
    }
    if (maxima !== null && value > maxima[bin]) {
      maxima[bin] = value
    }
  }

  let aggregated = new Float32Array(numBins)
  for (let bin = 0; bin < numBins; bin++) {
    if (counts[bin] === 0) {
      continue
    }
    if (metric === 'density') {
      aggregated[bin] = counts[bin]
    } else if (metric === 'sum' && sums !== null) {
      aggregated[bin] = sums[bin]
    } else if (metric === 'mean' && sums !== null) {
      aggregated[bin] = sums[bin] / counts[bin]
    } else if (metric === 'max' && maxima !== null) {
      aggregated[bin] = maxima[bin]
    }
  }

  let smoothedCounts = counts
  if (smoothingSigmaBins > 0) {
    aggregated = gaussianBlur(aggregated, width, height, smoothingSigmaBins)
    smoothedCounts = blurCoverage(counts, width, height, smoothingSigmaBins)
  }

  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  for (let bin = 0; bin < numBins; bin++) {
    if (smoothedCounts[bin] === 0) {
      continue
    }
    const value = aggregated[bin]
    if (value < minValue) {
      minValue = value
    }
    if (value > maxValue) {
      maxValue = value
    }
  }
  if (minValue === Number.POSITIVE_INFINITY) {
    minValue = 0
    maxValue = 0
  }

  return {
    requestId: request.requestId,
    values: aggregated,
    counts: smoothedCounts,
    width,
    height,
    minValue,
    maxValue,
    includedCount,
    durationMs: performance.now() - start,
  }
}

/**
 * Separable Gaussian blur over a row-major float grid.
 */
export function gaussianBlur(
  source: Float32Array,
  width: number,
  height: number,
  sigma: number,
): Float32Array {
  const kernel = buildGaussianKernel(sigma)
  const radius = (kernel.length - 1) / 2
  const horizontal = new Float32Array(source.length)
  for (let row = 0; row < height; row++) {
    const rowOffset = row * width
    for (let column = 0; column < width; column++) {
      let accumulator = 0
      for (let k = -radius; k <= radius; k++) {
        const sampleColumn = clamp(column + k, 0, width - 1)
        accumulator += source[rowOffset + sampleColumn] * kernel[k + radius]
      }
      horizontal[rowOffset + column] = accumulator
    }
  }
  const output = new Float32Array(source.length)
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let accumulator = 0
      for (let k = -radius; k <= radius; k++) {
        const sampleRow = clamp(row + k, 0, height - 1)
        accumulator +=
          horizontal[sampleRow * width + column] * kernel[k + radius]
      }
      output[row * width + column] = accumulator
    }
  }
  return output
}

/**
 * Blur the occupancy mask so that smoothing widens the rendered footprint
 * instead of leaving smoothed values stranded in bins marked transparent.
 */
function blurCoverage(
  counts: Uint32Array,
  width: number,
  height: number,
  sigma: number,
): Uint32Array {
  const asFloat = new Float32Array(counts.length)
  for (let i = 0; i < counts.length; i++) {
    asFloat[i] = counts[i] > 0 ? 1 : 0
  }
  const blurred = gaussianBlur(asFloat, width, height, sigma)
  const output = new Uint32Array(counts.length)
  for (let i = 0; i < counts.length; i++) {
    output[i] = blurred[i] > 0.02 ? Math.max(1, counts[i]) : 0
  }
  return output
}

function buildGaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let total = 0
  for (let k = -radius; k <= radius; k++) {
    const weight = Math.exp(-(k * k) / (2 * sigma * sigma))
    kernel[k + radius] = weight
    total += weight
  }
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] /= total
  }
  return kernel
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) {
    return low
  }
  if (value > high) {
    return high
  }
  return value
}

/**
 * Value of the bin under a projection coordinate, or `null` outside the grid
 * or in an empty bin. Used for the hover readout.
 */
export function sampleGrid(
  grid: HeatmapGrid,
  coordinate: number[],
): number | null {
  const [minX, , , maxY] = grid.extent
  const column = Math.floor((coordinate[0] - minX) / grid.binSizeUnits)
  const row = Math.floor((maxY - coordinate[1]) / grid.binSizeUnits)
  if (column < 0 || column >= grid.width || row < 0 || row >= grid.height) {
    return null
  }
  const bin = row * grid.width + column
  return grid.counts[bin] === 0 ? null : grid.values[bin]
}
