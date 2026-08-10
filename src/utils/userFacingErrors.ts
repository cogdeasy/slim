/**
 * Translation of technical errors into plain language for end users.
 *
 * Errors reach the user through the notification middleware (toast and header
 * badge) and through in-viewport error states. In all cases the user needs to
 * know three things: what failed, whether what is displayed can be trusted and
 * what they can do about it. The technical detail is never discarded, it stays
 * on the error object and in the console for developers.
 */

/**
 * Consequence of a failure for the image that is currently displayed.
 */
export enum ErrorImpact {
  /** Nothing is missing from the displayed image. */
  NONE = 'none',
  /** The image is displayed, but is incomplete or not colour accurate. */
  DEGRADED = 'degraded',
  /** The slide (or the requested data) cannot be displayed at all. */
  BLOCKED = 'blocked',
}

export interface UserFacingError {
  /** Short plain-language summary of what failed. */
  title: string
  /** What failed and what the user can do about it. */
  description: string
  /** Whether the displayed image can still be trusted. */
  impact: ErrorImpact
  /** Whether the failure is expected to resolve by trying again. */
  isTransient: boolean
}

const IMPACT_STATEMENTS: Record<ErrorImpact, string> = {
  [ErrorImpact.NONE]: '',
  [ErrorImpact.DEGRADED]:
    'The slide is still displayed, but it may be incomplete or not colour accurate.',
  [ErrorImpact.BLOCKED]: 'The requested data cannot be displayed.',
}

/**
 * Returns the statement that tells the user whether the displayed image can
 * still be trusted, or an empty string if the image is unaffected.
 */
export const getImpactStatement = (impact: ErrorImpact): string =>
  IMPACT_STATEMENTS[impact]

interface ErrorLike {
  message?: string
  status?: number
  type?: string
  request?: { status?: number }
}

const asErrorLike = (error: unknown): ErrorLike => {
  if (typeof error === 'object' && error !== null) {
    return error as ErrorLike
  }
  return { message: String(error) }
}

const getStatus = (error: ErrorLike): number | undefined => {
  if (typeof error.status === 'number') {
    return error.status
  }
  if (typeof error.request?.status === 'number') {
    return error.request.status
  }
  const match = /\b(?:status|code)[: ]+(\d{3})\b/i.exec(error.message ?? '')
  if (match !== null) {
    return Number(match[1])
  }
  return undefined
}

const describeHttpStatus = (status: number): UserFacingError | undefined => {
  if (status === 0) {
    return {
      title: 'Cannot reach the image server',
      description:
        'The server did not respond. Check your network connection and whether the configured server is available, then reload the page.',
      impact: ErrorImpact.BLOCKED,
      isTransient: true,
    }
  }
  if (status === 401) {
    return {
      title: 'Sign-in required',
      description:
        'Your session is no longer valid. Sign in again to continue viewing this data.',
      impact: ErrorImpact.BLOCKED,
      isTransient: false,
    }
  }
  if (status === 403) {
    return {
      title: 'Access denied',
      description:
        'You are not authorised to view this data. Ask the data owner for access, or select a different server.',
      impact: ErrorImpact.BLOCKED,
      isTransient: false,
    }
  }
  if (status === 404) {
    return {
      title: 'Data not found on the server',
      description:
        'The server does not have the requested study, series or image. It may have been removed, or the link may be incorrect. Check the link, or go back to the worklist and select the slide again.',
      impact: ErrorImpact.BLOCKED,
      isTransient: false,
    }
  }
  if (status === 408 || status === 429) {
    return {
      title: 'The image server is busy',
      description:
        'The server did not answer in time and the request was retried automatically. Wait a moment and try again.',
      impact: ErrorImpact.DEGRADED,
      isTransient: true,
    }
  }
  if (status >= 500) {
    return {
      title: 'The image server reported an error',
      description:
        'The server could not deliver the requested data and the request was retried automatically. Wait a moment and try again, or report the problem if it persists.',
      impact: ErrorImpact.DEGRADED,
      isTransient: true,
    }
  }
  if (status >= 400) {
    return {
      title: 'The image server rejected the request',
      description:
        'The server could not process the request for this data. Go back to the worklist and select the slide again, or report the problem if it persists.',
      impact: ErrorImpact.BLOCKED,
      isTransient: false,
    }
  }
  return undefined
}

interface MessagePattern {
  pattern: RegExp
  describe: () => UserFacingError
}

/**
 * Failure modes that are recognisable from the message of the underlying
 * error and that describe the failure more precisely than its status code,
 * such as a bulkdata request that happens to fail with a 404.
 */
const CONTENT_PATTERNS: MessagePattern[] = [
  {
    pattern: /icc profile/i,
    describe: () => ({
      title: 'Colour profile could not be loaded',
      description:
        'The colour profile that describes how this slide was scanned is missing or could not be read, so the slide is shown with default colours. Colours may differ from the original; do not rely on them for colour-sensitive assessment.',
      impact: ErrorImpact.DEGRADED,
      isTransient: false,
    }),
  },
  {
    pattern: /pyramid|frame of reference|different from reference|geometry/i,
    describe: () => ({
      title: 'Slide images are inconsistent',
      description:
        'The resolution layers of this slide do not describe the same image, so it cannot be displayed reliably. This is a problem with the data itself rather than with the viewer; try another slide of this study.',
      impact: ErrorImpact.BLOCKED,
      isTransient: false,
    }),
  },
  {
    pattern: /decod|codec|transfer syntax|jpeg|jp2|jls|pixel data/i,
    describe: () => ({
      title: 'Part of the image could not be decoded',
      description:
        'Some image tiles are stored in a format that could not be decoded, so parts of the slide may be missing or blank.',
      impact: ErrorImpact.DEGRADED,
      isTransient: false,
    }),
  },
]

/**
 * Failure modes of libraries that report a transport problem without a status
 * code. Only consulted when the error does not carry a status code itself.
 */
const TRANSPORT_PATTERNS: MessagePattern[] = [
  {
    pattern: /network|failed to fetch|timeout|timed out|connection/i,
    describe: () => ({
      title: 'Cannot reach the image server',
      description:
        'The connection to the server failed. Check your network connection and whether the configured server is available, then reload the page.',
      impact: ErrorImpact.BLOCKED,
      isTransient: true,
    }),
  },
]

const DEFAULT_BY_CATEGORY: Record<string, UserFacingError> = {
  Authentication: {
    title: 'Sign-in problem',
    description:
      'You could not be signed in. Sign in again, and report the problem if it persists.',
    impact: ErrorImpact.BLOCKED,
    isTransient: false,
  },
  Communication: {
    title: 'Data could not be retrieved',
    description:
      'The viewer could not retrieve data from the image server. Reload the page, and report the problem if it persists.',
    impact: ErrorImpact.DEGRADED,
    isTransient: true,
  },
  EncodingDecoding: {
    title: 'Part of the image could not be read',
    description:
      'Some of the data of this slide could not be interpreted, so parts of it may be missing.',
    impact: ErrorImpact.DEGRADED,
    isTransient: false,
  },
  Visualization: {
    title: 'The slide could not be displayed',
    description:
      'The viewer could not build a display for this slide. Try another slide of this study, and report the problem if it persists.',
    impact: ErrorImpact.BLOCKED,
    isTransient: false,
  },
}

/**
 * Failure of a request for part of the pixel data of a slide, which leaves the
 * slide displayable but incomplete.
 */
export const PARTIAL_IMAGE_FAILURE: UserFacingError = {
  title: 'Part of the slide could not be loaded',
  description:
    'Some image data could not be retrieved from the server, so parts of the slide may be missing or blank. Reload the page to try again.',
  impact: ErrorImpact.DEGRADED,
  isTransient: true,
}

const FALLBACK: UserFacingError = {
  title: 'Something went wrong',
  description:
    'The viewer ran into an unexpected problem. Reload the page, and report the problem if it persists.',
  impact: ErrorImpact.DEGRADED,
  isTransient: false,
}

/**
 * Translates an arbitrary error into a message that can be shown to a user.
 *
 * The underlying error is left untouched; callers are expected to keep logging
 * it and to keep it available in the error detail view.
 *
 * @param error - error raised by the viewer or by one of its dependencies
 * @returns plain-language description of the failure
 */
export const describeError = (error: unknown): UserFacingError => {
  const errorLike = asErrorLike(error)

  const status = getStatus(errorLike)
  const message = errorLike.message ?? ''

  const contentPattern = CONTENT_PATTERNS.find((candidate) =>
    candidate.pattern.test(message),
  )
  if (contentPattern !== undefined) {
    return contentPattern.describe()
  }

  if (status !== undefined) {
    const described = describeHttpStatus(status)
    if (described !== undefined) {
      return described
    }
  }

  const transportPattern = TRANSPORT_PATTERNS.find((candidate) =>
    candidate.pattern.test(message),
  )
  if (transportPattern !== undefined) {
    return transportPattern.describe()
  }

  if (errorLike.type !== undefined && errorLike.type in DEFAULT_BY_CATEGORY) {
    return DEFAULT_BY_CATEGORY[errorLike.type]
  }

  return FALLBACK
}

export default describeError
