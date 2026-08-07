// skipcq: JS-C1003 - dcmjs uses nested namespaces (dcmjs.sr.coding.CodedConcept)
import type * as dcmjs from 'dcmjs'
// skipcq: JS-C1003 - dmv uses nested namespaces (dmv.viewer)
import type * as dmv from 'dicom-microscopy-viewer'

import type DicomWebManager from '../../../../DicomWebManager'
import type { OlFeatureLike } from '../annotationData'
import { HeatmapController } from '../HeatmapController'
import {
  type BinningRequest,
  DEFAULT_HEATMAP_SETTINGS,
  type HeatmapSettings,
} from '../types'

/**
 * The real factory uses `import.meta.url`, which the CommonJS transform of the
 * test runner cannot parse, and a real worker would make the tests racy.
 */
jest.mock('../createBinningWorker', () => ({
  createBinningWorker: () => mockWorker,
}))

/**
 * The layer pulls in OpenLayers and a canvas, neither of which says anything
 * about the pipeline under test here.
 */
jest.mock('../HeatmapLayer', () => ({
  HeatmapLayer: class {
    /**
     * @returns A placeholder for the OpenLayers layer
     */
    getOlLayer(): object {
      return {}
    }

    /**
     * Accept render options.
     */
    setRenderOptions(): void {}

    /**
     * Accept a visibility change.
     */
    setVisible(): void {}

    /**
     * Accept a grid.
     */
    setGrid(): void {}

    /**
     * Accept disposal.
     */
    dispose(): void {}
  },
}))

/**
 * A stand-in for the binning worker that records the requests posted to it.
 */
class FakeWorker {
  readonly requests: BinningRequest[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  /**
   * Record a binning request instead of answering it.
   *
   * @param request - Binning request
   */
  postMessage(request: BinningRequest): void {
    this.requests.push(request)
  }

  /**
   * Accept termination.
   */
  terminate(): void {}
}

let mockWorker: FakeWorker

const AREA = {
  CodingSchemeDesignator: 'SCT',
  CodeValue: '42798000',
  CodeMeaning: 'Area',
} as unknown as dcmjs.sr.coding.CodedConcept

/**
 * Build a fake OpenLayers feature of an annotation group.
 *
 * @param annotationGroupUID - Group the feature belongs to
 * @param annotationIndex - DICOM annotation index of the feature
 *
 * @returns The fake feature
 */
function buildFeature(
  annotationGroupUID: string,
  annotationIndex: number,
): OlFeatureLike {
  return {
    getId: () => `${annotationGroupUID}-${annotationIndex}`,
    get: (key: string) =>
      key === 'annotationGroupUID' ? annotationGroupUID : undefined,
    getGeometry: () => ({
      getExtent: () => [annotationIndex, -1, annotationIndex, -1],
    }),
  }
}

/**
 * Build the metadata of an annotation instance holding one group with one
 * measurement, whose values are referenced as bulk data.
 *
 * @param annotationGroupUID - Unique identifier of the annotation group
 *
 * @returns The fake metadata
 */
function buildMetadata(annotationGroupUID: string): object {
  return {
    AnnotationGroupSequence: [
      {
        AnnotationGroupUID: annotationGroupUID,
        NumberOfAnnotations: 2,
        MeasurementsSequence: [
          {
            ConceptNameCodeSequence: [AREA],
            MeasurementUnitsCodeSequence: [
              { CodeValue: 'um2', CodeMeaning: 'um2' },
            ],
          },
        ],
      },
    ],
    bulkdataReferences: {
      AnnotationGroupSequence: [
        {
          MeasurementsSequence: [
            {
              MeasurementValuesSequence: [
                {
                  FloatingPointValues: {
                    BulkDataURI: `bulk://${annotationGroupUID}`,
                    vr: 'OF',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

/**
 * Build a viewer whose annotation features can be rearranged between
 * extractions, the way DMV rebuilds them when a group is reloaded.
 *
 * @returns The viewer and a way to set the features it exposes
 */
function buildViewer(): {
  viewer: dmv.viewer.VolumeImageViewer
  setFeatures: (features: OlFeatureLike[]) => void
} {
  let features: OlFeatureLike[] = []
  /** One map for the lifetime of the viewer, so that its calls can be counted. */
  const map = {
    getView: () => ({
      getProjection: () => ({ getExtent: () => [0, -2, 2, 0] }),
    }),
    getLayers: () => ({
      getArray: () => [{ getSource: () => ({ getFeatures: () => features }) }],
    }),
    addLayer: jest.fn(),
    removeLayer: jest.fn(),
  }
  const viewer = {
    getMap: () => map,
    getAffine: () => [
      [0.001, 0, 0],
      [0, 0.001, 0],
      [0, 0, 1],
    ],
    getAnnotationGroupMetadata: (annotationGroupUID: string) =>
      buildMetadata(annotationGroupUID),
  }
  return {
    viewer: viewer as unknown as dmv.viewer.VolumeImageViewer,
    setFeatures: (next) => {
      features = next
    },
  }
}

const SETTINGS: HeatmapSettings = {
  ...DEFAULT_HEATMAP_SETTINGS,
  isVisible: true,
  metric: 'mean',
  measurement: AREA,
  /** One bin over the whole fake slide keeps the grid trivial. */
  binSizeMicrometer: 1000,
}

/**
 * Run the debounced recompute and let its promise settle.
 */
async function flush(): Promise<void> {
  jest.advanceTimersByTime(200)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('HeatmapController', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockWorker = new FakeWorker()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('realigns cached measurement values onto freshly extracted positions', async () => {
    /*
     * Measurement values are fetched per group and positions are extracted per
     * group, but the two caches are bounded separately, so the positions can
     * be evicted while the values survive. If the values were cached in the
     * extraction order of the evicted positions, they would then be attributed
     * to the wrong annotations.
     */
    const { viewer, setFeatures } = buildViewer()
    const retrieveBulkData = jest.fn(async ({ BulkDataURI }: { BulkDataURI: string }) =>
      BulkDataURI === 'bulk://a'
        ? [Float32Array.from([10, 20]).buffer]
        : [Float32Array.from([1, 2]).buffer],
    )
    const controller = new HeatmapController({
      viewer,
      client: { retrieveBulkData } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(Array.from(mockWorker.requests[0].values ?? [])).toEqual([10, 20])

    /** Two further groups evict the positions of "a" but not its values. */
    for (const uid of ['b', 'c']) {
      setFeatures([buildFeature(uid, 0), buildFeature(uid, 1)])
      controller.update({ ...SETTINGS, annotationGroupUID: uid }, [])
      await flush()
    }

    /** DMV rebuilt the features of "a" in the opposite order. */
    setFeatures([buildFeature('a', 1), buildFeature('a', 0)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()

    const last = mockWorker.requests[mockWorker.requests.length - 1]
    expect(Array.from(last.values ?? [])).toEqual([20, 10])
    /** The values themselves came from the cache rather than the network. */
    expect(
      retrieveBulkData.mock.calls.filter(
        ([{ BulkDataURI }]) => BulkDataURI === 'bulk://a',
      ),
    ).toHaveLength(1)

    controller.dispose()
  })

  it('re-extracts a group that was still loading when it was first read', async () => {
    /*
     * DMV materializes a large group progressively, so an extraction can be a
     * snapshot of a group that is still growing. Caching it would freeze the
     * heatmap on the partial data for as long as the group stays visible.
     */
    const { viewer, setFeatures } = buildViewer()
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    /** One of the two annotations the metadata documents has arrived. */
    setFeatures([buildFeature('a', 0)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(mockWorker.requests[0].xy).toHaveLength(2)

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(mockWorker.requests[1].xy).toHaveLength(4)

    /** A complete extraction, in contrast, is answered from the cache. */
    setFeatures([])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(mockWorker.requests[2].xy).toHaveLength(4)

    controller.dispose()
  })

  it('bounds the filter slider without downloading the values again', async () => {
    const { viewer, setFeatures } = buildViewer()
    const retrieveBulkData = jest.fn(async () => [
      Float32Array.from([10, 20]).buffer,
    ])
    const controller = new HeatmapController({
      viewer,
      client: { retrieveBulkData } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()

    expect(await controller.getMeasurementRange('a', AREA)).toEqual([10, 20])
    expect(retrieveBulkData).toHaveBeenCalledTimes(1)

    controller.dispose()
  })

  it('drops the grid along with the overlay when the heatmap is hidden', async () => {
    const { viewer, setFeatures } = buildViewer()
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    mockWorker.onmessage?.({
      data: {
        requestId: mockWorker.requests[0].requestId,
        values: Float32Array.from([15]),
        counts: Uint32Array.from([2]),
        width: 1,
        height: 1,
        binSizeUnits: 1000,
        minValue: 15,
        maxValue: 15,
        includedCount: 2,
        durationMs: 1,
      },
    } as MessageEvent<unknown>)
    expect(controller.getStatus().grid).not.toBeNull()

    controller.update({ ...SETTINGS, annotationGroupUID: 'a', isVisible: false }, [])
    expect(controller.getStatus().grid).toBeNull()

    controller.dispose()
  })

  it('keeps an error on screen when the abandoned recompute answers', async () => {
    /*
     * The binner has no idea that the recompute it is working for has been
     * given up on, so its answer arrives after the error message and must not
     * paint the heatmap of the settings the user has moved away from over it.
     */
    const { viewer, setFeatures } = buildViewer()
    const statuses: Array<string | null> = []
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: (status) => statuses.push(status.error),
    })

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    const inFlight = mockWorker.requests[0].requestId

    /** No group selected, so the next recompute can only report a problem. */
    controller.update({ ...SETTINGS, annotationGroupUID: undefined }, [])
    await flush()
    expect(statuses[statuses.length - 1]).toBe('Select an annotation group.')

    mockWorker.onmessage?.({
      data: {
        requestId: inFlight,
        values: Float32Array.from([15]),
        counts: Uint32Array.from([2]),
        width: 1,
        height: 1,
        binSizeUnits: 1000,
        minValue: 15,
        maxValue: 15,
        includedCount: 2,
        durationMs: 1,
      },
    } as MessageEvent<unknown>)
    expect(controller.getStatus().error).toBe('Select an annotation group.')
    expect(controller.getStatus().grid).toBeNull()

    controller.dispose()
  })

  it('leaves the map alone while the heatmap is switched off', () => {
    const { viewer } = buildViewer()
    const map = viewer.getMap() as unknown as { addLayer: jest.Mock }
    const controller = new HeatmapController({
      viewer,
      client: {} as unknown as DicomWebManager,
      settings: DEFAULT_HEATMAP_SETTINGS,
      onStatusChange: () => {},
    })

    controller.update({ ...DEFAULT_HEATMAP_SETTINGS, opacity: 0.4 }, [])
    expect(map.addLayer).not.toHaveBeenCalled()

    controller.update({ ...DEFAULT_HEATMAP_SETTINGS, isVisible: true }, [])
    expect(map.addLayer).toHaveBeenCalledTimes(1)

    controller.dispose()
  })

  it('abandons a recompute that a newer one has overtaken', async () => {
    /*
     * Fetching measurements is an unbounded await, so a recompute can be
     * suspended in it while the user changes the settings. Letting it finish
     * would put the settings the user moved away from back on the screen.
     */
    const { viewer, setFeatures } = buildViewer()
    let releaseFetch = (): void => {}
    const retrieveBulkData = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseFetch = resolve
      })
      return [Float32Array.from([10, 20]).buffer]
    })
    const controller = new HeatmapController({
      viewer,
      client: { retrieveBulkData } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(mockWorker.requests).toHaveLength(0)

    /** The user switches to a metric that needs no measurement at all. */
    controller.update(
      { ...SETTINGS, annotationGroupUID: 'a', metric: 'density' },
      [],
    )
    await flush()
    expect(mockWorker.requests).toHaveLength(1)
    expect(mockWorker.requests[0].metric).toBe('density')

    releaseFetch()
    await flush()
    expect(mockWorker.requests).toHaveLength(1)

    controller.dispose()
  })
})
