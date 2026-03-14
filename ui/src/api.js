import { createParser } from 'eventsource-parser'

function isLoopbackHost(hostname) {
  const value = String(hostname || '').trim().toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

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

export async function createWorkspace({ name, goal }) {
  return fetchJson('/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, goal }),
  })
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

export function openTasksStream({ onReady, onTaskStatusChanged, onError } = {}) {
  const stream = new EventSource(`${API_BASE_URL}/tasks/stream`)

  stream.addEventListener('ready', (event) => {
    const payload = parseEventPayload(event)
    onReady?.(payload)
  })

  stream.addEventListener('task_status_changed', (event) => {
    const payload = parseEventPayload(event)
    if (!payload || typeof payload !== 'object') {
      return
    }
    onTaskStatusChanged?.(payload)
  })

  stream.addEventListener('error', (event) => {
    onError?.(event)
  })

  return () => {
    stream.close()
  }
}

export function openConversationThreadStream(
  threadId,
  { onReady, onThreadUpdated, onError } = {},
) {
  const stream = new EventSource(
    `${API_BASE_URL}/conversations/${encodeURIComponent(threadId)}/stream`,
  )

  stream.addEventListener('ready', (event) => {
    const payload = parseEventPayload(event)
    onReady?.(payload)
  })

  stream.addEventListener('thread_updated', (event) => {
    const payload = parseEventPayload(event)
    if (!payload || typeof payload !== 'object') {
      return
    }
    onThreadUpdated?.(payload)
  })

  stream.addEventListener('error', (event) => {
    onError?.(event)
  })

  return () => {
    stream.close()
  }
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
  const stream = new EventSource(
    `${API_BASE_URL}/services/${encodeURIComponent(serviceId)}/stream`,
  )

  stream.addEventListener('ready', (event) => {
    onReady?.(parseEventPayload(event))
  })

  stream.addEventListener('log', (event) => {
    onLog?.(parseEventPayload(event))
  })

  stream.addEventListener('status', (event) => {
    onStatus?.(parseEventPayload(event))
  })

  stream.addEventListener('error', (event) => {
    onError?.(event)
  })

  return () => {
    stream.close()
  }
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

export async function updateAgent(id, updates) {
  return fetchJson(`/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
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

export async function executeFromPlanThread(threadId, { recipient_agent_id, reasoning_effort }) {
  return fetchJson(`/conversations/${encodeURIComponent(threadId)}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient_agent_id, reasoning_effort }),
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

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      parser.reset({ consume: true })
      break
    }

    parser.feed(decoder.decode(value, { stream: true }))
  }
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

export { API_URL }
