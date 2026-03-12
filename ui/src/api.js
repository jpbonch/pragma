const API_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3000'

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function fetchJson(path, init) {
  const response = await fetch(`${API_URL}${path}`, init)

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (!response.ok) {
    const code = body?.error ?? `HTTP_${response.status}`
    const message = body?.message ?? body?.error ?? `HTTP ${response.status}`
    throw new ApiError(message, response.status, code)
  }

  return body ?? {}
}

export async function fetchWorkspaces() {
  const data = await fetchJson('/workspaces')
  return Array.isArray(data.workspaces) ? data.workspaces : []
}

export async function fetchActiveWorkspace() {
  const data = await fetchJson('/workspace/active')
  return data.workspace ?? null
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

export async function fetchJobs(limit = 200) {
  const data = await fetchJson(`/jobs?limit=${limit}`)
  return Array.isArray(data.jobs) ? data.jobs : []
}

export function openJobsStream({ onReady, onJobStatusChanged, onError } = {}) {
  const stream = new EventSource(`${API_URL}/jobs/stream`)

  stream.addEventListener('ready', (event) => {
    const payload = parseEventPayload(event)
    onReady?.(payload)
  })

  stream.addEventListener('job_status_changed', (event) => {
    const payload = parseEventPayload(event)
    if (!payload || typeof payload !== 'object') {
      return
    }
    onJobStatusChanged?.(payload)
  })

  stream.addEventListener('error', (event) => {
    onError?.(event)
  })

  return () => {
    stream.close()
  }
}

export async function fetchJobOutputChanges(jobId) {
  return fetchJson(`/jobs/${encodeURIComponent(jobId)}/output/changes`)
}

export async function fetchJobOutputFiles(jobId) {
  return fetchJson(`/jobs/${encodeURIComponent(jobId)}/output/files`)
}

export function jobOutputContentUrl(jobId, path) {
  const params = new URLSearchParams()
  params.set('path', path)
  return `${API_URL}/jobs/${encodeURIComponent(jobId)}/output/file/content?${params.toString()}`
}

export function jobOutputDownloadUrl(jobId, path) {
  const params = new URLSearchParams()
  params.set('path', path)
  return `${API_URL}/jobs/${encodeURIComponent(jobId)}/output/file/download?${params.toString()}`
}

export async function openJobOutputFolder(jobId, path = '') {
  const body = {}
  if (path) {
    body.path = path
  }
  return fetchJson(`/jobs/${encodeURIComponent(jobId)}/output/open-folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function reviewJob(jobId, action) {
  return fetchJson(`/jobs/${encodeURIComponent(jobId)}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

export async function fetchAgents() {
  const data = await fetchJson('/agents')
  return Array.isArray(data.agents) ? data.agents : []
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
  const data = await fetchJson('/context')
  const context = data.context
  if (!context || typeof context !== 'object') {
    return { folders: [], files: [] }
  }

  return {
    folders: Array.isArray(context.folders) ? context.folders : [],
    files: Array.isArray(context.files) ? context.files : [],
  }
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

export async function createExecuteJob({ prompt, recipient_agent_id, reasoning_effort }) {
  return fetchJson('/jobs/execute', {
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

export async function setJobRecipient(jobId, recipient_agent_id) {
  return fetchJson(`/jobs/${encodeURIComponent(jobId)}/recipient`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient_agent_id }),
  })
}

export async function respondToJob(jobId, message) {
  return fetchJson(`/jobs/${encodeURIComponent(jobId)}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })
}

export async function fetchConversationThread(threadId) {
  return fetchJson(`/conversations/${encodeURIComponent(threadId)}`)
}

export async function fetchChats(limit = 20, cursor = '') {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (cursor) {
    params.set('cursor', cursor)
  }
  const data = await fetchJson(`/conversations/chats?${params.toString()}`)
  return Array.isArray(data.chats) ? data.chats : []
}

export async function streamConversationTurn(payload, { onEvent, signal } = {}) {
  const response = await fetch(`${API_URL}/conversations/turns/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }

    const code = body?.error ?? `HTTP_${response.status}`
    const message = body?.message ?? body?.error ?? `HTTP ${response.status}`
    throw new ApiError(message, response.status, code)
  }

  if (!response.body) {
    throw new ApiError('Streaming response body is missing.', 500, 'STREAM_BODY_MISSING')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) {
        parseAndDispatchEventBlock(buffer, onEvent)
      }
      break
    }

    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const splitIndex = findEventBoundary(buffer)
      if (splitIndex === -1) {
        break
      }

      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + (buffer.startsWith('\r\n', splitIndex) ? 4 : 2))
      parseAndDispatchEventBlock(chunk, onEvent)
    }
  }
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

function findEventBoundary(buffer) {
  const idxLf = buffer.indexOf('\n\n')
  const idxCrlf = buffer.indexOf('\r\n\r\n')

  if (idxLf === -1) return idxCrlf
  if (idxCrlf === -1) return idxLf
  return Math.min(idxLf, idxCrlf)
}

function parseAndDispatchEventBlock(block, onEvent) {
  if (!onEvent) {
    return
  }

  const lines = block.split(/\r?\n/)
  let eventName = 'message'
  const dataLines = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim() || 'message'
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }

  if (dataLines.length === 0) {
    return
  }

  const raw = dataLines.join('\n')
  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }

  onEvent({ event: eventName, data })
}

export { API_URL }
