import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { OpenCodeV2 } from './v2.mjs'

export class OpenCodeTransport {
  constructor({ executable = process.env.GECKIT_OPENCODE_BIN ?? 'opencode', launch = spawn, fetcher = fetch, startupMs = 15_000 } = {}) {
    this.executable = executable
    this.launch = launch
    this.fetcher = fetcher
    this.startupMs = startupMs
    this.disposed = false
    this.requests = new Set()
    this.v2 = new OpenCodeV2(this)
  }

  start() {
    if (this.disposed) return Promise.reject(new Error('OpenCode library has been disposed.'))
    if (this.starting) return this.starting
    this.password = randomBytes(24).toString('hex')
    this.starting = new Promise((resolve, reject) => {
      const child = this.launch(this.executable, ['serve', '--hostname=127.0.0.1', '--port=0'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, OPENCODE_SERVER_USERNAME: 'geckit', OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_PASSWORD: this.password },
      })
      this.child = child
      let output = ''
      let settled = false
      const fail = (error) => {
        clearTimeout(timer)
        if (!settled) { settled = true; reject(error) }
        if (this.child === child) { this.child = undefined; this.starting = undefined }
        for (const controller of this.requests) controller.abort(error)
        child.kill()
      }
      const timer = setTimeout(() => fail(new Error('OpenCode server did not start within 15 seconds.')), this.startupMs)
      child.once('error', (error) => fail(new Error(`Cannot start OpenCode: ${error.message}`)))
      child.once('close', () => fail(new Error('OpenCode server exited.')))
      child.stderr.on('data', () => {})
      child.stdout.on('data', (data) => {
        if (settled) return
        output = (output + data.toString()).slice(-8192)
        const found = /(?:^|\n)(opencode )?server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
        if (!found) return
        this.protocol = found[1] ? 1 : 2
        const url = new URL(found[2])
        if (url.port === '0') return
        settled = true
        clearTimeout(timer)
        resolve(url.origin)
      })
    })
    const pending = this.starting
    void pending.catch(() => { if (this.starting === pending) this.starting = undefined })
    return this.starting
  }

  async response(root, path, method, body, signal, timeoutMs = 30_000) {
    if (root?.startsWith('ssh://')) throw new Error('OpenCode (Llama) runs only on this computer.')
    const base = await this.start()
    if (signal?.aborted) throw signal.reason
    const url = new URL(path, base)
    if (root) url.searchParams.set(this.protocol === 2 && url.pathname !== '/api/session' ? 'location[directory]' : 'directory', root)
    const controller = new AbortController()
    this.requests.add(controller)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('OpenCode request timed out.')), timeoutMs) : undefined
    const release = () => { clearTimeout(timer); this.requests.delete(controller) }
    try {
      const response = await this.fetcher(url, {
        method, signal: combined,
        headers: { Authorization: `Basic ${Buffer.from(`${this.protocol === 2 ? 'opencode' : 'geckit'}:${this.password}`).toString('base64')}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2000)
        throw Object.assign(new Error(`OpenCode ${method} ${url.pathname}: ${response.status} ${detail}`), { status: response.status })
      }
      return { response, release, controller }
    } catch (error) { release(); throw error }
  }

  async request(root, path, method = 'GET', body, signal, timeoutMs) {
    await this.start()
    return this.protocol === 2 ? this.v2.request(root, path, method, body, signal, timeoutMs) : this.rawRequest(root, path, method, body, signal, timeoutMs)
  }

  async rawRequest(root, path, method = 'GET', body, signal, timeoutMs) {
    const { response, release } = await this.response(root, path, method, body, signal, timeoutMs)
    try { return response.status === 204 ? undefined : await response.json() }
    finally { release() }
  }

  async subscribe(root, hear, failed, signal, sessionID) {
    await this.start()
    return this.protocol === 2 ? this.v2.subscribe(root, hear, failed, signal, sessionID) : this.subscribeAt(root, '/event', hear, failed, signal)
  }

  async subscribeAt(root, path, hear, failed, signal) {
    const { response, release, controller } = await this.response(root, path, 'GET', undefined, signal)
    if (!response.body) { release(); throw new Error('OpenCode event stream is missing.') }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const pump = async () => {
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) throw new Error('OpenCode event stream disconnected.')
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
          let at
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (data) hear(JSON.parse(data))
          }
          if (buffer.length > 4_000_000) throw new Error('OpenCode event frame is too large.')
        }
      } catch (error) { if (!signal?.aborted && (!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError')) failed(error) }
      finally { release(); reader.releaseLock() }
    }
    // The header deadline applies to connection only; a conversation can stay idle indefinitely.
    release()
    this.requests.add(controller)
    const done = pump().finally(() => this.requests.delete(controller))
    return { close: async () => { controller.abort(); await reader.cancel().catch(() => {}); await done } }
  }

  dispose() {
    this.disposed = true
    for (const controller of this.requests) controller.abort(new Error('OpenCode library disposed.'))
    this.child?.kill()
  }
}
