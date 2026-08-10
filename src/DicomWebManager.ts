// skipcq: JS-C1003

// skipcq: JS-C1003
import * as dcmjs from 'dcmjs'
// skipcq: JS-C1003
import * as dmv from 'dicom-microscopy-viewer'
import * as dwc from 'dicomweb-client'

import type {
  DicomWebManagerErrorHandler,
  RetryRequestSettings,
  ServerSettings,
} from './AppConfig'
import DicomMetadataStore, {
  type Instance,
} from './services/DICOMMetadataStore'
import NotificationMiddleware, {
  NotificationMiddlewareContext,
} from './services/NotificationMiddleware'
import { CustomError, errorTypes } from './utils/CustomError'
import { resolveRetrySettings, retryRequest } from './utils/retryRequest'
import { joinUrl } from './utils/url'
import {
  PARTIAL_IMAGE_FAILURE,
  type UserFacingError,
} from './utils/userFacingErrors'

const { naturalizeDataset } = dcmjs.data.DicomMetaDictionary

interface Store {
  id: string
  read: boolean
  write: boolean
  client: dwc.api.DICOMwebClient
  retrySettings: Required<RetryRequestSettings>
}

export default class DicomWebManager implements dwc.api.DICOMwebClient {
  private readonly stores: Store[] = []

  private readonly handleError: DicomWebManagerErrorHandler

  constructor({
    baseUri,
    settings,
    onError,
  }: {
    baseUri: string
    settings: ServerSettings[]
    onError?: DicomWebManagerErrorHandler
  }) {
    if (onError != null) {
      this.handleError = onError
    } else {
      this.handleError = (error, serverSettings) => {
        // Only log errors in development environment
        if (process.env.NODE_ENV === 'development') {
          console.error(error, serverSettings)
        }
      }
    }

    settings.forEach((serverSettings) => {
      if (serverSettings === undefined) {
        NotificationMiddleware.onError(
          NotificationMiddlewareContext.SLIM,
          new CustomError(
            errorTypes.COMMUNICATION,
            'At least one server needs to be configured.',
          ),
        )
      }

      let serviceUrl: string
      if (serverSettings.url !== undefined) {
        serviceUrl = serverSettings.url
      } else if (serverSettings.path !== undefined) {
        serviceUrl = joinUrl(serverSettings.path, baseUri)
      } else {
        NotificationMiddleware.onError(
          NotificationMiddlewareContext.SLIM,
          new CustomError(
            errorTypes.COMMUNICATION,
            'Either path or full URL needs to be configured for server.',
          ),
        )
        throw new CustomError(
          errorTypes.COMMUNICATION,
          'Either path or full URL needs to be configured for server.',
        )
      }

      const hasHttpsUrl = (url?: string): boolean =>
        url?.startsWith('https') ?? false

      const clientSettings: dwc.api.DICOMwebClientOptions = {
        url: serviceUrl,
      }

      const shouldUpgradeInsecure =
        serverSettings.upgradeInsecureRequests === true &&
        [
          serviceUrl,
          serverSettings.qidoPathPrefix,
          serverSettings.wadoPathPrefix,
          serverSettings.stowPathPrefix,
        ].some(hasHttpsUrl)

      if (serverSettings.qidoPathPrefix !== undefined) {
        clientSettings.qidoURLPrefix = serverSettings.qidoPathPrefix
      }
      if (serverSettings.wadoPathPrefix !== undefined) {
        clientSettings.wadoURLPrefix = serverSettings.wadoPathPrefix
      }
      if (serverSettings.stowPathPrefix !== undefined) {
        clientSettings.stowURLPrefix = serverSettings.stowPathPrefix
      }

      if (shouldUpgradeInsecure) {
        clientSettings.headers = {
          ...clientSettings.headers,
          'Content-Security-Policy': 'upgrade-insecure-requests',
        }
      }

      clientSettings.errorInterceptor = (
        error: dwc.api.DICOMwebClientError,
      ) => {
        this.handleError(error, serverSettings)
      }

      this.stores.push({
        id: serverSettings.id,
        write: serverSettings.write ?? false,
        read: serverSettings.read ?? true,
        client: new dwc.api.DICOMwebClient(clientSettings),
        retrySettings: resolveRetrySettings(serverSettings.retry),
      })
    })

    if (this.stores.length > 1) {
      NotificationMiddleware.onError(
        NotificationMiddlewareContext.SLIM,
        new CustomError(
          errorTypes.COMMUNICATION,
          'Only one store is supported for now.',
        ),
      )
    }
  }

  /**
   * Performs a request against the store, retries it for failures that may be
   * transient and reports the failure to the user if it persists.
   *
   * @param description - description of the request, used for logging
   * @param request - function performing the request
   * @param options.userFacingError - description to present to the user
   * instead of the one derived from the error, used where a failure only
   * degrades the display
   * @param options.retry - whether the request may be repeated
   * @returns result of the request
   */
  private readonly request = async <T>(
    description: string,
    request: () => Promise<T>,
    options: { userFacingError?: UserFacingError; retry?: boolean } = {},
  ): Promise<T> => {
    const { userFacingError, retry = true } = options
    try {
      return await retryRequest({
        description,
        settings: retry
          ? this.stores[0].retrySettings
          : { ...this.stores[0].retrySettings, retries: 0 },
        request,
      })
    } catch (error) {
      NotificationMiddleware.onError(
        NotificationMiddlewareContext.DICOMWEB,
        error as Error,
        userFacingError,
      )
      throw error
    }
  }

  get baseURL(): string {
    return this.stores[0].client.baseURL
  }

  updateHeaders = (fields: { [name: string]: string }): void => {
    for (const f in fields) {
      this.stores[0].client.headers[f] = fields[f]
    }
  }

  get headers(): { [name: string]: string } {
    return this.stores[0].client.headers
  }

  storeInstances = async (
    options: dwc.api.StoreInstancesOptions,
  ): Promise<void> => {
    if (this.stores[0].write) {
      return await this.request(
        'storage of instances',
        async () => await this.stores[0].client.storeInstances(options),
        { retry: false },
      )
    } else {
      return await Promise.reject(new Error('Store is not writable.'))
    }
  }

  searchForStudies = async (
    options: dwc.api.SearchForStudiesOptions,
  ): Promise<dwc.api.Study[]> => {
    return await this.request(
      'search for studies',
      async () => await this.stores[0].client.searchForStudies(options),
    )
  }

  searchForSeries = async (
    options: dwc.api.SearchForSeriesOptions,
  ): Promise<dwc.api.Series[]> => {
    return await this.request(
      'search for series',
      async () => await this.stores[0].client.searchForSeries(options),
    )
  }

  searchForInstances = async (
    options: dwc.api.SearchForInstancesOptions,
  ): Promise<dwc.api.Instance[]> => {
    return await this.request(
      'search for instances',
      async () => await this.stores[0].client.searchForInstances(options),
    )
  }

  retrieveStudyMetadata = async (
    options: dwc.api.RetrieveStudyMetadataOptions,
  ): Promise<dwc.api.Metadata[]> => {
    const studySummaryMetadata = await this.request(
      `retrieval of metadata of study "${options.studyInstanceUID}"`,
      async () => await this.stores[0].client.retrieveStudyMetadata(options),
    )
    const naturalized = naturalizeDataset(studySummaryMetadata)
    DicomMetadataStore.addStudy(naturalized as Record<string, unknown>)
    return studySummaryMetadata
  }

  retrieveSeriesMetadata = async (
    options: dwc.api.RetrieveSeriesMetadataOptions,
  ): Promise<dwc.api.Metadata[]> => {
    const seriesSummaryMetadata = await this.request(
      `retrieval of metadata of series "${options.seriesInstanceUID}"`,
      async () => await this.stores[0].client.retrieveSeriesMetadata(options),
    )
    const naturalized = seriesSummaryMetadata.map(naturalizeDataset)
    DicomMetadataStore.addSeriesMetadata(
      naturalized as Array<Record<string, unknown>>,
      true,
    )
    return seriesSummaryMetadata
  }

  retrieveInstanceMetadata = async (
    options: dwc.api.RetrieveInstanceMetadataOptions,
  ): Promise<dwc.api.Metadata[]> => {
    return await this.request(
      `retrieval of metadata of instance "${options.sopInstanceUID}"`,
      async () => await this.stores[0].client.retrieveInstanceMetadata(options),
    )
  }

  retrieveInstance = async (
    options: dwc.api.RetrieveInstanceOptions,
  ): Promise<dwc.api.Dataset> => {
    const instance = await this.request(
      `retrieval of instance "${options.sopInstanceUID}"`,
      async () => await this.stores[0].client.retrieveInstance(options),
    )
    const data = dcmjs.data.DicomMessage.readFile(instance)
    const { dataset } = dmv.metadata.formatMetadata(data.dict)
    DicomMetadataStore.addInstances([dataset as Instance])
    return instance
  }

  retrieveInstanceFrames = async (
    options: dwc.api.RetrieveInstanceFramesOptions,
  ): Promise<dwc.api.Pixeldata[]> => {
    return await this.request(
      `retrieval of frames of instance "${options.sopInstanceUID}"`,
      async () => await this.stores[0].client.retrieveInstanceFrames(options),
      { userFacingError: PARTIAL_IMAGE_FAILURE },
    )
  }

  retrieveInstanceRendered = async (
    options: dwc.api.RetrieveInstanceRenderedOptions,
  ): Promise<dwc.api.Pixeldata> => {
    return await this.request(
      `retrieval of rendered instance "${options.sopInstanceUID}"`,
      async () => await this.stores[0].client.retrieveInstanceRendered(options),
      { userFacingError: PARTIAL_IMAGE_FAILURE },
    )
  }

  retrieveInstanceFramesRendered = async (
    options: dwc.api.RetrieveInstanceFramesRenderedOptions,
  ): Promise<dwc.api.Pixeldata> => {
    return await this.request(
      `retrieval of rendered frames of instance "${options.sopInstanceUID}"`,
      async () =>
        await this.stores[0].client.retrieveInstanceFramesRendered(options),
      { userFacingError: PARTIAL_IMAGE_FAILURE },
    )
  }

  retrieveBulkData = async (
    options: dwc.api.RetrieveBulkDataOptions,
  ): Promise<dwc.api.Bulkdata[]> => {
    /**
     * Bulkdata is retrieved for optional parts of a slide such as ICC
     * profiles. Failures are reported by the components that requested them,
     * which know what the missing data means for the user.
     */
    return await retryRequest({
      description: 'retrieval of bulkdata',
      settings: this.stores[0].retrySettings,
      request: async () =>
        await this.stores[0].client.retrieveBulkData(options),
    })
  }
}
