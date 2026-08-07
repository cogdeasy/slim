import type { BinningRequest, BinningResponse, HeatmapGrid } from './types'

/**
 * Largest grid dimension we are willing to allocate. Small bin sizes on a
 * whole-slide extent otherwise produce grids of 10^8 bins.
 */
export const MAX_GRID_DIMENSION = 2048

/**
 * Dimensions of the grid that covers an extent with a given bin size.
 *
 * The bin size is enlarged when it would produce more than
 * `MAX_GRID_DIMENSION` bins along either axis, so that an unreasonably small
 * bin size degrades to a coarser heatmap rather than exhausting memory.
 *
 * @param options - Options
 * @param options.extent - Extent to cover, `[minX, minY, maxX, maxY]`
 * @param options.binSizeUnits - Requested bin size in projection units
 *
 * @returns Effective bin size and the resulting grid dimensions
 */
export function computeGridDimensions({
  extent,
  binSizeUnits,
}: {
  extent: [number, number, number, number]
  binSizeUnits: number
}): { binSizeUnits: number; width: number; height: number } {
  const [minX, minY, maxX, maxY] = extent
  const effectiveBinSizeUnits = Math.max(
    binSizeUnits,
    (maxX - minX) / MAX_GRID_DIMENSION,
    (maxY - minY) / MAX_GRID_DIMENSION,
    Number.MIN_VALUE,
  )
  return {
    binSizeUnits: effectiveBinSizeUnits,
    width: Math.max(1, Math.ceil((maxX - minX) / effectiveBinSizeUnits)),
    height: Math.max(1, Math.ceil((maxY - minY) / effectiveBinSizeUnits)),
  }
}

/**
 * Bin annotation positions into a regular grid and aggregate a value per bin.
 *
 * Runs over flat typed arrays in a single pass so that it can be executed
 * inside a Web Worker. Positions outside the extent, positions whose value is
 * not finite and positions excluded by `filterRange` do not contribute.
 *
 * @param request - Positions, aggregation metric and grid geometry
 *
 * @returns The aggregated grid, keyed by the request id of `request`
 */
export function computeHeatmapGrid(request: BinningRequest): BinningResponse {
  const start = performance.now()
  const { xy, values, metric, extent, smoothingSigmaBins, filterRange } =
    request
  const minX = extent[0]
  const maxY = extent[3]

  const { binSizeUnits, width, height } = computeGridDimensions({
    extent,
    binSizeUnits: request.binSizeUnits,
  })
  const numberOfBins = width * height

  const counts = new Uint32Array(numberOfBins)
  const sums = metric === 'density' ? null : new Float32Array(numberOfBins)
  const maxima = metric === 'max' ? new Float32Array(numberOfBins) : null
  if (maxima !== null) {
    maxima.fill(Number.NEGATIVE_INFINITY)
  }

  const count = xy.length >>> 1
  const lowerBound = filterRange?.[0] ?? Number.NEGATIVE_INFINITY
  const upperBound = filterRange?.[1] ?? Number.POSITIVE_INFINITY
  let includedCount = 0

  for (let i = 0; i < count; i++) {
    let value = 1
    if (values !== undefined) {
      value = values[i]
      /** Annotations without a usable measurement value are skipped. */
      if (!Number.isFinite(value) || value < lowerBound || value > upperBound) {
        continue
      }
    }
    const column = Math.floor((xy[i * 2] - minX) / binSizeUnits)
    /*
     * Projection y increases upwards while grid rows increase downwards, so
     * the row index is measured from the top of the extent. Getting this wrong
     * mirrors the heatmap vertically, which looks plausible on a roughly
     * symmetric slide - hence the explicit test.
     */
    const row = Math.floor((maxY - xy[i * 2 + 1]) / binSizeUnits)
    if (column < 0 || column >= width || row < 0 || row >= height) {
      continue
    }
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

  let aggregated = new Float32Array(numberOfBins)
  for (let bin = 0; bin < numberOfBins; bin++) {
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

  let coverage = counts
  if (smoothingSigmaBins > 0) {
    aggregated = gaussianBlur({
      source: aggregated,
      width,
      height,
      sigma: smoothingSigmaBins,
    })
    coverage = blurCoverage({
      counts,
      width,
      height,
      sigma: smoothingSigmaBins,
    })
  }

  const { minValue, maxValue } = findValueRange({
    values: aggregated,
    coverage,
  })

  return {
    requestId: request.requestId,
    values: aggregated,
    counts: coverage,
    width,
    height,
    binSizeUnits,
    minValue,
    maxValue,
    includedCount,
    durationMs: performance.now() - start,
  }
}

/**
 * Range of the values of the bins that hold at least one annotation.
 *
 * @param options - Options
 * @param options.values - Aggregated value per bin
 * @param options.coverage - Number of annotations per bin
 *
 * @returns Minimum and maximum, both 0 when no bin is populated
 */
function findValueRange({
  values,
  coverage,
}: {
  values: Float32Array
  coverage: Uint32Array
}): { minValue: number; maxValue: number } {
  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  for (let bin = 0; bin < values.length; bin++) {
    if (coverage[bin] === 0) {
      continue
    }
    if (values[bin] < minValue) {
      minValue = values[bin]
    }
    if (values[bin] > maxValue) {
      maxValue = values[bin]
    }
  }
  if (minValue === Number.POSITIVE_INFINITY) {
    return { minValue: 0, maxValue: 0 }
  }
  return { minValue, maxValue }
}

/**
 * Separable Gaussian blur over a row-major float grid.
 *
 * @param options - Options
 * @param options.source - Row-major grid
 * @param options.width - Number of columns
 * @param options.height - Number of rows
 * @param options.sigma - Standard deviation in bins
 *
 * @returns A new blurred grid; edges are handled by clamping
 */
export function gaussianBlur({
  source,
  width,
  height,
  sigma,
}: {
  source: Float32Array
  width: number
  height: number
  sigma: number
}): Float32Array {
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
 *
 * @param options - Options
 * @param options.counts - Number of annotations per bin
 * @param options.width - Number of columns
 * @param options.height - Number of rows
 * @param options.sigma - Standard deviation in bins
 *
 * @returns Occupancy counts widened by the blur
 */
function blurCoverage({
  counts,
  width,
  height,
  sigma,
}: {
  counts: Uint32Array
  width: number
  height: number
  sigma: number
}): Uint32Array {
  const occupancy = new Float32Array(counts.length)
  for (let i = 0; i < counts.length; i++) {
    occupancy[i] = counts[i] > 0 ? 1 : 0
  }
  const blurred = gaussianBlur({ source: occupancy, width, height, sigma })
  const output = new Uint32Array(counts.length)
  for (let i = 0; i < counts.length; i++) {
    output[i] = blurred[i] > 0.02 ? Math.max(1, counts[i]) : 0
  }
  return output
}

/**
 * Build a normalized 1D Gaussian kernel truncated at three standard
 * deviations.
 *
 * @param sigma - Standard deviation in bins
 *
 * @returns Kernel weights, summing to 1
 */
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

/**
 * Restrict a value to an inclusive range.
 *
 * @param value - Value to clamp
 * @param low - Lower bound
 * @param high - Upper bound
 *
 * @returns The clamped value
 */
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
 * Value of the bin under a projection coordinate.
 *
 * Lives here rather than on the layer so that the hover readout can be tested
 * without loading OpenLayers.
 *
 * @param grid - Grid to sample
 * @param coordinate - Coordinate in OpenLayers projection units
 *
 * @returns The bin value, or `null` outside the grid or in an empty bin
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
