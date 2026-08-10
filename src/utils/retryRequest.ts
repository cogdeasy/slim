import retry from 'retry'

import type { RetryRequestSettings } from '../AppConfig'

/**
 * Default retry behaviour of DICOMweb requests. Besides the usual transient
 * failures, requests are retried for 404, because archives may answer with 404
 * while data is still being ingested or while the request is routed to a
 * replica that does not have the data yet
 * (see https://github.com/ImagingDataCommons/slim/issues/106).
 * A status of 0 indicates that the request never reached the server.
 */
export const defaultRetrySettings: Required<RetryRequestSettings> = {
  retries: 3,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 8000,
  randomize: true,
  retryableStatusCodes: [0, 404, 408, 429, 500, 502, 503, 504],
}

/**
 * Combines configured retry settings with the defaults.
 */
export const resolveRetrySettings = (
  settings?: RetryRequestSettings,
): Required<RetryRequestSettings> => ({
  ...defaultRetrySettings,
  ...Object.fromEntries(
    Object.entries(settings ?? {}).filter(([, value]) => value != null),
  ),
})

const getStatus = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status?: unknown }
    if (typeof status === 'number') {
      return status
    }
  }
  return undefined
}

/**
 * Performs a request and retries it while it fails with a status code that is
 * configured as retryable.
 *
 * @param options.description - description of the request, used for logging
 * @param options.settings - configured retry settings
 * @param options.request - function performing the request
 * @returns result of the request
 */
export const retryRequest = async <T>({
  description,
  settings,
  request,
}: {
  description: string
  settings: Required<RetryRequestSettings>
  request: () => Promise<T>
}): Promise<T> => {
  if (settings.retries < 1) {
    return await request()
  }

  const operation = retry.operation(settings)

  return await new Promise<T>((resolve, reject) => {
    operation.attempt((attempt: number) => {
      request().then(resolve, (error: unknown) => {
        const status = getStatus(error)
        const isRetryable =
          status !== undefined && settings.retryableStatusCodes.includes(status)
        if (
          isRetryable &&
          operation.retry(
            error instanceof Error ? error : new Error(description),
          )
        ) {
          console.warn(
            `${description} failed with status ${status}, ` +
              `retrying (attempt ${attempt + 1} of ${settings.retries + 1})`,
          )
          return
        }
        reject(error)
      })
    })
  })
}

export default retryRequest
