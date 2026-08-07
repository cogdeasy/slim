/**
 * Start the worker that bins annotations off the main thread.
 *
 * A module of its own so that the controller can be unit tested: the
 * `new Worker(new URL(...), import.meta.url)` form is what the bundler looks
 * for in order to emit the worker as its own chunk, but `import.meta` cannot
 * be parsed by the CommonJS transform the test runner uses, so it has to sit
 * behind a boundary that tests can replace.
 *
 * @returns The worker
 */
export function createBinningWorker(): Worker {
  return new Worker(new URL('./binning.worker.ts', import.meta.url))
}
