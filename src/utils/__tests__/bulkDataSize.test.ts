// skipcq: JS-C1003
import type * as dmv from 'dicom-microscopy-viewer'
import {
  DEFAULT_MAX_BULK_DATA_SIZE,
  estimateAnnotationGroupBulkDataSize,
  formatBulkDataSize,
  getMaxBulkDataSize,
} from '../bulkDataSize'

const createMetadata = ({
  graphicType,
  numberOfAnnotations,
  coordinateType = '2D',
  isDouble = false,
  hasIndexList = true,
  hasBulkdataReferences = true,
}: {
  graphicType: string
  numberOfAnnotations: number
  coordinateType?: string
  isDouble?: boolean
  hasIndexList?: boolean
  hasBulkdataReferences?: boolean
}): dmv.metadata.MicroscopyBulkSimpleAnnotations => {
  const reference = { vr: 'OF', BulkDataURI: 'https://example.com/bulkdata' }
  const references: Record<string, unknown> = {}
  if (isDouble) {
    references.DoublePointCoordinatesData = { ...reference, vr: 'OD' }
  } else {
    references.PointCoordinatesData = reference
  }
  if (hasIndexList) {
    references.LongPrimitivePointIndexList = { ...reference, vr: 'OL' }
  }
  return {
    AnnotationCoordinateType: coordinateType,
    AnnotationGroupSequence: [
      {
        AnnotationGroupUID: '1.2.3',
        GraphicType: graphicType,
        NumberOfAnnotations: numberOfAnnotations,
      },
    ],
    bulkdataReferences: hasBulkdataReferences
      ? { AnnotationGroupSequence: [references] }
      : {},
  } as unknown as dmv.metadata.MicroscopyBulkSimpleAnnotations
}

describe('estimateAnnotationGroupBulkDataSize', () => {
  it('computes an exact size for graphic types with a known point count', () => {
    const metadata = createMetadata({
      graphicType: 'POINT',
      numberOfAnnotations: 1000,
      hasIndexList: false,
    })
    expect(estimateAnnotationGroupBulkDataSize(metadata, '1.2.3')).toEqual({
      bytes: 1000 * 1 * 2 * 4,
      isApproximate: false,
    })
  })

  it('accounts for 3D coordinates and double precision values', () => {
    const metadata = createMetadata({
      graphicType: 'RECTANGLE',
      numberOfAnnotations: 10,
      coordinateType: '3D',
      isDouble: true,
      hasIndexList: false,
    })
    expect(estimateAnnotationGroupBulkDataSize(metadata, '1.2.3')).toEqual({
      bytes: 10 * 4 * 3 * 8,
      isApproximate: false,
    })
  })

  it('approximates the size of polygons and includes the point index list', () => {
    const metadata = createMetadata({
      graphicType: 'POLYGON',
      numberOfAnnotations: 100,
    })
    const estimate = estimateAnnotationGroupBulkDataSize(metadata, '1.2.3')
    expect(estimate?.isApproximate).toBe(true)
    expect(estimate?.bytes).toBe(100 * 35 * 2 * 4 + 100 * 4)
  })

  it('returns null when there is no bulk data to retrieve', () => {
    const metadata = createMetadata({
      graphicType: 'POINT',
      numberOfAnnotations: 100,
      hasBulkdataReferences: false,
    })
    expect(estimateAnnotationGroupBulkDataSize(metadata, '1.2.3')).toBeNull()
  })

  it('returns null for an unknown annotation group', () => {
    const metadata = createMetadata({
      graphicType: 'POINT',
      numberOfAnnotations: 100,
    })
    expect(estimateAnnotationGroupBulkDataSize(metadata, '4.5.6')).toBeNull()
  })
})

describe('formatBulkDataSize', () => {
  it('marks approximate estimates', () => {
    expect(formatBulkDataSize({ bytes: 1024, isApproximate: false })).toBe(
      '1.00 KB',
    )
    expect(formatBulkDataSize({ bytes: 1024, isApproximate: true })).toBe(
      '~1.00 KB',
    )
  })
})

describe('getMaxBulkDataSize', () => {
  afterEach(() => {
    Object.defineProperty(window, 'config', {
      value: undefined,
      writable: true,
    })
  })

  it('falls back to the default limit', () => {
    expect(getMaxBulkDataSize()).toBe(DEFAULT_MAX_BULK_DATA_SIZE)
  })

  it('uses the configured limit', () => {
    Object.defineProperty(window, 'config', {
      value: { maxBulkDataSize: 1024 },
      writable: true,
    })
    expect(getMaxBulkDataSize()).toBe(1024)
  })
})
