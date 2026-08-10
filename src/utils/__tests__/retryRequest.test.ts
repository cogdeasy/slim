import {
  defaultRetrySettings,
  resolveRetrySettings,
  retryRequest,
} from '../retryRequest'

const fastSettings = resolveRetrySettings({
  retries: 2,
  minTimeout: 1,
  maxTimeout: 2,
  randomize: false,
})

describe('resolveRetrySettings', () => {
  it('retries 404 by default', () => {
    expect(defaultRetrySettings.retryableStatusCodes).toContain(404)
  })

  it('keeps defaults for options that are not configured', () => {
    const settings = resolveRetrySettings({ retries: 1 })
    expect(settings.retries).toBe(1)
    expect(settings.factor).toBe(defaultRetrySettings.factor)
  })
})

describe('retryRequest', () => {
  it('resolves without retrying when the request succeeds', async () => {
    const request = jest.fn().mockResolvedValue('metadata')
    await expect(
      retryRequest({ description: 'test', settings: fastSettings, request }),
    ).resolves.toBe('metadata')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retries a request that fails with a retryable status', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('failed'), { status: 404 }))
      .mockResolvedValue('metadata')
    await expect(
      retryRequest({ description: 'test', settings: fastSettings, request }),
    ).resolves.toBe('metadata')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('gives up after the configured number of retries', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('failed'), { status: 503 }))
    await expect(
      retryRequest({ description: 'test', settings: fastSettings, request }),
    ).rejects.toThrow('failed')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('does not retry a request that failed for a non-transient reason', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    await expect(
      retryRequest({ description: 'test', settings: fastSettings, request }),
    ).rejects.toThrow('forbidden')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
