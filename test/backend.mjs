export class Backend {
  constructor() {
    this.calls = []
    this.sessions = new Map()
    this.history = new Map()
    this.streams = new Set()
    this.prompts = []
    this.providers = { connected: ['ollama'], all: [{ id: 'ollama', models: {
      'llama3.1:8b': { name: 'Llama 3.1', limit: { context: 16384, output: 4096 }, cost: { input: 0, output: 0 } },
      'qwen3': { name: 'Qwen 3' },
    } }, { id: 'hosted', models: { llama: { name: 'Disconnected Llama' } } }] }
    this.config = { model: 'ollama/llama3.1:8b' }
  }
  session(directory, title = 'Task') {
    const id = `ses_${this.sessions.size + 1}`
    const saved = { id, directory, title, time: { created: 100, updated: 200 } }
    this.sessions.set(id, saved)
    this.history.set(id, [])
    return saved
  }
  emit(sessionID, type, properties = {}) {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type, properties: { sessionID, ...properties } })}\n\n`)
    for (const stream of this.streams) if (stream.root === this.sessions.get(sessionID)?.directory) stream.controller.enqueue(bytes)
  }
  complete(prompt, error, cost = 0) {
    prompt.info = { ...prompt.info, cost, tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 10, write: 0 } }, ...(error ? { error: { name: 'UnknownError', data: { message: error } } } : {}) }
    prompt.part.text = 'Hello https://example.com.'
    this.history.get(prompt.id).push({ info: prompt.info, parts: [prompt.part] })
    this.emit(prompt.id, 'message.updated', { info: prompt.info })
    this.emit(prompt.id, 'message.part.updated', { part: prompt.part })
    this.emit(prompt.id, 'session.status', { status: { type: 'idle' } })
    this.emit(prompt.id, 'session.idle')
    prompt.resolve(new Response(JSON.stringify({ info: prompt.info, parts: [prompt.part] })))
  }
  fetch = async (given, options) => {
    const url = new URL(given)
    const root = url.searchParams.get('directory')
    const path = url.pathname
    const body = options.body ? JSON.parse(options.body) : undefined
    this.calls.push({ root, path, method: options.method, body, headers: options.headers })
    const json = (value) => new Response(JSON.stringify(value))
    if (path === '/global/health') return json({ healthy: true, version: '1.18.35' })
    if (path === '/provider') return json(this.providers)
    if (path === '/config') return json(this.config)
    if (path === '/mcp') return json({ local: { status: 'connected' } })
    if (path.startsWith('/mcp/')) return json(true)
    if (path === '/event') {
      let stream
      return new Response(new ReadableStream({
        start: (controller) => {
          stream = { root, controller }
          this.streams.add(stream)
          options.signal.addEventListener('abort', () => { this.streams.delete(stream); controller.error(options.signal.reason) }, { once: true })
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\r\n\r\n'))
        },
        cancel: () => this.streams.delete(stream),
      }))
    }
    if (path === '/session') return json(options.method === 'POST' ? this.session(root, body?.title) : [...this.sessions.values()])
    if (path.startsWith('/permission/') || path.startsWith('/question/')) return json(true)
    const [, id, operation] = /^\/session\/(ses_[A-Za-z0-9]+)(?:\/(.*))?$/.exec(path) ?? []
    const saved = this.sessions.get(id)
    if (!saved) return new Response('not found', { status: 404 })
    if (!operation) {
      if (options.method === 'DELETE') { this.sessions.delete(id); this.history.delete(id); return json(true) }
      if (options.method === 'PATCH') Object.assign(saved, body)
      return json(saved)
    }
    if (operation === 'message' && options.method === 'GET') return json(this.history.get(id))
    if (operation === 'fork') {
      const fork = this.session(root, saved.title)
      const history = this.history.get(id)
      const index = body.messageID ? history.findIndex(({ info }) => info.id === body.messageID) : history.length
      this.history.set(fork.id, structuredClone(history.slice(0, index)))
      return json(fork)
    }
    if (operation === 'abort') return json(true)
    if (operation === 'message' && options.method === 'POST') {
      return new Promise((resolve, reject) => {
        const number = this.prompts.length
        const user = { id: `msg_user${number}`, sessionID: id, role: 'user', time: { created: 300 + number * 100 }, model: body.model }
        const userPart = { id: `prt_user${number}`, sessionID: id, messageID: user.id, type: 'text', text: body.parts[0].text }
        this.history.get(id).push({ info: user, parts: [userPart] })
        this.emit(id, 'message.updated', { info: user })
        this.emit(id, 'message.part.updated', { part: userPart })
        const info = { id: `msg_assistant${number}`, sessionID: id, role: 'assistant', time: { created: 350 + number * 100 }, providerID: body.model.providerID, modelID: body.model.modelID }
        const part = { id: `prt_text${number}`, sessionID: id, messageID: info.id, type: 'text', text: 'Hel' }
        const prompt = { id, info, part, body, resolve, reject }
        this.prompts.push(prompt)
        this.emit(id, 'message.updated', { info })
        this.emit(id, 'message.part.updated', { part: { ...part } })
        this.emit(id, 'message.part.delta', { messageID: info.id, partID: part.id, field: 'text', delta: 'lo' })
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        if (this.auto) queueMicrotask(() => this.complete(prompt))
      })
    }
    throw new Error(`Unexpected route ${path}`)
  }
}
