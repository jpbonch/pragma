import { iconForAgent } from './agentIcon'

export const ORCHESTRATOR_AGENT_ID = 'pragma-orchestrator'

export function getPendingCount(tasks) {
  return tasks.filter((task) => {
    const status = String(task.status).toLowerCase()
    return (
      status === 'pending_review' ||
      status === 'waiting_for_recipient' ||
      status === 'waiting_for_question_response' ||
      status === 'waiting_for_help_response'
    )
  }).length
}

export function isWaitingForHumanResponse(status) {
  return status === 'waiting_for_question_response' || status === 'waiting_for_help_response' || status === 'pending_review'
}

export function isTaskActivelyRunning(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : ''
  return normalized === 'running' || normalized === 'orchestrating' || normalized === 'queued' || normalized === 'planning'
}

export function hasRunningTurn(turns) {
  if (!Array.isArray(turns)) return false
  return turns.some((t) => t && typeof t.status === 'string' && t.status === 'running')
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export function nextEntryId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

const EXPLORE_LABELS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'read', 'glob', 'grep', 'websearch', 'webfetch',
  'search', 'list_directory',
])
const WRITE_LABELS = new Set([
  'Write', 'Edit', 'NotebookEdit',
  'write', 'edit', 'notebookedit', 'write_file',
])
const COMMAND_LABELS = new Set(['Bash', 'bash', 'shell'])

export function buildToolGroupSummary(tools) {
  let explores = 0
  let writes = 0
  let commands = 0
  let other = 0
  const writtenFiles = new Set()

  for (const t of tools) {
    const lbl = t.label || ''
    if (EXPLORE_LABELS.has(lbl)) {
      explores++
    } else if (WRITE_LABELS.has(lbl)) {
      writes++
      if (t.summary) writtenFiles.add(t.summary)
    } else if (COMMAND_LABELS.has(lbl)) {
      commands++
    } else {
      other++
    }
  }

  const parts = []
  if (explores > 0) parts.push(`Explored ${explores} file${explores > 1 ? 's' : ''}`)
  if (writes > 0) {
    if (writtenFiles.size <= 3 && writtenFiles.size > 0) {
      parts.push(`Updated ${[...writtenFiles].join(', ')}`)
    } else {
      parts.push(`Updated ${writes} file${writes > 1 ? 's' : ''}`)
    }
  }
  if (commands > 0) parts.push(`Ran ${commands} command${commands > 1 ? 's' : ''}`)
  if (other > 0 && parts.length === 0) parts.push(`Performed ${other} tool call${other > 1 ? 's' : ''}`)

  return parts.length > 0 ? parts.join(', ') : `Performed ${tools.length} tool calls`
}

export function groupConsecutiveToolEntries(entries) {
  const result = []
  let i = 0
  while (i < entries.length) {
    if (entries[i].type !== 'tool') {
      result.push(entries[i])
      i++
      continue
    }
    // Start of a tool run
    const runStart = i
    while (i < entries.length && entries[i].type === 'tool') {
      i++
    }
    const run = entries.slice(runStart, i)
    result.push({
      id: nextEntryId('tool_group'),
      type: 'tool_group',
      tools: run,
      summary: buildToolGroupSummary(run),
    })
  }
  return result
}

export function appendToolEntryStreaming(entries, toolEntry) {
  const last = entries[entries.length - 1]
  if (last && last.type === 'tool_group') {
    const tools = [...last.tools, toolEntry]
    const updated = { ...last, tools, summary: buildToolGroupSummary(tools) }
    return [...entries.slice(0, -1), updated]
  }
  if (last && last.type === 'tool') {
    const tools = [last, toolEntry]
    const group = {
      id: nextEntryId('tool_group'),
      type: 'tool_group',
      tools,
      summary: buildToolGroupSummary(tools),
    }
    return [...entries.slice(0, -1), group]
  }
  // Wrap single tool in a group immediately so it shows summary like "Ran 1 command"
  const singleGroup = {
    id: nextEntryId('tool_group'),
    type: 'tool_group',
    tools: [toolEntry],
    summary: buildToolGroupSummary([toolEntry]),
  }
  return [...entries, singleGroup]
}

export function appendAssistantDelta(entries, delta, assistantIdentity) {
  if (!delta) {
    return entries
  }

  const last = entries[entries.length - 1]
  if (last && last.type === 'assistant') {
    const nextLast = {
      ...last,
      content: last.content ? `${last.content}\n${delta}` : delta,
    }
    return [...entries.slice(0, -1), nextLast]
  }

  return [
    ...entries,
    {
      id: nextEntryId('assistant'),
      type: 'assistant',
      content: delta,
      agentId: assistantIdentity?.agentId || '',
      agentName: assistantIdentity?.agentName || '',
      agentEmoji: assistantIdentity?.agentEmoji || '',
    },
  ]
}

export function summarizeToolEvent(name, payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  if (name === 'assistant.tool_use' && payload.type === 'tool_use') {
    const toolName = typeof payload.name === 'string' ? payload.name : 'Tool'
    const input = payload.input && typeof payload.input === 'object' ? payload.input : {}
    return {
      label: toolName,
      summary: summarizeToolInput(input),
    }
  }

  if (name.startsWith('item.')) {
    if (name === 'item.reasoning' || name === 'item.plan') {
      return null
    }

    const type = typeof payload.type === 'string' ? payload.type : name.replace('item.', '')
    if (typeof payload.command === 'string') {
      return { label: type, summary: truncate(payload.command, 140) }
    }
    if (typeof payload.file_path === 'string') {
      return { label: type, summary: basename(payload.file_path) }
    }
    if (typeof payload.name === 'string') {
      return { label: type, summary: payload.name }
    }
  }

  return null
}

function summarizeToolInput(input) {
  if (typeof input.command === 'string' && input.command.trim()) {
    return truncate(input.command.trim(), 140)
  }
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    return basename(input.file_path.trim())
  }
  if (Array.isArray(input.paths) && input.paths.length > 0) {
    return input.paths.map(basename).join(', ')
  }
  if (typeof input.description === 'string' && input.description.trim()) {
    return truncate(input.description.trim(), 140)
  }
  if (typeof input.query === 'string' && input.query.trim()) {
    return input.query.trim()
  }

  const keys = Object.keys(input)
  if (keys.length > 0) {
    return keys.slice(0, 4).join(', ')
  }

  return ''
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 3)}...`
}

function basename(filePath) {
  if (typeof filePath !== 'string') return filePath
  const lastSlash = filePath.lastIndexOf('/')
  if (lastSlash === -1) return filePath
  return filePath.slice(lastSlash + 1) || filePath
}

export function normalizeTaskTitle(value) {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) {
    return ''
  }
  return title.replace(/^execute:\s*/i, '')
}

export function resolveConversationHeaderAgent({ conversation, tasks, agentById }) {
  const currentConversation = conversation && typeof conversation === 'object' ? conversation : null
  const allTasks = Array.isArray(tasks) ? tasks : []
  const entries = Array.isArray(currentConversation?.entries) ? currentConversation.entries : []

  let resolvedAgentId = ''
  if (typeof currentConversation?.taskId === 'string' && currentConversation.taskId) {
    const currentTask = allTasks.find((task) => task?.id === currentConversation.taskId)
    if (currentTask && typeof currentTask.assigned_to === 'string' && currentTask.assigned_to.trim()) {
      resolvedAgentId = currentTask.assigned_to.trim()
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.type !== 'assistant') {
      continue
    }

    const entryAgentId =
      typeof entry.agentId === 'string' && entry.agentId.trim() ? entry.agentId.trim() : ''
    if (entryAgentId) {
      resolvedAgentId = entryAgentId
      break
    }

    const entryAgentName =
      typeof entry.agentName === 'string' && entry.agentName.trim() ? entry.agentName.trim() : ''
    const entryAgentEmoji =
      typeof entry.agentEmoji === 'string' && entry.agentEmoji.trim() ? entry.agentEmoji.trim() : ''
    if (entryAgentName || entryAgentEmoji) {
      return {
        name: entryAgentName || 'Assistant',
        emoji: entryAgentEmoji || iconForAgent(ORCHESTRATOR_AGENT_ID),
      }
    }
  }

  if (!resolvedAgentId && currentConversation?.mode === 'plan') {
    resolvedAgentId = ORCHESTRATOR_AGENT_ID
  }
  if (!resolvedAgentId && currentConversation?.mode === 'chat') {
    resolvedAgentId = ORCHESTRATOR_AGENT_ID
  }
  if (!resolvedAgentId) {
    return { name: '', emoji: '' }
  }

  const agent =
    agentById && typeof agentById === 'object' ? agentById[resolvedAgentId] ?? null : null
  return {
    name:
      (agent && typeof agent.name === 'string' && agent.name.trim()) ||
      (resolvedAgentId === ORCHESTRATOR_AGENT_ID ? 'Orchestrator' : resolvedAgentId),
    emoji:
      (agent && typeof agent.emoji === 'string' && agent.emoji.trim()) ||
      iconForAgent(resolvedAgentId),
  }
}

export function buildEntriesFromThreadData(data, agentById) {
  const timeline = []
  const turns = Array.isArray(data?.turns) ? data.turns : []
  const messages = Array.isArray(data?.messages) ? data.messages : []
  const events = Array.isArray(data?.events) ? data.events : []
  const turnsById = new Map()
  const turnsWithAssistantTextEvents = new Set()

  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') {
      continue
    }
    if (typeof turn.id !== 'string' || !turn.id) {
      continue
    }
    turnsById.set(turn.id, turn)
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue
    }
    if (event.event_name !== 'assistant_text' && event.event_name !== 'worker_text') {
      continue
    }
    if (typeof event.turn_id !== 'string' || !event.turn_id) {
      continue
    }
    turnsWithAssistantTextEvents.add(event.turn_id)
  }

  function resolveAssistantIdentity(turnId, fallbackAgentId = '') {
    const turn = typeof turnId === 'string' && turnId ? turnsById.get(turnId) ?? null : null
    const mode = typeof turn?.mode === 'string' ? turn.mode : ''
    const selectedAgentId =
      typeof turn?.selected_agent_id === 'string' ? turn.selected_agent_id : ''
    const orchestratorAgentId =
      typeof turn?.orchestrator_agent_id === 'string' ? turn.orchestrator_agent_id : ''

    const resolvedAgentId =
      mode === 'execute'
        ? selectedAgentId || fallbackAgentId || orchestratorAgentId || ORCHESTRATOR_AGENT_ID
        : orchestratorAgentId || ORCHESTRATOR_AGENT_ID
    const resolvedAgent =
      resolvedAgentId && agentById && typeof agentById === 'object'
        ? agentById[resolvedAgentId]
        : null

    return {
      agentId: resolvedAgentId,
      agentName:
        (resolvedAgent && typeof resolvedAgent.name === 'string' && resolvedAgent.name) ||
        (resolvedAgentId === ORCHESTRATOR_AGENT_ID ? 'Orchestrator' : '') ||
        resolvedAgentId,
      agentEmoji:
        (resolvedAgent && typeof resolvedAgent.emoji === 'string' && resolvedAgent.emoji) ||
        iconForAgent(resolvedAgentId),
    }
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
      continue
    }
    if (typeof message.content !== 'string') {
      throw new Error('Conversation message content must be a string.')
    }
    if (
      message.role === 'assistant' &&
      typeof message.turn_id === 'string' &&
      message.turn_id &&
      turnsWithAssistantTextEvents.has(message.turn_id)
    ) {
      // Avoid duplicating assistant text when the turn already emitted streaming text events.
      continue
    }

    const entry = {
      id: message.id || nextEntryId(message.role),
      type: message.role,
      content: message.content,
    }

    if (message.role === 'assistant') {
      const identity = resolveAssistantIdentity(message.turn_id)
      entry.agentId = identity.agentId
      entry.agentName = identity.agentName
      entry.agentEmoji = identity.agentEmoji
    }

    timeline.push({
      createdAt: toTimestamp(message.created_at),
      order: message.role === 'user' ? 1 : 2,
      entry,
    })
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue
    }

    if (event.event_name === 'assistant_text' || event.event_name === 'worker_text') {
      const delta = typeof event.payload?.delta === 'string' ? event.payload.delta : ''
      if (!delta) {
        continue
      }
      const workerAgentId =
        typeof event.payload?.worker_agent_id === 'string' ? event.payload.worker_agent_id : ''
      const identity = resolveAssistantIdentity(event.turn_id, workerAgentId)
      timeline.push({
        createdAt: toTimestamp(event.created_at),
        order: 2,
        entry: {
          id: event.id || nextEntryId('assistant'),
          type: 'assistant',
          content: delta,
          agentId: identity.agentId,
          agentName: identity.agentName,
          agentEmoji: identity.agentEmoji,
        },
      })
      continue
    }

    if (event.event_name === 'tool_event' || event.event_name === 'worker_tool_event') {
      const payload = event.payload
      const summary = summarizeToolEvent(payload?.name, payload?.payload)
      if (!summary) {
        continue
      }
      timeline.push({
        createdAt: toTimestamp(event.created_at),
        order: 3,
        entry: {
          id: event.id || nextEntryId('tool'),
          type: 'tool',
          label: summary.label,
          summary: summary.summary,
        },
      })
      continue
    }

    if (event.event_name === 'worker_question_requested') {
      const question = event.payload?.question || 'Question from agent'
      const options = Array.isArray(event.payload?.options) ? event.payload.options : null
      const details = event.payload?.details || null
      timeline.push({
        createdAt: toTimestamp(event.created_at),
        order: 4,
        entry: {
          id: event.id || nextEntryId('question'),
          type: 'question',
          content: question,
          details,
          options,
        },
      })
      continue
    }

    const statusText = summarizeStatusEvent(event.event_name, event.payload)
    if (statusText) {
      timeline.push({
        createdAt: toTimestamp(event.created_at),
        order: 4,
        entry: {
          id: event.id || nextEntryId('status'),
          type: 'status',
          content: statusText,
        },
      })
    }
  }

  timeline.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
  return groupConsecutiveToolEntries(timeline.map((item) => item.entry))
}

const EVENT_DESCRIPTIONS = {
  orchestrator_started: () => 'Orchestrator started.',
  recipient_requested: (p) => `Manual recipient requested: ${requireEventString(p?.recipient_agent_id, 'recipient_agent_id')}`,
  recipient_selected: (p) => `Recipient selected: ${requireEventString(p?.selected_agent_id, 'selected_agent_id')}`,
  plan_recipient_selected: (p) => `Plan recipient selected: ${requireEventString(p?.selected_agent_id, 'selected_agent_id')}`,
  plan_proposal_submitted: (p) => {
    const count = Array.isArray(p?.tasks) ? p.tasks.length : 0
    return `Plan proposal submitted with ${count} task${count !== 1 ? 's' : ''}.`
  },
  recipient_selected_via_cli: () => '',
  worker_started: (p) => `Worker started: ${requireEventString(p?.worker_agent_id, 'worker_agent_id')}`,
  recipient_required: (p) => requireEventString(p?.reason, 'reason'),
  worker_question_requested: (p) => requireEventString(p?.question, 'question'),
  worker_help_requested: (p) => requireEventString(p?.summary, 'summary'),
  human_response_received: () => 'Human response received. Resuming worker.',
  worker_completed: () => 'Worker completed.',
  task_reopened: () => 'Task reopened. Send a follow-up message to continue.',
}

function summarizeStatusEvent(name, payload) {
  if (!name) return ''
  const fn = EVENT_DESCRIPTIONS[name]
  return fn ? fn(payload) : ''
}

function requireEventString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing event field: ${fieldName}`)
  }
  return value
}

function toTimestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const HIDDEN_CHATS_STORAGE_KEY = 'pragma.hidden_sidebar_chats.v1'

export function loadHiddenChatsByWorkspace() {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(HIDDEN_CHATS_STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const next = {}
    for (const [workspace, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) {
        continue
      }
      const filtered = ids.filter((id) => typeof id === 'string' && id.trim())
      if (filtered.length > 0) {
        next[workspace] = filtered
      }
    }
    return next
  } catch {
    return {}
  }
}

export function saveHiddenChatsByWorkspace(value) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(HIDDEN_CHATS_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Ignore storage failures.
  }
}

export const CLI_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
}
