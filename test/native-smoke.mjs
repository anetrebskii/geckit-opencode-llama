import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from '../index.mjs'

const base = await mkdtemp(join(tmpdir(), 'geckit-opencode-smoke-'))
const project = join(base, 'project')
await mkdir(project)
await writeFile(join(project, 'README.md'), 'Native permission fixture.')
for (const [key, dir] of [['XDG_DATA_HOME', 'data'], ['XDG_CONFIG_HOME', 'config'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state']]) process.env[key] = join(base, dir)
process.env.GECKIT_OPENCODE_BIN ??= 'opencode'
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'
const requests = []
let toolIssued = false
const server = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk
  requests.push({ url: request.url, method: request.method })
  if (request.url.endsWith('/chat/completions')) {
    const body = JSON.parse(text)
    assert.equal(body.model, 'llama-test')
    const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: 'llama-test', choices: [{ index: 0, delta, finish_reason }] })
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (!toolIssued && body.tools?.some((tool) => tool.function?.name === 'read')) {
        toolIssued = true
        response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(project, 'README.md') }) } }] }))}\n\n`)
        response.end(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\ndata: [DONE]\n\n`)
        return
      }
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Mock ' }))}\n\n`)
      response.write(`data: ${JSON.stringify(chunk({ content: 'Llama reply.' }))}\n\n`)
      response.end(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`)
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: 'llama-test', choices: [{ index: 0, message: { role: 'assistant', content: 'Mock Llama reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }))
    }
  } else { response.writeHead(404); response.end('not found') }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: 'mock/llama-test', small_model: 'mock/llama-test',
  provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock Llama', options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { 'llama-test': { name: 'Llama Test', limit: { context: 16384, output: 4096 } } } } },
})
const provider = create({})
let driver
try {
  console.log('Program:', JSON.stringify(await provider.program()))
  const models = await provider.models(project)
  assert.ok(models.some((model) => model.value === 'mock/llama-test'))
  const id = await provider.create({ root: project, model: 'mock/llama-test' })
  const heard = []
  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native turn timed out')), 60_000)
    driver = provider.hold({ id, root: project, mode: 'manual', model: 'mock/llama-test', resume: true }, (event) => {
      heard.push(event)
      for (const signal of event.signals) if (signal.kind === 'asks') driver.answer(signal.ask, 'once')
      const end = event.signals.find((signal) => signal.kind === 'ended')
      if (end) { clearTimeout(timeout); resolve(end) }
    }, () => {})
  })
  driver.send('Read README.md, then say hello.')
  const result = await ended
  assert.equal(result.how, 'done', JSON.stringify(result))
  const saved = await provider.read(project, id)
  assert.ok(saved.items.some((item) => item.kind === 'theirs' && item.text.includes('Mock Llama reply.')))
  assert.ok(heard.some((event) => event.items.some((item) => item.kind === 'theirs' && item.text.includes('Mock'))))
  assert.equal(heard.flatMap((event) => event.signals).filter((signal) => signal.kind === 'ended').length, 1)
  assert.ok(heard.flatMap((event) => event.signals).some((signal) => signal.kind === 'asks'), 'Native permission card was received')
  assert.ok(saved.items.some((item) => item.kind === 'did'), 'Native read tool persisted')
  await driver.end()
  const listed = await provider.list([project])
  assert.ok(listed.some((row) => row.id === id))
  const fork = await provider.fork(project, id, Date.now(), 'manual', 'mock/llama-test')
  assert.ok(fork.items.some((item) => item.kind === 'theirs'))
  await provider.rename(id, 'Native smoke')
  assert.ok((await provider.search([project], 'hello')).length)
  await provider.delete(project, fork.id)
  await provider.delete(project, id)
  const report = { version: (await provider.program()).version, models, completed: result, itemKinds: saved.items.map((item) => item.kind), mockRequests: requests, history: 'read/list/search/rename/fork/delete and native permission pass', root: base }
  await writeFile(join(base, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await driver?.end()
  provider.dispose()
  await new Promise((resolve) => server.close(resolve))
}
