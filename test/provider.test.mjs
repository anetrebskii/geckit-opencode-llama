import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { create } from '../src/provider.mjs'
import { OpenCodeTransport } from '../src/transport.mjs'
import { catalog, conversation, family, nativeId, partItem } from '../src/transcript.mjs'
import { Backend } from './backend.mjs'
import { v2Message } from '../src/v2-transcript.mjs'

const until = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition timed out')
}
function setup(t, context = {}) {
  const backend = new Backend()
  let launches = 0
  let killed = 0
  const launch = (_executable, args, options) => {
    launches++
    assert.deepEqual(args, ['serve', '--hostname=127.0.0.1', '--port=0'])
    assert.ok(options.env.OPENCODE_SERVER_PASSWORD.length >= 32)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { killed++; return true }
    queueMicrotask(() => child.stdout.write('opencode server listening on http://127.0.0.1:54321\n'))
    return child
  }
  const transport = new OpenCodeTransport({ launch, fetcher: backend.fetch })
  const provider = create(context, { transport })
  t.after(() => provider.dispose())
  return { provider, transport, backend, launched: () => launches, killed: () => killed }
}
function held(provider, id, mode = 'manual') {
  const heard = []
  let left = 0
  const driver = provider.hold({ id, root: '/project', mode, resume: true }, (event) => heard.push(event), () => left++)
  return { driver, heard, left: () => left, signals: () => heard.flatMap((heard) => heard.signals), items: () => heard.flatMap((heard) => heard.items) }
}

test('logs cached limits and transport/turn outcomes without prompts or backend bodies', async (t) => {
  const logs = []
  const { provider, backend, transport } = setup(t, { log: { write: (level, event, fields) => logs.push({ level, event, fields }) } })
  const models = await provider.models('/project')
  const calls = backend.calls.length
  await provider.limits(models.map((model) => model.value))
  assert.equal(backend.calls.length, calls, 'limits do not make backend requests')
  assert.equal(logs.find((one) => one.event === 'limits.cache.returned').fields.backendCheck, false)
  const h = held(provider, await provider.create({ root: '/project' }))
  h.driver.send('PRIVATE PROMPT', undefined, ['PRIVATE COMMAND OUTPUT'])
  await until(() => backend.prompts.length === 1)
  backend.complete(backend.prompts[0], 'PRIVATE BACKEND ERROR')
  await until(() => h.signals().some((signal) => signal.kind === 'ended'))
  assert.equal(logs.find((one) => one.event === 'session.turn.ended').fields.outcome, 'failed')
  transport.fetcher = async () => new Response('PRIVATE HTTP BODY', { status: 500 })
  await assert.rejects(transport.request('/PRIVATE ROOT', '/session/private-id/message?private=query'), /PRIVATE HTTP BODY/)
  assert(logs.some((one) => one.event === 'transport.request.failed' && one.fields.status === 500))
  await h.driver.end()
  const serialized = JSON.stringify(logs)
  for (const privateText of ['PRIVATE', 'private-id', 'private=query', transport.password]) assert.equal(serialized.includes(privateText), false, privateText)
  for (const event of ['provider.created', 'transport.starting', 'transport.started', 'transport.request.started', 'transport.request.completed', 'message.send.requested', 'session.closed']) assert(logs.some((one) => one.event === event), event)
})

test('unavailable plugin logger does not affect provider operations', async (t) => {
  const { provider } = setup(t, { log: { write: () => { throw new Error('Cannot write logs') } } })
  assert((await provider.models('/project')).length > 0)
  assert((await provider.limits(['ollama/llama3.1:8b'])).windows.has('ollama/llama3.1:8b'))
})

test('manifest, complete contract, inert creation and bundled entry', async (t) => {
  const { provider, launched } = setup(t)
  const manifest = JSON.parse(await readFile(new URL('../geckit-plugin.json', import.meta.url)))
  assert.equal(manifest.provider.id, provider.id)
  assert.equal(manifest.provider.family, provider.family)
  for (const key of ['account', 'program', 'models', 'limits', 'list', 'search', 'hidden', 'create', 'fork', 'has', 'read', 'links', 'goal', 'setGoal', 'clearGoal', 'hold', 'rename', 'remote', 'mcp', 'browsers', 'correct', 'setInstructions', 'delete', 'dispose']) assert.equal(typeof provider[key], 'function', key)
  assert.equal(launched(), 0)
  const bundled = await import('../index.mjs')
  const loaded = bundled.create({})
  assert.equal(loaded.id, family)
  loaded.dispose()
  assert.throws(() => nativeId('codex:ses_1'))
  assert.throws(() => nativeId(`${family}:../../tmp`))
  assert.equal(nativeId(`${family}:ses_1`), 'ses_1')
})

test('Ollama catalog includes all families and reports backend capacity, zero prices and unknown quotas', async (t) => {
  const { provider, backend, launched } = setup(t)
  const models = await provider.models('/project')
  assert.equal(models.length, 2)
  assert.deepEqual(models.map((model) => model.value), ['ollama/llama3.1:8b', 'ollama/qwen3'])
  assert.equal(models[0].contextWindow, 16384)
  assert.equal(models[0].pricing.input, 0)
  assert.equal(models[0].supportsAutoMode, false)
  assert.equal(models[0].isDefault, true)
  assert.equal((await provider.limits([models[0].value])).windows.get(models[0].value), 16384)
  assert.equal((await provider.limits([])).quotas, undefined)
  assert.equal((await provider.account()).signedIn, true)
  assert.equal((await provider.program()).version, '1.18.35')
  assert.equal(launched(), 1)
  assert.match(backend.calls[0].headers.Authorization, /^Basic /)
  assert.equal(catalog({ all: [{ id: 'ollama', models: { llama: { name: 'Llama' } } }], connected: ['ollama'] })[0].contextWindow, undefined)
  backend.providers.connected = []
  await assert.rejects(provider.create({ root: '/project' }), /No Ollama models/)
  await assert.rejects(provider.create({ root: '/project', model: 'hosted/llama' }), /not available/)
  await assert.rejects(provider.create({ root: 'ssh://host/project' }), /only on this computer/)
})

test('conversation selection forwards non-Llama Ollama model and rejects other providers', async (t) => {
  const { provider, backend } = setup(t)
  backend.providers.connected.push('hosted')
  assert.equal((await provider.models('/project')).some((model) => model.value.startsWith('hosted/')), false)
  const selected = 'ollama/qwen3'
  backend.config.model = selected
  assert.equal((await provider.models('/project')).find((model) => model.isDefault).value, selected)
  const id = await provider.create({ root: '/project', model: selected })
  const driver = provider.hold({ id, root: '/project', mode: 'manual', resume: true, model: selected }, () => {}, () => {})
  driver.send('selected model')
  await until(() => backend.prompts.length === 1)
  assert.deepEqual(backend.calls.findLast((call) => call.path.endsWith('/message')).body.model, { providerID: 'ollama', modelID: 'qwen3' })
  backend.complete(backend.prompts[0])
  await driver.end()
  backend.config.model = 'hosted/llama'
  assert.equal((await provider.models('/project')).find((model) => model.isDefault).value, 'ollama/llama3.1:8b')
  delete backend.providers.all[0].models.qwen3
  await assert.rejects(provider.create({ root: '/project', model: selected }), /Ollama model is not available/)
  await assert.rejects(provider.create({ root: '/project', model: 'hosted/llama' }), /Ollama model is not available/)
})

test('stream assistant/delta/tool/thought without user echo, completion once, resumed turn and spend', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  const h = held(provider, id)
  h.driver.send('hello', undefined, ['command result'])
  await until(() => backend.prompts.length === 1)
  await until(() => h.items().some((item) => item.text === 'Hello'))
  assert.equal(h.items().some((item) => item.kind === 'mine'), false)
  assert.equal(backend.prompts[0].body.parts[0].text, 'command result\n\nhello')
  const prompt = backend.prompts[0]
  const base = { sessionID: prompt.id, messageID: prompt.info.id }
  backend.emit(prompt.id, 'message.part.updated', { part: { ...base, id: 'prt_thought', type: 'reasoning', text: 'Thinking' } })
  backend.emit(prompt.id, 'message.part.updated', { part: { ...base, id: 'prt_tool', type: 'tool', tool: 'read', state: { status: 'running', input: { filePath: 'README.md' } } } })
  backend.emit('ses_other', 'permission.asked', { id: 'perm_wrong', permission: 'bash', patterns: ['bad'] })
  backend.emit(prompt.id, 'session.error', { error: { data: { message: 'Nonfatal attachment read' } } })
  backend.complete(prompt, undefined, 0.2)
  await until(() => h.signals().some((signal) => signal.kind === 'ended'))
  assert.equal(h.signals().filter((signal) => signal.kind === 'ended').length, 1)
  assert.ok(h.items().some((item) => item.kind === 'thought'))
  assert.ok(h.items().some((item) => item.kind === 'did' && item.live))
  assert.equal(h.signals().find((signal) => signal.kind === 'started').session, id)
  assert.equal(h.signals().findLast((signal) => signal.kind === 'spend').used, 117)
  assert.equal(h.signals().findLast((signal) => signal.kind === 'spend').window, 16384)
  assert.equal(h.signals().findLast((signal) => signal.kind === 'spend').cost, 0.2)
  const finalItemCount = h.items().length
  backend.emit(prompt.id, 'message.part.updated', { part: { ...prompt.part, text: '' } })
  backend.emit(prompt.id, 'message.part.delta', { partID: prompt.part.id, field: 'text', delta: 'Stale' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.items().length, finalItemCount)
  h.driver.send('again')
  await until(() => backend.prompts.length === 2)
  backend.complete(backend.prompts[1], undefined, 0.3)
  await until(() => h.signals().filter((signal) => signal.kind === 'ended').length === 2)
  assert.equal(h.signals().findLast((signal) => signal.kind === 'spend').cost, 0.5)
  await h.driver.end()
  await h.driver.end()
  assert.equal(h.left(), 1)
  assert.equal(backend.streams.size, 0)
})

test('late native user snapshots do not duplicate optimistic messages or collapse identical turns', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  const original = backend.emit.bind(backend)
  backend.emit = (session, type, properties = {}) => {
    if (properties.info?.role === 'user' || properties.part?.messageID.startsWith('msg_user')) return
    original(session, type, properties)
  }
  const shown = new Map()
  let completed = 0
  const driver = provider.hold({ id, root: '/project', mode: 'manual', resume: true }, (event) => {
    completed += event.signals.filter((signal) => signal.kind === 'ended').length
    for (const gone of event.gone) shown.delete(gone)
    for (const item of event.items) shown.set(item.id, item)
  }, () => {})
  for (let turn = 0; turn < 2; turn++) {
    shown.set(`optimistic:${turn}`, { kind: 'mine', id: `optimistic:${turn}`, text: 'What?' })
    driver.send('What?')
    await until(() => backend.prompts.length === turn + 1)
    backend.complete(backend.prompts[turn])
    await until(() => completed === turn + 1)
    assert.deepEqual([...shown.values()].filter((item) => item.kind === 'mine' || item.kind === 'theirs').map((item) => item.kind), Array.from({ length: turn + 1 }, () => ['mine', 'theirs']).flat())
  }
  await driver.end()
  const saved = await provider.read('/project', id)
  assert.deepEqual(saved.items.filter((item) => item.kind === 'mine' || item.kind === 'theirs').map((item) => item.kind), ['mine', 'theirs', 'mine', 'theirs'])
  assert.deepEqual(saved.items.filter((item) => item.kind === 'mine').map((item) => item.text), ['What?', 'What?'])
})

test('permission mapping and multiple question cards use native request IDs', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  const h = held(provider, id)
  h.driver.send('task')
  await until(() => backend.prompts.length === 1)
  for (const [answer, reply] of [['once', 'once'], ['session', 'once'], ['no', 'reject']]) {
    backend.emit('ses_1', 'permission.asked', { id: `perm_${answer}`, permission: 'bash', patterns: [`npm ${answer}`] })
    await until(() => h.signals().some((signal) => signal.ask === `perm_${answer}`))
    h.driver.answer(`perm_${answer}`, answer)
    await until(() => backend.calls.some((call) => call.path === `/permission/perm_${answer}/reply`))
    assert.equal(backend.calls.find((call) => call.path === `/permission/perm_${answer}/reply`).body.reply, reply)
  }
  backend.emit('ses_1', 'question.asked', { id: 'q_1', questions: [
    { question: 'Color?', options: [{ label: 'Red' }], custom: false },
    { question: 'Why?', options: [], custom: true },
  ] })
  await until(() => h.signals().some((signal) => signal.ask === 'q_1#1'))
  h.driver.answer('q_1', 'Red')
  h.driver.answer('q_1#1', 'Because')
  await until(() => backend.calls.some((call) => call.path === '/question/q_1/reply'))
  assert.deepEqual(backend.calls.find((call) => call.path === '/question/q_1/reply').body.answers, [['Red'], ['Because']])
  backend.complete(backend.prompts[0])
  await h.driver.end()
})

test('stop then another send waits for abort, end is exact once', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  const h = held(provider, id)
  h.driver.send('task')
  await until(() => backend.prompts.length === 1)
  h.driver.stop()
  h.driver.send('new')
  await until(() => h.signals().some((signal) => signal.kind === 'ended'))
  assert.equal(h.signals().find((signal) => signal.kind === 'ended').how, 'stopped')
  await until(() => backend.prompts.length === 2)
  const second = backend.calls.findLastIndex((call) => call.path === '/session/ses_1/message' && call.method === 'POST')
  const abort = backend.calls.findIndex((call) => call.path.endsWith('/abort'))
  assert.ok(abort >= 0 && abort < second)
  backend.complete(backend.prompts[1])
  await until(() => h.signals().filter((signal) => signal.kind === 'ended').length === 2)
  await h.driver.end()
  assert.equal(h.left(), 1)
})

test('stop during preparation prevents a late prompt', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  const h = held(provider, id)
  h.driver.send('task')
  h.driver.stop()
  await h.driver.end()
  assert.equal(backend.prompts.length, 0)
  assert.equal(h.signals().filter((signal) => signal.kind === 'ended').length, 1)
})

test('Plan denies mutating tools, auto is manual, owned instruction toggle', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  await provider.setInstructions(true, {})
  const h = held(provider, id, 'plan')
  h.driver.send('plan')
  await until(() => backend.prompts.length === 1)
  assert.equal(backend.prompts[0].body.agent, 'plan')
  assert.match(backend.prompts[0].body.system, /GeckIt/)
  assert.ok(backend.calls.findLast((call) => call.method === 'PATCH').body.permission.some((rule) => rule.permission === 'edit' && rule.action === 'deny'))
  backend.complete(backend.prompts[0])
  await until(() => h.signals().some((signal) => signal.kind === 'ended'))
  await h.driver.end()
  await provider.setInstructions(false, {})
  const auto = held(provider, id, 'auto')
  auto.driver.send('task')
  await until(() => backend.prompts.length === 2)
  assert.equal(backend.prompts[1].body.system, undefined)
  assert.equal(auto.signals().find((signal) => signal.kind === 'started').mode, 'manual')
  backend.complete(backend.prompts[1])
  await auto.driver.end()
})

test('native history survives provider recreation; scope, fork cutoff, search, rename, delete', async (t) => {
  const { provider, transport, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  backend.session('/other')
  backend.auto = true
  const h = held(provider, id)
  h.driver.send('search me')
  await until(() => h.signals().some((signal) => signal.kind === 'ended'))
  await h.driver.end()
  const reopened = create({}, { transport })
  const rows = await reopened.list(['/project', 'ssh://host/project', '/project/'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, id)
  assert.equal((await reopened.read('/project', id)).items.length, 2)
  await assert.rejects(reopened.read('/other', id), /another folder/)
  assert.equal((await reopened.search(['/project'], 'search')).length, 1)
  assert.deepEqual(await reopened.links('/project', id), [{ url: 'https://example.com' }])
  await reopened.rename(id, 'Renamed')
  assert.equal(backend.sessions.get('ses_1').title, 'Renamed')
  const fork = await reopened.fork('/project', id, 300, 'manual')
  assert.equal(fork.items.length, 1)
  assert.equal(backend.calls.findLast((call) => call.path.endsWith('/fork')).body.messageID, 'msg_assistant0')
  assert.equal(await reopened.delete('/project', id), true)
  assert.equal(await reopened.read('/project', id), undefined)
  assert.equal(await reopened.has('/project', id), false)
})

test('correction has no tools and its temporary native history is deleted', async (t) => {
  const { provider, backend } = setup(t)
  backend.auto = true
  const result = await provider.correct('hello', 'Correct', 'ollama/llama3.1:8b')
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Hello https://example.com.')
  assert.deepEqual(backend.calls.find((call) => call.path === '/session' && call.method === 'POST').body.permission, [{ permission: '*', pattern: '*', action: 'deny' }])
  assert.equal(backend.sessions.size, 0)
  assert.equal(provider.nativeGoals, false)
  assert.equal(await provider.goal('/project', 'unused'), undefined)
  assert.equal(await provider.browsers(), undefined)
  assert.deepEqual(await provider.mcp('/project'), [{ name: 'local', status: 'connected' }])
})

test('model failure and stream disconnect release active turn once', async (t) => {
  const { provider, backend } = setup(t)
  const id = await provider.create({ root: '/project' })
  const h = held(provider, id)
  h.driver.send('task')
  await until(() => backend.prompts.length === 1)
  backend.complete(backend.prompts[0], 'Model unavailable')
  await until(() => h.signals().some((signal) => signal.kind === 'ended'))
  assert.equal(h.signals().find((signal) => signal.kind === 'ended').how, 'failed')
  h.driver.send('another')
  await until(() => backend.prompts.length === 2)
  for (const stream of backend.streams) stream.controller.close()
  backend.streams.clear()
  await until(() => h.signals().filter((signal) => signal.kind === 'ended').length === 2)
  assert.match(h.signals().findLast((signal) => signal.kind === 'ended').text, /disconnected/)
  await h.driver.end()
})

test('successful native completion without a final text reply fails clearly and allows another turn', async (t) => {
  const cases = [
    { name: 'reasoning only', content: [{ type: 'reasoning', text: 'Thinking about the greeting.' }] },
    { name: 'blank text', content: [{ type: 'text', text: ' \n\t' }] },
    { name: 'ignored text', content: [{ type: 'text', text: 'Hidden', ignored: true }] },
    { name: 'synthetic text', content: [{ type: 'text', text: 'Context', synthetic: true }] },
    { name: 'no assistant message', content: undefined },
  ]
  for (const sample of cases) await t.test(sample.name, async (t) => {
    const { provider, backend } = setup(t)
    const id = await provider.create({ root: '/project' })
    backend.history.get('ses_1').push({ info: { id: 'old_answer', role: 'assistant' }, parts: [{ id: 'old_text', type: 'text', text: 'Previous reply.' }] })
    const emit = backend.emit.bind(backend)
    backend.emit = (session, type, data) => {
      if (data?.part?.type === 'text' || type === 'message.part.delta') return
      emit(session, type, data)
    }
    const h = held(provider, id)
    h.driver.send('Hi')
    await until(() => backend.prompts.length === 1)
    const prompt = backend.prompts[0]
    const intermediate = { info: { id: 'intermediate', role: 'assistant' }, parts: [{ id: 'intermediate_text', type: 'text', text: 'Checking the task.' }] }
    const final = v2Message({ id: prompt.info.id, type: 'assistant', content: sample.content ?? [] }, 'ses_1')
    if (sample.content) backend.history.get('ses_1').push(intermediate, final)
    for (const part of final.parts) emit('ses_1', 'message.part.updated', { part })
    prompt.resolve(Response.json(final))
    await until(() => h.signals().some((signal) => signal.kind === 'ended'))
    assert.deepEqual(h.signals().filter((signal) => signal.kind === 'ended'), [{ kind: 'ended', how: 'failed', text: 'OpenCode finished without a final text reply. Try another model or send again.' }])
    const saved = await provider.read('/project', id)
    if (sample.name === 'reasoning only') {
      assert.ok(h.items().some((item) => item.kind === 'thought' && item.text === final.parts[0].text))
      assert.ok(saved.items.some((item) => item.kind === 'thought' && item.text === final.parts[0].text))
    }
    assert.equal(h.items().some((item) => item.kind === 'mine'), false)
    h.driver.send('Reply again')
    await until(() => backend.prompts.length === 2)
    backend.complete(backend.prompts[1])
    await until(() => h.signals().filter((signal) => signal.kind === 'ended').length === 2)
    assert.equal(h.signals().findLast((signal) => signal.kind === 'ended').how, 'done')
    await h.driver.end()
  })
})

test('pure replay excludes synthetic/ignored user context and retains tools/errors', () => {
  assert.equal(partItem({ type: 'text', synthetic: true }, { role: 'assistant' }), undefined)
  assert.equal(partItem({ type: 'text', ignored: true }, { role: 'user' }), undefined)
  const saved = conversation([{ info: { role: 'assistant', id: 'msg_1', cost: 0, tokens: { input: 1 } }, parts: [{ type: 'tool', id: 'p', tool: 'bash', state: { status: 'error', error: 'Failed' } }] }])
  assert.equal(saved.items[0].live, false)
  assert.equal(saved.items[0].detail, 'Failed')
  assert.equal(saved.cost, 0)
})

test('missing executable, startup timeout and disposal are bounded', async () => {
  const launch = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => child.emit('error', new Error('ENOENT')))
    return child
  }
  const missing = new OpenCodeTransport({ launch })
  await assert.rejects(missing.start(), /Cannot start OpenCode/)
  missing.dispose()
  const hanging = new OpenCodeTransport({ startupMs: 5, launch: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    return child
  } })
  await assert.rejects(hanging.start(), /did not start/)
  hanging.dispose()
  await assert.rejects(hanging.start(), /disposed/)
})

test('OpenCode 2 startup banner selects its native adapter across output chunks', async () => {
  let killed = false
  const transport = new OpenCodeTransport({ startupMs: 100, launch: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { killed = true; return true }
    queueMicrotask(() => {
      child.stdout.write('server listening on http://127.0.')
      child.stdout.write('0.1:54321\n')
    })
    return child
  } })
  try {
    assert.equal(await transport.start(), 'http://127.0.0.1:54321')
    assert.equal(transport.protocol, 2)
  }
  finally { transport.dispose() }
  assert.equal(killed, true)
})

test('session allowances stay in one conversation and use once at the native boundary', async (t) => {
  const { provider, backend } = setup(t)
  const first = held(provider, await provider.create({ root: '/project' }))
  const second = held(provider, await provider.create({ root: '/project' }))
  first.driver.send('first')
  second.driver.send('second')
  await until(() => backend.prompts.length === 2)
  backend.emit('ses_1', 'permission.asked', { id: 'perm_original', permission: 'bash', patterns: ['npm test'] })
  await until(() => first.signals().some((signal) => signal.ask === 'perm_original'))
  first.driver.answer('perm_original', 'session')
  await until(() => backend.calls.some((call) => call.path === '/permission/perm_original/reply'))
  backend.emit('ses_1', 'permission.asked', { id: 'perm_repeated', permission: 'bash', patterns: ['npm test'] })
  backend.emit('ses_2', 'permission.asked', { id: 'perm_other', permission: 'bash', patterns: ['npm test'] })
  await until(() => backend.calls.some((call) => call.path === '/permission/perm_repeated/reply'))
  await until(() => second.signals().some((signal) => signal.ask === 'perm_other'))
  assert.ok(!first.signals().some((signal) => signal.kind === 'asks' && signal.ask === 'perm_repeated'))
  assert.ok(!backend.calls.some((call) => call.path === '/permission/perm_other/reply'))
  assert.ok(backend.calls.filter((call) => call.path.startsWith('/permission/')).every((call) => call.body.reply === 'once'))
  await first.driver.end()
  await second.driver.end()
})

test('startup failure can recover after installing or repairing the executable', async () => {
  let attempts = 0
  const transport = new OpenCodeTransport({ launch: () => {
    attempts++
    if (attempts === 1) throw new Error('Invalid executable')
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => child.stdout.write('opencode server listening on http://127.0.0.1:54321\n'))
    return child
  } })
  await assert.rejects(transport.start(), /Invalid executable/)
  assert.equal(await transport.start(), 'http://127.0.0.1:54321')
  transport.dispose()
})

test('canonical native directories match project aliases without changing the board root', async (t) => {
  const { provider, backend } = setup(t)
  const folder = await mkdtemp(join(tmpdir(), 'geckit-opencode-alias-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const alias = `${folder}-link`
  await symlink(folder, alias)
  t.after(() => rm(alias))
  const native = backend.session(await realpath(folder))
  const id = `${family}:${native.id}`
  assert.equal(await provider.has(alias, id), true)
  const rows = await provider.list([alias, folder])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].root, alias)
})
