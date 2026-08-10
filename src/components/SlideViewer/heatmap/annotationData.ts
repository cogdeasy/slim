// skipcq: JS-C1003
import type * as dcmjs from 'dcmjs'
// skipcq: JS-C1003
import * as dmv from 'dicom-microscopy-viewer'

import type DicomWebManager from '../../../DicomWebManager'
import type { AnnotationPositions } from './types'

/**
 * Structural view of the OpenLayers objects owned by DMV.
 *
 * The heatmap reaches into `viewer.getMap()` (public DMV API) but must not
 * `instanceof`-check against Slim's own copy of OpenLayers: DMV bundles its
 * own copy, so the classes are structurally but not referentially identical.
 * Feature access is therefore duck typed.
 */
interface OlFeatureLike {
  getId: () => string | number | undefined
  get: (key: string) => unknown
  getGeometry: () => { getExtent: () => number[] } | null
}

interface OlVectorSourceLike {
  getFeatures?: () => OlFeatureLike[]
  /** Present on cluster sources, which wrap the real point source. */
  getSource?: () => OlVectorSourceLike | null
}

type OlStyleFunctionLike = (
  feature: OlFeatureLike,
  resolution: number,
) => unknown

interface OlVectorLayerLike {
  getSource?: () => OlVectorSourceLike | null
  getStyle?: () => unknown
  setStyle?: (style: unknown) => void
  changed?: () => void
}

type VolumeViewer = dmv.viewer.VolumeImageViewer

/**
 * Extent of the whole slide in OpenLayers projection coordinates.
 */
export function getSlideExtent(
  viewer: VolumeViewer,
): [number, number, number, number] {
  const extent = viewer.getMap().getView().getProjection().getExtent()
  return [extent[0], extent[1], extent[2], extent[3]]
}

/**
 * Collect every vector source reachable from the map, unwrapping cluster
 * sources so that the underlying point source is visited too.
 */
function collectSources(viewer: VolumeViewer): OlVectorSourceLike[] {
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
  viewer
    .getMap()
    .getLayers()
    .getArray()
    .forEach((layer) => {
      const candidate = layer as unknown as {
        getSource?: () => OlVectorSourceLike | null
      }
      if (typeof candidate.getSource === 'function') {
        visit(candidate.getSource())
      }
    })
  return sources
}

/**
 * Style functions the filter has replaced, so that clearing the filter can put
 * the original back. Keyed by layer, so layers DMV recreates simply drop out.
 */
const baseStyles = new WeakMap<object, unknown>()

/** Marks a style function as one the filter installed. */
const WRAPPER_FLAG = '__slimHeatmapFilterWrapper'

function isWrapper(style: unknown): boolean {
  return (
    typeof style === 'function' &&
    (style as unknown as Record<string, unknown>)[WRAPPER_FLAG] === true
  )
}

/** Layers of the map whose (possibly clustered) source holds the group. */
function findAnnotationGroupLayers(
  viewer: VolumeViewer,
  annotationGroupUID: string,
): OlVectorLayerLike[] {
  return viewer
    .getMap()
    .getLayers()
    .getArray()
    .filter((layer) => {
      const candidate = layer as unknown as OlVectorLayerLike
      if (typeof candidate.getSource !== 'function') {
        return false
      }
      let source = candidate.getSource()
      while (source !== null && source !== undefined) {
        const features =
          typeof source.getFeatures === 'function' ? source.getFeatures() : []
        if (
          features.length > 0 &&
          features[0].get('annotationGroupUID') === annotationGroupUID
        ) {
          return true
        }
        source =
          typeof source.getSource === 'function' ? source.getSource() : null
      }
      return false
    }) as unknown as OlVectorLayerLike[]
}

/**
 * Hide the annotations of a group whose annotation index is not in `allowed`,
 * or show all of them again when `allowed` is `null`.
 *
 * DMV has no API for this: `setAnnotationGroupStyle` accepts `limitValues` for
 * optical paths and parameter mappings but silently ignores it for annotation
 * groups. So the group's layer styles are wrapped instead — an excluded
 * feature is styled `undefined`, which OpenLayers renders as nothing.
 *
 * Cluster features have no id of their own; they are kept whenever any of
 * their members is allowed, so cluster bubbles thin out rather than vanish.
 */
export function setAnnotationVisibilityFilter({
  viewer,
  annotationGroupUID,
  allowed,
}: {
  viewer: VolumeViewer
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
    const id = feature.getId()
    if (typeof id !== 'string' || !id.startsWith(prefix)) {
      return true
    }
    const index = Number.parseInt(id.slice(prefix.length), 10)
    return (
      Number.isNaN(index) || index >= allowed.length || allowed[index] === 1
    )
  }

  for (const layer of findAnnotationGroupLayers(viewer, annotationGroupUID)) {
    if (
      typeof layer.getStyle !== 'function' ||
      typeof layer.setStyle !== 'function'
    ) {
      continue
    }
    /*
     * DMV replaces the style whenever the group is shown, hidden or restyled,
     * so the current style is only the base if it is not already a wrapper —
     * otherwise re-applying would nest wrappers and never restore.
     */
    const current = layer.getStyle()
    if (!isWrapper(current)) {
      baseStyles.set(layer, current)
    }
    const base = baseStyles.get(layer)
    if (allowed === null) {
      if (isWrapper(current)) {
        layer.setStyle(base)
      }
      baseStyles.delete(layer)
      continue
    }
    const wrapper = (feature: OlFeatureLike, resolution: number): unknown => {
      if (!isAllowed(feature)) {
        return undefined
      }
      return typeof base === 'function'
        ? (base as OlStyleFunctionLike)(feature, resolution)
        : base
    }
    ;(wrapper as unknown as Record<string, unknown>)[WRAPPER_FLAG] = true
    layer.setStyle(wrapper)
  }
}

/**
 * Extract one representative position per annotation of an annotation group
 * from the OpenLayers features that DMV has already materialised.
 *
 * DMV populates a point source (one feature per annotation, positioned at the
 * annotation's first vertex) for every annotation group, in addition to the
 * viewport-filtered high-resolution polygon source. We deliberately prefer the
 * source with the most features so that the heatmap covers the whole slide
 * rather than only the current viewport.
 *
 * Returns `null` when DMV has not loaded the group's features yet, which is
 * the case until the group has been made visible at least once.
 */
export function extractAnnotationPositions({
  viewer,
  annotationGroupUID,
}: {
  viewer: VolumeViewer
  annotationGroupUID: string
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
  for (let i = 0; i < count; i++) {
    const feature = best[i]
    const geometry = feature.getGeometry()
    if (geometry === null) {
      continue
    }
    /*
     * The bounding-box centre is used as the representative point. For POINT
     * groups it is the point itself; for polygon groups DMV's point source
     * already holds one point per annotation, so the extent is degenerate.
     * Only the viewport-filtered polygon source yields true bounding boxes,
     * whose centre is within a cell diameter of the true centroid — far below
     * any sensible bin size.
     */
    const extent = geometry.getExtent()
    xy[written * 2] = (extent[0] + extent[2]) / 2
    xy[written * 2 + 1] = (extent[1] + extent[3]) / 2

    const id = feature.getId()
    const idString = typeof id === 'string' ? id : ''
    annotationIndices[written] = idString.startsWith(prefix)
      ? Number.parseInt(idString.slice(prefix.length), 10)
      : -1
    written += 1
  }

  return {
    xy: written === count ? xy : xy.slice(0, written * 2),
    annotationIndices:
      written === count
        ? annotationIndices
        : annotationIndices.slice(0, written),
    count: written,
    extent: getSlideExtent(viewer),
  }
}

/**
 * Extract positions of the user's own ROI annotations (drawn or loaded from
 * Comprehensive 3D SR).
 *
 * ROI coordinates are SCOORD3D slide coordinates in millimetres and therefore
 * have to be mapped back into OpenLayers projection coordinates, which are
 * total-pixel-matrix coordinates of the base level with a flipped y axis.
 */
export function extractRoiPositions({
  viewer,
  rois,
}: {
  viewer: VolumeViewer
  rois: dmv.roi.ROI[]
}): AnnotationPositions {
  const affine = viewer.getAffine()
  const xy = new Float32Array(rois.length * 2)
  const annotationIndices = new Int32Array(rois.length)
  let written = 0
  rois.forEach((roi, index) => {
    const coordinates = roi.scoord3d.graphicData as number[][] | number[]
    const points: number[][] = Array.isArray(coordinates[0])
      ? (coordinates as number[][])
      : [coordinates as number[]]
    let sumX = 0
    let sumY = 0
    points.forEach((point) => {
      const pixel = dmv.utils.applyInverseTransform({
        coordinate: [point[0], point[1]],
        affine,
      })
      sumX += pixel[0]
      /** OpenLayers projection coordinates flip the row axis. */
      sumY += -(pixel[1] + 1)
    })
    xy[written * 2] = sumX / points.length
    xy[written * 2 + 1] = sumY / points.length
    annotationIndices[written] = index
    written += 1
  })
  return {
    xy: xy.slice(0, written * 2),
    annotationIndices: annotationIndices.slice(0, written),
    count: written,
    extent: getSlideExtent(viewer),
  }
}

/**
 * Descriptor of one per-annotation measurement available on an annotation
 * group.
 */
export interface MeasurementDescriptor {
  index: number
  name: dcmjs.sr.coding.CodedConcept
  key: string
  label: string
  unit?: string
}

function toKey(name: {
  CodingSchemeDesignator: string
  CodeValue: string
}): string {
  return `${name.CodingSchemeDesignator}-${name.CodeValue}`
}

/**
 * List the measurements defined on an annotation group.
 */
export function listMeasurements(
  metadata: dmv.metadata.MicroscopyBulkSimpleAnnotations,
  annotationGroupUID: string,
): MeasurementDescriptor[] {
  const item = metadata.AnnotationGroupSequence.find(
    (candidate) => candidate.AnnotationGroupUID === annotationGroupUID,
  )
  const sequence = item?.MeasurementsSequence ?? []
  return sequence.map((measurement, index) => {
    const name = measurement.ConceptNameCodeSequence[0]
    const unit = measurement.MeasurementUnitsCodeSequence?.[0]
    return {
      index,
      name: name as unknown as dcmjs.sr.coding.CodedConcept,
      key: toKey(name),
      label: name.CodeMeaning,
      unit: unit?.CodeValue,
    }
  })
}

/**
 * Fetch the per-annotation values of one measurement of an annotation group.
 *
 * DMV does not fetch measurement bulk data (the call is commented out in
 * `addAnnotationGroups`), so the heatmap retrieves it itself. The payload is
 * one float32 per annotation, i.e. three orders of magnitude smaller than the
 * point coordinate data.
 */
export async function fetchMeasurementValues({
  client,
  metadata,
  annotationGroupUID,
  measurementIndex,
}: {
  client: DicomWebManager
  metadata: dmv.metadata.MicroscopyBulkSimpleAnnotations
  annotationGroupUID: string
  measurementIndex: number
}): Promise<Float32Array> {
  const groupIndex = metadata.AnnotationGroupSequence.findIndex(
    (candidate) => candidate.AnnotationGroupUID === annotationGroupUID,
  )
  if (groupIndex < 0) {
    throw new Error(`Unknown annotation group "${annotationGroupUID}".`)
  }
  const metadataItem = metadata.AnnotationGroupSequence[groupIndex]
  const valuesMetadataItem =
    metadataItem.MeasurementsSequence?.[measurementIndex]
      ?.MeasurementValuesSequence?.[0]

  /** Values may be included inline rather than by reference. */
  const inlineValues = (
    valuesMetadataItem as unknown as { FloatingPointValues?: Float32Array }
  )?.FloatingPointValues
  if (inlineValues !== undefined) {
    return Float32Array.from(inlineValues)
  }

  const bulkdataReferences = (
    metadata as unknown as {
      bulkdataReferences: {
        AnnotationGroupSequence?: Array<{
          MeasurementsSequence?: Array<{
            MeasurementValuesSequence?: Array<{
              FloatingPointValues?: { BulkDataURI: string }
            }>
          }>
        }>
      }
    }
  ).bulkdataReferences
  const reference =
    bulkdataReferences?.AnnotationGroupSequence?.[groupIndex]
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
  const bytes = new Uint8Array(data[0])
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 4),
  )
}

/**
 * Align measurement values with the extracted positions.
 *
 * Measurement values are indexed by DICOM annotation index while positions are
 * ordered by however DMV happened to build its features, so a gather step is
 * needed rather than a straight reuse of the array.
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
