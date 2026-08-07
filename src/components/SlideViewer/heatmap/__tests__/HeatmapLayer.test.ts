/**
 * @jest-environment jsdom
 */
import { HeatmapLayer } from '../HeatmapLayer'
import type { HeatmapGrid } from '../types'

/**
 * OpenLayers ships as untranspiled ECMAScript modules, which the CommonJS
 * transform of the test runner cannot load, and nothing here depends on what
 * the real layer does with the canvas it is given.
 */
jest.mock('ol/layer/Image', () => ({
  __esModule: true,
  default: class {
    private opacity: number
    private readonly source: unknown

    /**
     * @param options - Layer options
     * @param options.opacity - Initial opacity
     * @param options.source - Source of the layer
     */
    constructor({ opacity, source }: { opacity: number; source: unknown }) {
      this.opacity = opacity
      this.source = source
    }

    /**
     * @returns The source of the layer
     */
    getSource(): unknown {
      return this.source
    }

    /**
     * @param opacity - Opacity to apply
     */
    setOpacity(opacity: number): void {
      this.opacity = opacity
    }

    /**
     * @returns The opacity of the layer
     */
    getOpacity(): number {
      return this.opacity
    }

    /**
     * Accept a visibility change.
     */
    setVisible(): void {}

    /**
     * Accept disposal.
     */
    dispose(): void {}
  },
}))

jest.mock('ol/source/ImageCanvas', () => ({
  __esModule: true,
  default: class {
    /**
     * @param options - Source options
     * @param options.canvasFunction - Called to render a requested region
     */
    constructor({
      canvasFunction,
    }: {
      canvasFunction: (
        extent: number[],
        resolution: number,
        pixelRatio: number,
        size: number[],
      ) => HTMLCanvasElement
    }) {
      mockCanvasFunctions.push(canvasFunction)
    }

    /**
     * Accept a change notification.
     */
    changed(): void {}

    /**
     * Accept disposal.
     */
    dispose(): void {}
  },
}))

/** The render callbacks the layers under test handed to their sources. */
const mockCanvasFunctions: Array<
  (
    extent: number[],
    resolution: number,
    pixelRatio: number,
    size: number[],
  ) => HTMLCanvasElement
> = []

const GRID: HeatmapGrid = {
  values: Float32Array.from([1, 2, 3, 4]),
  counts: Uint32Array.from([1, 1, 1, 1]),
  width: 2,
  height: 2,
  binSizeUnits: 1,
  extent: [0, 0, 2, 2],
  minValue: 1,
  maxValue: 4,
  includedCount: 4,
}

const OPTIONS = {
  colormap: 'VIRIDIS' as const,
  opacity: 0.5,
  useLogScale: false,
}

let putImageData: jest.Mock

/**
 * Install a 2d context that records the images painted into it, since jsdom
 * has no canvas implementation of its own.
 */
beforeEach(() => {
  mockCanvasFunctions.length = 0
  putImageData = jest.fn()
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }),
    putImageData,
    clearRect: () => {},
    drawImage: () => {},
    imageSmoothingEnabled: false,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
})

describe('HeatmapLayer', () => {
  it('does not repaint the bins when only the opacity changes', () => {
    /*
     * Opacity is a property of the layer, while a repaint walks every bin of
     * a grid that can hold four million of them, and the controller passes
     * the render options on for every step of the slider.
     */
    const layer = new HeatmapLayer(OPTIONS)
    layer.setGrid(GRID)
    expect(putImageData).toHaveBeenCalledTimes(1)

    layer.setRenderOptions({ ...OPTIONS, opacity: 0.9 })
    expect(putImageData).toHaveBeenCalledTimes(1)
    expect(layer.getOlLayer().getOpacity()).toBe(0.9)

    layer.dispose()
  })

  it('renders into the size OpenLayers asked for', () => {
    /*
     * `ol/source/ImageCanvas` derives the size from the extent, the resolution
     * and the device pixel ratio, so it is already in device pixels. Scaling
     * it again returns an image larger than the renderer expects for the
     * extent, and the overlay is drawn that many times too big.
     */
    const layer = new HeatmapLayer(OPTIONS)
    layer.setGrid(GRID)
    const render = mockCanvasFunctions[0]

    const canvas = render([0, 0, 2, 2], 0.5, 2, [300, 200])
    expect([canvas.width, canvas.height]).toEqual([300, 200])

    /** The canvas is reused, rather than allocated once per pan step. */
    const next = render([1, 1, 3, 3], 0.5, 2, [300, 200])
    expect(next).toBe(canvas)

    layer.dispose()
  })

  it('repaints the bins when the colors they map to change', () => {
    const layer = new HeatmapLayer(OPTIONS)
    layer.setGrid(GRID)

    layer.setRenderOptions({ ...OPTIONS, colormap: 'MAGMA' })
    expect(putImageData).toHaveBeenCalledTimes(2)

    layer.setRenderOptions({ ...OPTIONS, colormap: 'MAGMA', useLogScale: true })
    expect(putImageData).toHaveBeenCalledTimes(3)

    layer.setRenderOptions({
      ...OPTIONS,
      colormap: 'MAGMA',
      useLogScale: true,
      clampRange: [2, 3],
    })
    expect(putImageData).toHaveBeenCalledTimes(4)

    layer.dispose()
  })
})
