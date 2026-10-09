import assert from 'node:assert/strict'
import test from 'node:test'
import { v2Catalog, v2Message, v2Question, v2Rules } from '../src/v2-transcript.mjs'
import { v2Events } from '../src/v2-events.mjs'
import { OpenCodeV2 } from '../src/v2.mjs'
import { partItem } from '../src/transcript.mjs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { OpenCodeTransport } from '../src/transport.mjs'

const assistant = {
  id: 'msg_1', type: 'assistant', model: { providerID: 'local', id: 'llama' }, time: { created: 1 }, cost: 0,
  content: [
    { type: 'reasoning', text: 'Thinking' },
    { type: 'text', text: 'Hello' },
    { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'README.md' }, content: [{ type: 'text', text: 'Content' }] } },
  ],
}

test('v2 live content and native snapshots share stable IDs and exclude control messages', () => {
  const events = []
  const requests = new Map(), forms = new Map(), failures = new Map()
  const event = v2Events((value) => events.push(value), requests, forms, failures, 'ses_1')
  const send = (type, data) => event({ type, created: 1, data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ...data } })
  send('session.step.started', { model: assistant.model, started: 1 })
  send('session.reasoning.started', { ordinal: 0 })
  send('session.reasoning.delta', { ordinal: 0, delta: 'Thinking' })
  send('session.text.started', { ordinal: 0 })
  send('session.text.delta', { ordinal: 0, delta: 'Hel' })
  send('session.text.ended', { ordinal: 0, text: 'Hello' })
  send('session.tool.input.started', { id: 'call_1', name: 'read' })
  send('session.tool.called', { id: 'call_1', input: { path: 'README.md' } })
  send('session.tool.success', { id: 'call_1', content: [{ type: 'text', text: 'Content' }] })
  const snapshot = v2Message(assistant, 'ses_1')
  for (const part of snapshot.parts) {
    const streamed = events.findLast((event) => event.properties.part?.id === part.id)?.properties.part
    assert.deepEqual(partItem(streamed, snapshot.info), partItem(part, snapshot.info))
  }
  assert.equal(v2Message({ id: 'msg_control', type: 'model-switched' }, 'ses_1').parts.length, 0)
  assert.equal(v2Message({ id: 'msg_user', type: 'user', text: 'Hi' }, 'ses_1').parts[0].id, 'msg_user:text:0')
  send('permission.asked', { id: 'per_other', sessionID: 'ses_other', action: 'shell', resources: ['npm test'] })
  assert.equal(requests.size, 0)
  send('permission.asked', { id: 'per_1', action: 'shell', resources: ['npm test'] })
  assert.equal(events.at(-1).properties.permission, 'shell')
  send('session.execution.failed', { error: { message: 'Provider unavailable' } })
  assert.equal(failures.get('ses_1').message, 'Provider unavailable')
  assert.equal(requests.size, 0)
})

test('v2 catalog preserves prices, excludes disabled models and translates Plan shell denial', () => {
  const models = [
    { id: 'llama', providerID: 'local', enabled: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
    { id: 'hidden', providerID: 'local', enabled: false, cost: [] },
  ]
  const catalog = v2Catalog([{ id: 'local' }], models)
  assert.deepEqual(Object.keys(catalog.all[0].models), ['llama'])
  assert.equal(catalog.all[0].models.llama.cost.cache_read, 0)
  assert.deepEqual(v2Rules([{ permission: 'bash', pattern: '*', action: 'deny' }]), [{ action: 'shell', resource: '*', effect: 'deny' }])
})

test('v2 authenticates as opencode and uses the native location query for model discovery', async () => {
  const calls = []
  const transport = new OpenCodeTransport({ launch: (_executable, _args, options) => {
    assert.equal(options.env.OPENCODE_PASSWORD, options.env.OPENCODE_SERVER_PASSWORD)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => child.stdout.write('server listening on http://127.0.0.1:54321\n'))
    return child
  }, fetcher: async (url, options) => {
    calls.push(url)
    assert.equal(Buffer.from(options.headers.Authorization.slice(6), 'base64').toString().split(':')[0], 'opencode')
    return Response.json([])
  } })
  try {
    await transport.rawRequest('/project with space', '/api/model')
    assert.equal(calls[0].searchParams.get('location[directory]'), '/project with space')
    assert.equal(calls[0].searchParams.has('directory'), false)
    await transport.rawRequest('/project with space', '/api/session?order=asc')
    assert.equal(calls[1].searchParams.get('directory'), '/project with space')
  } finally { transport.dispose() }
})

test('v2 consumes history pages and maps fork cutoff, owned replies and instruction cleanup', async () => {
  const calls = []
  const form = { id: 'frm_1', sessionID: 'ses_1', title: 'Questions', metadata: { kind: 'question' }, fields: [
    { key: 'q0', type: 'string', description: 'Pick', options: [{ value: 'a', label: 'First' }] },
    { key: 'q1', type: 'multiselect', title: 'More', options: [{ value: 'b', label: 'Second' }] },
  ] }
  const transport = { async rawRequest(root, path, method, body, signal, timeout) {
    calls.push({ root, path, method, body, signal, timeout })
    if (path.includes('/message')) return path.includes('cursor=')
      ? { data: [assistant, { id: 'msg_idle', type: 'idle', outcome: 'succeeded' }], cursor: {} }
      : { data: [{ id: 'msg_user', type: 'user', text: 'Hi' }], cursor: { next: 'cursor with space' } }
    if (path.endsWith('/fork')) return { data: { id: 'ses_fork', location: { directory: '/project' } } }
    return undefined
  } }
  const adapter = new OpenCodeV2(transport)
  const history = await adapter.request('/project', '/session/ses_1/message', 'GET')
  assert.equal(history.length, 3)
  assert.ok(calls.some((call) => call.path.endsWith('cursor=cursor%20with%20space')))
  assert.equal((await adapter.request('/project', '/session/ses_1/fork', 'POST', { messageID: 'msg_1' })).directory, '/project')
  assert.deepEqual(calls.at(-1).body, { before: 'msg_1' })
  adapter.requests.set('per_1', 'ses_1')
  await adapter.request('/project', '/permission/per_1/reply', 'POST', { reply: 'once' })
  assert.equal(calls.at(-1).path, '/api/session/ses_1/permission/per_1/reply')
  assert.deepEqual(calls.at(-1).body, { decision: 'once' })
  await assert.rejects(adapter.request('/project', '/permission/per_1/reply', 'POST', { reply: 'once' }), /no longer pending/)
  adapter.forms.set(form.id, form)
  await adapter.request('/project', '/question/frm_1/reply', 'POST', { answers: [['First'], ['Second']] })
  assert.deepEqual(calls.at(-1).body, { answer: { q0: 'a', q1: ['b'] } })
  assert.equal(v2Question(form).questions[0].question, 'Pick')
  assert.ok(v2Question({ ...form, fields: [{ type: 'external', key: 'auth' }] }).error)
  const result = await adapter.request('/project', '/session/ses_1/message', 'POST', {
    model: { providerID: 'local', modelID: 'llama' }, agent: 'plan', parts: [{ text: 'Hi' }],
  }, undefined, 0)
  assert.equal(result.parts[1].text, 'Hello')
  assert.ok(calls.some((call) => call.path.endsWith('/instructions/entries/geckit') && call.method === 'DELETE'))
  assert.ok(calls.some((call) => call.path.endsWith('/wait') && call.timeout === 0))
  assert.ok(calls.some((call) => call.path.endsWith('/model') && call.body.model.id === 'llama'))
  await adapter.request('/project', '/session/ses_1/abort', 'POST')
  assert.equal(calls.at(-1).path, '/api/session/ses_1/interrupt')
})

test('v2 waits for asynchronous Ollama discovery on the first model request', async () => {
  let polls = 0
  const adapter = new OpenCodeV2({ startupMs: 500, async rawRequest(_root, path) {
    if (path === '/api/config') return []
    if (path === '/api/provider') return { data: [{ id: 'ollama' }] }
    if (path === '/api/model') return { data: ++polls < 2 ? [] : [{ id: 'qwen3', providerID: 'ollama', enabled: true, name: 'Qwen 3', cost: [] }] }
    throw new Error(path)
  } })
  const catalog = await adapter.request('/project', '/provider')
  assert.deepEqual(Object.keys(catalog.all[0].models), ['qwen3'])
  assert.equal(polls, 2)
})

test('v2 bounds empty discovery and errors when configured Ollama models never load', async () => {
  let configured = false
  const adapter = new OpenCodeV2({ startupMs: 0, async rawRequest(_root, path) {
    if (path === '/api/config') return configured ? [{ type: 'document', info: { providers: { ollama: { models: { qwen3: {} } } } } }] : []
    return { data: [] }
  } })
  assert.deepEqual((await adapter.request('/project', '/provider')).all, [])
  configured = true
  await assert.rejects(adapter.request('/project', '/provider'), /did not load the configured Ollama models/)
})
