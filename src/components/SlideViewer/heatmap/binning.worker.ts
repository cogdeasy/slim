import { computeHeatmapGrid } from './binning'
import type { BinningRequest } from './types'

/**
 * The worker global scope, typed as a `Worker` because that is the closest
 * built-in type with the `onmessage` and `postMessage` members this needs.
 * Spelled `globalThis` rather than `self` because CRA's eslint configuration
 * restricts `self` in application code.
 */
const context = globalThis as unknown as Worker

/**
 * Bin one request and post the resulting grid back.
 *
 * The request buffers are copies (the controller deliberately does not
 * transfer them, because the position array it owns is cached and must not be
 * detached), while the response buffers are freshly allocated here and are
 * therefore transferred.
 */
context.onmessage = (event: MessageEvent<BinningRequest>): void => {
  const response = computeHeatmapGrid(event.data)
  context.postMessage(response, [
    response.values.buffer,
    response.counts.buffer,
  ])
}
