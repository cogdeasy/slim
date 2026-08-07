// skipcq: JS-C1003 - dcmjs uses nested namespaces (dcmjs.sr.coding.CodedConcept)
import type * as dcmjs from 'dcmjs'
// skipcq: JS-C1003 - dmv uses nested namespaces (dmv.utils, dmv.roi)
import * as dmv from 'dicom-microscopy-viewer'

import type DicomWebManager from '../../../DicomWebManager'
import type { AnnotationPositions } from './types'

/**
 * Structural views of the OpenLayers objects owned by DMV.
 *
 * The heatmap reaches into `viewer.getMap()`, which is public DMV API, but it
 * must not `instanceof`-check the objects it finds there: DMV bundles its own
 * copy of OpenLayers, so the classes are structurally but not referentially
 * identical to the ones Slim imports. All access is therefore duck typed.
 */
export interface OlFeatureLike {
  getId: () => string | number | undefined
  get: (key: string) => unknown
  getGeometry: () => { getExtent: () => number[] } | null
}

export interface OlVectorSourceLike {
  getFeatures?: () => OlFeatureLike[]
  /** Present on cluster sources, which wrap the real point source. */
  getSource?: () => OlVectorSourceLike | null
}

export interface OlVectorLayerLike {
  getSource?: () => OlVectorSourceLike | null
  getStyle?: () => unknown
  setStyle?: (style: unknown) => void
}

type OlStyleFunctionLike = (
  feature: OlFeatureLike,
  resolution: number,
) => unknown

/**
 * Minimal structural view of the volume viewer, so that the functions of this
 * module can be exercised against fakes rather than against a real viewer.
 */
export interface ViewerLike {
  getMap: () => {
    getView: () => { getProjection: () => { getExtent: () => number[] } }
    getLayers: () => { getArray: () => unknown[] }
  }
}

/**
 * Item of the Annotation Group Sequence, as far as the heatmap reads it.
 */
interface AnnotationGroupMetadataItem {
  AnnotationGroupUID: string
  NumberOfAnnotations?: number | string
  MeasurementsSequence?: Array<{
    ConceptNameCodeSequence: Array<{
      CodingSchemeDesignator: string
      CodeValue: string
      CodeMeaning: string
    }>
    MeasurementUnitsCodeSequence?: Array<{
      CodeValue: string
      CodeMeaning: string
    }>
    MeasurementValuesSequence?: Array<{
      FloatingPointValues?: Float32Array | number[]
    }>
  }>
}

/**
 * Reference to a bulk data element, as returned by `dmv.metadata.formatMetadata`.
 */
interface BulkDataReference {
  BulkDataURI: string
  vr?: string
}

/**
 * The parts of a Microscopy Bulk Simple Annotations instance the heatmap
 * reads. Declared structurally because the DMV type declarations do not model
 * the sequences.
 */
export interface AnnotationsMetadataLike {
  AnnotationGroupSequence: AnnotationGroupMetadataItem[]
  bulkdataReferences?: {
    AnnotationGroupSequence?: Array<{
      MeasurementsSequence?: Array<{
        MeasurementValuesSequence?: Array<{
          FloatingPointValues?: BulkDataReference
        }>
      }>
    }>
  }
}

/**
 * Descriptor of one per-annotation measurement of an annotation group.
 */
export interface MeasurementDescriptor {
  index: number
  name: dcmjs.sr.coding.CodedConcept
  /** Stable identifier of the measurement, `<schemeDesignator>-<codeValue>`. */
  key: string
  label: string
  unit?: string
}

/**
 * Get the extent of the whole slide in OpenLayers projection coordinates.
 *
 * @param viewer - Volume image viewer
 *
 * @returns Extent `[minX, minY, maxX, maxY]`
 */
export function getSlideExtent(
  viewer: ViewerLike,
): [number, number, number, number] {
  const extent = viewer.getMap().getView().getProjection().getExtent()
  return [extent[0], extent[1], extent[2], extent[3]]
}

/**
 * Collect every vector source reachable from the map, unwrapping cluster
 * sources so that the point source they wrap is visited too.
 *
 * @param viewer - Volume image viewer
 *
 * @returns The sources, in layer order
 */
function collectSources(viewer: ViewerLike): OlVectorSourceLike[] {
  const sources: OlVectorSourceLike[] = []
  const visit = (source: OlVectorSourceLike | null | undefined): void => {
    if (source === null || source === undefined || sources.includes(source)) {
      return
    }
    sources.push(source)
    if (typeof source.getSource === 'function') {
      visit(source.getSource())
    }
  }
  for (const layer of viewer.getMap().getLayers().getArray()) {
    const candidate = layer as OlVectorLayerLike
    if (typeof candidate.getSource === 'function') {
      visit(candidate.getSource())
    }
  }
  return sources
}

/**
 * Style functions that the visibility filter has replaced, so that clearing
 * the filter can put the original back. Keyed by layer, so that layers DMV
 * recreates simply drop out.
 */
const baseStyles = new WeakMap<object, unknown>()

/**
 * Find the layers whose (possibly clustered) source holds an annotation group.
 *
 * @param viewer - Volume image viewer
 * @param annotationGroupUID - Unique identifier of the annotation group
 *
 * @returns The matching layers
 */
function findAnnotationGroupLayers(
  viewer: ViewerLike,
  annotationGroupUID: string,
): OlVectorLayerLike[] {
  const layers: OlVectorLayerLike[] = []
  for (const item of viewer.getMap().getLayers().getArray()) {
    const layer = item as OlVectorLayerLike
    if (typeof layer.getSource !== 'function') {
      continue
    }
    let source = layer.getSource()
    while (source !== null && source !== undefined) {
      const features =
        typeof source.getFeatures === 'function' ? source.getFeatures() : []
      if (
        features.length > 0 &&
        features[0].get('annotationGroupUID') === annotationGroupUID
      ) {
        layers.push(layer)
        break
      }
      source =
        typeof source.getSource === 'function' ? source.getSource() : null
    }
  }
  return layers
}

/**
 * Hide the annotations of a group whose annotation index is not marked in
 * `allowed`, or show all of them again.
 *
 * DMV has no API for this: `setAnnotationGroupStyle` accepts `limitValues` for
 * optical paths and parameter mappings but reads only `opacity`, `color` and
 * `measurement` for annotation groups, so unknown keys are dropped without an
 * error. The group's layer styles are therefore wrapped here instead - an
 * excluded feature is styled `undefined`, which OpenLayers renders as nothing.
 *
 * Cluster features have no id of their own, so a cluster is kept whenever any
 * of its members is allowed; cluster bubbles thin out rather than vanish.
 *
 * @param options - Options
 * @param options.viewer - Volume image viewer
 * @param options.annotationGroupUID - Unique identifier of the annotation group
 * @param options.allowed - Mask indexed by DICOM annotation index, or `null`
 * to restore the styles DMV originally set
 */
export function setAnnotationVisibilityFilter({
  viewer,
  annotationGroupUID,
  allowed,
}: {
  viewer: ViewerLike
  annotationGroupUID: string
  allowed: Uint8Array | null
}): void {
  const prefix = `${annotationGroupUID}-`

  const isAllowed = (feature: OlFeatureLike): boolean => {
    if (allowed === null) {
      return true
    }
    const members = feature.get('features')
    if (Array.isArray(members)) {
      return (members as OlFeatureLike[]).some(isAllowed)
    }
    const index = parseAnnotationIndex(feature.getId(), prefix)
    /** Features that are not part of the group are left untouched. */
    return index < 0 || index >= allowed.length || allowed[index] === 1
  }

  for (const layer of findAnnotationGroupLayers(viewer, annotationGroupUID)) {
    if (
      typeof layer.getStyle !== 'function' ||
      typeof layer.setStyle !== 'function'
    ) {
      continue
    }
    if (!baseStyles.has(layer)) {
      baseStyles.set(layer, layer.getStyle())
    }
    const base = baseStyles.get(layer)
    if (allowed === null) {
      layer.setStyle(base)
      baseStyles.delete(layer)
      continue
    }
    layer.setStyle((feature: OlFeatureLike, resolution: number) => {
      if (!isAllowed(feature)) {
        return undefined
      }
      return typeof base === 'function'
        ? (base as OlStyleFunctionLike)(feature, resolution)
        : base
    })
  }
}

/**
 * Parse the DICOM annotation index out of the id DMV assigns to a feature,
 * which is `<annotationGroupUID>-<annotationIndex>`.
 *
 * @param id - Feature id
 * @param prefix - Expected `<annotationGroupUID>-` prefix
 *
 * @returns The annotation index, or `-1` when the id does not match
 */
function parseAnnotationIndex(
  id: string | number | undefined,
  prefix: string,
): number {
  if (typeof id !== 'string' || !id.startsWith(prefix)) {
    return -1
  }
  const index = Number.parseInt(id.slice(prefix.length), 10)
  return Number.isInteger(index) && index >= 0 ? index : -1
}

/**
 * Get the number of annotations an annotation group is documented to hold.
 *
 * @param metadata - Metadata of the annotation instance
 * @param annotationGroupUID - Unique identifier of the annotation group
 *
 * @returns The number of annotations, or `null` when not stated
 */
export function getExpectedAnnotationCount(
  metadata: AnnotationsMetadataLike,
  annotationGroupUID: string,
): number | null {
  const item = metadata.AnnotationGroupSequence.find(
    (candidate) => candidate.AnnotationGroupUID === annotationGroupUID,
  )
  const count = Number(item?.NumberOfAnnotations)
  return Number.isFinite(count) && count > 0 ? count : null
}

/**
 * Extract one representative position per annotation of an annotation group
 * from the OpenLayers features that DMV has already materialized.
 *
 * DMV maintains several sources per group: a point source holding one feature
 * per annotation over the whole slide, and viewport-filtered polygon and
 * cluster sources. The source with the most features is used, so that the
 * heatmap covers the whole slide rather than the current viewport; the caller
 * is told through `expectedCount` when even that source is incomplete.
 *
 * @param options - Options
 * @param options.viewer - Volume image viewer
 * @param options.annotationGroupUID - Unique identifier of the annotation group
 * @param options.expectedCount - Number of annotations of the group, when known
 *
 * @returns Positions, or `null` when DMV has not materialized the group yet,
 * which is the case until the group has been made visible once
 */
export function extractAnnotationPositions({
  viewer,
  annotationGroupUID,
  expectedCount = null,
}: {
  viewer: ViewerLike
  annotationGroupUID: string
  expectedCount?: number | null
}): AnnotationPositions | null {
  const prefix = `${annotationGroupUID}-`

  let best: OlFeatureLike[] | null = null
  for (const source of collectSources(viewer)) {
    if (typeof source.getFeatures !== 'function') {
      continue
    }
    const features = source.getFeatures()
    if (features.length === 0) {
      continue
    }
    if (features[0].get('annotationGroupUID') !== annotationGroupUID) {
      continue
    }
    if (best === null || features.length > best.length) {
      best = features
    }
  }

  if (best === null) {
    return null
  }

  const count = best.length
  const xy = new Float32Array(count * 2)
  const annotationIndices = new Int32Array(count)
  let written = 0
  let invalidIndexCount = 0
  for (let i = 0; i < count; i++) {
    const feature = best[i]
    /*
     * Guard against the source-selection heuristic having picked up features
     * of another group, which would silently misplace them on the heatmap.
     */
    if (feature.get('annotationGroupUID') !== annotationGroupUID) {
      continue
    }
    const geometry = feature.getGeometry()
    if (geometry === null) {
      continue
    }
    /*
     * The center of the bounding box is the representative point. On the
     * whole-slide point source the extent is degenerate, so this is exact;
     * on a polygon source it is off by at most a cell radius, orders of
     * magnitude below any sensible bin size.
     */
    const extent = geometry.getExtent()
    xy[written * 2] = (extent[0] + extent[2]) / 2
    xy[written * 2 + 1] = (extent[1] + extent[3]) / 2

    const annotationIndex = parseAnnotationIndex(feature.getId(), prefix)
    if (annotationIndex < 0) {
      invalidIndexCount += 1
    }
    annotationIndices[written] = annotationIndex
    written += 1
  }

  return {
    xy: written === count ? xy : xy.slice(0, written * 2),
    annotationIndices:
      written === count
        ? annotationIndices
        : annotationIndices.slice(0, written),
    count: written,
    invalidIndexCount,
    expectedCount,
    extent: getSlideExtent(viewer),
  }
}

/**
 * Extract the positions of the user's own ROI annotations, drawn in the viewer
 * or loaded from a Comprehensive 3D SR.
 *
 * ROI coordinates are SCOORD3D slide coordinates in millimeter and are
 * therefore mapped back into OpenLayers projection coordinates, which are
 * total pixel matrix coordinates of the base level with a flipped y axis.
 *
 * @param options - Options
 * @param options.viewer - Volume image viewer
 * @param options.rois - Regions of interest
 *
 * @returns Positions, one per region of interest
 */
export function extractRoiPositions({
  viewer,
  rois,
}: {
  viewer: dmv.viewer.VolumeImageViewer
  rois: dmv.roi.ROI[]
}): AnnotationPositions {
  const affine = viewer.getAffine()
  const xy = new Float32Array(rois.length * 2)
  const annotationIndices = new Int32Array(rois.length)
  rois.forEach((roi, index) => {
    const graphicData = roi.scoord3d.graphicData as number[][] | number[]
    const points: number[][] = Array.isArray(graphicData[0])
      ? (graphicData as number[][])
      : [graphicData as number[]]
    let sumX = 0
    let sumY = 0
    for (const point of points) {
      const pixel = dmv.utils.applyInverseTransform({
        coordinate: [point[0], point[1]],
        affine,
      })
      sumX += pixel[0]
      /** OpenLayers projection coordinates flip the row axis. */
      sumY += -(pixel[1] + 1)
    }
    xy[index * 2] = sumX / points.length
    xy[index * 2 + 1] = sumY / points.length
    annotationIndices[index] = index
  })
  return {
    xy,
    annotationIndices,
    count: rois.length,
    invalidIndexCount: 0,
    expectedCount: rois.length,
    extent: getSlideExtent(viewer as unknown as ViewerLike),
  }
}

/**
 * List the measurements defined on an annotation group.
 *
 * @param metadata - Metadata of the annotation instance
 * @param annotationGroupUID - Unique identifier of the annotation group
 *
 * @returns One descriptor per measurement, in Measurements Sequence order
 */
export function listMeasurements(
  metadata: AnnotationsMetadataLike,
  annotationGroupUID: string,
): MeasurementDescriptor[] {
  const item = metadata.AnnotationGroupSequence.find(
    (candidate) => candidate.AnnotationGroupUID === annotationGroupUID,
  )
  return (item?.MeasurementsSequence ?? []).map((measurement, index) => {
    const name = measurement.ConceptNameCodeSequence[0]
    const unit = measurement.MeasurementUnitsCodeSequence?.[0]
    return {
      index,
      name: name as unknown as dcmjs.sr.coding.CodedConcept,
      key: `${name.CodingSchemeDesignator}-${name.CodeValue}`,
      label: name.CodeMeaning,
      unit: unit?.CodeValue,
    }
  })
}

/**
 * Find the descriptor of a measurement of an annotation group.
 *
 * @param options - Options
 * @param options.metadata - Metadata of the annotation instance
 * @param options.annotationGroupUID - Unique identifier of the annotation group
 * @param options.measurement - Coded concept naming the measurement
 *
 * @returns The descriptor, or `undefined` when the group has no such
 * measurement
 */
export function findMeasurement({
  metadata,
  annotationGroupUID,
  measurement,
}: {
  metadata: AnnotationsMetadataLike
  annotationGroupUID: string
  measurement: { CodeValue: string; CodingSchemeDesignator: string }
}): MeasurementDescriptor | undefined {
  return listMeasurements(metadata, annotationGroupUID).find(
    (candidate) =>
      candidate.name.CodeValue === measurement.CodeValue &&
      candidate.name.CodingSchemeDesignator ===
        measurement.CodingSchemeDesignator,
  )
}

/**
 * Interpret a bulk data payload according to its value representation.
 *
 * Mirrors the conversion DMV applies to bulk data elements, so that
 * measurements stored as anything other than 32-bit floats are read
 * correctly.
 *
 * @param options - Options
 * @param options.data - Payload
 * @param options.vr - Value representation, defaulting to `OF`
 *
 * @returns The values as 32-bit floats
 */
export function decodeBulkDataValues({
  data,
  vr = 'OF',
}: {
  data: ArrayBuffer
  vr?: string
}): Float32Array {
  switch (vr) {
    case 'OD':
    case 'OV':
      return Float32Array.from(
        new Float64Array(data, 0, Math.floor(data.byteLength / 8)),
      )
    case 'OL':
      return Float32Array.from(
        new Int32Array(data, 0, Math.floor(data.byteLength / 4)),
      )
    case 'OW':
      return Float32Array.from(
        new Uint16Array(data, 0, Math.floor(data.byteLength / 2)),
      )
    case 'OB':
      return Float32Array.from(new Uint8Array(data))
    case 'OF':
      return new Float32Array(data, 0, Math.floor(data.byteLength / 4))
    default:
      throw new Error(
        `Cannot read measurement values with value representation "${vr}".`,
      )
  }
}

/**
 * Fetch the per-annotation values of one measurement of an annotation group.
 *
 * DMV does not fetch measurement bulk data - the call is commented out in its
 * `addAnnotationGroups` path, so `feature.get('measurementValue0')` is
 * `undefined` - hence the direct DICOMweb retrieval. The payload is one value
 * per annotation and thus three orders of magnitude smaller than the
 * coordinate data of the same group.
 *
 * @param options - Options
 * @param options.client - DICOMweb client of the annotation instance
 * @param options.metadata - Metadata of the annotation instance
 * @param options.annotationGroupUID - Unique identifier of the annotation group
 * @param options.measurementIndex - Index in the Measurements Sequence
 *
 * @returns The values, indexed by DICOM annotation index
 */
export async function fetchMeasurementValues({
  client,
  metadata,
  annotationGroupUID,
  measurementIndex,
}: {
  client: DicomWebManager
  metadata: AnnotationsMetadataLike
  annotationGroupUID: string
  measurementIndex: number
}): Promise<Float32Array> {
  const groupIndex = metadata.AnnotationGroupSequence.findIndex(
    (candidate) => candidate.AnnotationGroupUID === annotationGroupUID,
  )
  if (groupIndex < 0) {
    throw new Error(`Unknown annotation group "${annotationGroupUID}".`)
  }

  /** Small measurement arrays may be included inline rather than by reference. */
  const inlineValues =
    metadata.AnnotationGroupSequence[groupIndex].MeasurementsSequence?.[
      measurementIndex
    ]?.MeasurementValuesSequence?.[0]?.FloatingPointValues
  if (inlineValues !== undefined) {
    return Float32Array.from(inlineValues)
  }

  const reference =
    metadata.bulkdataReferences?.AnnotationGroupSequence?.[groupIndex]
      ?.MeasurementsSequence?.[measurementIndex]?.MeasurementValuesSequence?.[0]
      ?.FloatingPointValues
  if (reference?.BulkDataURI === undefined) {
    throw new Error(
      `No bulk data reference for measurement #${measurementIndex} ` +
        `of annotation group "${annotationGroupUID}".`,
    )
  }

  const data = await client.retrieveBulkData({
    BulkDataURI: reference.BulkDataURI,
  })
  if (data.length === 0) {
    throw new Error(
      `Empty bulk data response for measurement #${measurementIndex} ` +
        `of annotation group "${annotationGroupUID}".`,
    )
  }
  return decodeBulkDataValues({ data: data[0], vr: reference.vr })
}

/**
 * Gather measurement values onto extracted positions.
 *
 * Measurement values are indexed by DICOM annotation index while positions are
 * ordered by however DMV happened to build its features, so the values have to
 * be gathered rather than reused as they are. Positions whose annotation index
 * is unknown or out of range receive `NaN` and are skipped by the binner.
 *
 * @param options - Options
 * @param options.positions - Extracted positions
 * @param options.values - Values indexed by DICOM annotation index
 *
 * @returns Values aligned with `positions`
 */
export function alignMeasurementValues({
  positions,
  values,
}: {
  positions: AnnotationPositions
  values: Float32Array
}): Float32Array {
  const aligned = new Float32Array(positions.count)
  for (let i = 0; i < positions.count; i++) {
    const annotationIndex = positions.annotationIndices[i]
    aligned[i] =
      annotationIndex >= 0 && annotationIndex < values.length
        ? values[annotationIndex]
        : Number.NaN
  }
  return aligned
}

/**
 * Build the mask of annotations that a measurement filter keeps.
 *
 * The mask is indexed by DICOM annotation index rather than by extraction
 * order, so that it can be applied to any of the layers of the group.
 *
 * @param options - Options
 * @param options.positions - Extracted positions
 * @param options.values - Measurement values aligned with the positions
 * @param options.range - Inclusive range of values to keep
 *
 * @returns The mask, with `1` for every annotation that is kept
 */
export function buildVisibilityMask({
  positions,
  values,
  range,
}: {
  positions: AnnotationPositions
  values: Float32Array
  range: [number, number]
}): Uint8Array {
  let highestIndex = -1
  for (let i = 0; i < positions.count; i++) {
    if (positions.annotationIndices[i] > highestIndex) {
      highestIndex = positions.annotationIndices[i]
    }
  }
  const allowed = new Uint8Array(highestIndex + 1)
  for (let i = 0; i < positions.count; i++) {
    const annotationIndex = positions.annotationIndices[i]
    if (
      annotationIndex >= 0 &&
      values[i] >= range[0] &&
      values[i] <= range[1]
    ) {
      allowed[annotationIndex] = 1
    }
  }
  return allowed
}

/**
 * Determine the range of a set of measurement values.
 *
 * @param values - Measurement values
 *
 * @returns Minimum and maximum, or `null` when no value is finite
 */
export function getValueRange(values: Float32Array): [number, number] | null {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      continue
    }
    if (values[i] < low) {
      low = values[i]
    }
    if (values[i] > high) {
      high = values[i]
    }
  }
  return low <= high ? [low, high] : null
}
