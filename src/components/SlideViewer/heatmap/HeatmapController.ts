// skipcq: JS-C1003
import type * as dmv from 'dicom-microscopy-viewer'

import type DicomWebManager from '../../../DicomWebManager'
import {
  alignMeasurementValues,
  extractAnnotationPositions,
  extractRoiPositions,
  fetchMeasurementValues,
  getSlideExtent,
  listMeasurements,
  setAnnotationVisibilityFilter,
} from './annotationData'
import { computeHeatmapGrid, sampleGrid } from './binning'
import { HeatmapLayer } from './HeatmapLayer'
import type {
  AnnotationPositions,
  BinningRequest,
  BinningResponse,
  HeatmapGrid,
  HeatmapSettings,
} from './types'

/**
 * Millimetres per OpenLayers projection unit, derived from the affine matrix
 * that DMV uses to map projection coordinates to slide coordinates.
 *
 * Projection units are total-pixel-matrix pixels of the base level, so this is
 * the base-level pixel spacing. Reading it off the affine rather than off
 * `getPixelSpacing(level)` avoids having to know which end of the pyramid a
 * given level index refers to.
 */
export function getMillimeterPerUnit(viewer: dmv.viewer.VolumeImageViewer): {
  x: number
  y: number
} {
  const affine = viewer.getAffine()
  return {
    x: Math.hypot(affine[0][0], affine[1][0]),
    y: Math.hypot(affine[0][1], affine[1][1]),
  }
}

export interface HeatmapStatus {
  isComputing: boolean
  grid: HeatmapGrid | null
  annotationCount: number
  /** Wall-clock timings of the last full recompute, for the perf write-up. */
  timings: {
    extractMs: number
    fetchMeasurementMs: number
    binMs: number
    totalMs: number
  } | null
  error: string | null
}

/**
 * Owns the heatmap pipeline for one `SlideViewer`: pulling positions and
 * measurements out of DMV, binning them (in a worker when available) and
 * driving the OpenLayers overlay layer.
 *
 * Deliberately not a React component — the pipeline is imperative, has to
 * outlive renders and talks to a map that React does not own.
 */
export class HeatmapController {
  private readonly viewer: dmv.viewer.VolumeImageViewer
  private readonly client: DicomWebManager
  private readonly onStatusChange: (status: HeatmapStatus) => void

  private readonly layer: HeatmapLayer
  private worker: Worker | null = null
  private isAttached = false

  /** Cached per source key, because extraction is the expensive step. */
  private readonly positionCache = new Map<string, AnnotationPositions>()
  private readonly measurementCache = new Map<string, Float32Array>()

  private requestCounter = 0
  private pendingRequestId: number | null = null
  private pendingContext: {
    binSizeUnits: number
    extent: [number, number, number, number]
    annotationCount: number
    extractMs: number
    fetchMeasurementMs: number
    totalStart: number
  } | null = null
  private debounceHandle: ReturnType<typeof setTimeout> | null = null
  /** Last visibility mask, so it can be re-applied after DMV re-styles. */
  private appliedFilter: {
    annotationGroupUID: string
    allowed: Uint8Array
  } | null = null
  private status: HeatmapStatus = {
    isComputing: false,
    grid: null,
    annotationCount: 0,
    timings: null,
    error: null,
  }

  constructor({
    viewer,
    client,
    settings,
    onStatusChange,
  }: {
    viewer: dmv.viewer.VolumeImageViewer
    client: DicomWebManager
    settings: HeatmapSettings
    onStatusChange: (status: HeatmapStatus) => void
  }) {
    this.viewer = viewer
    this.client = client
    this.onStatusChange = onStatusChange
    this.layer = new HeatmapLayer({
      colormap: settings.colormap,
      opacity: settings.opacity,
      clampRange: settings.clampRange,
      useLogScale: settings.useLogScale,
    })

    try {
      this.worker = new Worker(new URL('./binning.worker.ts', import.meta.url))
      this.worker.onmessage = (event: MessageEvent<BinningResponse>) => {
        this.handleWorkerResponse(event.data)
      }
      this.worker.onerror = () => {
        /** Fall back to binning on the main thread. */
        this.worker?.terminate()
        this.worker = null
      }
    } catch {
      this.worker = null
    }
  }

  attach(): void {
    if (this.isAttached) {
      return
    }
    this.viewer.getMap().addLayer(this.layer.getOlLayer())
    this.isAttached = true
  }

  dispose(): void {
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle)
    }
    this.worker?.terminate()
    this.worker = null
    if (this.isAttached) {
      this.viewer.getMap().removeLayer(this.layer.getOlLayer())
      this.isAttached = false
    }
    this.layer.dispose()
    this.positionCache.clear()
    this.measurementCache.clear()
  }

  getStatus(): HeatmapStatus {
    return this.status
  }

  /**
   * Value of the bin under a map coordinate, for the legend hover readout.
   */
  sampleAt(coordinate: number[]): number | null {
    return this.status.grid === null
      ? null
      : sampleGrid(this.status.grid, coordinate)
  }

  listMeasurementsOf(
    annotationGroupUID: string,
  ): ReturnType<typeof listMeasurements> {
    const metadata = this.viewer.getAnnotationGroupMetadata(annotationGroupUID)
    return listMeasurements(metadata, annotationGroupUID)
  }

  /**
   * Apply new settings. Cheap changes (colormap, opacity, clamp, log scale,
   * visibility) repaint immediately; anything that changes the binning is
   * debounced.
   */
  update(settings: HeatmapSettings, rois: dmv.roi.ROI[]): void {
    this.attach()
    this.layer.setRenderOptions({
      colormap: settings.colormap,
      opacity: settings.opacity,
      clampRange: settings.clampRange,
      useLogScale: settings.useLogScale,
    })
    this.layer.setVisible(settings.isVisible)
    if (!settings.isVisible) {
      return
    }
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle)
    }
    this.debounceHandle = setTimeout(() => {
      void this.recompute(settings, rois)
    }, 150)
  }

  /**
   * Re-apply the measurement filter to the annotations.
   *
   * Showing, hiding or re-styling an annotation group makes DMV replace the
   * styles of its layers, which discards the filter's style wrapper and brings
   * every annotation back while the heatmap still shows the filtered subset.
   * `SlideViewer` calls this after any such operation.
   */
  reapplyAnnotationFilter(): void {
    if (this.appliedFilter === null) {
      return
    }
    setAnnotationVisibilityFilter({
      viewer: this.viewer,
      annotationGroupUID: this.appliedFilter.annotationGroupUID,
      allowed: this.appliedFilter.allowed,
    })
  }

  /**
   * Hide the annotations excluded by the measurement filter on the slide
   * itself, so the filter does what its label says rather than only reshaping
   * the heatmap.
   */
  private applyAnnotationVisibility(
    settings: HeatmapSettings,
    positions: AnnotationPositions,
    values: Float32Array | undefined,
  ): void {
    const uid = settings.annotationGroupUID
    if (uid === undefined || settings.sourceKind !== 'annotationGroup') {
      return
    }
    const range = settings.filterRange
    if (range === undefined || values === undefined) {
      this.appliedFilter = null
      setAnnotationVisibilityFilter({
        viewer: this.viewer,
        annotationGroupUID: uid,
        allowed: null,
      })
      return
    }
    /*
     * Indexed by DICOM annotation index rather than by extraction order, so
     * that it can be applied to any of the group's layers.
     */
    let highest = 0
    for (let i = 0; i < positions.count; i++) {
      if (positions.annotationIndices[i] > highest) {
        highest = positions.annotationIndices[i]
      }
    }
    const allowed = new Uint8Array(highest + 1)
    for (let i = 0; i < positions.count; i++) {
      if (values[i] >= range[0] && values[i] <= range[1]) {
        allowed[positions.annotationIndices[i]] = 1
      }
    }
    this.appliedFilter = { annotationGroupUID: uid, allowed }
    setAnnotationVisibilityFilter({
      viewer: this.viewer,
      annotationGroupUID: uid,
      allowed,
    })
  }

  private setStatus(patch: Partial<HeatmapStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatusChange(this.status)
  }

  private async recompute(
    settings: HeatmapSettings,
    rois: dmv.roi.ROI[],
  ): Promise<void> {
    const totalStart = performance.now()
    this.setStatus({ isComputing: true, error: null })

    let positions: AnnotationPositions | null = null
    const extractStart = performance.now()
    try {
      positions = this.getPositions(settings, rois)
    } catch (error) {
      this.setStatus({
        isComputing: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const extractMs = performance.now() - extractStart

    if (positions === null || positions.count === 0) {
      this.layer.setGrid(null)
      this.setStatus({
        isComputing: false,
        grid: null,
        annotationCount: 0,
        error:
          settings.sourceKind === 'annotationGroup'
            ? 'No annotations loaded yet. Make the annotation group visible first.'
            : 'No ROI annotations on this slide.',
      })
      return
    }

    let values: Float32Array | undefined
    let fetchMeasurementMs = 0
    const needsMeasurement =
      settings.metric !== 'density' || settings.filterRange !== undefined
    if (needsMeasurement && settings.measurement !== undefined) {
      const fetchStart = performance.now()
      try {
        values = await this.getMeasurementValues(settings, positions)
      } catch (error) {
        this.setStatus({
          isComputing: false,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      fetchMeasurementMs = performance.now() - fetchStart
    }

    if (settings.metric !== 'density' && values === undefined) {
      this.layer.setGrid(null)
      this.setStatus({
        isComputing: false,
        grid: null,
        error: 'Select a measurement for this metric.',
      })
      return
    }

    this.applyAnnotationVisibility(settings, positions, values)

    const millimeterPerUnit = getMillimeterPerUnit(this.viewer)
    const binSizeUnits =
      settings.binSizeMicrometer / 1000 / Math.max(millimeterPerUnit.x, 1e-9)

    this.requestCounter += 1
    const requestId = this.requestCounter
    this.pendingRequestId = requestId
    const request: BinningRequest = {
      requestId,
      xy: positions.xy,
      values,
      metric: settings.metric,
      extent: positions.extent,
      binSizeUnits,
      smoothingSigmaBins: settings.smoothingSigmaBins,
      filterRange: settings.filterRange,
    }

    this.pendingContext = {
      binSizeUnits,
      extent: positions.extent,
      annotationCount: positions.count,
      extractMs,
      fetchMeasurementMs,
      totalStart,
    }

    if (this.worker !== null) {
      /*
       * The buffers are copied rather than transferred: the position array is
       * cached and reused across recomputes, so it must not be detached.
       */
      this.worker.postMessage(request)
    } else {
      this.handleWorkerResponse(computeHeatmapGrid(request))
    }
  }

  private handleWorkerResponse(response: BinningResponse): void {
    if (response.requestId !== this.pendingRequestId) {
      /** A newer request has superseded this one. */
      return
    }
    const context = this.pendingContext
    if (context === null) {
      return
    }
    const grid: HeatmapGrid = {
      values: response.values,
      counts: response.counts,
      width: response.width,
      height: response.height,
      binSizeUnits: context.binSizeUnits,
      extent: context.extent,
      minValue: response.minValue,
      maxValue: response.maxValue,
      includedCount: response.includedCount,
    }
    this.layer.setGrid(grid)
    this.setStatus({
      isComputing: false,
      grid,
      annotationCount: context.annotationCount,
      error: null,
      timings: {
        extractMs: context.extractMs,
        fetchMeasurementMs: context.fetchMeasurementMs,
        binMs: response.durationMs,
        totalMs: performance.now() - context.totalStart,
      },
    })
  }

  private getPositions(
    settings: HeatmapSettings,
    rois: dmv.roi.ROI[],
  ): AnnotationPositions | null {
    if (settings.sourceKind === 'rois') {
      /** ROIs change as the user draws, so they are never cached. */
      return extractRoiPositions({ viewer: this.viewer, rois })
    }
    const uid = settings.annotationGroupUID
    if (uid === undefined) {
      return null
    }
    const cached = this.positionCache.get(uid)
    if (cached !== undefined) {
      return cached
    }
    const positions = extractAnnotationPositions({
      viewer: this.viewer,
      annotationGroupUID: uid,
    })
    if (positions !== null) {
      this.positionCache.set(uid, positions)
    }
    return positions
  }

  private async getMeasurementValues(
    settings: HeatmapSettings,
    positions: AnnotationPositions,
  ): Promise<Float32Array | undefined> {
    const uid = settings.annotationGroupUID
    const measurement = settings.measurement
    if (
      settings.sourceKind !== 'annotationGroup' ||
      uid === undefined ||
      measurement === undefined
    ) {
      return undefined
    }
    const metadata = this.viewer.getAnnotationGroupMetadata(uid)
    const descriptors = listMeasurements(metadata, uid)
    const descriptor = descriptors.find(
      (candidate) =>
        candidate.name.CodeValue === measurement.CodeValue &&
        candidate.name.CodingSchemeDesignator ===
          measurement.CodingSchemeDesignator,
    )
    if (descriptor === undefined) {
      return undefined
    }
    const cacheKey = `${uid}::${descriptor.key}`
    const cached = this.measurementCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }
    const raw = await fetchMeasurementValues({
      client: this.client,
      metadata,
      annotationGroupUID: uid,
      measurementIndex: descriptor.index,
    })
    const aligned = alignMeasurementValues({ positions, values: raw })
    this.measurementCache.set(cacheKey, aligned)
    return aligned
  }

  /**
   * Range of a measurement across the whole annotation group, used to
   * initialise the filter slider bounds.
   */
  async getMeasurementRange(
    annotationGroupUID: string,
    measurement: { CodeValue: string; CodingSchemeDesignator: string },
  ): Promise<[number, number] | null> {
    const metadata = this.viewer.getAnnotationGroupMetadata(annotationGroupUID)
    const descriptor = listMeasurements(metadata, annotationGroupUID).find(
      (candidate) =>
        candidate.name.CodeValue === measurement.CodeValue &&
        candidate.name.CodingSchemeDesignator ===
          measurement.CodingSchemeDesignator,
    )
    if (descriptor === undefined) {
      return null
    }
    const values = await fetchMeasurementValues({
      client: this.client,
      metadata,
      annotationGroupUID,
      measurementIndex: descriptor.index,
    })
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (Number.isNaN(value)) {
        continue
      }
      if (value < low) {
        low = value
      }
      if (value > high) {
        high = value
      }
    }
    return low <= high ? [low, high] : null
  }

  /**
   * Slide extent in OpenLayers projection units, exposed for diagnostics.
   */
  getExtent(): [number, number, number, number] {
    return getSlideExtent(this.viewer)
  }
}
