import { describe, expect, it } from 'vitest'
import {
  CHAT_MEDIA_REQUEST_CONCURRENCY,
  enqueueChatMediaRequest,
} from '@/services/chatMediaQueue'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('chatMediaQueue', () => {
  it('starts no more than four media requests at once', async () => {
    const requests = Array.from({ length: CHAT_MEDIA_REQUEST_CONCURRENCY + 2 }, () => deferred<string>())
    const started: number[] = []
    const queued = requests.map((request, index) => enqueueChatMediaRequest(() => {
      started.push(index)
      return request.promise
    }))

    expect(started).toEqual([0, 1, 2, 3])

    requests[0].resolve('first')
    await queued[0].promise
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3, 4])

    requests[1].resolve('second')
    await queued[1].promise
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3, 4, 5])

    for (let index = 2; index < requests.length; index += 1) {
      requests[index].resolve(`request-${index}`)
    }
    await Promise.all(queued.map(request => request.promise))
  })

  it('gives a lightbox request priority over queued viewport prefetches', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const third = deferred<string>()
    const fourth = deferred<string>()
    const prefetch = deferred<string>()
    const lightbox = deferred<string>()
    const started: string[] = []

    const running = [first, second, third, fourth].map((request, index) => enqueueChatMediaRequest(() => {
      started.push(`running-${index}`)
      return request.promise
    }))
    const queuedPrefetch = enqueueChatMediaRequest(() => {
      started.push('prefetch')
      return prefetch.promise
    })
    const queuedLightbox = enqueueChatMediaRequest(() => {
      started.push('lightbox')
      return lightbox.promise
    }, 'high')

    first.resolve('first')
    await running[0].promise
    await Promise.resolve()
    expect(started).toEqual(['running-0', 'running-1', 'running-2', 'running-3', 'lightbox'])

    second.resolve('second')
    third.resolve('third')
    fourth.resolve('fourth')
    lightbox.resolve('lightbox')
    prefetch.resolve('prefetch')
    await Promise.all([
      ...running.slice(1).map(request => request.promise),
      queuedPrefetch.promise,
      queuedLightbox.promise,
    ])
  })
})
