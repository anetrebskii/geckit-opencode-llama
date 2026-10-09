import { v2Question } from './v2-transcript.mjs'

export function v2Events(hear, requests, forms, failures, ownedSession) {
  const messages = new Map()
  const parts = new Map()
  const emit = (type, properties) => hear({ type, properties })
  const updatePart = (part) => { parts.set(part.id, part); emit('message.part.updated', { part }) }
  return (event) => {
    const p = event.data
    if (!p) return
    const sessionID = p.sessionID ?? p.form?.sessionID
    if (ownedSession && sessionID !== ownedSession) return
    if (event.type === 'session.execution.started') failures.delete(sessionID)
    if (event.type === 'session.execution.failed') failures.set(sessionID, p.error)
    if (event.type === 'permission.asked') {
      requests.set(p.id, p.sessionID)
      emit('permission.asked', { ...p, permission: p.action, patterns: p.resources })
    }
    if (event.type === 'permission.replied') { requests.delete(p.requestID); emit(event.type, p) }
    if (event.type === 'form.created') {
      forms.set(p.form.id, p.form)
      emit('question.asked', v2Question(p.form))
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      forms.delete(p.id)
      emit(event.type === 'form.replied' ? 'question.replied' : 'question.rejected', { ...p, requestID: p.id })
    }
    const messageID = p.assistantMessageID
    if (event.type === 'session.step.started') {
      const info = { id: messageID, sessionID, role: 'assistant', providerID: p.model.providerID, modelID: p.model.id, time: { created: p.started } }
      messages.set(messageID, info)
      emit('message.updated', { info })
    }
    if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
      const info = { ...messages.get(messageID), id: messageID, sessionID, role: 'assistant', cost: p.cost, tokens: p.tokens, error: p.error }
      messages.set(messageID, info)
      emit('message.updated', { info })
    }
    const fragment = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(event.type)
    if (fragment) {
      const [, type, phase] = fragment
      const id = `${messageID}:${type}:${p.ordinal}`
      const previous = parts.get(id)
      updatePart({ id, sessionID, messageID, type, text: phase === 'delta' ? (previous?.text ?? '') + p.delta : p.text ?? '' })
    }
    if (event.type.startsWith('session.tool.')) {
      const id = `${messageID}:tool:${p.id}`
      const previous = parts.get(id)
      const base = { id, sessionID, messageID, type: 'tool', tool: p.name ?? previous?.tool }
      const state = previous?.state ?? { status: 'pending', input: '' }
      if (event.type === 'session.tool.input.started') updatePart({ ...base, state })
      if (event.type === 'session.tool.input.delta') updatePart({ ...base, state: { ...state, input: state.input + p.delta } })
      if (event.type === 'session.tool.input.ended') updatePart({ ...base, state: { ...state, input: p.text } })
      if (event.type === 'session.tool.called') updatePart({ ...base, state: { status: 'running', input: p.input } })
      if (event.type === 'session.tool.progress') updatePart({ ...base, state: { ...state, title: p.metadata.title } })
      if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') updatePart({
        ...base, state: { ...state, status: p.error ? 'error' : 'completed', error: p.error?.message,
          output: p.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') },
      })
    }
    if (event.type === 'session.retry.scheduled') emit('session.status', { sessionID, status: { type: 'retry', message: p.error.message } })
    if (event.type.startsWith('session.execution.') && event.type !== 'session.execution.started') {
      for (const [id, info] of messages) if (info.sessionID === sessionID) messages.delete(id)
      for (const [id, part] of parts) if (part.sessionID === sessionID) parts.delete(id)
      for (const [id, owner] of requests) if (owner === sessionID) requests.delete(id)
      for (const [id, form] of forms) if (form.sessionID === sessionID) forms.delete(id)
    }
  }
}
