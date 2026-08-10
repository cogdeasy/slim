/**
 * Whether a logarithmic color scale can be applied to a value range.
 *
 * `mean`, `sum` and `max` of a signed measurement can be zero or negative,
 * for which a logarithm is undefined. Rather than silently substituting a
 * floor (which misrepresents the data) the heatmap only offers a log scale
 * when the whole range is strictly positive.
 *
 * @param low - Lower end of the range that is mapped onto the color ramp
 *
 * @returns Whether a logarithmic scale is meaningful for the range
 */
export function isLogScaleApplicable(low: number): boolean {
  return Number.isFinite(low) && low > 0
}

/**
 * Build a function that maps bin values onto the `[0, 1]` interval of the
 * color ramp.
 *
 * @param options - Options
 * @param options.low - Value mapped to the start of the ramp
 * @param options.high - Value mapped to the end of the ramp
 * @param options.useLogScale - Whether to space values logarithmically;
 * ignored when the range is not strictly positive
 *
 * @returns A normalization function
 */
export function createNormalizer({
  low,
  high,
  useLogScale,
}: {
  low: number
  high: number
  useLogScale: boolean
}): (value: number) => number {
  const isLogarithmic = useLogScale && isLogScaleApplicable(low)
  const transform = (value: number): number =>
    isLogarithmic ? Math.log(Math.max(value, Number.MIN_VALUE)) : value
  const lowTransformed = transform(low)
  const span = transform(high) - lowTransformed
  return (value: number): number => {
    if (!Number.isFinite(value)) {
      return 0
    }
    if (span <= 0) {
      return 1
    }
    const normalized = (transform(value) - lowTransformed) / span
    if (normalized < 0) {
      return 0
    }
    if (normalized > 1) {
      return 1
    }
    return normalized
  }
}
