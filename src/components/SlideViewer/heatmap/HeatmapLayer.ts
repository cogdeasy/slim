import ImageLayer from 'ol/layer/Image'
import ImageCanvasSource from 'ol/source/ImageCanvas'

import { getColormapLut } from './colormap'
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
 * An `ol/layer/Image` backed by an `ol/source/ImageCanvas` that rasterises a
 * pre-computed bin grid.
 *
 * The grid is painted once into a small offscreen canvas at grid resolution
 * and then blitted, scaled, into whatever extent OpenLayers asks for. This
 * keeps pan and zoom free of any recomputation: the grid lives in slide
 * coordinates and is independent of the view.
 *
 * The layer is added to the map owned by DMV. DMV bundles its own copy of
 * OpenLayers, so this object is an instance of Slim's copy of `ImageLayer`
 * rather than DMV's. That works because `Map#addLayer` and the map renderer
 * only duck type layers; it would break if either side started using
 * `instanceof` on layers. See the proposal document for the risk assessment.
 */
export class HeatmapLayer {
  private readonly layer: ImageLayer<ImageCanvasSource>
  private readonly offscreen: HTMLCanvasElement
  private grid: HeatmapGrid | null = null
  private options: HeatmapRenderOptions

  constructor(options: HeatmapRenderOptions) {
    this.options = options
    this.offscreen = document.createElement('canvas')
    const source = new ImageCanvasSource({
      ratio: 1,
      canvasFunction: (extent, resolution, pixelRatio, size) =>
        this.renderCanvas(extent, resolution, pixelRatio, size),
    })
    this.layer = new ImageLayer({
      source,
      opacity: options.opacity,
    })
    this.layer.setVisible(false)
    /** Keep the heatmap above the slide image but below drawing interactions. */
    this.layer.setZIndex(50)
  }

  /**
   * The OpenLayers layer, to be handed to `map.addLayer`.
   */
  getOlLayer(): ImageLayer<ImageCanvasSource> {
    return this.layer
  }

  setVisible(isVisible: boolean): void {
    this.layer.setVisible(isVisible)
  }

  setGrid(grid: HeatmapGrid | null): void {
    this.grid = grid
    this.repaintOffscreen()
    this.layer.getSource()?.changed()
  }

  setRenderOptions(options: HeatmapRenderOptions): void {
    this.options = options
    this.layer.setOpacity(options.opacity)
    this.repaintOffscreen()
    this.layer.getSource()?.changed()
  }

  dispose(): void {
    this.layer.getSource()?.dispose()
    this.layer.dispose()
  }

  /**
   * Paint the bin grid into the offscreen canvas, one pixel per bin.
   */
  private repaintOffscreen(): void {
    const grid = this.grid
    if (grid === null || grid.width === 0 || grid.height === 0) {
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
    const lowValue = clampRange?.[0] ?? grid.minValue
    const highValue = clampRange?.[1] ?? grid.maxValue
    const transform = (value: number): number =>
      useLogScale ? Math.log1p(Math.max(0, value)) : value
    const low = transform(lowValue)
    const high = transform(highValue)
    const span = high - low

    const image = context.createImageData(grid.width, grid.height)
    const data = image.data
    for (let bin = 0; bin < grid.values.length; bin++) {
      if (grid.counts[bin] === 0) {
        continue
      }
      const normalized =
        span > 0 ? (transform(grid.values[bin]) - low) / span : 1
      const index = Math.min(255, Math.max(0, Math.round(normalized * 255)))
      const offset = bin * 4
      data[offset] = lut[index * 3]
      data[offset + 1] = lut[index * 3 + 1]
      data[offset + 2] = lut[index * 3 + 2]
      data[offset + 3] = 255
    }
    context.putImageData(image, 0, 0)
  }

  /**
   * `ol/source/ImageCanvas` callback: draw the offscreen grid into the region
   * OpenLayers requested, in view resolution.
   */
  private renderCanvas(
    extent: number[],
    _resolution: number,
    pixelRatio: number,
    size: number[],
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    const width = Math.max(1, Math.round(size[0] * pixelRatio))
    const height = Math.max(1, Math.round(size[1] * pixelRatio))
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    const grid = this.grid
    if (context === null || grid === null) {
      return canvas
    }

    /*
     * Map the grid extent onto the requested extent. Both are in OpenLayers
     * projection coordinates, so this is a plain linear rescale; the y axis is
     * inverted because canvas rows grow downwards while projection y grows
     * upwards.
     */
    const scaleX = width / (extent[2] - extent[0])
    const scaleY = height / (extent[3] - extent[1])
    const destinationX = (grid.extent[0] - extent[0]) * scaleX
    const destinationY = (extent[3] - grid.extent[3]) * scaleY
    const destinationWidth = (grid.extent[2] - grid.extent[0]) * scaleX
    const destinationHeight = (grid.extent[3] - grid.extent[1]) * scaleY

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      this.offscreen,
      destinationX,
      destinationY,
      destinationWidth,
      destinationHeight,
    )
    return canvas
  }
}
