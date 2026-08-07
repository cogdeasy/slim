// skipcq: JS-C1003 - dcmjs uses nested namespaces (dcmjs.sr.coding.CodedConcept)
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
 * User-facing heatmap settings.
 *
 * Only `sourceKind`, `annotationGroupUID`, `metric`, `measurement`,
 * `binSizeMicrometer`, `smoothingSigmaBins` and `filterRange` affect the
 * binning; the remaining fields only affect how an existing grid is painted.
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
  /**
   * Measurement range that annotations must fall within to be counted and to
   * remain visible on the slide. `undefined` means "no filter"; a range equal
   * to the bounds of the measurement is normalized to `undefined`.
   */
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
 * coordinates: the coordinate system of the map DMV builds, in which x grows
 * to the right from 0 and y grows upwards from `-(rows + 1)` to `-1`, so that
 * the top of the slide is the largest y. One unit is one pixel of the highest
 * resolution level, which `getMillimeterPerUnit` converts to millimeters.
 *
 * Stored as flat typed arrays (12 bytes per annotation) so that hundreds of
 * thousands of annotations can be cached and handed to a worker cheaply.
 */
export interface AnnotationPositions {
  /** Interleaved x/y in OpenLayers projection units. Length `2 * count`. */
  xy: Float32Array
  /**
   * DICOM annotation index of each position, needed to look up per-annotation
   * measurement values. Length `count`; `-1` where the index of a feature
   * could not be determined.
   */
  annotationIndices: Int32Array
  count: number
  /** Number of entries of `annotationIndices` that are `-1`. */
  invalidIndexCount: number
  /**
   * Number of annotations the source is documented to hold, when known. A
   * value larger than `count` means the viewer has not materialized all
   * annotations, i.e. the heatmap covers only part of the group.
   */
  expectedCount: number | null
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
  /** Number of annotations that contributed, i.e. that survived the filter. */
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
  binSizeUnits: number
  minValue: number
  maxValue: number
  includedCount: number
  /** Wall-clock duration of the binning pass, in milliseconds. */
  durationMs: number
}

/**
 * Timings of the last full recompute, surfaced in the panel to make the cost
 * of the pipeline visible while a slide is being explored.
 */
export interface HeatmapTimings {
  extractMs: number
  fetchMeasurementMs: number
  binMs: number
  totalMs: number
}

/**
 * Everything the heatmap panel needs to know about the pipeline.
 *
 * Declared here rather than next to `HeatmapController` so that the UI can
 * depend on it without pulling in OpenLayers or the worker.
 */
export interface HeatmapStatus {
  isComputing: boolean
  grid: HeatmapGrid | null
  /** Number of annotation positions the grid was computed from. */
  annotationCount: number
  timings: HeatmapTimings | null
  /** Recoverable problem: the heatmap is shown but may be incomplete. */
  warning: string | null
  /** Unrecoverable problem: no heatmap is shown. */
  error: string | null
}

export const INITIAL_HEATMAP_STATUS: HeatmapStatus = {
  isComputing: false,
  grid: null,
  annotationCount: 0,
  timings: null,
  warning: null,
  error: null,
}
