import { notification } from 'antd'
import { CustomError, errorTypes } from '../utils/CustomError'
import PubSub from '../utils/PubSub'
import { describeError, ErrorImpact } from '../utils/userFacingErrors'

export const NotificationMiddlewareEvents = {
  OnError: 'onError',
  OnWarning: 'onWarning',
}

export const NotificationMiddlewareContext = {
  DICOMWEB: 'dicomweb-client',
  DMV: 'dicom-microscopy-viewer',
  DCMJS: 'dcmjs',
  SLIM: 'slim',
  AUTH: 'authentication',
}

const NotificationType = {
  TOAST: 'toast',
  CONSOLE: 'console',
}

/* Sources of Error:
  1. 'dicomweb-client': Error while requesting/fetching data, tagged as 'Communication'
  2. 'slim' and 'dicom-microscopy-viewer' library: Error related to dicom data encoding/decoding,
  could directly/indirectly impact image-related visualization, tagged as 'Visualization' or
  'Encoding/Decoding' accordingly
  3. 'dcmjs' library: Data parsing error, tagged as 'DICOMError'
  4. 'authentication': Error during user authentication, tagged as 'Authentication'
  */
const NotificationSourceDefinition = {
  sources: [
    {
      category: errorTypes.AUTHENTICATION,
      notificationType: NotificationType.TOAST,
    },
    {
      category: errorTypes.COMMUNICATION,
      notificationType: NotificationType.TOAST,
    },
    {
      category: errorTypes.VISUALIZATION,
      notificationType: NotificationType.TOAST,
    },
    {
      category: errorTypes.ENCODINGANDDECODING,
      notificationType: NotificationType.CONSOLE,
    },
    {
      category: 'Warning',
      notificationType: NotificationType.TOAST,
    },
  ],
}

class NotificationMiddleware extends PubSub {
  constructor() {
    super()

    /** Toasts currently on screen, keyed by source and user-facing title. */
    this.toasts = new Map()

    const outerContext = (args) => {
      this.publish(
        NotificationMiddlewareEvents.OnWarning,
        Array.from(args).join(' '),
      )
    }

    ;(() => {
      const warn = console.warn
      console.warn = function (...args) {
        if (!JSON.stringify(args).includes('request')) {
          outerContext(args)
        }
        warn.apply(this, args)
      }
    })()
  }

  /**
   * Shows a toast for a user-facing error, collapsing repeats of the same
   * failure (a slide with many failing tiles would otherwise bury the screen
   * under identical toasts) into a single toast with an occurrence count.
   */
  showToast(key, userFacingError) {
    const previous = this.toasts.get(key)
    const occurrences = (previous?.occurrences ?? 0) + 1
    this.toasts.set(key, { occurrences })

    const notify =
      userFacingError.impact === ErrorImpact.BLOCKED
        ? notification.error
        : notification.warning

    notify({
      key,
      message:
        occurrences > 1
          ? `${userFacingError.title} (${occurrences}\u00d7)`
          : userFacingError.title,
      description: userFacingError.description,
      duration: userFacingError.impact === ErrorImpact.BLOCKED ? 0 : 8,
      onClose: () => {
        this.toasts.delete(key)
      },
    })
  }

  /**
   * Error handling middleware function
   *
   * @param {string} source - source of error - dicomweb-client, dmv, dcmjs or slim itself
   * @param {Error} error - error object
   * @param {import('../utils/userFacingErrors').UserFacingError} [userFacingErrorOverride] -
   * plain-language description to present to the user instead of the one
   * derived from the error itself
   */
  onError(source, error, userFacingErrorOverride = undefined) {
    const defaultCategory =
      source === NotificationMiddlewareContext.DICOMWEB
        ? errorTypes.COMMUNICATION
        : errorTypes.VISUALIZATION
    const errorCategory = error.type ?? defaultCategory
    const sourceConfig = NotificationSourceDefinition.sources.find(
      (s) => s.category === errorCategory,
    )
    const notificationType =
      sourceConfig?.notificationType ?? NotificationType.CONSOLE

    const userFacingError = userFacingErrorOverride ?? describeError(error)

    this.publish(NotificationMiddlewareEvents.OnError, {
      source,
      error,
      category: errorCategory,
      userFacingError,
    })

    /**
     * The technical error is always logged in full, independent of how (and
     * whether) it is presented to the user.
     */
    console.error(
      `A ${errorCategory} error occurred in ${source}: `,
      error instanceof CustomError ? error.message : String(error),
      error,
    )

    if (notificationType === NotificationType.TOAST) {
      this.showToast(`${source}:${userFacingError.title}`, userFacingError)
    }
  }
}

const notificationMiddleware = new NotificationMiddleware()

export default notificationMiddleware
