// skipcq: JS-C1003
import type * as dcmjs from 'dcmjs'

/**
 * Which population of annotations feeds the heatmap.
 */
export type HeatmapSourceKind = 'annotationGroup' | 'rois'

/**
 * How the value of a bin is derived from the annotations that fall into it.
 */
export type HeatmapMetric = 'density' | 'mean' | 'max' | 'sum'

export type HeatmapColormapName =
  | 'VIRIDIS'
  | 'INFERNO'
  | 'MAGMA'
  | 'GRAY'
  | 'BLUE_RED'
  | 'HOT'

/**
 * User-facing heatmap settings. Everything here is cheap to change; only
 * `binSizeMicrometer` and the filter/metric fields trigger a rebin.
 */
export interface HeatmapSettings {
  isVisible: boolean
  sourceKind: HeatmapSourceKind
  /** Annotation group UID when `sourceKind === 'annotationGroup'`. */
  annotationGroupUID?: string
  metric: HeatmapMetric
  /** Required for the `mean` / `max` / `sum` metrics. */
  measurement?: dcmjs.sr.coding.CodedConcept
  binSizeMicrometer: number
  colormap: HeatmapColormapName
  opacity: number
  /** Gaussian smoothing sigma expressed in bins. 0 disables smoothing. */
  smoothingSigmaBins: number
  /** Clamp of the color ramp; `undefined` means "use the computed range". */
  clampRange?: [number, number]
  useLogScale: boolean
  /** Measurement range that annotations must fall within to be counted. */
  filterRange?: [number, number]
}

export const DEFAULT_HEATMAP_SETTINGS: HeatmapSettings = {
  isVisible: false,
  sourceKind: 'annotationGroup',
  metric: 'density',
  binSizeMicrometer: 100,
  colormap: 'VIRIDIS',
  opacity: 0.7,
  smoothingSigmaBins: 1,
  useLogScale: false,
}

/**
 * Positions of the annotations of one source, in OpenLayers projection
 * coordinates (see `docs/proposals/heatmap-annotations.md` for the coordinate
 * system definitions).
 *
 * Stored as a flat interleaved `[x0, y0, x1, y1, ...]` typed array so that it
 * can be transferred to the binning worker without a copy.
 */
export interface AnnotationPositions {
  /** Interleaved x/y in OpenLayers projection units. Length `2 * count`. */
  xy: Float32Array
  /**
   * DICOM annotation index of each position, needed to look up per-annotation
   * measurement values. Length `count`.
   */
  annotationIndices: Int32Array
  count: number
  /** Extent `[minX, minY, maxX, maxY]` of the whole slide, not of the points. */
  extent: [number, number, number, number]
}

/**
 * Result of binning `AnnotationPositions` into a regular grid.
 */
export interface HeatmapGrid {
  /** Aggregated value per bin, row-major, length `width * height`. */
  values: Float32Array
  /** Number of annotations per bin, row-major. Bins with 0 are transparent. */
  counts: Uint32Array
  width: number
  height: number
  /** Size of one bin in OpenLayers projection units. */
  binSizeUnits: number
  /** Extent covered by the grid, `[minX, minY, maxX, maxY]`. */
  extent: [number, number, number, number]
  /** Range of non-empty bin values, before clamping. */
  minValue: number
  maxValue: number
  /** Number of annotations that contributed (i.e. survived the filter). */
  includedCount: number
}

export interface BinningRequest {
  requestId: number
  xy: Float32Array
  /** Per-annotation values aligned with `xy`; omitted for the density metric. */
  values?: Float32Array
  metric: HeatmapMetric
  extent: [number, number, number, number]
  binSizeUnits: number
  smoothingSigmaBins: number
  filterRange?: [number, number]
}

export interface BinningResponse {
  requestId: number
  values: Float32Array
  counts: Uint32Array
  width: number
  height: number
  minValue: number
  maxValue: number
  includedCount: number
  /** Wall-clock duration of the binning pass, in milliseconds. */
  durationMs: number
}
