export const v2Rules = (rules) => rules.map((rule) => ({ action: rule.permission === 'bash' ? 'shell' : rule.permission, resource: rule.pattern, effect: rule.action }))
export const v2Session = (session) => ({ ...session, directory: session.location.directory })

export function v2Message(message, sessionID) {
  const role = message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : undefined
  const info = {
    ...message, sessionID, role, providerID: message.model?.providerID, modelID: message.model?.id,
  }
  if (!role) return { info, parts: [] }
  if (role === 'user') return { info, parts: [{ id: `${message.id}:text:0`, sessionID, messageID: message.id, type: 'text', text: message.text }] }
  const ordinals = { text: 0, reasoning: 0 }
  const parts = message.content.map((content) => {
    const base = { sessionID, messageID: message.id, type: content.type }
    if (content.type !== 'tool') return { ...content, ...base, id: `${message.id}:${content.type}:${ordinals[content.type]++}` }
    return {
      ...base, id: `${message.id}:tool:${content.id}`, tool: content.name,
      state: {
        ...content.state,
        status: content.state.status === 'streaming' ? 'pending' : content.state.status,
        title: content.state.metadata?.title,
        output: content.state.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n'),
        error: content.state.error?.message,
      },
    }
  })
  return { info, parts }
}

export function v2Catalog(providers, models) {
  return {
    connected: providers.map((provider) => provider.id),
    all: providers.map((provider) => ({
      ...provider,
      models: Object.fromEntries(models.filter((model) => model.providerID === provider.id && model.enabled).map((model) => {
        const cost = model.cost.find((tier) => !tier.tier)
        return [model.id, {
          ...model,
          cost: cost && { input: cost.input, output: cost.output, cache_read: cost.cache.read, cache_write: cost.cache.write },
        }]
      })),
    })),
  }
}

export function v2Question(form) {
  const supported = form.metadata?.kind === 'question' && form.fields.every((field) =>
    (field.type === 'string' || field.type === 'multiselect') && !field.when?.length && !field.hidden)
  return {
    id: form.id, sessionID: form.sessionID,
    ...(supported ? {} : { error: 'This OpenCode form cannot be answered in GeckIt. Use a question with text or choices.' }),
    questions: supported ? form.fields.map((field) => ({
      question: field.description ?? field.title ?? form.title,
      options: (field.options ?? []).map((option) => ({ label: option.label, description: option.description })),
      custom: field.custom !== false,
    })) : [],
  }
}
