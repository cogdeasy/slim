// skipcq: JS-C1003
import * as dcmjs from 'dcmjs'

export type DicomWebManagerErrorHandler = (
  error: dwc.api.DICOMwebClientError,
  serverSettings: ServerSettings,
) => void

export interface DICOMwebClientRequestHookMetadata {
  url: string
  method: string
}

/**
 * Retry behaviour of DICOMweb requests. Any option that is not specified falls
 * back to the default (see `defaultRetrySettings`).
 */
export interface RetryRequestSettings {
  /** Number of retries after the initial attempt (0 disables retrying). */
  retries?: number
  /** Exponential backoff factor. */
  factor?: number
  /** Minimum number of milliseconds to wait before the next retry. */
  minTimeout?: number
  /** Maximum number of milliseconds to wait before the next retry. */
  maxTimeout?: number
  /** Whether the wait time should be randomized. */
  randomize?: boolean
  /**
   * HTTP status codes that trigger a retry. A status of 0 means that the
   * server could not be reached.
   */
  retryableStatusCodes?: number[]
}

export interface EvaluationSetting {
  name: dcmjs.sr.coding.CodeOptions
  values: dcmjs.sr.coding.CodeOptions[]
}

export interface MeasurementSetting {
  name: dcmjs.sr.coding.CodeOptions
  unit: dcmjs.sr.coding.CodeOptions
}

export interface AnnotationSettings {
  finding: dcmjs.sr.coding.CodeOptions
  findingCategory?: dcmjs.sr.coding.CodeOptions
  evaluations?: EvaluationSetting[]
  measurements?: MeasurementSetting[]
  geometryTypes?: string[]
  style?: {
    stroke: {
      color: number[]
      width: number
    }
    fill: {
      color: number[]
    }
    radius?: number
  }
}

export interface ErrorMessageSettings {
  status: number
  message: string
}

export interface ServerSettings {
  id: string
  url?: string
  path?: string
  write: boolean
  read?: boolean
  qidoPathPrefix?: string
  wadoPathPrefix?: string
  stowPathPrefix?: string
  retry?: RetryRequestSettings
  errorMessages?: ErrorMessageSettings[]
  storageClasses?: string[]
  upgradeInsecureRequests?: boolean
}

export interface OidcSettings {
  authority: string
  clientId: string
  scope: string
  grantType?: string
  authorizationEndpoint?: string
  endSessionEndpoint?: string
}

export default interface AppConfig {
  /**
   * Currently, only one server is supported. However, support for multiple
   * servers is planned and the "server" parameter therefore expects an array.
   * Authentication and authorization for any of the servers is expected to go
   * through the same identity provider and authorization server using the OIDC
   * and OAuth 2.0 protocols (see "oidc" parameter).
   */
  servers: ServerSettings[]
  path: string
  annotations: AnnotationSettings[]
  organization?: string
  gcpBaseUrl?: string
  oidc?: OidcSettings
  disableWorklist?: boolean
  disableAnnotationTools?: boolean
  enableServerSelection?: boolean
  mode?: string
  preload?: boolean
  messages?: {
    disabled?: boolean | string[]
    top?: number
    duration?: number
  }
  logger?: {
    level?: 'DEBUG' | 'LOG' | 'WARN' | 'ERROR' | 'NONE'
    enableInProduction?: boolean
    enableInDevelopment?: boolean
  }
  enableMemoryMonitoring?: boolean
}
