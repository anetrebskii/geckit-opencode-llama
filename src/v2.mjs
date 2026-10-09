import { v2Events } from './v2-events.mjs'
import { v2Catalog, v2Message, v2Rules, v2Session } from './v2-transcript.mjs'
import { setTimeout as delay } from 'node:timers/promises'

export class OpenCodeV2 {
  constructor(transport) {
    this.transport = transport
    this.requests = new Map()
    this.forms = new Map()
    this.failures = new Map()
  }

  async page(root, path, signal) {
    const data = []
    let cursor
    do {
      const separator = path.includes('?') ? '&' : '?'
      const page = await this.transport.rawRequest(root, `${path}${separator}${cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=asc'}`, 'GET', undefined, signal)
      data.push(...page.data)
      cursor = page.cursor.next
    } while (cursor)
    return data
  }

  async request(root, path, method, body, signal, timeoutMs) {
    const raw = (path, method = 'GET', body, deadline = 30_000) => this.transport.rawRequest(root, path, method, body, signal, deadline)
    if (path === '/global/health') return raw('/api/info')
    if (path === '/provider') {
      const config = await raw('/api/config')
      const configured = new Map()
      for (const entry of config.filter((entry) => entry.type === 'document')) {
        for (const [id, provider] of Object.entries(entry.info.providers ?? {})) {
          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            configured.set(`${id}/${modelID}`, !model.disabled && /llama/i.test(`${modelID} ${model.name ?? ''}`))
          }
        }
      }
      const expected = [...configured].filter(([, enabled]) => enabled).map(([id]) => id)
      const deadline = Date.now() + this.transport.startupMs
      for (;;) {
        const [providers, models] = await Promise.all([raw('/api/provider'), raw('/api/model')])
        const present = new Set(models.data.filter((model) => model.enabled).map((model) => `${model.providerID}/${model.id}`))
        if (expected.every((id) => present.has(id))) return v2Catalog(providers.data, models.data)
        if (Date.now() >= deadline) throw new Error('OpenCode did not load the configured Llama models.')
        await delay(100, undefined, { signal })
      }
    }
    if (path === '/config') {
      const { data: model } = await raw('/api/model/default')
      return { model: model ? `${model.providerID}/${model.id}` : undefined }
    }
    if (path === '/session') {
      if (method === 'GET') return (await this.page(root, '/api/session', signal)).map(v2Session)
      const { permission, ...other } = body
      const result = await raw('/api/session', method, { ...other, location: { directory: root }, permissions: v2Rules(permission ?? []) })
      return v2Session(result.data)
    }
    const session = /^\/session\/(ses_[A-Za-z0-9]+)(?:\/(message|abort|fork))?$/.exec(path)
    if (session) {
      const [, id, action] = session
      const base = `/api/session/${id}`
      if (!action) {
        if (method === 'GET') return v2Session((await raw(base)).data)
        if (method === 'DELETE') { await raw(base, method); return true }
        const { permission, ...other } = body
        await raw(base, method, { ...other, ...(permission ? { permissions: v2Rules(permission) } : {}) })
        return
      }
      if (action === 'abort') return raw(`${base}/interrupt`, 'POST')
      if (action === 'fork') return v2Session((await raw(`${base}/fork`, method, body.messageID ? { before: body.messageID } : {})).data)
      if (method === 'GET') return (await this.page(undefined, `${base}/message`, signal)).map((message) => v2Message(message, id))
      await raw(`${base}/model`, 'POST', { model: { providerID: body.model.providerID, id: body.model.modelID } })
      await raw(`${base}/agent`, 'POST', { agent: body.agent ?? 'build' })
      const instruction = `/api/experimental/session/${id}/instructions/entries/geckit`
      if (body.system) await raw(instruction, 'PUT', { value: body.system })
      else await raw(instruction, 'DELETE')
      await raw(`${base}/prompt`, 'POST', { text: body.parts.map((part) => part.text).join('\n'), delivery: 'steer' })
      await raw(`/api/experimental/session/${id}/wait`, 'POST', undefined, timeoutMs ?? 0)
      const messages = await this.page(undefined, `${base}/message`, signal)
      const assistant = messages.findLast((message) => message.type === 'assistant')
      const result = assistant ? v2Message(assistant, id) : { info: {}, parts: [] }
      const idle = messages.findLast((message) => message.type === 'idle')
      if (idle?.outcome === 'failed') result.info.error ??= this.failures.get(id) ?? { message: 'OpenCode execution failed.' }
      if (idle?.outcome === 'interrupted') result.info.error ??= { message: 'OpenCode execution was interrupted.' }
      this.failures.delete(id)
      return result
    }
    const permission = /^\/permission\/([^/]+)\/reply$/.exec(path)
    if (permission) {
      const id = decodeURIComponent(permission[1])
      const owner = this.requests.get(id)
      if (!owner) throw new Error('OpenCode permission request is no longer pending.')
      await raw(`/api/session/${owner}/permission/${encodeURIComponent(id)}/reply`, 'POST', { decision: body.reply })
      this.requests.delete(id)
      return true
    }
    const question = /^\/question\/([^/]+)\/reply$/.exec(path)
    if (question) {
      const id = decodeURIComponent(question[1])
      const form = this.forms.get(id)
      if (!form) throw new Error('OpenCode question is no longer pending.')
      const answer = Object.fromEntries(form.fields.map((field, i) => {
        const values = body.answers[i].map((label) => field.options?.find((option) => option.label === label)?.value ?? label)
        return [field.key, field.type === 'multiselect' ? values : values[0]]
      }))
      await raw(`/api/session/${form.sessionID}/form/${encodeURIComponent(id)}/reply`, 'POST', { answer })
      this.forms.delete(id)
      return true
    }
    if (path === '/mcp') {
      const { data } = await raw('/api/mcp')
      return Object.fromEntries(data.map((server) => [server.name, server.status]))
    }
    if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(path)) return raw(`/api/experimental${path}`, method)
    throw new Error(`OpenCode 2 operation is unsupported: ${method} ${path}`)
  }

  subscribe(root, hear, failed, signal, sessionID) {
    return this.transport.subscribeAt(undefined, '/api/event', v2Events(hear, this.requests, this.forms, this.failures, sessionID), failed, signal)
  }
}
