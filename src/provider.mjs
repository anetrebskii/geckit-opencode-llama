import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { OpenCodeTransport } from './transport.mjs'
import { holdOpenCode } from './driver.mjs'
import { catalog, conversation, errorText, family, geckitId, linksIn, nativeId, permissions } from './transcript.mjs'

const noModel = 'No Ollama models available. Start Ollama and make a model available to OpenCode.'
const local = (root) => {
  if (root.startsWith('ssh://')) throw new Error('OpenCode + Ollama runs only on this computer.')
  try { return realpathSync(resolve(root)) }
  catch { return resolve(root) }
}

export function create(_host, { transport = new OpenCodeTransport() } = {}) {
  const roots = new Map()
  const windows = new Map()
  const state = {
    transport, drivers: new Set(), grants: new Map(), instructions: undefined,
    async session(root, id) {
      const native = nativeId(id)
      const saved = await transport.request(root, `/session/${native}`)
      if (local(saved.directory) !== local(root)) throw new Error('OpenCode conversation belongs to another folder.')
      roots.set(id, local(root))
      return saved
    },
    async chooseModel(root, value) {
      const models = await provider.models(root)
      const model = value ? models.find((model) => model.value === value) : models.find((model) => model.isDefault) ?? models[0]
      if (!model) throw new Error(value ? `Ollama model is not available: ${value}` : noModel)
      return model
    },
  }
  const rootFor = async (id) => {
    nativeId(id)
    const root = roots.get(id)
    if (root) return root
    const saved = await transport.request(undefined, `/session/${nativeId(id)}`)
    roots.set(id, local(saved.directory))
    return saved.directory
  }
  const missing = (error) => error.status === 404
  const provider = {
    id: family, family, name: 'OpenCode + Ollama', shortName: 'Ollama', icon: 'opencode-llama',
    browser: 'none', loginCommand: 'opencode auth login', planName: '',
    localOnly: true, available: true, subscriptionOnly: false, images: false,
    remoteControl: false, nativeGoals: false, idleMs: 10 * 60_000, waitForExit: true,
    async account() {
      try { return { provider: family, here: true, signedIn: true, program: await provider.program() } }
      catch { return { provider: family, here: false, signedIn: undefined } }
    },
    async program() {
      const health = await transport.request(undefined, '/global/health')
      return { version: health.version, path: transport.executable }
    },
    async models(root) {
      if (root?.startsWith('ssh://')) return []
      const [data, config] = await Promise.all([transport.request(root, '/provider'), transport.request(root, '/config')])
      const models = catalog(data, config.model)
      if (models.length && !models.some((model) => model.isDefault)) models[0].isDefault = true
      for (const model of models) if (model.contextWindow !== undefined) windows.set(model.value, model.contextWindow)
      return models
    },
    async limits(models) { return { windows: new Map(models.map((id) => [id, windows.get(id)])) } },
    async create({ root, model }) {
      local(root)
      await state.chooseModel(root, model)
      const session = await transport.request(root, '/session', 'POST', { permission: permissions })
      const id = geckitId(session.id)
      nativeId(id)
      roots.set(id, local(root))
      return id
    },
    async list(askedRoots) {
      const rows = []
      const folders = new Map()
      for (const root of askedRoots.filter((root) => !root.startsWith('ssh://'))) {
        const folder = local(root)
        if (!folders.has(folder)) folders.set(folder, root)
      }
      for (const [folder, root] of folders) {
        const saved = await transport.request(root, '/session')
        for (const session of saved) {
          if (local(session.directory) !== folder || session.time?.archived) continue
          const id = geckitId(session.id)
          nativeId(id)
          roots.set(id, root)
          rows.push({ id, root, title: session.title ?? 'OpenCode conversation', stands: '', at: session.time.updated, created: session.time.created, driven: false })
        }
      }
      return rows
    },
    async search(askedRoots, asked) {
      if (!asked.trim()) return []
      const found = []
      const needle = asked.toLocaleLowerCase()
      for (const row of await provider.list(askedRoots)) {
        const saved = await provider.read(row.root, row.id)
        const matches = (saved?.items ?? []).filter((item) => (item.kind === 'mine' || item.kind === 'theirs') && item.text.toLocaleLowerCase().includes(needle))
        if (matches.length) {
          const text = matches.at(-1).text
          const start = Math.max(0, text.toLocaleLowerCase().indexOf(needle) - 80)
          found.push({ id: row.id, root: row.root, count: matches.length, said: text.slice(start, start + 240) })
        }
      }
      return found
    },
    hidden: async () => [],
    async has(root, id) {
      try { await state.session(root, id); return true }
      catch (error) { if (missing(error)) return false; throw error }
    },
    async read(root, id) {
      try {
        await state.session(root, id)
        const messages = await transport.request(root, `/session/${nativeId(id)}/message`)
        const last = messages.findLast(({ info }) => info.role === 'assistant')?.info
        const model = last ? `${last.providerID}/${last.modelID}` : undefined
        return conversation(messages, windows.get(model))
      } catch (error) { if (missing(error)) return undefined; throw error }
    },
    links: async (root, id) => linksIn((await provider.read(root, id))?.items ?? []),
    async fork(root, id, at, _mode, model) {
      await state.session(root, id)
      await state.chooseModel(root, model)
      const messages = await transport.request(root, `/session/${nativeId(id)}/message`)
      // OpenCode forks before messageID, rather than including that message.
      const after = messages.find(({ info }) => info.time.created > at)?.info.id
      const saved = await transport.request(root, `/session/${nativeId(id)}/fork`, 'POST', after ? { messageID: after } : {})
      const fork = geckitId(saved.id)
      nativeId(fork)
      roots.set(fork, local(root))
      return { id: fork, begun: true, items: (await provider.read(root, fork))?.items ?? [] }
    },
    hold(options, hear, left) { local(options.root); return holdOpenCode(state, options, hear, left) },
    async rename(id, title) { await transport.request(await rootFor(id), `/session/${nativeId(id)}`, 'PATCH', { title }) },
    async delete(root, id) {
      try {
        await state.session(root, id)
        const result = await transport.request(root, `/session/${nativeId(id)}`, 'DELETE')
        roots.delete(id)
        return result === true
      } catch (error) { if (missing(error)) return false; throw error }
    },
    goal: async () => undefined, setGoal: async () => undefined, clearGoal: async () => {},
    remote: async () => { throw new Error('OpenCode + Ollama does not support remote control.') },
    browsers: async () => undefined,
    async mcp(root, change) {
      if (change) await transport.request(root, `/mcp/${encodeURIComponent(change.name)}/${change.enabled ? 'connect' : 'disconnect'}`, 'POST')
      const servers = await transport.request(root, '/mcp')
      return Object.entries(servers).map(([name, value]) => ({ name, status: value.status }))
    },
    async correct(text, instruction, model) {
      const root = homedir()
      let id
      try {
        const selected = await state.chooseModel(root, model || undefined)
        const slash = selected.value.indexOf('/')
        const session = await transport.request(root, '/session', 'POST', { title: 'GeckIt correction', permission: [{ permission: '*', pattern: '*', action: 'deny' }] })
        id = session.id
        const result = await transport.request(root, `/session/${id}/message`, 'POST', {
          model: { providerID: selected.value.slice(0, slash), modelID: selected.value.slice(slash + 1) },
          system: 'Return only the requested text. Do not use tools.',
          tools: { '*': false }, parts: [{ type: 'text', text: `${instruction}\n\n${text}` }],
        }, undefined, 90_000)
        if (result.info.error) return { ok: false, error: errorText(result.info.error) }
        const answer = result.parts.filter((part) => part.type === 'text' && !part.ignored && !part.synthetic).map((part) => part.text).join('\n').trim()
        return answer ? { ok: true, text: answer } : { ok: false, error: 'OpenCode returned no correction.' }
      } catch (error) { return { ok: false, error: errorText(error) } }
      finally {
        if (id) {
          await transport.request(root, `/session/${id}/abort`, 'POST').catch(() => {})
          await transport.request(root, `/session/${id}`, 'DELETE').catch(() => {})
        }
      }
    },
    async setInstructions(enabled) {
      const command = process.env.GECKIT_SOURCE_CLI ?? `${homedir()}/.geckit/bin/geckit`
      state.instructions = enabled ? `This conversation is running in GeckIt. Use ${command} for board and conversation operations; run ${command} instructions app to read app guidance. Follow project AGENTS.md instructions. Never fabricate session links or claim unsupported native goals.` : undefined
    },
    dispose() {
      for (const driver of state.drivers) void driver.end()
      transport.dispose()
    },
  }
  return provider
}
