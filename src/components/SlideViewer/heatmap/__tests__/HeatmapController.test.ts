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
 * Reason the main thread binner is to fail with, for the case of a worker that
 * died of the binning rather than of a failure to start. `null` runs the real
 * binner.
 */
let mockBinningFailure: string | null = null

jest.mock('../binning', () => {
  const actual = jest.requireActual('../binning')
  return {
    ...actual,
    /**
     * Bin as usual, unless the test asked for the binning to fail.
     *
     * @param request - Binning request
     *
     * @returns The binned grid
     */
    computeHeatmapGrid: (request: unknown) => {
      if (mockBinningFailure !== null) {
        throw new Error(mockBinningFailure)
      }
      return actual.computeHeatmapGrid(request)
    },
  }
})

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

/** Stand-in for the style function DMV puts on the layers of a group. */
const BASE_STYLE = (): string => 'dmv'

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
 * @param numberOfAnnotations - Value of `NumberOfAnnotations`, omitted from
 *   the metadata when `null`, as it is for a group that does not document it
 *
 * @returns The fake metadata
 */
function buildMetadata(
  annotationGroupUID: string,
  numberOfAnnotations: number | null,
): object {
  return {
    AnnotationGroupSequence: [
      {
        AnnotationGroupUID: annotationGroupUID,
        ...(numberOfAnnotations === null
          ? {}
          : { NumberOfAnnotations: numberOfAnnotations }),
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
 * @param numberOfAnnotations - Number of annotations the metadata of a group
 *   documents, `null` for a group that documents none
 *
 * @returns The viewer and a way to set the features it exposes
 */
function buildViewer(numberOfAnnotations: number | null = 2): {
  viewer: dmv.viewer.VolumeImageViewer
  setFeatures: (features: OlFeatureLike[]) => void
  getStyle: () => unknown
} {
  let features: OlFeatureLike[] = []
  /** The style DMV would have put on the layer of the annotation group. */
  let style: unknown = BASE_STYLE
  const layer = {
    getSource: () => ({ getFeatures: () => features }),
    getStyle: () => style,
    setStyle: (next: unknown) => {
      style = next
    },
  }
  /** One map for the lifetime of the viewer, so that its calls can be counted. */
  const map = {
    getView: () => ({
      getProjection: () => ({ getExtent: () => [0, -2, 2, 0] }),
    }),
    getLayers: () => ({
      getArray: () => [layer],
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
      buildMetadata(annotationGroupUID, numberOfAnnotations),
  }
  return {
    viewer: viewer as unknown as dmv.viewer.VolumeImageViewer,
    setFeatures: (next) => {
      features = next
    },
    getStyle: () => style,
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
    mockBinningFailure = null
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

  it('keeps the measurements of a group that is hidden and shown again', async () => {
    /*
     * Hiding a group makes DMV drop its features, so the positions have to go,
     * but the measurements are bulk data of the annotation instance: they
     * cannot have changed, and re-downloading megabytes of them on a
     * visibility toggle would be pure waste.
     */
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
    expect(retrieveBulkData).toHaveBeenCalledTimes(1)

    /** DMV tore the features down and rebuilt them in the opposite order. */
    controller.invalidateAnnotationGroup('a')
    setFeatures([buildFeature('a', 1), buildFeature('a', 0)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()

    const last = mockWorker.requests[mockWorker.requests.length - 1]
    expect(Array.from(last.values ?? [])).toEqual([20, 10])
    expect(retrieveBulkData).toHaveBeenCalledTimes(1)

    controller.dispose()
  })

  it('re-extracts a group that was still loading when it was first read', async () => {
    /*
     * DMV materializes a large group progressively, so an extraction can be a
     * snapshot of a group that is still growing. Caching it would freeze the
     * heatmap on the partial data for as long as the group stays visible.
     *
     * The group here documents no `NumberOfAnnotations`, which is optional, so
     * the growth of the source is the only thing that can reveal the snapshot
     * as partial.
     */
    const { viewer, setFeatures } = buildViewer(null)
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    /** The first of the annotations of the group has arrived. */
    setFeatures([buildFeature('a', 0)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(mockWorker.requests[0].xy).toHaveLength(2)

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(mockWorker.requests[1].xy).toHaveLength(4)

    /*
     * A source that has stopped growing is answered from the cache, and a
     * source that momentarily holds fewer features - the cluster source
     * swapping its contents around a zoom threshold - keeps the heatmap it
     * was binned from rather than flickering.
     */
    setFeatures([])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a', opacity: 0.4 }, [])
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

  it('shows the annotations again when the heatmap gives up', async () => {
    /*
     * The measurement filter is driven by settings that no longer produce a
     * heatmap, and the slider that could lift it goes away with them, so
     * leaving the annotations hidden would strand the user without a control
     * to get them back.
     */
    const { viewer, setFeatures, getStyle } = buildViewer()
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update(
      { ...SETTINGS, annotationGroupUID: 'a', filterRange: [0, 15] },
      [],
    )
    await flush()
    expect(getStyle()).not.toBe(BASE_STYLE)

    /** Clearing the group is one of the settings that can only fail. */
    controller.update({ ...SETTINGS, annotationGroupUID: undefined }, [])
    await flush()
    expect(controller.getStatus().error).toBe('Select an annotation group.')
    expect(getStyle()).toBe(BASE_STYLE)

    controller.dispose()
  })

  it('keeps the grid it has when nothing that is binned has changed', async () => {
    /*
     * The panel calls `update` for every control it owns, including the ones
     * that only recolor, and DMV calls it again whenever anything finishes
     * loading. Binning the same annotations again would copy megabytes to the
     * worker to arrive at the picture that is already on screen.
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

    controller.update(
      { ...SETTINGS, annotationGroupUID: 'a', opacity: 0.2 },
      [],
    )
    await flush()
    expect(mockWorker.requests).toHaveLength(1)
    expect(controller.getStatus().isComputing).toBe(false)
    expect(controller.getStatus().grid).not.toBeNull()

    /** A bin size, in contrast, is a different question about the same data. */
    controller.update(
      { ...SETTINGS, annotationGroupUID: 'a', binSizeMicrometer: 500 },
      [],
    )
    await flush()
    expect(mockWorker.requests).toHaveLength(2)

    controller.dispose()
  })

  it('downloads a measurement once when the slider and the heatmap both want it', async () => {
    /*
     * Selecting a measurement bounds the filter slider and bins the values at
     * the same moment. Caching only the resolved array would let the binning
     * miss a cache the slider has not filled yet and fetch the same few
     * megabytes a second time.
     */
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
    const range = controller.getMeasurementRange('a', AREA)
    await flush()

    expect(await range).toEqual([10, 20])
    expect(mockWorker.requests).toHaveLength(1)
    expect(retrieveBulkData).toHaveBeenCalledTimes(1)

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

  it('reports a failure of the binning the dead worker left behind', async () => {
    /*
     * The fallback for a worker that dies is to bin on the main thread, which
     * runs into the same defect when the worker died of the binning itself.
     * An exception escaping the error handler would leave the panel computing
     * for good.
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

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    expect(controller.getStatus().isComputing).toBe(true)

    mockBinningFailure = 'out of memory'
    expect(() => {
      mockWorker.onerror?.({ message: 'worker died' } as ErrorEvent)
    }).not.toThrow()

    expect(controller.getStatus().isComputing).toBe(false)
    expect(controller.getStatus().error).toBe(
      'Could not compute the heatmap: out of memory',
    )

    controller.dispose()
  })

  it('keeps the positions of another group while one is still loading', async () => {
    /*
     * Re-extracting a group that is still growing overwrites its own cache
     * entry rather than adding one, so making room for it would throw away
     * the positions of the other group the cache can hold for nothing.
     */
    const { viewer, setFeatures } = buildViewer(null)
    const extractedFeatures: Record<string, number> = { a: 0, b: 0 }
    /**
     * Build a feature that records having been read by an extraction.
     *
     * @param annotationGroupUID - Group the feature belongs to
     * @param annotationIndex - DICOM annotation index of the feature
     *
     * @returns The counting feature
     */
    const buildCountingFeature = (
      annotationGroupUID: string,
      annotationIndex: number,
    ): OlFeatureLike => ({
      ...buildFeature(annotationGroupUID, annotationIndex),
      getGeometry: () => {
        extractedFeatures[annotationGroupUID] += 1
        return {
          getExtent: () => [annotationIndex, -1, annotationIndex, -1],
        }
      },
    })
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    /** The first annotation of a group that is still loading. */
    setFeatures([buildCountingFeature('a', 0)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()

    setFeatures([buildCountingFeature('b', 0), buildCountingFeature('b', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'b' }, [])
    await flush()
    const extractedB = extractedFeatures.b

    /** More of the first group has arrived, so it has to be read again. */
    setFeatures([buildCountingFeature('a', 0), buildCountingFeature('a', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()

    setFeatures([buildCountingFeature('b', 0), buildCountingFeature('b', 1)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'b' }, [])
    await flush()
    expect(extractedFeatures.b).toBe(extractedB)

    controller.dispose()
  })

  it('keeps saying that a heatmap is incomplete while it still is', async () => {
    /*
     * A recompute that finds the grid on screen already correct publishes no
     * response, so anything it does not republish stays cleared - and a
     * partial heatmap that stops saying so as soon as a slider is touched
     * invites conclusions to be drawn from missing annotations.
     */
    const { viewer, setFeatures } = buildViewer(2)
    const controller = new HeatmapController({
      viewer,
      client: {
        retrieveBulkData: async () => [Float32Array.from([10, 20]).buffer],
      } as unknown as DicomWebManager,
      settings: SETTINGS,
      onStatusChange: () => {},
    })

    /** One of the two annotations the metadata documents has been loaded. */
    setFeatures([buildFeature('a', 0)])
    controller.update({ ...SETTINGS, annotationGroupUID: 'a' }, [])
    await flush()
    mockWorker.onmessage?.({
      data: {
        requestId: mockWorker.requests[0].requestId,
        values: Float32Array.from([10]),
        counts: Uint32Array.from([1]),
        width: 1,
        height: 1,
        binSizeUnits: 1000,
        minValue: 10,
        maxValue: 10,
        includedCount: 1,
        durationMs: 1,
      },
    } as MessageEvent<unknown>)
    expect(controller.getStatus().warning).toContain('may be incomplete')

    controller.update({ ...SETTINGS, annotationGroupUID: 'a', opacity: 0.2 }, [])
    await flush()
    expect(mockWorker.requests).toHaveLength(1)
    expect(controller.getStatus().warning).toContain('may be incomplete')

    controller.dispose()
  })

  it('does not ask the binner for a range it has no values for', async () => {
    /*
     * A range can only exclude an annotation whose value is known. Sending one
     * without values would make the request, the binner and the annotations on
     * the slide disagree about what the heatmap shows.
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

    setFeatures([buildFeature('a', 0), buildFeature('a', 1)])
    controller.update(
      {
        ...SETTINGS,
        annotationGroupUID: 'a',
        metric: 'density',
        measurement: undefined,
        filterRange: [0, 15],
      },
      [],
    )
    await flush()

    expect(mockWorker.requests).toHaveLength(1)
    expect(mockWorker.requests[0].values).toBeUndefined()
    expect(mockWorker.requests[0].filterRange).toBeUndefined()

    controller.dispose()
  })
})
