// skipcq: JS-C1003 - dmv uses nested namespaces (dmv.viewer, dmv.roi)
import type * as dmv from 'dicom-microscopy-viewer'

import type DicomWebManager from '../../../DicomWebManager'
import { logger } from '../../../utils/logger'
import { getMillimeterPerUnit } from './affine'
import {
  type AnnotationsMetadataLike,
  alignMeasurementValues,
  buildVisibilityMask,
  extractAnnotationPositions,
  extractRoiPositions,
  fetchMeasurementValues,
  findMeasurement,
  getExpectedAnnotationCount,
  getSlideExtent,
  getValueRange,
  listMeasurements,
  type MeasurementDescriptor,
  setAnnotationVisibilityFilter,
  type ViewerLike,
} from './annotationData'
import { computeHeatmapGrid, sampleGrid } from './binning'
import { createBinningWorker } from './createBinningWorker'
import { HeatmapLayer } from './HeatmapLayer'
import { requiresMeasurement } from './settings'
import {
  type AnnotationPositions,
  type BinningRequest,
  type BinningResponse,
  type HeatmapGrid,
  type HeatmapSettings,
  type HeatmapStatus,
  INITIAL_HEATMAP_STATUS,
} from './types'

/** Recomputes are coalesced over this window while a slider is being dragged. */
const DEBOUNCE_MILLISECONDS = 150

/**
 * Cache bounds. Positions cost ~12 bytes and measurements ~4 bytes per
 * annotation, so a group of a million annotations costs ~12 MB and ~4 MB
 * respectively; DMV itself already needs gigabytes for such a group, so the
 * caches are kept deliberately small.
 */
const MAX_CACHED_POSITIONS = 2
const MAX_CACHED_MEASUREMENTS = 4

/**
 * Owns the heatmap pipeline of one `SlideViewer`: pulling positions and
 * measurements out of DMV, binning them (in a worker when available) and
 * driving the OpenLayers overlay layer and the annotation visibility filter.
 *
 * Deliberately not a React component - the pipeline is imperative, has to
 * outlive renders and talks to a map that React does not own. State is
 * mirrored back into `SlideViewer` through `onStatusChange`.
 */
export class HeatmapController {
  private readonly viewer: dmv.viewer.VolumeImageViewer
  private readonly client: DicomWebManager
  private readonly onStatusChange: (status: HeatmapStatus) => void

  private readonly layer: HeatmapLayer
  private worker: Worker | null = null
  private isAttached = false
  private isDisposed = false

  /** Extraction is the expensive step, so its result is cached per group. */
  private readonly positionCache = new Map<string, AnnotationPositions>()

  /**
   * Raw measurement values as fetched, indexed by DICOM annotation index.
   *
   * Deliberately not the values aligned with a set of positions: an aligned
   * array is a gather into the extraction order of one particular
   * `AnnotationPositions`, and the two caches are bounded separately, so a
   * cached aligned array can outlive the positions it belongs to and end up
   * attributing values to the wrong annotations.
   */
  private readonly measurementCache = new Map<string, Float32Array>()

  /** Group whose annotations are currently hidden by the filter, if any. */
  private filteredAnnotationGroupUID: string | null = null
  private lastAllowed: Uint8Array | null = null

  /**
   * Incremented whenever a recompute starts or is abandoned, so that a
   * recompute suspended in an `await` can tell that it has been superseded.
   */
  private generation = 0
  private requestCounter = 0
  private pendingRequestId: number | null = null
  private pendingRequest: BinningRequest | null = null
  private pendingContext: {
    binSizeUnits: number
    extent: [number, number, number, number]
    annotationCount: number
    warning: string | null
    extractMs: number
    fetchMeasurementMs: number
    totalStart: number
  } | null = null
  private debounceHandle: ReturnType<typeof setTimeout> | null = null
  private status: HeatmapStatus = INITIAL_HEATMAP_STATUS

  /**
   * @param options - Options
   * @param options.viewer - Volume image viewer the heatmap overlays
   * @param options.client - Client used to fetch measurement bulk data
   * @param options.settings - Initial heatmap settings
   * @param options.onStatusChange - Called whenever the status changes, to
   * mirror it into React state
   */
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
      this.worker = createBinningWorker()
      this.worker.onmessage = (event: MessageEvent<BinningResponse>) => {
        this.handleBinningResponse(event.data)
      }
      this.worker.onerror = (event) => {
        logger.warn(
          `heatmap worker failed, binning on the main thread: ${event.message}`,
        )
        this.worker?.terminate()
        this.worker = null
        /*
         * A request that was in flight when the worker died will never be
         * answered, so redo it here rather than leaving the panel computing.
         */
        const request = this.pendingRequest
        if (request !== null) {
          this.handleBinningResponse(computeHeatmapGrid(request))
        }
      }
    } catch (error) {
      /** Binning then runs on the main thread, which blocks but still works. */
      logger.warn(`could not start heatmap worker: ${String(error)}`)
      this.worker = null
    }
  }

  /**
   * Add the overlay layer to the map of the viewer.
   */
  attach(): void {
    if (this.isAttached || this.isDisposed) {
      return
    }
    this.viewer.getMap().addLayer(this.layer.getOlLayer())
    this.isAttached = true
  }

  /**
   * Remove the overlay layer, terminate the worker, drop the caches and
   * restore the annotations that the filter hid.
   *
   * Must be called before the viewer is cleaned up, on unmount and on slide
   * switch, otherwise the worker and the cached position arrays outlive the
   * viewer they belong to.
   */
  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    this.generation += 1
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle)
      this.debounceHandle = null
    }
    this.pendingRequestId = null
    this.pendingRequest = null
    this.pendingContext = null
    this.worker?.terminate()
    this.worker = null
    this.clearAnnotationVisibilityFilter()
    if (this.isAttached) {
      this.viewer.getMap().removeLayer(this.layer.getOlLayer())
      this.isAttached = false
    }
    this.layer.dispose()
    this.positionCache.clear()
    this.measurementCache.clear()
  }

  /**
   * Get the most recently published status.
   *
   * @returns The current status
   */
  getStatus(): HeatmapStatus {
    return this.status
  }

  /**
   * Get the value of the bin under a map coordinate, for the hover readout.
   *
   * @param coordinate - Coordinate in OpenLayers projection units
   *
   * @returns The bin value, or `null` outside the grid or in an empty bin
   */
  sampleAt(coordinate: number[]): number | null {
    return this.status.grid === null
      ? null
      : sampleGrid(this.status.grid, coordinate)
  }

  /**
   * List the measurements of an annotation group.
   *
   * @param annotationGroupUID - Unique identifier of the annotation group
   *
   * @returns One descriptor per measurement
   */
  listMeasurementsOf(annotationGroupUID: string): MeasurementDescriptor[] {
    return listMeasurementsOfGroup(this.viewer, annotationGroupUID)
  }

  /**
   * Get the range of a measurement across a whole annotation group, to bound
   * the filter slider.
   *
   * @param annotationGroupUID - Unique identifier of the annotation group
   * @param measurement - Coded concept naming the measurement
   *
   * @returns The range, or `null` when the group has no such measurement or no
   * finite values
   */
  async getMeasurementRange(
    annotationGroupUID: string,
    measurement: { CodeValue: string; CodingSchemeDesignator: string },
  ): Promise<[number, number] | null> {
    const metadata = this.getMetadata(annotationGroupUID)
    const descriptor = findMeasurement({
      metadata,
      annotationGroupUID,
      measurement,
    })
    if (descriptor === undefined) {
      return null
    }
    /*
     * Through the cache rather than through `getMeasurementRangeOfGroup`:
     * selecting a measurement asks for its range and bins it, and the values
     * are one number per annotation, so the free function would download the
     * same few megabytes a second time.
     */
    return getValueRange(
      await this.getRawMeasurementValues({
        annotationGroupUID,
        metadata,
        descriptor,
      }),
    )
  }

  /**
   * Drop what is cached for an annotation group.
   *
   * Called when a group is hidden (its features are then dropped by DMV, and
   * the cached positions would go stale) and when it is shown (the previously
   * cached positions may have been extracted from a partially loaded group).
   *
   * @param annotationGroupUID - Unique identifier of the annotation group
   */
  invalidateAnnotationGroup(annotationGroupUID: string): void {
    if (this.filteredAnnotationGroupUID === annotationGroupUID) {
      /*
       * The layers the filter wrapped are about to be torn down or rebuilt, so
       * the bookkeeping would otherwise keep pointing at styles that no longer
       * exist and the rebuilt layers would stay unfiltered.
       */
      this.clearAnnotationVisibilityFilter()
    }
    this.positionCache.delete(annotationGroupUID)
    for (const key of Array.from(this.measurementCache.keys())) {
      if (key.startsWith(`${annotationGroupUID}::`)) {
        this.measurementCache.delete(key)
      }
    }
  }

  /**
   * Reapply the visibility filter to whichever group it currently hides
   * annotations of, if any.
   *
   * For changes that can move a group onto layers the filter has not wrapped,
   * such as switching clustering on or off, where the caller does not know
   * which group is filtered.
   */
  refreshAnnotationVisibilityFilter(): void {
    if (this.filteredAnnotationGroupUID !== null) {
      this.reapplyAnnotationVisibilityFilter(this.filteredAnnotationGroupUID)
    }
  }

  /**
   * Reapply the visibility filter after DMV has rebuilt the styles of a group,
   * which it does whenever the style of the group is changed.
   *
   * @param annotationGroupUID - Unique identifier of the annotation group whose
   * style changed
   */
  reapplyAnnotationVisibilityFilter(annotationGroupUID: string): void {
    if (
      this.isDisposed ||
      this.lastAllowed === null ||
      this.filteredAnnotationGroupUID !== annotationGroupUID
    ) {
      return
    }
    setAnnotationVisibilityFilter({
      viewer: this.viewer as unknown as ViewerLike,
      annotationGroupUID,
      allowed: this.lastAllowed,
    })
  }

  /**
   * Apply new settings.
   *
   * Changes that only affect painting (colormap, opacity, clamp, log scale,
   * visibility) take effect immediately; anything that changes the binning is
   * debounced, so that dragging a slider does not queue a recompute per pixel.
   *
   * @param settings - Current heatmap settings
   * @param rois - Regions of interest, used when the source is `rois`
   */
  update(settings: HeatmapSettings, rois: dmv.roi.ROI[]): void {
    if (this.isDisposed) {
      return
    }
    this.attach()
    this.layer.setRenderOptions({
      colormap: settings.colormap,
      opacity: settings.opacity,
      clampRange: settings.clampRange,
      useLogScale: settings.useLogScale,
    })
    this.layer.setVisible(settings.isVisible)
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle)
      this.debounceHandle = null
    }
    if (!settings.isVisible) {
      /** Hiding the heatmap must not leave annotations hidden with it. */
      this.generation += 1
      this.pendingRequestId = null
      this.pendingRequest = null
      this.pendingContext = null
      this.clearAnnotationVisibilityFilter()
      this.layer.setGrid(null)
      /*
       * The grid goes with the overlay: a legend describing bins nobody can
       * see is worse than no legend. Showing the heatmap again recomputes it.
       */
      this.setStatus({
        isComputing: false,
        grid: null,
        timings: null,
        error: null,
        warning: null,
      })
      return
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null
      void this.recompute(settings, rois)
    }, DEBOUNCE_MILLISECONDS)
  }

  /**
   * Get the extent of the slide in projection units, exposed for diagnostics.
   *
   * @returns Extent `[minX, minY, maxX, maxY]`
   */
  getExtent(): [number, number, number, number] {
    return getSlideExtent(this.viewer as unknown as ViewerLike)
  }

  /**
   * Get the metadata of the annotation instance an annotation group belongs to.
   *
   * @param annotationGroupUID - Unique identifier of the annotation group
   *
   * @returns The metadata
   */
  private getMetadata(annotationGroupUID: string): AnnotationsMetadataLike {
    return this.viewer.getAnnotationGroupMetadata(
      annotationGroupUID,
    ) as unknown as AnnotationsMetadataLike
  }

  /**
   * Publish a status change to the owner of the controller.
   *
   * @param patch - Fields of the status that changed
   */
  private setStatus(patch: Partial<HeatmapStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatusChange(this.status)
  }

  /**
   * Report a condition that prevents a heatmap from being computed.
   *
   * @param message - Message to show in the panel
   */
  private failWith(message: string): void {
    this.layer.setGrid(null)
    this.setStatus({
      isComputing: false,
      grid: null,
      timings: null,
      annotationCount: 0,
      error: message,
    })
  }

  /**
   * Recompute positions, measurements and the grid for the given settings.
   *
   * @param settings - Current heatmap settings
   * @param rois - Regions of interest, used when the source is `rois`
   */
  private async recompute(
    settings: HeatmapSettings,
    rois: dmv.roi.ROI[],
  ): Promise<void> {
    const totalStart = performance.now()
    this.generation += 1
    const generation = this.generation
    this.setStatus({ isComputing: true, error: null, warning: null })

    if (
      settings.sourceKind === 'annotationGroup' &&
      settings.annotationGroupUID === undefined
    ) {
      this.failWith('Select an annotation group.')
      return
    }
    if (
      settings.sourceKind === 'rois' &&
      requiresMeasurement(settings.metric)
    ) {
      this.failWith(
        'Regions of interest carry no per-annotation measurements; ' +
          'use the density metric.',
      )
      return
    }
    if (
      settings.sourceKind === 'annotationGroup' &&
      requiresMeasurement(settings.metric) &&
      settings.measurement === undefined
    ) {
      this.failWith('Select a measurement for this metric.')
      return
    }

    const extractStart = performance.now()
    let positions: AnnotationPositions | null
    try {
      positions = this.getPositions(settings, rois)
    } catch (error) {
      this.failWith(error instanceof Error ? error.message : String(error))
      return
    }
    const extractMs = performance.now() - extractStart
    if (this.isStale(generation)) {
      return
    }

    if (positions === null || positions.count === 0) {
      this.failWith(
        settings.sourceKind === 'annotationGroup'
          ? 'No annotations have been loaded yet. Make the annotation group ' +
              'visible under Annotation Groups; a large group takes a while ' +
              'to load and the heatmap follows once it has.'
          : 'There are no regions of interest on this slide.',
      )
      return
    }

    const needsMeasurement =
      requiresMeasurement(settings.metric) || settings.filterRange !== undefined
    let values: Float32Array | undefined
    let fetchMeasurementMs = 0
    if (needsMeasurement && settings.sourceKind === 'annotationGroup') {
      if (positions.invalidIndexCount > 0) {
        /*
         * Measurement values are indexed by annotation index, so without a
         * reliable index the values cannot be attributed to a position. Fail
         * rather than draw a heatmap of misattributed measurements.
         */
        this.failWith(
          `${positions.invalidIndexCount} of ${positions.count} annotations ` +
            'have an unrecognized feature identifier, so measurements ' +
            'cannot be matched to them. Only the density metric is ' +
            'available for this annotation group.',
        )
        return
      }
      const fetchStart = performance.now()
      try {
        values = await this.getMeasurementValues(settings, positions)
      } catch (error) {
        if (this.isStale(generation)) {
          return
        }
        this.failWith(
          `Could not load measurement values: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      fetchMeasurementMs = performance.now() - fetchStart
    }
    /*
     * A fetch can take arbitrarily long, so by now a later recompute may
     * already have published its grid and filter. Publishing this one would
     * put the settings the user has moved away from back on the screen.
     */
    if (this.isStale(generation)) {
      return
    }

    if (requiresMeasurement(settings.metric) && values === undefined) {
      this.failWith(
        'The selected measurement is not defined for this annotation group.',
      )
      return
    }

    this.applyAnnotationVisibilityFilter(settings, positions, values)

    const millimeterPerUnit = getMillimeterPerUnit(this.viewer)
    const binSizeUnits =
      settings.binSizeMicrometer / 1000 / Math.max(millimeterPerUnit.x, 1e-9)

    this.requestCounter += 1
    const requestId = this.requestCounter
    this.pendingRequestId = requestId
    this.pendingContext = {
      binSizeUnits,
      extent: positions.extent,
      annotationCount: positions.count,
      warning: describeIncompleteness(positions),
      extractMs,
      fetchMeasurementMs,
      totalStart,
    }
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
    this.pendingRequest = request

    if (this.worker !== null) {
      /*
       * The buffers are copied rather than transferred: the position array is
       * cached and reused across recomputes, so it must not be detached.
       */
      this.worker.postMessage(request)
    } else {
      this.handleBinningResponse(computeHeatmapGrid(request))
    }
  }

  /**
   * Determine whether a recompute has been superseded while it was suspended.
   *
   * @param generation - Generation the recompute claimed when it started
   *
   * @returns Whether the recompute must abandon its result
   */
  private isStale(generation: number): boolean {
    return this.isDisposed || generation !== this.generation
  }

  /**
   * Adopt a binned grid, unless a newer request has superseded it.
   *
   * @param response - Response of the binner
   */
  private handleBinningResponse(response: BinningResponse): void {
    if (this.isDisposed || response.requestId !== this.pendingRequestId) {
      return
    }
    const context = this.pendingContext
    if (context === null) {
      return
    }
    /** A request is answered once, whichever binner got there first. */
    this.pendingRequestId = null
    this.pendingRequest = null
    this.pendingContext = null
    const grid: HeatmapGrid = {
      values: response.values,
      counts: response.counts,
      width: response.width,
      height: response.height,
      /*
       * The effective bin size, which the binner enlarges when the requested
       * one would exceed the grid dimension cap. Using the requested one here
       * would shrink the overlay into a corner of the slide and make the hover
       * readout sample the wrong bin.
       */
      binSizeUnits: response.binSizeUnits,
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
      warning: context.warning,
      timings: {
        extractMs: context.extractMs,
        fetchMeasurementMs: context.fetchMeasurementMs,
        binMs: response.durationMs,
        totalMs: performance.now() - context.totalStart,
      },
    })
  }

  /**
   * Get the positions of the configured source, from the cache when possible.
   *
   * @param settings - Current heatmap settings
   * @param rois - Regions of interest, used when the source is `rois`
   *
   * @returns The positions, or `null` when the source holds nothing
   */
  private getPositions(
    settings: HeatmapSettings,
    rois: dmv.roi.ROI[],
  ): AnnotationPositions | null {
    if (settings.sourceKind === 'rois') {
      /** Regions of interest change as the user draws, so are never cached. */
      return extractRoiPositions({ viewer: this.viewer, rois })
    }
    const uid = settings.annotationGroupUID
    if (uid === undefined) {
      return null
    }
    const cached = readCache(this.positionCache, uid)
    if (cached !== undefined) {
      return cached
    }
    const positions = extractAnnotationPositions({
      viewer: this.viewer as unknown as ViewerLike,
      annotationGroupUID: uid,
      expectedCount: getExpectedAnnotationCount(this.getMetadata(uid), uid),
    })
    /*
     * Only a complete extraction is worth remembering. DMV materializes a
     * large group progressively, so an extraction taken too early is a
     * snapshot of a group that is still growing; caching it would freeze the
     * heatmap on the partial data until the group is toggled off and on.
     * Re-extracting costs a walk over the features, which is the price of the
     * heatmap becoming complete on its own.
     */
    if (positions !== null && isComplete(positions)) {
      evictOldest(this.positionCache, MAX_CACHED_POSITIONS)
      this.positionCache.set(uid, positions)
    }
    return positions
  }

  /**
   * Get the measurement values of the configured source, aligned with the
   * positions and cached per group and measurement.
   *
   * @param settings - Current heatmap settings
   * @param positions - Extracted positions
   *
   * @returns The aligned values, or `undefined` when the group does not have
   * the selected measurement
   */
  private async getMeasurementValues(
    settings: HeatmapSettings,
    positions: AnnotationPositions,
  ): Promise<Float32Array | undefined> {
    const uid = settings.annotationGroupUID
    const measurement = settings.measurement
    if (uid === undefined || measurement === undefined) {
      return undefined
    }
    const metadata = this.getMetadata(uid)
    const descriptor = findMeasurement({
      metadata,
      annotationGroupUID: uid,
      measurement,
    })
    if (descriptor === undefined) {
      return undefined
    }
    const raw = await this.getRawMeasurementValues({
      annotationGroupUID: uid,
      metadata,
      descriptor,
    })
    /*
     * Aligning on every recompute rather than caching the aligned array: the
     * gather is a few milliseconds even for a million annotations, and it is
     * the only way to guarantee that the values match the positions in hand.
     */
    return alignMeasurementValues({ positions, values: raw })
  }

  /**
   * Get the values of one measurement as fetched, indexed by DICOM annotation
   * index, from the cache when possible.
   *
   * @param options - Options
   * @param options.annotationGroupUID - Unique identifier of the annotation
   * group
   * @param options.metadata - Metadata of the annotation instance
   * @param options.descriptor - Descriptor of the measurement
   *
   * @returns The values
   */
  private async getRawMeasurementValues({
    annotationGroupUID,
    metadata,
    descriptor,
  }: {
    annotationGroupUID: string
    metadata: AnnotationsMetadataLike
    descriptor: MeasurementDescriptor
  }): Promise<Float32Array> {
    const cacheKey = `${annotationGroupUID}::${descriptor.key}`
    const cached = readCache(this.measurementCache, cacheKey)
    if (cached !== undefined) {
      return cached
    }
    const raw = await fetchMeasurementValues({
      client: this.client,
      metadata,
      annotationGroupUID,
      measurementIndex: descriptor.index,
    })
    evictOldest(this.measurementCache, MAX_CACHED_MEASUREMENTS)
    this.measurementCache.set(cacheKey, raw)
    return raw
  }

  /**
   * Hide the annotations excluded by the measurement filter on the slide
   * itself, so that the filter does what its label says rather than only
   * reshaping the heatmap.
   *
   * @param settings - Current heatmap settings
   * @param positions - Extracted positions
   * @param values - Measurement values aligned with the positions
   */
  private applyAnnotationVisibilityFilter(
    settings: HeatmapSettings,
    positions: AnnotationPositions,
    values: Float32Array | undefined,
  ): void {
    const uid = settings.annotationGroupUID
    const range = settings.filterRange
    if (
      settings.sourceKind !== 'annotationGroup' ||
      uid === undefined ||
      range === undefined ||
      values === undefined
    ) {
      this.clearAnnotationVisibilityFilter()
      return
    }
    if (
      this.filteredAnnotationGroupUID !== null &&
      this.filteredAnnotationGroupUID !== uid
    ) {
      this.clearAnnotationVisibilityFilter()
    }
    const allowed = buildVisibilityMask({ positions, values, range })
    setAnnotationVisibilityFilter({
      viewer: this.viewer as unknown as ViewerLike,
      annotationGroupUID: uid,
      allowed,
    })
    this.filteredAnnotationGroupUID = uid
    this.lastAllowed = allowed
  }

  /**
   * Restore the annotations that the filter hid, if any.
   */
  private clearAnnotationVisibilityFilter(): void {
    if (this.filteredAnnotationGroupUID === null) {
      return
    }
    setAnnotationVisibilityFilter({
      viewer: this.viewer as unknown as ViewerLike,
      annotationGroupUID: this.filteredAnnotationGroupUID,
      allowed: null,
    })
    this.filteredAnnotationGroupUID = null
    this.lastAllowed = null
  }
}

/**
 * List the measurements of an annotation group.
 *
 * A free function so that the sidebar can populate its measurement selector
 * without a controller, and therefore without constructing a worker and an
 * OpenLayers layer as a side effect of rendering.
 *
 * @param viewer - Volume image viewer
 * @param annotationGroupUID - Unique identifier of the annotation group
 *
 * @returns One descriptor per measurement
 */
export function listMeasurementsOfGroup(
  viewer: dmv.viewer.VolumeImageViewer,
  annotationGroupUID: string,
): MeasurementDescriptor[] {
  const metadata = viewer.getAnnotationGroupMetadata(
    annotationGroupUID,
  ) as unknown as AnnotationsMetadataLike
  return listMeasurements(metadata, annotationGroupUID)
}

/**
 * Get the range of a measurement across a whole annotation group, to bound the
 * filter slider.
 *
 * A free function for the same reason as `listMeasurementsOfGroup`: it needs
 * nothing but metadata and a client, so asking for it should not cost a
 * worker and a layer.
 *
 * @param options - Options
 * @param options.viewer - Volume image viewer
 * @param options.client - Client used to fetch measurement bulk data
 * @param options.annotationGroupUID - Unique identifier of the annotation group
 * @param options.measurement - Coded concept naming the measurement
 *
 * @returns The range, or `null` when the group has no such measurement or no
 * finite values
 */
export async function getMeasurementRangeOfGroup({
  viewer,
  client,
  annotationGroupUID,
  measurement,
}: {
  viewer: dmv.viewer.VolumeImageViewer
  client: DicomWebManager
  annotationGroupUID: string
  measurement: { CodeValue: string; CodingSchemeDesignator: string }
}): Promise<[number, number] | null> {
  const metadata = viewer.getAnnotationGroupMetadata(
    annotationGroupUID,
  ) as unknown as AnnotationsMetadataLike
  const descriptor = findMeasurement({
    metadata,
    annotationGroupUID,
    measurement,
  })
  if (descriptor === undefined) {
    return null
  }
  const values = await fetchMeasurementValues({
    client,
    metadata,
    annotationGroupUID,
    measurementIndex: descriptor.index,
  })
  return getValueRange(values)
}

/**
 * Describe the ways in which extracted positions are known to be incomplete.
 *
 * @param positions - Extracted positions
 *
 * @returns A warning for the panel, or `null` when the positions are complete
 */
function describeIncompleteness(positions: AnnotationPositions): string | null {
  const warnings: string[] = []
  if (
    positions.expectedCount !== null &&
    positions.count < positions.expectedCount
  ) {
    warnings.push(
      `only ${positions.count} of ${positions.expectedCount} annotations ` +
        'have been loaded by the viewer',
    )
  }
  if (positions.invalidIndexCount > 0) {
    warnings.push(
      `${positions.invalidIndexCount} annotations have an unrecognized ` +
        'feature identifier',
    )
  }
  return warnings.length === 0
    ? null
    : `Heatmap may be incomplete: ${warnings.join('; ')}.`
}

/**
 * Read an entry of a cache, marking it as the most recently used.
 *
 * @param cache - Cache to read
 * @param key - Key of the entry
 *
 * @returns The entry, or `undefined` when the cache does not hold it
 */
function readCache<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key)
  if (value === undefined) {
    return undefined
  }
  /*
   * Re-insertion moves the entry to the back of the insertion order that
   * `evictOldest` walks, which is what makes the eviction least-recently-used
   * rather than first-in-first-out.
   */
  cache.delete(key)
  cache.set(key, value)
  return value
}

/**
 * Determine whether an extraction covers the whole annotation group.
 *
 * @param positions - Extracted positions
 *
 * @returns Whether every annotation the group documents was extracted
 */
function isComplete(positions: AnnotationPositions): boolean {
  return (
    positions.count > 0 &&
    (positions.expectedCount === null ||
      positions.count >= positions.expectedCount)
  )
}

/**
 * Evict the least recently used entries of a cache until it can hold one more
 * entry without exceeding its bound.
 *
 * @param cache - Cache to bound
 * @param maximumSize - Number of entries the cache may hold
 */
function evictOldest<T>(cache: Map<string, T>, maximumSize: number): void {
  while (cache.size >= maximumSize) {
    const oldest = cache.keys().next()
    if (oldest.done === true) {
      return
    }
    cache.delete(oldest.value)
  }
}
