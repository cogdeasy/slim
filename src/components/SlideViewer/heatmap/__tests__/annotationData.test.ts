import {
  alignMeasurementValues,
  type AnnotationsMetadataLike,
  buildVisibilityMask,
  countAnnotationFeatures,
  decodeBulkDataValues,
  extractAnnotationPositions,
  findMeasurement,
  getExpectedAnnotationCount,
  getValueRange,
  listMeasurements,
  type OlFeatureLike,
  type OlVectorLayerLike,
  setAnnotationVisibilityFilter,
  type ViewerLike,
} from '../annotationData'
import type { AnnotationPositions } from '../types'

const GROUP_UID = '1.2.3.4'
const EXTENT = [0, -100, 100, 0]

/**
 * Build a fake OpenLayers feature.
 *
 * The heatmap duck-types every OpenLayers object it gets from DMV, because
 * DMV bundles its own copy of OpenLayers; these fakes exercise exactly that
 * contract.
 *
 * @param options - Options
 * @param options.id - Feature id
 * @param options.annotationGroupUID - Group the feature belongs to
 * @param options.center - Center of the geometry
 * @param options.members - Members, when the feature is a cluster
 *
 * @returns The fake feature
 */
function buildFeature({
  id,
  annotationGroupUID = GROUP_UID,
  center = [0, 0],
  members,
}: {
  id?: string | number
  annotationGroupUID?: string
  center?: [number, number]
  members?: OlFeatureLike[]
}): OlFeatureLike {
  return {
    getId: () => id,
    get: (key: string) => {
      if (key === 'annotationGroupUID') {
        return annotationGroupUID
      }
      if (key === 'features') {
        return members
      }
      return undefined
    },
    getGeometry: () => ({
      getExtent: () => [center[0], center[1], center[0], center[1]],
    }),
  }
}

/**
 * Build a fake viewer whose map holds the given layers.
 *
 * @param layers - Layers of the map
 *
 * @returns The fake viewer
 */
function buildViewer(layers: OlVectorLayerLike[]): ViewerLike {
  return {
    getMap: () => ({
      getView: () => ({
        getProjection: () => ({ getExtent: () => EXTENT }),
      }),
      getLayers: () => ({ getArray: () => layers }),
    }),
  }
}

/**
 * Build a fake vector layer over a fixed set of features.
 *
 * @param features - Features of the source of the layer
 *
 * @returns The fake layer
 */
function buildLayer(features: OlFeatureLike[]): OlVectorLayerLike {
  return { getSource: () => ({ getFeatures: () => features }) }
}

const METADATA: AnnotationsMetadataLike = {
  AnnotationGroupSequence: [
    {
      AnnotationGroupUID: GROUP_UID,
      NumberOfAnnotations: '3',
      MeasurementsSequence: [
        {
          ConceptNameCodeSequence: [
            {
              CodingSchemeDesignator: 'SCT',
              CodeValue: '42798000',
              CodeMeaning: 'Area',
            },
          ],
          MeasurementUnitsCodeSequence: [
            { CodeValue: 'um2', CodeMeaning: 'square micrometer' },
          ],
        },
        {
          ConceptNameCodeSequence: [
            {
              CodingSchemeDesignator: 'SCT',
              CodeValue: '131187009',
              CodeMeaning: 'Circularity',
            },
          ],
        },
      ],
    },
  ],
}

describe('listMeasurements', () => {
  it('describes every measurement of the group', () => {
    expect(listMeasurements(METADATA, GROUP_UID)).toEqual([
      {
        index: 0,
        name: METADATA.AnnotationGroupSequence[0].MeasurementsSequence?.[0]
          .ConceptNameCodeSequence[0],
        key: 'SCT-42798000',
        label: 'Area',
        unit: 'um2',
      },
      {
        index: 1,
        name: METADATA.AnnotationGroupSequence[0].MeasurementsSequence?.[1]
          .ConceptNameCodeSequence[0],
        key: 'SCT-131187009',
        label: 'Circularity',
        unit: undefined,
      },
    ])
  })

  it('returns nothing for an unknown group', () => {
    expect(listMeasurements(METADATA, 'other')).toEqual([])
  })
})

describe('findMeasurement', () => {
  it('matches on code value and scheme designator', () => {
    expect(
      findMeasurement({
        metadata: METADATA,
        annotationGroupUID: GROUP_UID,
        measurement: { CodeValue: '42798000', CodingSchemeDesignator: 'SCT' },
      })?.index,
    ).toBe(0)
  })

  it('does not match a code value from another scheme', () => {
    expect(
      findMeasurement({
        metadata: METADATA,
        annotationGroupUID: GROUP_UID,
        measurement: { CodeValue: '42798000', CodingSchemeDesignator: 'DCM' },
      }),
    ).toBeUndefined()
  })
})

describe('getExpectedAnnotationCount', () => {
  it('reads the documented number of annotations', () => {
    expect(getExpectedAnnotationCount(METADATA, GROUP_UID)).toBe(3)
  })

  it('returns null when the group is unknown', () => {
    expect(getExpectedAnnotationCount(METADATA, 'other')).toBeNull()
  })
})

describe('extractAnnotationPositions', () => {
  it('takes the center of each geometry and the index from the id', () => {
    const viewer = buildViewer([
      buildLayer([
        buildFeature({ id: `${GROUP_UID}-0`, center: [10, -10] }),
        buildFeature({ id: `${GROUP_UID}-1`, center: [20, -20] }),
      ]),
    ])
    const positions = extractAnnotationPositions({
      viewer,
      annotationGroupUID: GROUP_UID,
      expectedCount: 2,
    })
    expect(positions).not.toBeNull()
    expect(positions?.count).toBe(2)
    expect(Array.from(positions?.xy ?? [])).toEqual([10, -10, 20, -20])
    expect(Array.from(positions?.annotationIndices ?? [])).toEqual([0, 1])
    expect(positions?.invalidIndexCount).toBe(0)
    expect(positions?.extent).toEqual(EXTENT)
  })

  it('prefers the source holding the most features of the group', () => {
    const viewer = buildViewer([
      buildLayer([buildFeature({ id: `${GROUP_UID}-0`, center: [1, -1] })]),
      buildLayer([
        buildFeature({ id: `${GROUP_UID}-0`, center: [1, -1] }),
        buildFeature({ id: `${GROUP_UID}-1`, center: [2, -2] }),
        buildFeature({ id: `${GROUP_UID}-2`, center: [3, -3] }),
      ]),
    ])
    expect(
      extractAnnotationPositions({ viewer, annotationGroupUID: GROUP_UID })
        ?.count,
    ).toBe(3)
  })

  it('ignores sources belonging to another group', () => {
    const viewer = buildViewer([
      buildLayer([
        buildFeature({
          id: 'other-0',
          annotationGroupUID: 'other',
          center: [9, -9],
        }),
        buildFeature({
          id: 'other-1',
          annotationGroupUID: 'other',
          center: [8, -8],
        }),
      ]),
      buildLayer([buildFeature({ id: `${GROUP_UID}-0`, center: [1, -1] })]),
    ])
    const positions = extractAnnotationPositions({
      viewer,
      annotationGroupUID: GROUP_UID,
    })
    expect(positions?.count).toBe(1)
    expect(Array.from(positions?.xy ?? [])).toEqual([1, -1])
  })

  it('reports ids that do not carry a usable annotation index', () => {
    const viewer = buildViewer([
      buildLayer([
        buildFeature({ id: `${GROUP_UID}-0`, center: [1, -1] }),
        buildFeature({ id: 'cluster-42', center: [2, -2] }),
        buildFeature({ id: undefined, center: [3, -3] }),
      ]),
    ])
    const positions = extractAnnotationPositions({
      viewer,
      annotationGroupUID: GROUP_UID,
    })
    expect(positions?.count).toBe(3)
    expect(positions?.invalidIndexCount).toBe(2)
    expect(Array.from(positions?.annotationIndices ?? [])).toEqual([0, -1, -1])
  })

  it('reports incompleteness through the expected count', () => {
    const viewer = buildViewer([
      buildLayer([buildFeature({ id: `${GROUP_UID}-0`, center: [1, -1] })]),
    ])
    const positions = extractAnnotationPositions({
      viewer,
      annotationGroupUID: GROUP_UID,
      expectedCount: 898090,
    })
    expect(positions?.count).toBe(1)
    expect(positions?.expectedCount).toBe(898090)
  })

  it('returns null when the group has not been materialized', () => {
    expect(
      extractAnnotationPositions({
        viewer: buildViewer([buildLayer([])]),
        annotationGroupUID: GROUP_UID,
      }),
    ).toBeNull()
  })
})

describe('countAnnotationFeatures', () => {
  it('counts the features of the fullest source of the group', () => {
    const viewer = buildViewer([
      buildLayer([buildFeature({ id: `${GROUP_UID}-0` })]),
      buildLayer([
        buildFeature({ id: `${GROUP_UID}-0` }),
        buildFeature({ id: `${GROUP_UID}-1` }),
      ]),
      buildLayer([
        buildFeature({ id: 'other-0', annotationGroupUID: 'other' }),
        buildFeature({ id: 'other-1', annotationGroupUID: 'other' }),
        buildFeature({ id: 'other-2', annotationGroupUID: 'other' }),
      ]),
    ])
    expect(countAnnotationFeatures(viewer, GROUP_UID)).toBe(2)
  })

  it('counts nothing for a group that has not been materialized', () => {
    expect(countAnnotationFeatures(buildViewer([buildLayer([])]), GROUP_UID)).toBe(
      0,
    )
  })
})

describe('alignMeasurementValues', () => {
  /**
   * Build positions with the given annotation indices.
   *
   * @param annotationIndices - DICOM annotation index of each position
   *
   * @returns The positions
   */
  const buildPositions = (annotationIndices: number[]): AnnotationPositions => ({
    xy: new Float32Array(annotationIndices.length * 2),
    annotationIndices: Int32Array.from(annotationIndices),
    count: annotationIndices.length,
    sourceCount: annotationIndices.length,
    invalidIndexCount: annotationIndices.filter((index) => index < 0).length,
    expectedCount: null,
    extent: [0, -100, 100, 0],
  })

  it('gathers values by annotation index rather than by position order', () => {
    const aligned = alignMeasurementValues({
      positions: buildPositions([2, 0, 1]),
      values: Float32Array.from([10, 20, 30]),
    })
    expect(Array.from(aligned)).toEqual([30, 10, 20])
  })

  it('yields NaN for unknown and out-of-range indices', () => {
    const aligned = alignMeasurementValues({
      positions: buildPositions([-1, 5, 0]),
      values: Float32Array.from([10, 20]),
    })
    expect(aligned[0]).toBeNaN()
    expect(aligned[1]).toBeNaN()
    expect(aligned[2]).toBe(10)
  })
})

describe('buildVisibilityMask', () => {
  const positions: AnnotationPositions = {
    xy: new Float32Array(6),
    annotationIndices: Int32Array.from([0, 1, 2]),
    count: 3,
    sourceCount: 3,
    invalidIndexCount: 0,
    expectedCount: 3,
    extent: [0, -100, 100, 0],
  }

  it('keeps the annotations inside the range, inclusively', () => {
    const mask = buildVisibilityMask({
      positions,
      values: Float32Array.from([5, 10, 15]),
      range: [10, 15],
    })
    expect(Array.from(mask)).toEqual([0, 1, 1])
  })

  it('is indexed by annotation index, not by extraction order', () => {
    const mask = buildVisibilityMask({
      positions: { ...positions, annotationIndices: Int32Array.from([4, 0, 2]) },
      values: Float32Array.from([100, 1, 100]),
      range: [50, 200],
    })
    expect(Array.from(mask)).toEqual([0, 0, 1, 0, 1])
  })
})

describe('setAnnotationVisibilityFilter', () => {
  /**
   * Build a layer whose style can be inspected and replaced.
   *
   * @param features - Features of the source
   *
   * @returns The layer and a way to evaluate its current style
   */
  function buildStyledLayer(features: OlFeatureLike[]): {
    layer: OlVectorLayerLike
    styleOf: (feature: OlFeatureLike) => unknown
  } {
    const baseStyle = 'base-style'
    let style: unknown = baseStyle
    const layer: OlVectorLayerLike = {
      getSource: () => ({ getFeatures: () => features }),
      getStyle: () => style,
      setStyle: (next: unknown) => {
        style = next
      },
    }
    return {
      layer,
      styleOf: (feature) =>
        typeof style === 'function'
          ? (style as (f: OlFeatureLike, r: number) => unknown)(feature, 1)
          : style,
    }
  }

  it('hides the features that the mask excludes', () => {
    const kept = buildFeature({ id: `${GROUP_UID}-0` })
    const hidden = buildFeature({ id: `${GROUP_UID}-1` })
    const { layer, styleOf } = buildStyledLayer([kept, hidden])
    setAnnotationVisibilityFilter({
      viewer: buildViewer([layer]),
      annotationGroupUID: GROUP_UID,
      allowed: Uint8Array.from([1, 0]),
    })
    expect(styleOf(kept)).toBe('base-style')
    expect(styleOf(hidden)).toBeUndefined()
  })

  it('keeps a cluster whenever one of its members is allowed', () => {
    const anchor = buildFeature({ id: `${GROUP_UID}-0` })
    const cluster = buildFeature({
      id: undefined,
      members: [
        buildFeature({ id: `${GROUP_UID}-1` }),
        buildFeature({ id: `${GROUP_UID}-0` }),
      ],
    })
    const emptyCluster = buildFeature({
      id: undefined,
      members: [buildFeature({ id: `${GROUP_UID}-1` })],
    })
    const { layer, styleOf } = buildStyledLayer([
      anchor,
      cluster,
      emptyCluster,
    ])
    setAnnotationVisibilityFilter({
      viewer: buildViewer([layer]),
      annotationGroupUID: GROUP_UID,
      allowed: Uint8Array.from([1, 0]),
    })
    expect(styleOf(cluster)).toBe('base-style')
    expect(styleOf(emptyCluster)).toBeUndefined()
  })

  it('leaves features of other groups untouched', () => {
    const own = buildFeature({ id: `${GROUP_UID}-1` })
    const foreign = buildFeature({ id: 'other-1', annotationGroupUID: 'other' })
    const { layer, styleOf } = buildStyledLayer([own, foreign])
    setAnnotationVisibilityFilter({
      viewer: buildViewer([layer]),
      annotationGroupUID: GROUP_UID,
      allowed: Uint8Array.from([1, 0]),
    })
    expect(styleOf(foreign)).toBe('base-style')
  })

  it('restores the original style when the filter is cleared', () => {
    const hidden = buildFeature({ id: `${GROUP_UID}-1` })
    const { layer, styleOf } = buildStyledLayer([hidden])
    const viewer = buildViewer([layer])
    setAnnotationVisibilityFilter({
      viewer,
      annotationGroupUID: GROUP_UID,
      allowed: Uint8Array.from([1, 0]),
    })
    expect(styleOf(hidden)).toBeUndefined()
    setAnnotationVisibilityFilter({
      viewer,
      annotationGroupUID: GROUP_UID,
      allowed: null,
    })
    expect(styleOf(hidden)).toBe('base-style')
  })

  it('adopts a style that was set while the filter was applied', () => {
    /*
     * DMV rebuilds the style of a group whenever its color or opacity is
     * changed. Keeping the style remembered from before the change would make
     * such a change invisible for as long as the filter is on.
     */
    const feature = buildFeature({ id: `${GROUP_UID}-0` })
    const { layer, styleOf } = buildStyledLayer([feature])
    const viewer = buildViewer([layer])
    const allowed = Uint8Array.from([1, 0])
    setAnnotationVisibilityFilter({ viewer, annotationGroupUID: GROUP_UID, allowed })
    layer.setStyle?.('recolored-style')
    setAnnotationVisibilityFilter({ viewer, annotationGroupUID: GROUP_UID, allowed })
    expect(styleOf(feature)).toBe('recolored-style')

    setAnnotationVisibilityFilter({
      viewer,
      annotationGroupUID: GROUP_UID,
      allowed: null,
    })
    expect(styleOf(feature)).toBe('recolored-style')
  })

  it('does not stack wrappers when applied repeatedly', () => {
    const feature = buildFeature({ id: `${GROUP_UID}-1` })
    const { layer, styleOf } = buildStyledLayer([feature])
    const viewer = buildViewer([layer])
    for (const allowed of [
      Uint8Array.from([1, 0]),
      Uint8Array.from([1, 1]),
      Uint8Array.from([1, 1]),
    ]) {
      setAnnotationVisibilityFilter({
        viewer,
        annotationGroupUID: GROUP_UID,
        allowed,
      })
    }
    expect(styleOf(feature)).toBe('base-style')
  })
})

describe('decodeBulkDataValues', () => {
  it('reads 32-bit floats by default', () => {
    const source = Float32Array.from([1.5, -2.5])
    expect(
      Array.from(decodeBulkDataValues({ data: source.buffer })),
    ).toEqual([1.5, -2.5])
  })

  it('narrows 64-bit floats', () => {
    const source = Float64Array.from([1.5, -2.5])
    expect(
      Array.from(decodeBulkDataValues({ data: source.buffer, vr: 'OD' })),
    ).toEqual([1.5, -2.5])
  })

  it('converts integer representations', () => {
    expect(
      Array.from(
        decodeBulkDataValues({ data: Int32Array.from([7, -7]).buffer, vr: 'OL' }),
      ),
    ).toEqual([7, -7])
    expect(
      Array.from(
        decodeBulkDataValues({ data: Uint16Array.from([7, 9]).buffer, vr: 'OW' }),
      ),
    ).toEqual([7, 9])
    expect(
      Array.from(
        decodeBulkDataValues({ data: Uint8Array.from([7, 9]).buffer, vr: 'OB' }),
      ),
    ).toEqual([7, 9])
  })

  it('reads 64-bit integers as integers rather than as doubles', () => {
    expect(
      Array.from(
        decodeBulkDataValues({
          data: BigUint64Array.from([BigInt(7), BigInt(9)]).buffer,
          vr: 'OV',
        }),
      ),
    ).toEqual([7, 9])
  })

  it('refuses a value representation it cannot interpret', () => {
    expect(() =>
      decodeBulkDataValues({ data: new ArrayBuffer(4), vr: 'SQ' }),
    ).toThrow(/SQ/)
  })
})

describe('getValueRange', () => {
  it('ignores values that are not finite', () => {
    expect(
      getValueRange(Float32Array.from([Number.NaN, 3, 1, Number.NaN])),
    ).toEqual([1, 3])
  })

  it('returns null when nothing is finite', () => {
    expect(getValueRange(Float32Array.from([Number.NaN]))).toBeNull()
    expect(getValueRange(new Float32Array(0))).toBeNull()
  })
})
