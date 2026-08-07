import ImageLayer from 'ol/layer/Image'
import ImageCanvasSource from 'ol/source/ImageCanvas'

import { COLORMAP_SIZE, getColormapLut } from './colormap'
import { createNormalizer } from './scaling'
import type { HeatmapColormapName, HeatmapGrid } from './types'

/**
 * Rendering options that can change without triggering a rebin.
 */
export interface HeatmapRenderOptions {
  colormap: HeatmapColormapName
  opacity: number
  clampRange?: [number, number]
  useLogScale: boolean
}

/**
 * Z index of the overlay: above the slide, the segmentations and the
 * annotations, below the drawing interactions and the overview map.
 */
const HEATMAP_Z_INDEX = 50

/**
 * An `ol/layer/Image` backed by an `ol/source/ImageCanvas` that rasterizes a
 * precomputed bin grid.
 *
 * The grid is painted once into an offscreen canvas at grid resolution and is
 * then blitted, scaled, into whatever extent OpenLayers asks for. Pan and zoom
 * therefore cost nothing: the grid lives in slide coordinates and does not
 * depend on the view.
 *
 * The layer is added to the map owned by DMV. DMV bundles its own copy of
 * OpenLayers, so this is an instance of Slim's `ImageLayer` rather than of
 * DMV's. That works because `Map#addLayer` and the map renderer duck type
 * layers; it would break if either side started using `instanceof`.
 */
export class HeatmapLayer {
  private readonly layer: ImageLayer<ImageCanvasSource>
  private readonly offscreen: HTMLCanvasElement
  private grid: HeatmapGrid | null = null
  private options: HeatmapRenderOptions

  /**
   * @param options - How the grid is to be painted
   */
  constructor(options: HeatmapRenderOptions) {
    this.options = options
    this.offscreen = document.createElement('canvas')
    this.layer = new ImageLayer({
      source: new ImageCanvasSource({
        ratio: 1,
        canvasFunction: (extent, _resolution, pixelRatio, size) =>
          this.renderCanvas({ extent, pixelRatio, size }),
      }),
      opacity: options.opacity,
      visible: false,
      zIndex: HEATMAP_Z_INDEX,
    })
  }

  /**
   * Get the OpenLayers layer, to be handed to `map.addLayer`.
   *
   * @returns The layer
   */
  getOlLayer(): ImageLayer<ImageCanvasSource> {
    return this.layer
  }

  /**
   * Show or hide the overlay.
   *
   * @param isVisible - Whether the overlay should be rendered
   */
  setVisible(isVisible: boolean): void {
    this.layer.setVisible(isVisible)
  }

  /**
   * Replace the grid that is rendered.
   *
   * @param grid - Grid to render, or `null` to render nothing
   */
  setGrid(grid: HeatmapGrid | null): void {
    this.grid = grid
    this.repaintOffscreen()
    this.layer.getSource()?.changed()
  }

  /**
   * Change how the current grid is painted, without rebinning it.
   *
   * @param options - Rendering options
   */
  setRenderOptions(options: HeatmapRenderOptions): void {
    this.options = options
    this.layer.setOpacity(options.opacity)
    this.repaintOffscreen()
    this.layer.getSource()?.changed()
  }

  /**
   * Release the OpenLayers objects. The caller is responsible for removing
   * the layer from the map first.
   */
  dispose(): void {
    this.grid = null
    this.offscreen.width = 0
    this.offscreen.height = 0
    this.layer.getSource()?.dispose()
    this.layer.dispose()
  }

  /**
   * Paint the bin grid into the offscreen canvas, one pixel per bin.
   */
  private repaintOffscreen(): void {
    const grid = this.grid
    if (grid === null || grid.width === 0 || grid.height === 0) {
      this.offscreen.width = 0
      this.offscreen.height = 0
      return
    }
    this.offscreen.width = grid.width
    this.offscreen.height = grid.height
    const context = this.offscreen.getContext('2d')
    if (context === null) {
      return
    }

    const { clampRange, useLogScale, colormap } = this.options
    const lut = getColormapLut(colormap)
    const normalize = createNormalizer({
      low: clampRange?.[0] ?? grid.minValue,
      high: clampRange?.[1] ?? grid.maxValue,
      useLogScale,
    })

    const image = context.createImageData(grid.width, grid.height)
    const data = image.data
    for (let bin = 0; bin < grid.values.length; bin++) {
      if (grid.counts[bin] === 0) {
        continue
      }
      const entry =
        Math.min(
          COLORMAP_SIZE - 1,
          Math.round(normalize(grid.values[bin]) * (COLORMAP_SIZE - 1)),
        ) * 3
      const offset = bin * 4
      data[offset] = lut[entry]
      data[offset + 1] = lut[entry + 1]
      data[offset + 2] = lut[entry + 2]
      data[offset + 3] = 255
    }
    context.putImageData(image, 0, 0)
  }

  /**
   * Draw the offscreen grid into the region OpenLayers requested.
   *
   * @param options - Options
   * @param options.extent - Requested extent in projection coordinates
   * @param options.pixelRatio - Device pixel ratio
   * @param options.size - Requested size in CSS pixels
   *
   * @returns The canvas to composite
   */
  private renderCanvas({
    extent,
    pixelRatio,
    size,
  }: {
    extent: number[]
    pixelRatio: number
    size: number[]
  }): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    const width = Math.max(1, Math.round(size[0] * pixelRatio))
    const height = Math.max(1, Math.round(size[1] * pixelRatio))
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    const grid = this.grid
    if (context === null || grid === null || this.offscreen.width === 0) {
      return canvas
    }

    /*
     * Both extents are in projection coordinates, so this is a plain linear
     * rescale. The y axis is inverted because canvas rows grow downwards while
     * projection y grows upwards.
     */
    const scaleX = width / (extent[2] - extent[0])
    const scaleY = height / (extent[3] - extent[1])
    /*
     * The grid is anchored at the top left of the slide extent and covers a
     * whole number of bins, which slightly overshoots the extent.
     */
    const gridWidthUnits = grid.width * grid.binSizeUnits
    const gridHeightUnits = grid.height * grid.binSizeUnits
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      this.offscreen,
      (grid.extent[0] - extent[0]) * scaleX,
      (extent[3] - grid.extent[3]) * scaleY,
      gridWidthUnits * scaleX,
      gridHeightUnits * scaleY,
    )
    return canvas
  }
}
