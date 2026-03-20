import { createParser } from 'eventsource-parser'
import { isLoopbackHost } from '../../shared/net'

function isWildcardHost(hostname) {
  const value = String(hostname || '').trim().toLowerCase()
  return value === '0.0.0.0' || value === '::'
}

function resolveApiUrl() {
  const raw = typeof import.meta.env.VITE_API_URL === 'string'
    ? import.meta.env.VITE_API_URL.trim()
    : ''

  if (!raw) {
    const fallback = new URL(window.location.origin)
    fallback.port = import.meta.env.VITE_API_PORT || '3000'
    return fallback.toString().replace(/\/$/, '')
  }

  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid VITE_API_URL: ${raw}`)
  }

  const uiHost = window.location.hostname
  if ((isWildcardHost(parsed.hostname) || isLoopbackHost(parsed.hostname)) && !isLoopbackHost(uiHost)) {
    parsed.hostname = uiHost
  }

  return parsed.toString().replace(/\/$/, '')
}

const API_URL = resolveApiUrl()
const API_BASE_URL = API_URL

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000
const REVIEW_REQUEST_TIMEOUT_MS = 120000
const CONVERSATION_REQUEST_TIMEOUT_MS = 30000
const TASK_RESPONSE_REQUEST_TIMEOUT_MS = 30000

function linkAbortSignals(target, source) {
  if (!source) return () => {}
  if (source.aborted) {
    target.abort(source.reason)
    return () => {}
  }

  const onAbort = () => target.abort(source.reason)
  source.addEventListener('abort', onAbort, { once: true })
  return () => source.removeEventListener('abort', onAbort)
}

async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const detach = linkAbortSignals(controller, init?.signal)
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    detach()
    clearTimeout(timeout)
  }
}

function invalidResponse(message) {
  return new ApiError(message, 500, 'INVALID_RESPONSE')
}

function asObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(message)
  }
  return value
}

async function fetchJson(path, init, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  let response
  try {
    response = await fetchWithTimeout(`${API_BASE_URL}${path}`, init, timeoutMs)
  } catch (error) {
    if (error instanceof Error && /timed out/i.test(error.message)) {
      throw new ApiError(error.message, 408, 'REQUEST_TIMEOUT')
    }
    throw error
  }

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (!response.ok) {
    const code = body && typeof body === 'object' && typeof body.error === 'string'
      ? body.error
      : `HTTP_${response.status}`
    const message = body && typeof body === 'object' && typeof body.message === 'string'
      ? body.message
      : `HTTP ${response.status}`
    throw new ApiError(message, response.status, code)
  }

  if (response.status === 204) {
    return {}
  }

  if (!body || typeof body !== 'object') {
    throw invalidResponse(`Expected JSON object from ${path}`)
  }

  return body
}

export async function fetchWorkspaces() {
  const data = asObject(await fetchJson('/workspaces'), 'Invalid workspaces response.')
  if (!Array.isArray(data.workspaces)) {
    throw invalidResponse('`workspaces` must be an array.')
  }
  return data.workspaces
}

export async function fetchActiveWorkspace() {
  const data = asObject(await fetchJson('/workspace/active'), 'Invalid active workspace response.')
  if (!('workspace' in data)) {
    throw invalidResponse('`workspace` is required in active workspace response.')
  }
  return data.workspace
}

export async function createWorkspace({ name, orchestrator_harness }) {
  return fetchJson('/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, orchestrator_harness }),
  })
}

export async function fetchAvailableClis() {
  const data = asObject(await fetchJson('/cli/available'), 'Invalid CLI response.')
  if (!Array.isArray(data.clis)) {
    throw invalidResponse('`clis` array is required in CLI response.')
  }
  return data.clis
}

export async function setActiveWorkspace(name) {
  return fetchJson('/workspaces/active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function deleteWorkspace(name) {
  return fetchJson(`/workspaces/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export async function fetchTasks(limit = 200) {
  const data = asObject(await fetchJson(`/tasks?limit=${limit}`), 'Invalid tasks response.')
  if (!Array.isArray(data.tasks)) {
    throw invalidResponse('`tasks` must be an array.')
  }
  return data.tasks
}

function parseEventPayload(event) {
  if (!event || typeof event.data !== 'string' || !event.data) {
    return null
  }

  try {
    return JSON.parse(event.data)
  } catch {
    return null
  }
}

function createReconnectingEventSource(url, {
  onOpen,
  onError,
  eventListeners = {},
  maxRetryMs = 30000,
  initialRetryMs = 1000,
} = {}) {
  let stream = null
  let retryMs = initialRetryMs
  let retryTimer = null
  let closed = false
  let lastEventId = null

  function connect() {
    if (closed) return

    const connectUrl = lastEventId
      ? `${url}${url.includes('?') ? '&' : '?'}_lastEventId=${encodeURIComponent(lastEventId)}`
      : url

    stream = new EventSource(connectUrl)

    stream.onopen = () => {
      retryMs = initialRetryMs
      onOpen?.()
    }

    stream.onerror = () => {
      stream.close()
      onError?.()
      if (!closed) {
        retryTimer = setTimeout(() => {
          retryMs = Math.min(retryMs * 2, maxRetryMs)
          connect()
        }, retryMs)
      }
    }

    for (const [eventName, handler] of Object.entries(eventListeners)) {
      stream.addEventListener(eventName, (event) => {
        if (event.lastEventId) {
          lastEventId = event.lastEventId
        }
        handler(event)
      })
    }
  }

  connect()

  return () => {
    closed = true
    if (retryTimer) clearTimeout(retryTimer)
    stream?.close()
  }
}

export function openTasksStream({ onReady, onTaskStatusChanged, onError } = {}) {
  return createReconnectingEventSource(`${API_BASE_URL}/tasks/stream`, {
    onError: () => onError?.(),
    eventListeners: {
      ready: (event) => onReady?.(parseEventPayload(event)),
      task_status_changed: (event) => {
        const payload = parseEventPayload(event)
        if (payload && typeof payload === 'object') {
          onTaskStatusChanged?.(payload)
        }
      },
    },
  })
}

export function openConversationThreadStream(
  threadId,
  { onReady, onThreadUpdated, onEvent, onError } = {},
) {
  const streamEventNames = [
    'worker_text', 'worker_tool_event', 'assistant_text', 'tool_event',
    'worker_completed', 'worker_question_requested', 'worker_help_requested',
    'error', 'recipient_selected', 'worker_started', 'human_response_received',
    'orchestrator_started',
  ]

  const eventListeners = {
    ready: (event) => onReady?.(parseEventPayload(event)),
    thread_updated: (event) => {
      const payload = parseEventPayload(event)
      if (payload && typeof payload === 'object') {
        onThreadUpdated?.(payload)
      }
    },
  }

  for (const name of streamEventNames) {
    eventListeners[name] = (event) => {
      const payload = parseEventPayload(event)
      if (payload) {
        onEvent?.({ event: name, data: payload, id: event.lastEventId })
      }
    }
  }

  return createReconnectingEventSource(
    `${API_BASE_URL}/conversations/${encodeURIComponent(threadId)}/stream`,
    { onError: () => onError?.(), eventListeners },
  )
}

export async function fetchWorkspaceOutputFiles() {
  return fetchJson('/workspace/outputs/files')
}

export function workspaceOutputContentUrl(path) {
  const params = new URLSearchParams()
  params.set('path', path)
  return `${API_BASE_URL}/workspace/outputs/file/content?${params.toString()}`
}

export function workspaceOutputDownloadUrl(path) {
  const params = new URLSearchParams()
  params.set('path', path)
  return `${API_BASE_URL}/workspace/outputs/file/download?${params.toString()}`
}

export async function fetchTaskOutputChanges(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/output/changes`)
}

export async function fetchTaskOutputFiles(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/output/files`)
}

export function taskOutputContentUrl(taskId, path) {
  const params = new URLSearchParams()
  params.set('path', path)
  return `${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/output/file/content?${params.toString()}`
}

export function taskOutputDownloadUrl(taskId, path) {
  const params = new URLSearchParams()
  params.set('path', path)
  return `${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/output/file/download?${params.toString()}`
}

export async function openTaskOutputFolder(taskId, path = '') {
  const body = {}
  if (path) {
    body.path = path
  }
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/output/open-folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function fetchTaskPlan(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/plan`)
}

export async function fetchTaskTestCommands(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/test-commands`)
}

export async function updateTaskTestCommands(taskId, commands) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/test-commands`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands }),
  }, 60 * 1000)
}

export async function runTaskTestCommand(taskId, command, cwd) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/test-commands/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, cwd }),
  }, 10 * 60 * 1000)
}

export async function fetchRuntimeServices() {
  const data = asObject(await fetchJson('/services'), 'Invalid services response.')
  if (!Array.isArray(data.services)) {
    throw invalidResponse('`services` must be an array.')
  }
  return data.services
}

export async function stopRuntimeService(serviceId) {
  return fetchJson(`/services/${encodeURIComponent(serviceId)}/stop`, {
    method: 'POST',
  })
}

export function openRuntimeServiceStream(serviceId, { onReady, onLog, onStatus, onError } = {}) {
  return createReconnectingEventSource(
    `${API_BASE_URL}/services/${encodeURIComponent(serviceId)}/stream`,
    {
      onError: () => onError?.(),
      eventListeners: {
        ready: (event) => onReady?.(parseEventPayload(event)),
        log: (event) => onLog?.(parseEventPayload(event)),
        status: (event) => onStatus?.(parseEventPayload(event)),
      },
    },
  )
}

export async function reviewTask(taskId, action) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  }, REVIEW_REQUEST_TIMEOUT_MS)
}

export async function deleteTask(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })
}

export async function stopTask(taskId, message) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message ? { message } : {}),
  })
}

export async function fetchAgents() {
  const data = asObject(await fetchJson('/agents'), 'Invalid agents response.')
  if (!Array.isArray(data.agents)) {
    throw invalidResponse('`agents` must be an array.')
  }
  return data.agents
}

export async function createAgent(agent) {
  return fetchJson('/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(agent),
  })
}

export async function fetchAgentTemplates() {
  const data = asObject(await fetchJson('/agents/templates'), 'Invalid templates response.')
  if (!Array.isArray(data.templates)) {
    throw invalidResponse('`templates` must be an array.')
  }
  return data.templates
}

export async function updateAgent(id, updates) {
  return fetchJson(`/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

export async function deleteAgent(id) {
  return fetchJson(`/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function fetchContextFiles() {
  const data = asObject(await fetchJson('/context'), 'Invalid context response.')
  const context = asObject(data.context, '`context` must be an object.')

  if (!Array.isArray(context.folders) || !Array.isArray(context.files)) {
    throw invalidResponse('`context.folders` and `context.files` must be arrays.')
  }

  return {
    folders: context.folders,
    files: context.files,
  }
}

export async function fetchCodeFolders() {
  const data = asObject(await fetchJson('/code/folders'), 'Invalid code folders response.')
  if (!Array.isArray(data.folders)) {
    throw invalidResponse('`folders` must be an array.')
  }
  return data.folders
}

export async function cloneCodeRepo(git_url) {
  return fetchJson('/code/repos/clone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ git_url }),
  })
}

export async function copyCodeFolderFromLocal(local_path) {
  return fetchJson('/code/folders/copy-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local_path }),
  })
}

export async function pickLocalCodeFolder() {
  return fetchJson('/code/folders/pick-local', {
    method: 'POST',
  })
}

export async function pushCodeFolder(folderName) {
  return fetchJson(`/code/folders/${encodeURIComponent(folderName)}/push`, {
    method: 'POST',
  }, 60000)
}

export async function updateContextFile(path, content) {
  return fetchJson('/context/file', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
}

export async function createContextFolder(name) {
  return fetchJson('/context/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function createContextFile(name, folder) {
  return fetchJson('/context/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, folder }),
  })
}

export async function createExecuteTask({ prompt, recipient_agent_id, reasoning_effort }) {
  return fetchJson('/tasks/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, recipient_agent_id, reasoning_effort }),
  })
}

export async function createFollowupTask(parentTaskId, { prompt, recipient_agent_id, reasoning_effort }) {
  return fetchJson(`/tasks/${encodeURIComponent(parentTaskId)}/followup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, recipient_agent_id, reasoning_effort }),
  })
}

export async function executeFromPlanThread(threadId, { recipient_agent_id, reasoning_effort }) {
  return fetchJson(`/conversations/${encodeURIComponent(threadId)}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient_agent_id, reasoning_effort }),
  })
}

export async function fetchPlanProposal(threadId) {
  const data = asObject(
    await fetchJson(`/conversations/${encodeURIComponent(threadId)}/plan-proposal`),
    'Invalid plan proposal response.',
  )
  return data.proposal
}

export async function executePlanProposal(threadId, { tasks, reasoning_effort }) {
  return fetchJson(`/conversations/${encodeURIComponent(threadId)}/execute-proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks, reasoning_effort }),
  })
}

export async function deletePlanThread(threadId) {
  return fetchJson(`/conversations/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
  })
}

export async function setTaskRecipient(taskId, recipient_agent_id) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/recipient`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient_agent_id }),
  })
}

export async function respondToTask(taskId, message) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  }, TASK_RESPONSE_REQUEST_TIMEOUT_MS)
}

export async function fetchConversationThread(threadId) {
  return fetchJson(`/conversations/${encodeURIComponent(threadId)}`, undefined, CONVERSATION_REQUEST_TIMEOUT_MS)
}

export async function fetchChats(limit = 20, cursor = '') {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (cursor) {
    params.set('cursor', cursor)
  }
  const data = asObject(await fetchJson(`/conversations/chats?${params.toString()}`), 'Invalid chats response.')
  if (!Array.isArray(data.chats)) {
    throw invalidResponse('`chats` must be an array.')
  }
  return data.chats
}

export async function fetchPlans(limit = 20, cursor = '') {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (cursor) {
    params.set('cursor', cursor)
  }
  const data = asObject(await fetchJson(`/conversations/plans?${params.toString()}`), 'Invalid plans response.')
  if (!Array.isArray(data.plans)) {
    throw invalidResponse('`plans` must be an array.')
  }
  return data.plans
}

export async function uploadFile(file) {
  const form = new FormData()
  form.append('file', file)
  const response = await fetchWithTimeout(`${API_BASE_URL}/uploads`, {
    method: 'POST',
    body: form,
  }, DEFAULT_REQUEST_TIMEOUT_MS)
  if (!response.ok) {
    let body = null
    try { body = await response.json() } catch {}
    const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : `HTTP_${response.status}`
    const message = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : `HTTP ${response.status}`
    throw new ApiError(message, response.status, code)
  }
  const data = await response.json()
  return asObject(data, 'Invalid upload response.')
}

export async function streamConversationTurn(payload, { onEvent, signal } = {}) {
  let response
  try {
    response = await fetchWithTimeout(
      `${API_BASE_URL}/conversations/turns/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      },
      15000,
    )
  } catch (error) {
    if (error instanceof Error && /timed out/i.test(error.message)) {
      throw new ApiError(error.message, 408, 'REQUEST_TIMEOUT')
    }
    throw error
  }

  if (!response.ok) {
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }

    const code = body && typeof body === 'object' && typeof body.error === 'string'
      ? body.error
      : `HTTP_${response.status}`
    const message = body && typeof body === 'object' && typeof body.message === 'string'
      ? body.message
      : `HTTP ${response.status}`
    throw new ApiError(message, response.status, code)
  }

  if (!response.body) {
    throw new ApiError('Streaming response body is missing.', 500, 'STREAM_BODY_MISSING')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  const parser = createParser({
    onEvent(event) {
      if (!onEvent) {
        return
      }

      let data = null
      try {
        data = JSON.parse(event.data)
      } catch {
        data = event.data
      }

      onEvent({
        event: event.event || 'message',
        data,
      })
    },
    onError(error) {
      throw new ApiError(error.message, 500, 'SSE_PARSE_ERROR')
    },
  })

  try {
    while (true) {
      if (signal?.aborted) {
        break
      }
      const { done, value } = await reader.read()
      if (done) {
        parser.reset({ consume: true })
        break
      }

      parser.feed(decoder.decode(value, { stream: true }))
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Expected when abort() is called — silently stop reading.
    } else {
      throw error
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/**
 * Fire-and-forget turn creation. Returns { turn_id, thread_id } immediately.
 * The caller should subscribe to GET /conversations/:threadId/stream to watch events.
 */
export async function createConversationTurn(payload) {
  return fetchJson('/conversations/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * Abort an in-progress turn.
 */
export async function abortConversationTurn(turnId) {
  return fetchJson(`/conversations/turns/${encodeURIComponent(turnId)}/abort`, {
    method: 'POST',
  })
}

export async function fetchHumans() {
  const data = asObject(await fetchJson('/humans'), 'Invalid humans response.')
  if (!Array.isArray(data.humans)) {
    throw invalidResponse('`humans` must be an array.')
  }
  return data.humans
}

export async function createHuman(emoji) {
  return fetchJson('/humans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emoji }),
  })
}

export async function updateHuman(id, emoji) {
  return fetchJson(`/humans/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emoji }),
  })
}

export async function fetchSkillRegistry() {
  const data = asObject(await fetchJson('/skills/registry', undefined, 60000), 'Invalid registry response.')
  if (!Array.isArray(data.skills)) {
    throw invalidResponse('`skills` must be an array.')
  }
  return data.skills
}

export async function fetchGlobalSkills(harness) {
  const url = harness ? `/skills/global?harness=${encodeURIComponent(harness)}` : '/skills/global'
  const data = asObject(await fetchJson(url), 'Invalid global skills response.')
  if (!Array.isArray(data.skills)) {
    throw invalidResponse('`skills` must be an array.')
  }
  return data.skills
}

export async function fetchMcpServers(harness) {
  const url = harness ? `/skills/mcp-servers?harness=${encodeURIComponent(harness)}` : '/skills/mcp-servers'
  const data = asObject(await fetchJson(url), 'Invalid MCP servers response.')
  if (!Array.isArray(data.servers)) {
    throw invalidResponse('`servers` must be an array.')
  }
  return data.servers
}

export async function fetchInstalledSkills() {
  const data = asObject(await fetchJson('/skills'), 'Invalid skills response.')
  if (!Array.isArray(data.skills)) {
    throw invalidResponse('`skills` must be an array.')
  }
  return data.skills
}

export async function installRegistrySkill({ name, provider, repo, skill_path }) {
  return fetchJson('/skills/registry/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, provider, repo, skill_path }),
  }, 30000)
}

export async function createCustomSkill({ name, description, content }) {
  return fetchJson('/skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description, content }),
  })
}

export async function deleteSkill(id) {
  return fetchJson(`/skills/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function fetchAgentSkills(agentId) {
  const data = asObject(
    await fetchJson(`/agents/${encodeURIComponent(agentId)}/skills`),
    'Invalid agent skills response.',
  )
  if (!Array.isArray(data.skills)) {
    throw invalidResponse('`skills` must be an array.')
  }
  return data.skills
}

export async function assignAgentSkill(agentId, skillId) {
  return fetchJson(`/agents/${encodeURIComponent(agentId)}/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill_id: skillId }),
  })
}

export async function unassignAgentSkill(agentId, skillId) {
  return fetchJson(
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
    { method: 'DELETE' },
  )
}

// ── Connectors ─────────────────────────────────────────────────────

export async function fetchConnectors() {
  const data = asObject(await fetchJson('/connectors'), 'Invalid connectors response.')
  if (!Array.isArray(data.connectors)) {
    throw invalidResponse('`connectors` must be an array.')
  }
  return data.connectors
}

export async function configureConnector(id, config) {
  return fetchJson(`/connectors/${encodeURIComponent(id)}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
}

export async function startConnectorAuth(id) {
  return fetchJson(`/connectors/${encodeURIComponent(id)}/auth`)
}

export async function disconnectConnector(id) {
  return fetchJson(`/connectors/${encodeURIComponent(id)}/auth`, { method: 'DELETE' })
}

export async function ensureConnectorBinary(id) {
  return fetchJson(`/connectors/${encodeURIComponent(id)}/ensure-binary`, { method: 'POST' }, 120000)
}

export async function fetchAgentConnectors(agentId) {
  const data = asObject(
    await fetchJson(`/agents/${encodeURIComponent(agentId)}/connectors`),
    'Invalid agent connectors response.',
  )
  if (!Array.isArray(data.connectors)) {
    throw invalidResponse('`connectors` must be an array.')
  }
  return data.connectors
}

export async function assignAgentConnector(agentId, connectorId) {
  return fetchJson(`/agents/${encodeURIComponent(agentId)}/connectors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connector_id: connectorId }),
  })
}

export async function unassignAgentConnector(agentId, connectorId) {
  return fetchJson(
    `/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`,
    { method: 'DELETE' },
  )
}

// ── Testing ─────────────────────────────────────────────────────

export async function fetchTaskTestingConfig(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/testing-config`)
}

export async function startTaskTesting(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/testing/start`, {
    method: 'POST',
  }, 120000)
}

export async function stopTaskTesting(taskId) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/testing/stop`, {
    method: 'POST',
  })
}

export async function proxyTestingRequest(taskId, { process_name, method, path, headers, body }) {
  return fetchJson(`/tasks/${encodeURIComponent(taskId)}/testing/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ process_name, method, path, headers, body }),
  }, 60000)
}

export async function sendServiceStdin(serviceId, text) {
  return fetchJson(`/services/${encodeURIComponent(serviceId)}/stdin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

// ── Process Management ─────────────────────────────────────────

export async function fetchProcesses() {
  const data = asObject(await fetchJson('/processes'), 'Invalid processes response.')
  if (!Array.isArray(data.processes)) {
    throw invalidResponse('`processes` must be an array.')
  }
  return data.processes
}

export async function fetchFolderProcesses(folderName) {
  const data = asObject(
    await fetchJson(`/code/folders/${encodeURIComponent(folderName)}/processes`),
    'Invalid folder processes response.',
  )
  if (!Array.isArray(data.processes)) {
    throw invalidResponse('`processes` must be an array.')
  }
  return data.processes
}

export async function createProcess(folderName, { label, command, cwd, type }) {
  return fetchJson(`/code/folders/${encodeURIComponent(folderName)}/processes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, command, cwd, type }),
  })
}

export async function updateProcess(processId, updates) {
  return fetchJson(`/processes/${encodeURIComponent(processId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

export async function deleteProcess(processId) {
  return fetchJson(`/processes/${encodeURIComponent(processId)}`, {
    method: 'DELETE',
  })
}

export async function startProcess(processId) {
  return fetchJson(`/processes/${encodeURIComponent(processId)}/start`, {
    method: 'POST',
  }, 60000)
}

export async function stopProcess(processId) {
  return fetchJson(`/processes/${encodeURIComponent(processId)}/stop`, {
    method: 'POST',
  })
}

export async function detectProcesses(folderName) {
  return fetchJson(`/code/folders/${encodeURIComponent(folderName)}/processes/detect`, {
    method: 'POST',
  })
}

export { API_URL }
