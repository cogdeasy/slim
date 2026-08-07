import { computeHeatmapGrid } from './binning'
import type { BinningRequest } from './types'

/* eslint-disable no-restricted-globals */
const context = self as unknown as Worker

context.onmessage = (event: MessageEvent<BinningRequest>): void => {
  const response = computeHeatmapGrid(event.data)
  context.postMessage(response, [
    response.values.buffer,
    response.counts.buffer,
  ])
}
