/**
 * Estimation of the amount of bulk data that has to be retrieved to display a
 * Microscopy Bulk Simple Annotations (ANN) annotation group.
 *
 * DICOMweb does not offer a way to query the size of a bulk data item: the
 * metadata resource only contains "BulkDataURI" references, servers are not
 * required to support HEAD on those URIs, and WADO-RS bulk data responses are
 * multipart and typically chunked, so neither "Content-Length" nor a ranged
 * GET yields the payload size (the IDC proxy, for example, answers HEAD with
 * 404 and sends no "Content-Length" on GET). The size is therefore derived
 * from the annotation group metadata, which specifies how many annotations of
 * which graphic type are encoded and in which value representation.
 */

// skipcq: JS-C1003
import type * as dmv from 'dicom-microscopy-viewer'
import { memoryMonitor } from '../services/MemoryMonitor'

/**
 * Default maximum amount of bulk data that is retrieved automatically.
 */
export const DEFAULT_MAX_BULK_DATA_SIZE = 250 * 1024 * 1024

/**
 * Average number of points per annotation assumed for graphic types whose
 * number of points is not encoded in the metadata (POLYGON and POLYLINE).
 * The value was measured on the Pan-Cancer-Nuclei-Seg annotations in IDC,
 * where nucleus polygons have ~35 points on average.
 */
const ASSUMED_POINTS_PER_ANNOTATION = 35

const POINTS_PER_ANNOTATION: { [graphicType: string]: number } = {
  POINT: 1,
  RECTANGLE: 4,
  ELLIPSE: 4,
  ELLIPSOID: 6,
}

/** Number of bytes of one value of the point index list (VR OL). */
const BYTES_PER_INDEX = 4

/** Number of bytes of one measurement value (VR OF) or index (VR OL). */
const BYTES_PER_MEASUREMENT_VALUE = 4

interface BulkDataReference {
  vr: string
  BulkDataURI: string
}

interface AnnotationGroupBulkDataReferences {
  PointCoordinatesData?: BulkDataReference
  DoublePointCoordinatesData?: BulkDataReference
  LongPrimitivePointIndexList?: BulkDataReference
  MeasurementsSequence?: Array<{
    MeasurementValuesSequence?: Array<{
      FloatingPointValues?: BulkDataReference
      AnnotationIndexList?: BulkDataReference
    }>
  }>
}

export interface BulkDataSizeEstimate {
  /** Estimated number of bytes that need to be retrieved */
  bytes: number
  /**
   * Whether the number of points per annotation had to be assumed, which is
   * the case for graphic types POLYGON and POLYLINE
   */
  isApproximate: boolean
}

/**
 * Get the configured maximum amount of bulk data (in bytes) that may be
 * retrieved automatically.
 */
export const getMaxBulkDataSize = (): number => {
  const configuredValue =
    typeof window !== 'undefined' ? window.config?.maxBulkDataSize : undefined
  if (typeof configuredValue === 'number' && configuredValue >= 0) {
    return configuredValue
  }
  return DEFAULT_MAX_BULK_DATA_SIZE
}

/**
 * Format an estimate for display, e.g., "~685.18 MB".
 */
export const formatBulkDataSize = (estimate: BulkDataSizeEstimate): string => {
  const size = memoryMonitor.formatBytes(estimate.bytes)
  return estimate.isApproximate ? `~${size}` : size
}

/**
 * Estimate the amount of bulk data that has to be retrieved to display an
 * annotation group. Values that are included in the metadata rather than
 * referenced via "BulkDataURI" do not need to be retrieved and are therefore
 * not counted.
 *
 * @param metadata - Metadata of the Microscopy Bulk Simple Annotations instance
 * @param annotationGroupUID - Unique identifier of the annotation group
 *
 * @returns Estimated size or null if the size cannot be determined
 */
export const estimateAnnotationGroupBulkDataSize = (
  metadata: dmv.metadata.MicroscopyBulkSimpleAnnotations,
  annotationGroupUID: string,
): BulkDataSizeEstimate | null => {
  const index = metadata.AnnotationGroupSequence.findIndex(
    (item) => item.AnnotationGroupUID === annotationGroupUID,
  )
  if (index < 0) {
    return null
  }
  const metadataItem = metadata.AnnotationGroupSequence[index]
  const references = (
    metadata.bulkdataReferences as {
      AnnotationGroupSequence?: AnnotationGroupBulkDataReferences[]
    }
  )?.AnnotationGroupSequence?.[index]
  if (references === undefined) {
    return null
  }

  const numberOfAnnotations = metadataItem.NumberOfAnnotations
  if (typeof numberOfAnnotations !== 'number' || numberOfAnnotations <= 0) {
    return null
  }

  let bytes = 0
  let isApproximate = false

  const coordinatesReference =
    references.DoublePointCoordinatesData ?? references.PointCoordinatesData
  if (coordinatesReference !== undefined) {
    const bytesPerCoordinate =
      references.DoublePointCoordinatesData !== undefined ? 8 : 4
    const numberOfDimensions =
      metadata.AnnotationCoordinateType === '3D' &&
      metadataItem.CommonZCoordinateValue === undefined
        ? 3
        : 2
    const numberOfPoints = POINTS_PER_ANNOTATION[metadataItem.GraphicType]
    if (numberOfPoints === undefined) {
      isApproximate = true
    }
    bytes +=
      numberOfAnnotations *
      (numberOfPoints ?? ASSUMED_POINTS_PER_ANNOTATION) *
      numberOfDimensions *
      bytesPerCoordinate
  }

  if (references.LongPrimitivePointIndexList !== undefined) {
    bytes += numberOfAnnotations * BYTES_PER_INDEX
  }

  references.MeasurementsSequence?.forEach((measurementItem) => {
    measurementItem.MeasurementValuesSequence?.forEach((valuesItem) => {
      if (valuesItem.FloatingPointValues !== undefined) {
        bytes += numberOfAnnotations * BYTES_PER_MEASUREMENT_VALUE
      }
      if (valuesItem.AnnotationIndexList !== undefined) {
        bytes += numberOfAnnotations * BYTES_PER_MEASUREMENT_VALUE
      }
    })
  })

  if (bytes === 0) {
    return null
  }
  return { bytes, isApproximate }
}
