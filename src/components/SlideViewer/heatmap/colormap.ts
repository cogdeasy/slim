import type { HeatmapColormapName } from './types'

/**
 * Control points of each ramp, sampled to 256 entries on first use.
 *
 * These are defined locally rather than via `dmv.color.createColormap`
 * because the DMV colormaps are built for DICOM palette color lookup tables
 * (they are consumed as `PaletteColorLookupTable` by the parametric map path)
 * whereas the heatmap needs a plain RGB ramp it can write into an `ImageData`
 * buffer.
 */
const RAMPS: Record<HeatmapColormapName, Array<[number, number, number]>> = {
  VIRIDIS: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37],
  ],
  INFERNO: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
  ],
  MAGMA: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
  GRAY: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  BLUE_RED: [
    [5, 48, 97],
    [67, 147, 195],
    [247, 247, 247],
    [214, 96, 77],
    [103, 0, 31],
  ],
  HOT: [
    [10, 0, 0],
    [178, 0, 0],
    [255, 121, 0],
    [255, 233, 100],
    [255, 255, 255],
  ],
}

export const COLORMAP_NAMES = Object.keys(RAMPS) as HeatmapColormapName[]

/** Number of entries of a lookup table. */
export const COLORMAP_SIZE = 256

const cache = new Map<HeatmapColormapName, Uint8ClampedArray>()

/**
 * Get the RGB lookup table of a colormap.
 *
 * @param name - Name of the colormap
 *
 * @returns Flat `[r, g, b, r, g, b, ...]` table of `COLORMAP_SIZE` entries
 */
export function getColormapLut(name: HeatmapColormapName): Uint8ClampedArray {
  const cached = cache.get(name)
  if (cached !== undefined) {
    return cached
  }
  const ramp = RAMPS[name]
  const lut = new Uint8ClampedArray(COLORMAP_SIZE * 3)
  for (let i = 0; i < COLORMAP_SIZE; i++) {
    const position = (i / (COLORMAP_SIZE - 1)) * (ramp.length - 1)
    const lowIndex = Math.floor(position)
    const highIndex = Math.min(ramp.length - 1, lowIndex + 1)
    const fraction = position - lowIndex
    for (let channel = 0; channel < 3; channel++) {
      lut[i * 3 + channel] =
        ramp[lowIndex][channel] * (1 - fraction) +
        ramp[highIndex][channel] * fraction
    }
  }
  cache.set(name, lut)
  return lut
}

/**
 * Get a CSS gradient that reproduces a colormap, for the legend swatch.
 *
 * @param name - Name of the colormap
 *
 * @returns A `linear-gradient(...)` declaration
 */
export function getColormapGradientCss(name: HeatmapColormapName): string {
  const stops = RAMPS[name].map((rgb, index) => {
    const percentage = (index / (RAMPS[name].length - 1)) * 100
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${percentage.toFixed(1)}%`
  })
  return `linear-gradient(to right, ${stops.join(', ')})`
}
