import { errorText, geckitId, nativeId, partItem, permissions, spend } from './transcript.mjs'

export function holdOpenCode(provider, options, hear, left) {
  const id = nativeId(options.id)
  const { transport } = provider
  const root = options.root
  const messages = new Map()
  const parts = new Map()
  const sealedMessages = new Set()
  const sealedParts = new Set()
  const requests = new Map()
  const grants = provider.grants.get(id) ?? []
  provider.grants.set(id, grants)
  let disposed = false
  let active
  let stream
  let mode = options.mode === 'plan' ? 'plan' : 'manual'
  let cost = 0
  let measuredCost = false
  let stopping = Promise.resolve()
  let appliedMode
  let capacity
  let ready
  let ending
  const emit = (items = [], signals = [], gone = []) => hear({ items, signals, gone })
  const finish = (turn, how, text) => {
    if (active !== turn) return
    active = undefined
    for (const ask of [...requests.keys()]) resolveRequest(ask, how === 'stopped' ? 'Stopped' : 'Turn ended')
    emit([], [{ kind: 'ended', how, ...(text === undefined ? {} : { text }) }])
  }
  const fail = (error) => {
    if (!active) return
    const turn = active
    turn.controller.abort(error)
    stopping = Promise.resolve().then(async () => {
      await ready?.catch(() => {})
      if (turn.prompted) await transport.request(root, `/session/${id}/abort`, 'POST').catch(() => {})
    })
    finish(turn, 'failed', errorText(error))
  }
  const updateInfo = (info) => {
    const previous = messages.get(info.id)
    messages.set(info.id, info)
    if (info.role === 'assistant' && active) {
      if (Number.isFinite(info.cost)) { measuredCost = true; cost += info.cost - (previous?.cost ?? 0) }
      emit([], [{ kind: 'spend', ...spend(info, capacity), ...(measuredCost ? { cost, currency: 'USD', costKind: 'api-equivalent' } : {}) }])
    }
    emit([...parts.values()].filter((part) => part.messageID === info.id).map((part) => partItem(part, info)).filter(Boolean))
  }
  const updatePart = (part) => {
    parts.set(part.id, part)
    const item = partItem(part, messages.get(part.messageID))
    if (item) emit([item], item.kind === 'did' && item.live ? [{ kind: 'doing', what: item.what }] : [])
  }
  const card = (ask, wanted, shown) => {
    emit([{ kind: 'card', id: `card:${ask}`, card: shown }], [{ kind: 'asks', ask, wanted }])
  }
  const resolveRequest = (requestID, answer) => {
    const request = requests.get(requestID)
    if (!request) return
    const asks = request.kind === 'question' ? request.questions.map((_, index) => index === 0 ? requestID : `${requestID}#${index}`) : [requestID]
    for (const ask of asks) {
      const shown = request.cards.get(ask)
      emit(shown ? [{ kind: 'card', id: `card:${ask}`, card: { ...shown, answered: answer } }] : [], [{ kind: 'resolved', ask }])
    }
    requests.delete(requestID)
  }
  const event = ({ type, properties: p = {} }) => {
    const session = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID
    if (session !== id) return
    if (type === 'message.updated' && !sealedMessages.has(p.info.id)) updateInfo(p.info)
    if (type === 'message.part.updated' && !sealedParts.has(p.part.id)) updatePart(p.part)
    if (type === 'message.part.delta') {
      const part = parts.get(p.partID)
      if (part && !sealedParts.has(p.partID) && p.field === 'text') updatePart({ ...part, text: (part.text ?? '') + p.delta })
    }
    if (type === 'message.part.removed') { parts.delete(p.partID); emit([], [], [p.partID]) }
    if (type === 'message.removed') {
      const gone = [...parts.values()].filter((part) => part.messageID === p.messageID).map((part) => part.id)
      for (const part of gone) parts.delete(part)
      messages.delete(p.messageID)
      emit([], [], gone)
    }
    if (type === 'permission.asked' && active && !requests.has(p.id)) {
      if (grants.some((grant) => grant.permission === p.permission && p.patterns.every((pattern) => grant.patterns.includes(pattern)))) {
        void transport.request(root, `/permission/${encodeURIComponent(p.id)}/reply`, 'POST', { reply: 'once' }).catch(fail)
        return
      }
      const detail = (p.patterns ?? []).join('\n')
      const shown = { kind: 'permission', title: `Allow ${p.permission}?`, detail }
      requests.set(p.id, { kind: 'permission', permission: p.permission, patterns: p.patterns, cards: new Map([[p.id, shown]]) })
      card(p.id, { kind: 'other', tool: p.permission, detail }, shown)
    }
    if (type === 'question.asked' && active && !requests.has(p.id)) {
      const cards = new Map()
      requests.set(p.id, { kind: 'question', questions: p.questions, answers: [], cards })
      p.questions.forEach((question, index) => {
        const ask = index === 0 ? p.id : `${p.id}#${index}`
        const choices = question.options.map((option) => option.label)
        const shown = { kind: 'question', title: question.question, choices }
        cards.set(ask, shown)
        card(ask, { kind: 'question', question: question.question, choices }, shown)
      })
    }
    if (type === 'permission.replied') resolveRequest(p.requestID, requests.get(p.requestID)?.answerLabel ?? (p.reply === 'reject' ? 'Declined' : 'Allowed once'))
    if (type === 'question.replied' || type === 'question.rejected') resolveRequest(p.requestID, type === 'question.rejected' ? 'Declined' : 'Answered')
    if (type === 'session.status' && p.status?.type === 'retry') emit([], [{ kind: 'doing', what: p.status.message }])
    // Prompt's HTTP result is authoritative; OpenCode sends two idle events and some nonfatal session.error events.
  }
  const prepare = async () => {
    await provider.session(root, options.id)
    const history = await transport.request(root, `/session/${id}/message`)
    for (const { info, parts: saved } of history) {
      messages.set(info.id, info)
      sealedMessages.add(info.id)
      for (const part of saved) { parts.set(part.id, part); sealedParts.add(part.id) }
    }
    stream = await transport.subscribe(root, event, (error) => {
      ready = undefined
      stream = undefined
      fail(error)
    })
    if (disposed) await stream.close()
  }
  const run = async (turn, text, images, before) => {
    try {
      await stopping
      if (active !== turn || disposed) return
      if (images?.length) throw new Error('OpenCode (Llama) accepts text only.')
      ready ??= prepare().catch((error) => { ready = undefined; throw error })
      await ready
      if (active !== turn || disposed) return
      const model = await provider.chooseModel(root, options.model)
      if (active !== turn || disposed) return
      capacity = model.contextWindow
      const slash = model.value.indexOf('/')
      const rules = mode === 'plan' ? [...permissions, ...['edit', 'write', 'apply_patch', 'bash'].map((permission) => ({ permission, pattern: '*', action: 'deny' }))] : permissions
      if (appliedMode !== mode) {
        await transport.request(root, `/session/${id}`, 'PATCH', { permission: rules }, turn.controller.signal)
        appliedMode = mode
      }
      if (active !== turn || disposed) return
      emit([], [{ kind: 'started', session: geckitId(id), model: model.value, key: false, mode }])
      turn.prompted = true
      const result = await transport.request(root, `/session/${id}/message`, 'POST', {
        model: { providerID: model.value.slice(0, slash), modelID: model.value.slice(slash + 1) },
        agent: mode === 'plan' ? 'plan' : 'build',
        ...(provider.instructions ? { system: provider.instructions } : {}),
        parts: [{ type: 'text', text: [...(before ?? []), text].join('\n\n') }],
      }, turn.controller.signal, 0)
      if (active !== turn || disposed) return
      const saved = await transport.request(root, `/session/${id}/message`, 'GET', undefined, turn.controller.signal)
      if (active !== turn || disposed) return
      for (const { info, parts: finalParts } of saved) {
        if (sealedMessages.has(info.id)) continue
        updateInfo(info)
        sealedMessages.add(info.id)
        for (const part of finalParts) { updatePart(part); sealedParts.add(part.id) }
      }
      finish(turn, result.info.error ? 'failed' : 'done', result.info.error ? errorText(result.info.error) : undefined)
    } catch (error) { if (active === turn) fail(error) }
  }
  const stop = async () => {
    const turn = active
    if (!turn) return
    // Prevent startup from sending a prompt after Stop, then cancel the native generation.
    turn.controller.abort()
    stopping = Promise.resolve().then(async () => {
      await ready?.catch(() => {})
      if (disposed && !stream) return
      await transport.request(root, `/session/${id}/abort`, 'POST').catch(() => {})
    })
    finish(turn, 'stopped')
    await stopping
  }
  const driver = {
    send(text, images, before) {
      if (disposed) throw new Error('OpenCode driver has ended.')
      if (active) throw new Error('OpenCode is already answering this conversation.')
      const turn = { controller: new AbortController() }
      active = turn
      turn.done = run(turn, text, images, before)
    },
    answer(ask, answer) {
      const split = ask.lastIndexOf('#')
      const requestID = split < 0 ? ask : ask.slice(0, split)
      const request = requests.get(requestID)
      if (!request) return
      const turn = active
      void (async () => {
        if (request.kind === 'permission') {
          const reply = answer === 'once' || answer === 'session' ? 'once' : 'reject'
          request.answerLabel = answer === 'session' ? 'Allowed for session' : reply === 'reject' ? 'Declined' : 'Allowed once'
          await transport.request(root, `/permission/${encodeURIComponent(requestID)}/reply`, 'POST', { reply })
          if (answer === 'session') grants.push({ permission: request.permission, patterns: request.patterns })
          resolveRequest(requestID, request.answerLabel)
        } else {
          const index = split < 0 ? 0 : Number(ask.slice(split + 1))
          const question = request.questions[index]
          if (!question) return
          if (question.custom === false && !question.options.some((option) => option.label === answer)) throw new Error('Choose one of the answers OpenCode offered.')
          request.answers[index] = [String(answer)]
          if (!request.questions.every((_, i) => request.answers[i] !== undefined)) return
          await transport.request(root, `/question/${encodeURIComponent(requestID)}/reply`, 'POST', { answers: request.answers })
          resolveRequest(requestID, 'Answered')
        }
      })().catch((error) => { if (active === turn) fail(error) })
    },
    permit(_mode, again) {
      mode = 'manual'
      emit([], [{ kind: 'mode', mode }])
      for (const ask of again) driver.answer(ask, 'once')
    },
    stop() { void stop() },
    end() {
      ending ??= (async () => {
        disposed = true
        await stop()
        await stopping
        await ready?.catch(() => {})
        await stream?.close()
        provider.drivers.delete(driver)
        left()
      })()
      return ending
    },
  }
  provider.drivers.add(driver)
  return driver
}
