import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from '../index.mjs'
import { OpenCodeTransport } from '../src/transport.mjs'

const base = await mkdtemp(join(tmpdir(), 'geckit-opencode-smoke-'))
const project = join(base, 'project')
await mkdir(project)
await writeFile(join(project, 'README.md'), 'Native permission fixture.')
for (const [key, dir] of [['XDG_DATA_HOME', 'data'], ['XDG_CONFIG_HOME', 'config'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state']]) process.env[key] = join(base, dir)
process.env.GECKIT_OPENCODE_BIN ??= 'opencode'
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'
const requests = []
let toolIssued = false
let questionIssued = false
let planWriteIssued = false
let stallStarted
const stalled = new Promise((resolve) => { stallStarted = resolve })
const stalledResponses = new Set()
const server = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk
  requests.push({ url: request.url, method: request.method })
  if (request.url.endsWith('/chat/completions')) {
    const body = JSON.parse(text)
    requests.at(-1).tools = body.tools?.map((tool) => tool.function?.name)
    requests.at(-1).geckitInstructions = JSON.stringify(body.messages).includes('This conversation is running in GeckIt.')
    assert.equal(body.model, 'qwen-test')
    const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: 'qwen-test', choices: [{ index: 0, delta, finish_reason }] })
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (JSON.stringify(body.messages.findLast((message) => message.role === 'user')).includes('reasoning-without-reply')) {
        response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', reasoning_content: 'Thinking about the greeting.' }))}\n\n`)
        response.end(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
        return
      }
      if (body.tools?.length && JSON.stringify(body.messages.findLast((message) => message.role === 'user')).includes('wait-for-stop')) {
        response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Waiting for Stop.' }))}\n\n`)
        stalledResponses.add(response)
        response.on('close', () => stalledResponses.delete(response))
        stallStarted()
        return
      }
      if (!planWriteIssued && body.tools?.length && JSON.stringify(body.messages.findLast((message) => message.role === 'user')).includes('force-plan-write')) {
        planWriteIssued = true
        const path = join(project, 'PLAN.md')
        response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'call_denied_write', type: 'function', function: { name: 'write', arguments: JSON.stringify(v2 ? { path, content: 'Must not be written' } : { filePath: path, content: 'Must not be written' }) } }] }))}\n\n`)
        response.end(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\ndata: [DONE]\n\n`)
        return
      }
      if (!toolIssued && body.tools?.some((tool) => tool.function?.name === 'read')) {
        toolIssued = true
        response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: JSON.stringify(v2 ? { path: join(project, 'README.md') } : { filePath: join(project, 'README.md') }) } }] }))}\n\n`)
        response.end(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\ndata: [DONE]\n\n`)
        return
      }
      if (!questionIssued && body.tools?.some((tool) => tool.function?.name === 'question')) {
        questionIssued = true
        const questions = [
          { header: 'First', question: 'Which first?', options: [{ label: 'A', description: 'First answer' }] },
          { header: 'Second', question: 'Which second?', multiple: true, options: [{ label: 'B', description: 'Second answer' }] },
        ]
        response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'call_question', type: 'function', function: { name: 'question', arguments: JSON.stringify({ questions }) } }] }))}\n\n`)
        response.end(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\ndata: [DONE]\n\n`)
        return
      }
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Mock ' }))}\n\n`)
      response.write(`data: ${JSON.stringify(chunk({ content: 'Ollama reply.' }))}\n\n`)
      response.end(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`)
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: 'qwen-test', choices: [{ index: 0, message: { role: 'assistant', content: 'Mock Ollama reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }))
    }
  } else { response.writeHead(404); response.end('not found') }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const v2 = /(?:^|\s)v?2\./.test(execFileSync(process.env.GECKIT_OPENCODE_BIN, ['--version'], { encoding: 'utf8' }))
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(v2 ? {
  model: 'ollama/qwen-test',
  providers: { ollama: { package: '@opencode/ai/providers/openai-compatible', name: 'Mock Ollama', settings: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { 'qwen-test': { name: 'Qwen Test', limit: { context: 131072, output: 4096 } } } } },
} : {
  model: 'ollama/qwen-test', small_model: 'ollama/qwen-test',
  provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Mock Ollama', options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { 'qwen-test': { name: 'Qwen Test', limit: { context: 16384, output: 4096 } } } } },
})
const transport = new OpenCodeTransport()
const provider = create({}, { transport })
let driver
let planDriver
try {
  console.log('Program:', JSON.stringify(await provider.program()))
  const models = await provider.models(project)
  assert.ok(models.some((model) => model.value === 'ollama/qwen-test'))
  const id = await provider.create({ root: project, model: 'ollama/qwen-test' })
  await provider.setInstructions(true)
  const heard = []
  let finishTurn
  driver = provider.hold({ id, root: project, mode: 'manual', model: 'ollama/qwen-test', resume: true }, (event) => {
      heard.push(event)
      for (const signal of event.signals) if (signal.kind === 'asks') driver.answer(signal.ask, signal.wanted.kind === 'question' ? signal.wanted.choices[0] : 'once')
      const end = event.signals.find((signal) => signal.kind === 'ended')
      if (end) finishTurn?.(end)
    }, () => {})
  const turn = (text) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native turn timed out')), 60_000)
    finishTurn = (end) => { clearTimeout(timeout); resolve(end) }
    driver.send(text)
  })
  const result = await turn('Read README.md, ask two questions, then say hello.')
  assert.equal(result.how, 'done', JSON.stringify(result))
  const saved = await provider.read(project, id)
  assert.equal(heard.flatMap((event) => event.items).some((item) => item.kind === 'mine'), false, 'GeckIt already displays submitted user messages')
  assert.equal(saved.items.filter((item) => item.kind === 'mine').length, 1, 'Native history retains one submitted message')
  assert.ok(saved.items.some((item) => item.kind === 'theirs' && item.text.includes('Mock Ollama reply.')))
  assert.ok(heard.some((event) => event.items.some((item) => item.kind === 'theirs' && item.text.includes('Mock'))))
  assert.equal(heard.flatMap((event) => event.signals).filter((signal) => signal.kind === 'ended').length, 1)
  assert.ok(heard.flatMap((event) => event.signals).some((signal) => signal.kind === 'asks'), `Native permission card was received: ${JSON.stringify(requests)}`)
  assert.equal(heard.flatMap((event) => event.signals).filter((signal) => signal.kind === 'asks' && signal.wanted.kind === 'question').length, 2)
  assert.ok(requests.some((request) => request.geckitInstructions), 'Owned GeckIt instructions reached the native model request')
  assert.ok(saved.items.some((item) => item.kind === 'did'), 'Native read tool persisted')
  const stopping = turn('wait-for-stop')
  await Promise.race([stalled, new Promise((_, reject) => setTimeout(() => reject(new Error('Stalled fixture did not start')), 10_000).unref())])
  driver.stop()
  assert.equal((await stopping).how, 'stopped')
  assert.equal((await turn('Continue after Stop.')).how, 'done')
  assert.equal(heard.flatMap((event) => event.signals).filter((signal) => signal.kind === 'ended').length, 3)
  const incomplete = await turn('reasoning-without-reply')
  assert.equal(incomplete.how, 'failed', JSON.stringify(incomplete))
  assert.equal(incomplete.text, 'OpenCode finished without a final text reply. Try another model or send again.')
  const incompleteHistory = await provider.read(project, id)
  assert.ok(incompleteHistory.items.some((item) => item.kind === 'thought' && item.text === 'Thinking about the greeting.'))
  assert.equal((await turn('Continue after the incomplete reply.')).how, 'done')
  assert.equal(heard.flatMap((event) => event.signals).filter((signal) => signal.kind === 'ended').length, 5)
  await driver.end()
  const listed = await provider.list([project])
  assert.ok(listed.some((row) => row.id === id))
  const fork = await provider.fork(project, id, Date.now(), 'manual', 'ollama/qwen-test')
  assert.ok(fork.items.some((item) => item.kind === 'theirs'))
  await provider.rename(id, 'Native smoke')
  assert.ok((await provider.search([project], 'hello')).length)
  await provider.delete(project, fork.id)
  await provider.delete(project, id)
  const planId = await provider.create({ root: project, model: 'ollama/qwen-test' })
  const planned = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native Plan turn timed out')), 60_000)
    planDriver = provider.hold({ id: planId, root: project, mode: 'plan', model: 'ollama/qwen-test', resume: true }, (event) => {
      const end = event.signals.find((signal) => signal.kind === 'ended')
      if (end) { clearTimeout(timeout); resolve(end) }
    }, () => {})
  })
  planDriver.send('force-plan-write')
  assert.equal((await planned).how, 'done')
  assert.equal(await stat(join(project, 'PLAN.md')).then(() => true, () => false), false)
  const native = await transport.request(project, `/session/${planId.slice('plugin:opencode-llama:'.length)}`)
  assert.ok((v2 ? native.permissions : native.permission).some((rule) => v2 ? rule.action === 'shell' && rule.effect === 'deny' : rule.permission === 'bash' && rule.action === 'deny'))
  await planDriver.end()
  await provider.delete(project, planId)
  const corrected = await provider.correct('Correction fixture', 'Return corrected text', 'ollama/qwen-test')
  assert.equal(corrected.ok, true, JSON.stringify(corrected))
  assert.match(corrected.text, /Mock Ollama reply/)
  const report = { version: (await provider.program()).version, models, completed: result, incomplete, itemKinds: saved.items.map((item) => item.kind), mockRequests: requests, history: 'read/list/search/rename/fork/delete, permission, two question cards, Stop/continue, reasoning-only failure/recovery, Plan denial, owned instructions and correction pass', root: base }
  await writeFile(join(base, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await driver?.end()
  await planDriver?.end()
  provider.dispose()
  for (const response of stalledResponses) response.destroy()
  await new Promise((resolve) => server.close(resolve))
}
