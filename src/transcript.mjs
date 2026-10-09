export const family = 'plugin:opencode-llama'
export const geckitId = (id) => `${family}:${id}`
export function nativeId(id) {
  if (typeof id !== 'string' || !id.startsWith(`${family}:`) || !/^ses_[A-Za-z0-9]+$/.test(id.slice(family.length + 1))) throw new Error('Session does not belong to OpenCode (Llama).')
  return id.slice(family.length + 1)
}
export const errorText = (error) => error?.data?.message ?? error?.message ?? 'OpenCode request failed.'
export const permissions = [
  { permission: '*', pattern: '*', action: 'ask' },
  { permission: 'question', pattern: '*', action: 'allow' },
]

export function catalog(data, defaultModel) {
  const connected = new Set(data.connected ?? [])
  return (data.all ?? []).filter((provider) => connected.has(provider.id)).flatMap((provider) =>
    Object.entries(provider.models ?? {}).filter(([id, model]) => /llama/i.test(`${id} ${model.name ?? ''}`)).map(([id, model]) => {
      const value = `${provider.id}/${id}`
      const cost = model.cost
      return {
        value, id: value, name: model.name ?? id,
        isDefault: value === defaultModel, supportsAutoMode: false,
        ...(model.limit?.context > 0 ? { contextWindow: model.limit.context } : {}),
        ...(model.limit?.output > 0 ? { maxOutputTokens: model.limit.output } : {}),
        ...(cost ? { pricing: {
          currency: 'USD',
          ...(Number.isFinite(cost.input) ? { input: cost.input } : {}),
          ...(Number.isFinite(cost.output) ? { output: cost.output } : {}),
          ...(Number.isFinite(cost.cache_read) ? { cacheRead: cost.cache_read } : {}),
          ...(Number.isFinite(cost.cache_write) ? { cacheWrite: cost.cache_write } : {}),
        } } : {}),
      }
    }))
}

export function partItem(part, info) {
  if (!info || part.ignored || part.synthetic) return undefined
  const at = info.time?.created
  if (part.type === 'text') return { kind: info.role === 'user' ? 'mine' : 'theirs', id: part.id, text: part.text ?? '', ...(at === undefined ? {} : { at }) }
  if (info.role !== 'assistant') return undefined
  if (part.type === 'reasoning') return { kind: 'thought', id: part.id, text: part.text ?? '' }
  if (part.type !== 'tool') return undefined
  const state = part.state ?? {}
  return {
    kind: 'did', id: part.id, what: state.title ?? part.tool,
    detail: state.output ?? state.error ?? JSON.stringify(state.input ?? {}),
    live: state.status === 'pending' || state.status === 'running',
  }
}

export function spend(info, window) {
  const tokens = info.tokens
  return {
    ...(tokens ? { used: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) } : {}),
    ...(window === undefined ? {} : { window }),
    ...(Number.isFinite(info.cost) ? { cost: info.cost, currency: 'USD', costKind: 'api-equivalent' } : {}),
  }
}

export function conversation(messages, window) {
  const items = messages.flatMap(({ info, parts }) => parts.map((part) => partItem(part, info)).filter(Boolean))
  const assistants = messages.map(({ info }) => info).filter((info) => info.role === 'assistant')
  const last = assistants.at(-1)
  return {
    items, tasks: [], ...(window === undefined ? {} : { window }),
    ...(assistants.some((info) => Number.isFinite(info.cost)) ? { cost: assistants.reduce((sum, info) => sum + (info.cost ?? 0), 0), currency: 'USD', costKind: 'api-equivalent' } : {}),
    ...(last === undefined ? {} : { used: spend(last).used }),
  }
}

export function linksIn(items) {
  const found = new Map()
  for (const item of [...items].reverse()) {
    if (item.kind !== 'mine' && item.kind !== 'theirs') continue
    for (const match of item.text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, '')
      if (!found.has(url)) found.set(url, { url })
    }
  }
  return [...found.values()]
}
