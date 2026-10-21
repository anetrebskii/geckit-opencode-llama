import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { OpenCodeTransport } from '../src/transport.mjs'

function setup(t, fetcher, options = {}) {
  const transport = new OpenCodeTransport({
    fetcher, retryDelays: [1, 2, 4], waitMs: 10, ...options,
    launch: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => child.stdout.write('server listening on http://127.0.0.1:54321\n'))
      return child
    },
  })
  t.after(() => transport.dispose())
  return transport
}
const disconnected = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Socket closed'), { code: 'UND_ERR_SOCKET' }) })

test('safe observations retry lost connections and transient HTTP failures, bounded to three retries', async (t) => {
  for (const method of ['GET', 'POST']) await t.test(method, async (t) => {
    let calls = 0
    const logs = []
    const transport = setup(t, async () => {
      if (++calls === 1) throw disconnected()
      if (calls === 2) return new Response('Temporary', { status: 503 })
      return Response.json({ done: true })
    })
    transport.log = (level, event, fields) => logs.push({ level, event, fields })
    const path = method === 'GET' ? '/api/model' : '/api/experimental/session/ses_1/wait'
    assert.deepEqual(await transport.rawRequest('/project', path, method), { done: true })
    assert.equal(calls, 3)
    assert.equal(logs.filter((entry) => entry.event === 'transport.request.retry').length, 2)
    calls = 0
    transport.fetcher = async () => { calls++; throw disconnected() }
    await assert.rejects(transport.rawRequest('/project', path, method), /fetch failed/)
    assert.equal(calls, 4)
  })
})

test('writes, authorization errors and invalid responses are never replayed', async (t) => {
  for (const [method, path, failure] of [
    ['POST', '/api/session/ses_1/prompt', disconnected()],
    ['POST', '/session/ses_1/message', disconnected()],
    ['POST', '/api/session/ses_1/permission/per_1/reply', disconnected()],
    ['PATCH', '/api/session/ses_1', disconnected()],
    ['GET', '/api/model', new Response('Unauthorized', { status: 401 })],
    ['GET', '/api/model', new Response('Bad request', { status: 400 })],
    ['GET', '/api/model', new Response('not JSON')],
  ]) await t.test(`${method} ${path} ${failure.status ?? failure.name}`, async (t) => {
    let calls = 0
    const transport = setup(t, async () => { calls++; if (failure instanceof Error) throw failure; return failure })
    await assert.rejects(transport.rawRequest('/project', path, method))
    assert.equal(calls, 1)
  })
})

test('Stop and disposal cancel backoff without issuing another request', async (t) => {
  for (const how of ['stop', 'dispose']) await t.test(how, async (t) => {
    let retry
    const scheduled = new Promise((resolve) => { retry = resolve })
    let calls = 0
    const controller = new AbortController()
    const transport = setup(t, async () => { calls++; throw disconnected() }, { retryDelays: [10_000] })
    transport.log = (_level, event) => { if (event === 'transport.request.retry') retry() }
    const pending = transport.rawRequest('/project', '/api/model', 'GET', undefined, controller.signal)
    await scheduled
    if (how === 'stop') controller.abort()
    else transport.dispose()
    await assert.rejects(pending)
    assert.equal(calls, 1)
  })
})

test('completion observer renews while generation continues and preserves total deadline', async (t) => {
  let waits = 0
  const transport = setup(t, async (_url, options) => {
    if (++waits === 3) return new Response(null, { status: 204 })
    await delay(1000, undefined, { signal: options.signal }).catch(() => { throw options.signal.reason })
  })
  await transport.v2.wait('/project', 'ses_1')
  assert.equal(waits, 3)
  transport.fetcher = async (_url, options) => {
    await delay(1000, undefined, { signal: options.signal }).catch(() => { throw options.signal.reason })
  }
  const began = Date.now()
  await assert.rejects(transport.v2.wait('/project', 'ses_1', undefined, 35), { code: 'GECKIT_REQUEST_TIMEOUT' })
  assert(Date.now() - began < 500)
})

test('caller cancellation ends an active observer without renewal', async (t) => {
  let began
  const started = new Promise((resolve) => { began = resolve })
  let waits = 0
  const transport = setup(t, async (_url, options) => {
    waits++
    began()
    await delay(1000, undefined, { signal: options.signal }).catch(() => { throw options.signal.reason })
  })
  const controller = new AbortController()
  const pending = transport.v2.wait('/project', 'ses_1', controller.signal)
  await started
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(waits, 1)
})
