import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  copyCodeFolderFromLocal,
  createAgent,
  deleteAgent,
  cloneCodeRepo,
  createContextFile,
  createContextFolder,
  createExecuteTask,
  createFollowupTask,
  createWorkspace,
  deleteWorkspace,
  fetchAvailableClis,
  deletePlanThread,
  executeFromPlanThread,
  executePlanProposal,
  fetchAgents,
  fetchChats,
  fetchHumans,
  updateHuman,
  fetchCodeFolders,
  fetchPlans,
  fetchRuntimeServices,
  fetchContextFiles,
  fetchConversationThread,
  fetchPlanProposal,
  fetchTasks,
  openRuntimeServiceStream,
  pickLocalCodeFolder,
  pushCodeFolder,
  openConversationThreadStream,
  openTasksStream,
  fetchWorkspaces,
  respondToTask,
  reviewTask,
  deleteTask,
  stopRuntimeService as stopRuntimeServiceApi,
  setTaskRecipient,
  setActiveWorkspace,
  createConversationTurn,
  streamConversationTurn,
  updateAgent,
  updateContextFile,
  uploadFile,
} from './api'
import { CodeView } from './components/CodeView'
import { ContextView } from './components/ContextView'
import { ConversationDrawer } from './components/ConversationDrawer'
import { InlineChatView } from './components/InlineChatView'
import { ConnectionsView } from './components/ConnectionsView'
import { FilesView } from './components/FilesView'
import { FeedView } from './components/FeedView'
import { InputBar } from './components/InputBar'
import { RightPanel } from './components/RightPanel'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { iconForAgent } from './lib/agentIcon'

const ORCHESTRATOR_AGENT_ID = 'pragma-orchestrator'

function getPendingCount(tasks) {
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

function isWaitingForHumanResponse(status) {
  return status === 'waiting_for_question_response' || status === 'waiting_for_help_response' || status === 'pending_review'
}

function isTaskActivelyRunning(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : ''
  return normalized === 'running' || normalized === 'orchestrating' || normalized === 'queued' || normalized === 'planning'
}

function hasRunningTurn(turns) {
  if (!Array.isArray(turns)) return false
  return turns.some((t) => t && typeof t.status === 'string' && t.status === 'running')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function nextEntryId(prefix) {
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

function buildToolGroupSummary(tools) {
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

function groupConsecutiveToolEntries(entries) {
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
    if (run.length === 1) {
      result.push(run[0])
    } else {
      result.push({
        id: nextEntryId('tool_group'),
        type: 'tool_group',
        tools: run,
        summary: buildToolGroupSummary(run),
      })
    }
  }
  return result
}

function appendToolEntryStreaming(entries, toolEntry) {
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
  return [...entries, toolEntry]
}

function appendAssistantDelta(entries, delta, assistantIdentity) {
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

function summarizeToolEvent(name, payload) {
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

function normalizeTaskTitle(value) {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) {
    return ''
  }
  return title.replace(/^execute:\s*/i, '')
}

function resolveConversationHeaderAgent({ conversation, tasks, agentById }) {
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

function buildEntriesFromThreadData(data, agentById) {
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
    if (message.role !== 'user' && message.role !== 'assistant') {
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

function summarizeStatusEvent(name, payload) {
  if (!name) {
    return ''
  }

  if (name === 'orchestrator_started') {
    return 'Orchestrator started.'
  }
  if (name === 'recipient_requested') {
    return `Manual recipient requested: ${requireEventString(payload?.recipient_agent_id, 'recipient_agent_id')}`
  }
  if (name === 'recipient_selected') {
    const id = requireEventString(payload?.selected_agent_id, 'selected_agent_id')
    return `Recipient selected: ${id}`
  }
  if (name === 'plan_recipient_selected') {
    const id = requireEventString(payload?.selected_agent_id, 'selected_agent_id')
    return `Plan recipient selected: ${id}`
  }
  if (name === 'plan_proposal_submitted') {
    const count = Array.isArray(payload?.tasks) ? payload.tasks.length : 0
    return `Plan proposal submitted with ${count} task${count !== 1 ? 's' : ''}.`
  }
  if (name === 'recipient_selected_via_cli') {
    return ''
  }
  if (name === 'worker_started') {
    return `Worker started: ${requireEventString(payload?.worker_agent_id, 'worker_agent_id')}`
  }
  if (name === 'recipient_required') {
    return requireEventString(payload?.reason, 'reason')
  }
  if (name === 'worker_question_requested') {
    return requireEventString(payload?.question, 'question')
  }
  if (name === 'worker_help_requested') {
    return requireEventString(payload?.summary, 'summary')
  }
  if (name === 'human_response_received') {
    return 'Human response received. Resuming worker.'
  }
  if (name === 'worker_completed') {
    return 'Worker completed.'
  }
  if (name === 'task_reopened') {
    return 'Task reopened. Send a follow-up message to continue.'
  }
  return ''
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

function loadHiddenChatsByWorkspace() {
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

function saveHiddenChatsByWorkspace(value) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(HIDDEN_CHATS_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Ignore storage failures.
  }
}

const CLI_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
}

function OnboardingModal({ open, canClose, onClose, onSubmit, loading, error }) {
  const [name, setName] = useState('')
  const [selectedHarness, setSelectedHarness] = useState('')
  const [clis, setClis] = useState(null)
  const [clisLoading, setClisLoading] = useState(false)
  const [clisError, setClisError] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setSelectedHarness('')
      setClisLoading(true)
      setClisError('')
      fetchAvailableClis()
        .then((result) => {
          setClis(result)
          const firstAvailable = result.find((cli) => cli.available)
          if (firstAvailable) {
            setSelectedHarness(firstAvailable.id)
          }
        })
        .catch(() => {
          setClisError('Failed to detect available CLIs.')
        })
        .finally(() => {
          setClisLoading(false)
        })
    }
  }, [open])

  if (!open) {
    return null
  }

  const availableClis = clis ? clis.filter((cli) => cli.available) : []
  const hasAnyCli = availableClis.length > 0
  const canCreate = name.trim() && selectedHarness && hasAnyCli

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>Create workspace</h2>
        <p>Pick a workspace name and configure the orchestrator.</p>

        <label className="modal-label">Workspace Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Product Launch"
        />

        <div className="orchestrator-config-section">
          <label className="modal-label">Configure Orchestrator</label>
          {clisLoading ? (
            <div className="orchestrator-config-loading">Detecting available CLIs...</div>
          ) : clisError ? (
            <div className="error">{clisError}</div>
          ) : clis ? (
            <>
              <div className="orchestrator-cli-options">
                {clis.map((cli) => (
                  <button
                    key={cli.id}
                    type="button"
                    className={
                      'orchestrator-cli-option' +
                      (selectedHarness === cli.id ? ' orchestrator-cli-option--selected' : '') +
                      (!cli.available ? ' orchestrator-cli-option--disabled' : '')
                    }
                    onClick={() => cli.available && setSelectedHarness(cli.id)}
                    disabled={!cli.available}
                  >
                    <span className="orchestrator-cli-name">{CLI_LABELS[cli.id] || cli.command}</span>
                    <span className="orchestrator-cli-command">{cli.command}</span>
                    {!cli.available && <span className="orchestrator-cli-unavailable">not installed</span>}
                  </button>
                ))}
              </div>
              {!hasAnyCli && (
                <div className="error">
                  No supported CLI found. Install at least one of: claude, codex.
                </div>
              )}
            </>
          ) : null}
        </div>

        {error && <div className="error">Error: {error}</div>}

        <div className="modal-actions">
          {canClose && (
            <button className="modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
          )}
          <button
            className="modal-create"
            onClick={() => onSubmit({ name, orchestrator_harness: selectedHarness })}
            disabled={loading || !canCreate}
          >
            {loading ? 'Creating...' : 'Create workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [activeTab, setActiveTab] = useState('feed')
  const [inputBarText, setInputBarText] = useState('')
  const [followupForTaskId, setFollowupForTaskId] = useState('')

  // Draft messages preserved across tab switches
  const chatDraftsRef = useRef({})
  const [newChatDraft, setNewChatDraft] = useState('')
  const [activeChatDraft, setActiveChatDraft] = useState('')

  const [tasks, setTasks] = useState([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState('')

  const [agents, setAgents] = useState([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [agentsError, setAgentsError] = useState('')

  const [humans, setHumans] = useState([])

  const [contextData, setContextData] = useState({ folders: [], files: [] })
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState('')
  const [codeFolders, setCodeFolders] = useState([])
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeError, setCodeError] = useState('')

  const [workspaces, setWorkspaces] = useState([])
  const [activeWorkspaceName, setActiveWorkspaceName] = useState('')
  const [workspacesLoading, setWorkspacesLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [sidebarPlans, setSidebarPlans] = useState([])
  const [sidebarPlansLoading, setSidebarPlansLoading] = useState(false)
  const [sidebarChats, setSidebarChats] = useState([])
  const [sidebarChatsLoading, setSidebarChatsLoading] = useState(false)
  const [runtimeServices, setRuntimeServices] = useState([])
  const [selectedServiceId, setSelectedServiceId] = useState('')
  const [runtimeServiceLogsById, setRuntimeServiceLogsById] = useState(() => ({}))
  const [runtimeServiceStreamError, setRuntimeServiceStreamError] = useState('')
  const [taskFailureNotice, setTaskFailureNotice] = useState(null)
  const [hiddenChatsByWorkspace, setHiddenChatsByWorkspace] = useState(() =>
    loadHiddenChatsByWorkspace(),
  )
  const [unreadChatIds, setUnreadChatIds] = useState(() => new Set())

  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false)
  const [onboardingError, setOnboardingError] = useState('')
  const [onboardingLoading, setOnboardingLoading] = useState(false)
  const [deleteWorkspaceLoading, setDeleteWorkspaceLoading] = useState(false)
  const [deleteWorkspaceError, setDeleteWorkspaceError] = useState('')
  const [openOrchestratorConfigRequest, setOpenOrchestratorConfigRequest] = useState(0)

  const [conversation, setConversation] = useState({
    open: false,
    mode: 'chat',
    threadId: '',
    taskId: '',
    taskStatus: '',
    taskTitle: '',
    harness: '',
    modelLabel: '',
    reasoningEffort: 'medium',
    recipientAgentId: '',
    entries: [],
    loading: false,
    error: '',
    planReady: false,
    planProposal: null,
  })

  const streamAbortRef = useRef(null)
  const threadIdRef = useRef(conversation.threadId)
  const tasksRefreshTimerRef = useRef(null)
  const conversationSyncInFlightRef = useRef(false)
  const conversationSyncPendingRef = useRef(false)
  const conversationSyncRetryTimerRef = useRef(null)
  const tasksRefreshInFlightRef = useRef(false)
  const tasksRefreshQueuedRef = useRef(false)
  const tasksInitialLoadDoneRef = useRef(false)
  const runtimeServicesPollTimerRef = useRef(null)
  const chatsPollTimerRef = useRef(null)
  const prevThinkingChatIdsRef = useRef(new Set())
  const viewingChatIdRef = useRef('')
  const runtimeServiceStreamCloseRef = useRef(null)
  const tasksRef = useRef(tasks)
  const pendingCount = useMemo(() => getPendingCount(tasks), [tasks])
  const orchestratorRuntime = useMemo(() => {
    return agents.find((agent) => agent?.id === ORCHESTRATOR_AGENT_ID) ?? null
  }, [agents])
  const recipientAgents = useMemo(() => {
    return agents.filter((agent) => agent && agent.id && agent.id !== ORCHESTRATOR_AGENT_ID)
  }, [agents])
  const agentById = useMemo(() => {
    const map = Object.create(null)
    for (const agent of agents) {
      if (!agent || typeof agent.id !== 'string' || !agent.id) {
        continue
      }
      map[agent.id] = agent
    }
    return map
  }, [agents])
  const hasAnyWorkspace = workspaces.length > 0
  const activePlanThreadId =
    conversation.open && conversation.mode === 'plan' ? conversation.threadId : ''
  const conversationHeaderAgent = useMemo(() => {
    return resolveConversationHeaderAgent({
      conversation,
      tasks,
      agentById,
    })
  }, [conversation, tasks, agentById])
  const visibleSidebarChats = useMemo(() => {
    const hiddenIds = new Set(hiddenChatsByWorkspace[activeWorkspaceName] || [])
    if (hiddenIds.size === 0) {
      return sidebarChats
    }
    return sidebarChats.filter((chat) => !hiddenIds.has(chat.id))
  }, [sidebarChats, hiddenChatsByWorkspace, activeWorkspaceName])
  const thinkingChatIds = useMemo(() => {
    const ids = new Set()
    // Currently streaming conversation in chat mode
    if (conversation.mode === 'chat' && conversation.loading && conversation.threadId) {
      ids.add(conversation.threadId)
    }
    // Chats with a running turn from server data
    for (const chat of sidebarChats) {
      if (chat.latest_turn_status === 'running') {
        ids.add(chat.id)
      }
    }
    return ids
  }, [conversation.mode, conversation.loading, conversation.threadId, sidebarChats])

  // Mark chats as unread when they stop thinking and the user isn't viewing them
  useEffect(() => {
    const prev = prevThinkingChatIdsRef.current
    const activeChatId =
      conversation.open && conversation.mode === 'chat' ? conversation.threadId : ''
    const viewingId = viewingChatIdRef.current
    const newlyDone = []
    for (const id of prev) {
      if (!thinkingChatIds.has(id) && id !== activeChatId && id !== viewingId) {
        newlyDone.push(id)
      }
    }
    if (newlyDone.length > 0) {
      setUnreadChatIds((current) => {
        const next = new Set(current)
        for (const id of newlyDone) {
          next.add(id)
        }
        return next
      })
    }
    prevThinkingChatIdsRef.current = new Set(thinkingChatIds)
  }, [thinkingChatIds, conversation.open, conversation.mode, conversation.threadId])

  const selectedRuntimeService = useMemo(() => {
    if (!selectedServiceId) {
      return null
    }
    return runtimeServices.find((service) => service.id === selectedServiceId) || null
  }, [runtimeServices, selectedServiceId])
  const selectedRuntimeServiceLogs = useMemo(() => {
    if (!selectedServiceId) {
      return []
    }
    const logs = runtimeServiceLogsById[selectedServiceId]
    return Array.isArray(logs) ? logs : []
  }, [runtimeServiceLogsById, selectedServiceId])
  const conversationRuntimeService =
    selectedRuntimeService &&
    conversation.taskId &&
    selectedRuntimeService.task_id === conversation.taskId
      ? selectedRuntimeService
      : null
  const visibleRuntimeServices = useMemo(() => {
    return runtimeServices.filter((service) => {
      if (service?.status === 'running') {
        return true
      }
      return service?.id === selectedServiceId
    })
  }, [runtimeServices, selectedServiceId])

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    threadIdRef.current = conversation.threadId
  }, [conversation.threadId])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    setTaskFailureNotice(null)
  }, [activeWorkspaceName])

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
      if (tasksRefreshTimerRef.current) {
        clearTimeout(tasksRefreshTimerRef.current)
        tasksRefreshTimerRef.current = null
      }
      if (conversationSyncRetryTimerRef.current) {
        clearTimeout(conversationSyncRetryTimerRef.current)
        conversationSyncRetryTimerRef.current = null
      }
      if (runtimeServicesPollTimerRef.current) {
        clearInterval(runtimeServicesPollTimerRef.current)
        runtimeServicesPollTimerRef.current = null
      }
      if (chatsPollTimerRef.current) {
        clearInterval(chatsPollTimerRef.current)
        chatsPollTimerRef.current = null
      }
      runtimeServiceStreamCloseRef.current?.()
      runtimeServiceStreamCloseRef.current = null
      conversationSyncPendingRef.current = false
      tasksRefreshQueuedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (
      !conversation.open ||
      conversation.mode !== 'chat' ||
      !conversation.taskId ||
      !conversation.threadId
    ) {
      return
    }

    let cancelled = false
    const scheduleConversationRetry = (delayMs = 150) => {
      if (cancelled || conversationSyncRetryTimerRef.current) {
        return
      }
      conversationSyncRetryTimerRef.current = setTimeout(() => {
        conversationSyncRetryTimerRef.current = null
        void syncOpenConversation()
      }, delayMs)
    }

    const syncOpenConversation = async () => {
      if (cancelled) {
        return
      }

      if (conversationSyncInFlightRef.current) {
        conversationSyncPendingRef.current = true
        return
      }

      conversationSyncInFlightRef.current = true
      try {
        conversationSyncPendingRef.current = false

        const currentThreadId = threadIdRef.current
        if (!currentThreadId || cancelled) {
          return
        }
        const data = await fetchConversationThread(currentThreadId)
        if (!data?.thread || cancelled) {
          return
        }

        const nextEntries = buildEntriesFromThreadData(data, agentById)
        const turnsRunning = hasRunningTurn(data.turns)

        // Fetch plan proposal if this is a plan thread
        let proposal = null
        if (data.thread.mode === 'plan') {
          try {
            proposal = await fetchPlanProposal(currentThreadId)
          } catch {
            // Proposal fetch failure is non-critical
          }
        }

        setConversation((prev) => {
          if (!prev.open || prev.threadId !== threadIdRef.current || cancelled) {
            return prev
          }
          const nextLoading = prev.taskId
            ? prev.loading
            : turnsRunning
          return {
            ...prev,
            harness: data.thread.harness,
            modelLabel: data.thread.model_label,
            loading: nextLoading,
            entries: nextEntries,
            ...(data.thread.mode === 'plan' && proposal ? { planProposal: proposal, planReady: true } : {}),
          }
        })
      } catch {
        // Keep current entries if background sync fails.
      } finally {
        conversationSyncInFlightRef.current = false
        if (conversationSyncPendingRef.current) {
          conversationSyncPendingRef.current = false
          scheduleConversationRetry(150)
        }
      }
    }

    const closeStream = openConversationThreadStream(conversation.threadId, {
      onReady: () => {
        void syncOpenConversation()
      },
      onThreadUpdated: () => {
        void syncOpenConversation()
      },
    })

    void syncOpenConversation()

    return () => {
      cancelled = true
      if (conversationSyncRetryTimerRef.current) {
        clearTimeout(conversationSyncRetryTimerRef.current)
        conversationSyncRetryTimerRef.current = null
      }
      conversationSyncPendingRef.current = false
      closeStream()
    }
  }, [conversation.open, conversation.mode, conversation.taskId, conversation.threadId, agentById])

  async function flushTasksRefresh() {
    if (tasksRefreshInFlightRef.current) {
      tasksRefreshQueuedRef.current = true
      return
    }

    tasksRefreshInFlightRef.current = true
    try {
      do {
        tasksRefreshQueuedRef.current = false
        await loadTasks()
      } while (tasksRefreshQueuedRef.current)
    } finally {
      tasksRefreshInFlightRef.current = false
    }
  }

  function scheduleTasksRefresh(delayMs = 250) {
    if (tasksRefreshTimerRef.current) {
      clearTimeout(tasksRefreshTimerRef.current)
    }
    tasksRefreshTimerRef.current = setTimeout(() => {
      tasksRefreshTimerRef.current = null
      void flushTasksRefresh()
    }, delayMs)
  }

  useEffect(() => {
    if (!activeWorkspaceName) {
      return
    }

    const closeStream = openTasksStream({
      onReady: () => {
        scheduleTasksRefresh(0)
      },
      onTaskStatusChanged: (event) => {
        const taskId = typeof event?.task_id === 'string' ? event.task_id : ''
        const status = typeof event?.status === 'string' ? event.status : ''
        const threadId = typeof event?.thread_id === 'string' ? event.thread_id : ''

        if (taskId && status) {
          setTasks((prev) =>
            prev.map((task) => {
              if (task.id !== taskId) return task
              const updates = { ...task, status }
              if (threadId && !task.thread_id) {
                updates.thread_id = threadId
              }
              return updates
            }),
          )
          setConversation((prev) => {
            // Guard: taskId mismatch prevents cross-task status/threadId
            // assignment when multiple agents run concurrently.
            if (prev.taskId !== taskId || prev.taskStatus === status) {
              return prev
            }
            const nextLoading = isTaskActivelyRunning(status)
            const updates = {
              ...prev,
              taskStatus: status,
              loading: nextLoading,
            }
            if (!prev.threadId && threadId) {
              updates.threadId = threadId
            }
            return updates
          })
        }

        if (taskId && status === 'failed') {
          const latestTasks = Array.isArray(tasksRef.current) ? tasksRef.current : []
          const task = latestTasks.find((item) => item?.id === taskId) || null
          const rawTitle = typeof task?.title === 'string' ? task.title : ''
          const normalizedTitle = rawTitle ? normalizeTaskTitle(rawTitle) : ''
          setTaskFailureNotice({
            taskId,
            taskTitle: normalizedTitle || taskId,
          })
        }

        scheduleTasksRefresh(250)

        // Refresh plans sidebar when a plan-related status change occurs
        if (status === 'planned' || status === 'planning' || status === 'waiting_for_question_response') {
          void loadPlans()
        }
      },
    })

    return () => {
      if (tasksRefreshTimerRef.current) {
        clearTimeout(tasksRefreshTimerRef.current)
        tasksRefreshTimerRef.current = null
      }
      tasksRefreshQueuedRef.current = false
      closeStream()
    }
  }, [activeWorkspaceName])

  useEffect(() => {
    if (!activeWorkspaceName) {
      setRuntimeServices([])
      setSelectedServiceId('')
      setRuntimeServiceLogsById({})
      setRuntimeServiceStreamError('')
      return
    }

    void loadRuntimeServices()

    if (runtimeServicesPollTimerRef.current) {
      clearInterval(runtimeServicesPollTimerRef.current)
    }
    runtimeServicesPollTimerRef.current = setInterval(() => {
      void loadRuntimeServices()
    }, 3000)

    return () => {
      if (runtimeServicesPollTimerRef.current) {
        clearInterval(runtimeServicesPollTimerRef.current)
        runtimeServicesPollTimerRef.current = null
      }
    }
  }, [activeWorkspaceName])

  useEffect(() => {
    runtimeServiceStreamCloseRef.current?.()
    runtimeServiceStreamCloseRef.current = null
    setRuntimeServiceStreamError('')

    if (!selectedServiceId) {
      return
    }

    const close = openRuntimeServiceStream(selectedServiceId, {
      onReady: (payload) => {
        if (!payload || typeof payload !== 'object') {
          return
        }
        if (payload.service && typeof payload.service === 'object') {
          upsertRuntimeService(payload.service)
        }
        if (Array.isArray(payload.logs)) {
          setRuntimeServiceLogsById((prev) => ({
            ...prev,
            [selectedServiceId]: payload.logs,
          }))
        }
      },
      onLog: (payload) => {
        const entry = payload?.entry
        if (!entry || typeof entry !== 'object') {
          return
        }
        setRuntimeServiceLogsById((prev) => {
          const existing = Array.isArray(prev[selectedServiceId]) ? prev[selectedServiceId] : []
          const nextLogs = [...existing, entry]
          if (nextLogs.length > 2000) {
            nextLogs.splice(0, nextLogs.length - 2000)
          }
          return {
            ...prev,
            [selectedServiceId]: nextLogs,
          }
        })
      },
      onStatus: (payload) => {
        const nextService = payload?.service
        if (!nextService || typeof nextService !== 'object') {
          return
        }
        upsertRuntimeService(nextService)
      },
      onError: () => {
        setRuntimeServiceStreamError('Service log stream disconnected.')
      },
    })

    runtimeServiceStreamCloseRef.current = close
    return () => {
      close()
      if (runtimeServiceStreamCloseRef.current === close) {
        runtimeServiceStreamCloseRef.current = null
      }
    }
  }, [selectedServiceId])

  useEffect(() => {
    if (!conversation.taskId) {
      return
    }

    const currentTaskId = conversation.taskId
    const match = tasks.find((task) => task.id === currentTaskId)
    const nextStatus = typeof match?.status === 'string' ? match.status : ''
    const nextThreadId = typeof match?.thread_id === 'string' ? match.thread_id : ''
    if (
      (!nextStatus || nextStatus === conversation.taskStatus) &&
      (!nextThreadId || conversation.threadId)
    ) {
      return
    }

    setConversation((prev) => {
      if (prev.taskId !== currentTaskId) {
        return prev
      }

      const updates = {}
      if (nextStatus && prev.taskStatus !== nextStatus) {
        updates.taskStatus = nextStatus
        updates.loading = isTaskActivelyRunning(nextStatus)
      }
      if (!prev.threadId && nextThreadId) {
        updates.threadId = nextThreadId
      } else if (prev.threadId && nextThreadId && prev.threadId !== nextThreadId) {
        // Do NOT overwrite an existing threadId with a different one.
        // This prevents a race where a task list refresh brings in a
        // thread_id from a different task's status change timing.
      }
      if (Object.keys(updates).length === 0) {
        return prev
      }

      return {
        ...prev,
        ...updates,
      }
    })
  }, [tasks, conversation.taskId, conversation.taskStatus, conversation.threadId])

  useEffect(() => {
    saveHiddenChatsByWorkspace(hiddenChatsByWorkspace)
  }, [hiddenChatsByWorkspace])

  useEffect(() => {
    if (activeTab !== 'feed' && openOrchestratorConfigRequest !== 0) {
      setOpenOrchestratorConfigRequest(0)
    }
  }, [activeTab, openOrchestratorConfigRequest])

  async function resolveOrchestratorRuntime() {
    if (orchestratorRuntime) {
      return orchestratorRuntime
    }

    try {
      const latestAgents = await fetchAgents()
      setAgents(latestAgents)
      const runtime = latestAgents.find((agent) => agent?.id === ORCHESTRATOR_AGENT_ID) ?? null
      if (runtime) {
        return runtime
      }
      setAgentsError('Orchestrator agent is missing from this workspace.')
      return null
    } catch (error) {
      setAgentsError(errorText(error))
      return null
    }
  }

  async function bootstrap() {
    setWorkspaceError('')
    setWorkspacesLoading(true)
    try {
      const next = await fetchWorkspaces()
      setWorkspaces(next)

      const active = next.find((ws) => ws.active)?.name ?? ''
      setActiveWorkspaceName(active)

      if (next.length === 0) {
        setIsOnboardingOpen(true)
        clearWorkspaceData()
        return
      }

      if (!active) {
        setWorkspaceError('No active workspace selected.')
        clearWorkspaceData()
        return
      }

      await loadWorkspaceData()
    } catch (error) {
      setWorkspaceError(errorText(error))
      clearWorkspaceData()
    } finally {
      setWorkspacesLoading(false)
    }
  }

  function clearWorkspaceData() {
    setTasks([])
    tasksInitialLoadDoneRef.current = false
    setAgents([])
    setHumans([])
    setContextData({ folders: [], files: [] })
    setCodeFolders([])
    setCodeLoading(false)
    setSidebarPlans([])
    setSidebarPlansLoading(false)
    setSidebarChats([])
    setSidebarChatsLoading(false)
    setTasksError('')
    setAgentsError('')
    setContextError('')
    setCodeError('')
    setRuntimeServices([])
    setSelectedServiceId('')
    setRuntimeServiceLogsById({})
    setRuntimeServiceStreamError('')
    runtimeServiceStreamCloseRef.current?.()
    runtimeServiceStreamCloseRef.current = null
    if (runtimeServicesPollTimerRef.current) {
      clearInterval(runtimeServicesPollTimerRef.current)
      runtimeServicesPollTimerRef.current = null
    }
    if (chatsPollTimerRef.current) {
      clearInterval(chatsPollTimerRef.current)
      chatsPollTimerRef.current = null
    }
    closeConversationDrawer()
  }

  async function loadWorkspaceData() {
    await Promise.all([
      loadTasks(),
      loadAgents(),
      loadHumans(),
      loadContext(),
      loadCode(),
      loadPlans(),
      loadChats(),
      loadRuntimeServices(),
    ])
  }

  async function loadRuntimeServices() {
    try {
      const next = await fetchRuntimeServices()
      setRuntimeServices(next)
      if (selectedServiceId && !next.some((service) => service.id === selectedServiceId)) {
        setSelectedServiceId('')
        setRuntimeServiceStreamError('')
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setRuntimeServices([])
        setSelectedServiceId('')
        return
      }
      if (error instanceof ApiError && error.code === 'REQUEST_TIMEOUT') {
        // Background polling can occasionally stall; skip noisy global errors and retry on next tick.
        return
      }
      // Keep prior services list; avoid blocking the app on transient background polling failures.
    }
  }

  function upsertRuntimeService(nextService) {
    if (!nextService || typeof nextService !== 'object' || !nextService.id) {
      return
    }
    setRuntimeServices((prev) => {
      const index = prev.findIndex((service) => service.id === nextService.id)
      if (index === -1) {
        return [nextService, ...prev]
      }
      const next = [...prev]
      next[index] = { ...next[index], ...nextService }
      return next
    })
  }

  function handleRuntimeServiceStarted(service) {
    upsertRuntimeService(service)
    if (service?.id) {
      setSelectedServiceId(service.id)
    }
  }

  async function handleStopRuntimeService(serviceId) {
    if (!serviceId) {
      return
    }
    try {
      const result = await stopRuntimeServiceApi(serviceId)
      if (result?.service) {
        upsertRuntimeService(result.service)
      } else {
        await loadRuntimeServices()
      }
      if (selectedServiceId === serviceId) {
        setSelectedServiceId('')
      }
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleOpenRuntimeService(service) {
    if (!service || typeof service !== 'object') {
      return
    }

    const serviceId = typeof service.id === 'string' ? service.id : ''
    const taskId = typeof service.task_id === 'string' ? service.task_id : ''
    if (!serviceId || !taskId) {
      return
    }

    setSelectedServiceId(serviceId)
    const existingTask = tasks.find((task) => task?.id === taskId)
    if (existingTask) {
      await handleOpenTaskConversation(existingTask, { serviceId })
      return
    }

    let refreshedTask = null
    try {
      const refreshedTasks = await fetchTasks(300)
      setTasks(refreshedTasks)
      refreshedTask = refreshedTasks.find((task) => task?.id === taskId) || null
    } catch {
      refreshedTask = null
    }
    if (refreshedTask) {
      await handleOpenTaskConversation(refreshedTask, { serviceId })
      return
    }

    setWorkspaceError(`Task not found for process task ${taskId}.`)
  }

  async function loadPlans() {
    setSidebarPlansLoading(true)
    try {
      setSidebarPlans(await fetchPlans(20))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setSidebarPlans([])
        return
      }
      if (error instanceof ApiError && error.code === 'REQUEST_TIMEOUT') {
        return
      }
      // Keep existing list if fetch fails and surface in workspace error area.
      setWorkspaceError((prev) => prev || errorText(error))
    } finally {
      setSidebarPlansLoading(false)
    }
  }

  async function loadTasks() {
    // Only show loading spinner on initial load; subsequent refreshes are silent
    if (!tasksInitialLoadDoneRef.current) {
      setTasksLoading(true)
    }
    setTasksError('')
    try {
      setTasks(await fetchTasks(300))
      tasksInitialLoadDoneRef.current = true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setTasks([])
        setTasksError('No active workspace.')
        return
      }
      setTasksError(errorText(error))
    } finally {
      setTasksLoading(false)
    }
  }

  async function loadChats({ silent = false } = {}) {
    if (!silent) {
      setSidebarChatsLoading(true)
    }
    try {
      setSidebarChats(await fetchChats(20))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setSidebarChats([])
        return
      }
      if (error instanceof ApiError && error.code === 'REQUEST_TIMEOUT') {
        return
      }
      // Keep existing list if fetch fails and surface in workspace error area.
      setWorkspaceError((prev) => prev || errorText(error))
    } finally {
      if (!silent) {
        setSidebarChatsLoading(false)
      }
    }
  }

  // Poll sidebar chats while any chat has a running turn so the spinner
  // stays visible even when the user is viewing a different tab.
  useEffect(() => {
    if (chatsPollTimerRef.current) {
      clearInterval(chatsPollTimerRef.current)
      chatsPollTimerRef.current = null
    }
    if (thinkingChatIds.size === 0 || !activeWorkspaceName) {
      return
    }
    chatsPollTimerRef.current = setInterval(() => {
      void loadChats({ silent: true })
    }, 3000)
    return () => {
      if (chatsPollTimerRef.current) {
        clearInterval(chatsPollTimerRef.current)
        chatsPollTimerRef.current = null
      }
    }
  }, [thinkingChatIds.size > 0, activeWorkspaceName])

  async function loadAgents() {
    setAgentsLoading(true)
    setAgentsError('')
    try {
      setAgents(await fetchAgents())
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setAgents([])
        setAgentsError('No active workspace.')
        return
      }
      setAgentsError(errorText(error))
    } finally {
      setAgentsLoading(false)
    }
  }

  async function loadHumans() {
    try {
      setHumans(await fetchHumans())
    } catch {
      // Humans are non-critical; keep empty list on failure.
    }
  }

  async function handleUpdateHumanEmoji(id, emoji) {
    try {
      await updateHuman(id, emoji)
      await loadHumans()
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleCreateAgent(agent) {
    await createAgent(agent)
    await loadAgents()
  }

  async function handleUpdateAgent(id, updates) {
    await updateAgent(id, updates)
    await loadAgents()
  }

  async function handleDeleteAgent(id) {
    await deleteAgent(id)
    await loadAgents()
  }

  async function loadContext() {
    setContextLoading(true)
    setContextError('')
    try {
      setContextData(await fetchContextFiles())
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setContextData({ folders: [], files: [] })
        setContextError('No active workspace.')
        return
      }
      setContextError(errorText(error))
    } finally {
      setContextLoading(false)
    }
  }

  async function loadCode() {
    setCodeLoading(true)
    setCodeError('')
    try {
      setCodeFolders(await fetchCodeFolders())
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setCodeFolders([])
        setCodeError('No active workspace.')
        return
      }
      setCodeError(errorText(error))
    } finally {
      setCodeLoading(false)
    }
  }

  async function handleSaveContextFile(path, content) {
    await updateContextFile(path, content)
    await loadContext()
  }

  async function handleCreateContextFolder(name) {
    await createContextFolder(name)
    await loadContext()
  }

  async function handleCreateContextFile(name, folder) {
    await createContextFile(name, folder)
    await loadContext()
  }

  async function handleCloneCodeRepo(gitUrl) {
    await cloneCodeRepo(gitUrl)
    await loadCode()
  }

  async function handleCopyCodeFolderFromLocal(localPath) {
    await copyCodeFolderFromLocal(localPath)
    await loadCode()
  }

  async function handlePickLocalCodeFolder() {
    const result = await pickLocalCodeFolder()
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid folder picker response.')
    }
    if (result.cancelled === true) {
      return ''
    }
    return typeof result.path === 'string' ? result.path : ''
  }

  async function handlePushCodeFolder(folderName) {
    await pushCodeFolder(folderName)
    await loadCode()
  }

  async function refreshWorkspaces() {
    const next = await fetchWorkspaces()
    setWorkspaces(next)
    const active = next.find((ws) => ws.active)?.name || ''
    setActiveWorkspaceName(active)
    return { next, active }
  }

  async function handleSelectWorkspace(name) {
    if (!name || name === activeWorkspaceName) {
      return
    }

    const previous = activeWorkspaceName
    setActiveWorkspaceName(name)
    setWorkspaceError('')

    try {
      await setActiveWorkspace(name)
      await refreshWorkspaces()
      await loadWorkspaceData()
    } catch (error) {
      setActiveWorkspaceName(previous)
      setWorkspaceError(errorText(error))
    }
  }

  async function handleCreateWorkspace({ name, orchestrator_harness }) {
    setOnboardingError('')

    if (!name || !name.trim()) {
      setOnboardingError('Workspace name is required.')
      return
    }

    if (!orchestrator_harness) {
      setOnboardingError('Select an orchestrator CLI.')
      return
    }

    setOnboardingLoading(true)
    try {
      await createWorkspace({ name, orchestrator_harness })
      await refreshWorkspaces()
      await loadWorkspaceData()
      setIsOnboardingOpen(false)
    } catch (error) {
      setOnboardingError(errorText(error))
    } finally {
      setOnboardingLoading(false)
    }
  }

  async function handleDeleteActiveWorkspace() {
    if (!activeWorkspaceName) {
      return
    }

    const confirmed = window.confirm(
      `Delete workspace \"${activeWorkspaceName}\" and all its files? This cannot be undone.`,
    )
    if (!confirmed) {
      return
    }

    setDeleteWorkspaceLoading(true)
    setDeleteWorkspaceError('')
    setWorkspaceError('')

    try {
      await deleteWorkspace(activeWorkspaceName)
      const { next, active } = await refreshWorkspaces()

      if (next.length === 0) {
        clearWorkspaceData()
        setActiveWorkspaceName('')
        setIsOnboardingOpen(true)
        setActiveTab('feed')
        return
      }

      if (!active) {
        clearWorkspaceData()
        setWorkspaceError('No active workspace selected.')
        return
      }

      await loadWorkspaceData()
    } catch (error) {
      setDeleteWorkspaceError(errorText(error))
    } finally {
      setDeleteWorkspaceLoading(false)
    }
  }

  function handleStopStream() {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setConversation((prev) => ({
      ...prev,
      loading: false,
    }))
  }

  function closeConversationDrawer() {
    viewingChatIdRef.current = ''
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setConversation({
      open: false,
      mode: 'chat',
      threadId: '',
      taskId: '',
      taskStatus: '',
      taskTitle: '',
      harness: '',
      modelLabel: '',
      reasoningEffort: 'medium',
      recipientAgentId: '',
      entries: [],
      loading: false,
      error: '',
      planReady: false,
      planProposal: null,
    })
  }

  async function handleInputSubmit({ message, mode, reasoningEffort, attachments, recipientAgentId }) {
    setWorkspaceError('')

    let finalMessage = message
    if (attachments && attachments.length > 0) {
      try {
        const uploaded = await Promise.all(
          attachments.map((att) => uploadFile(att.file)),
        )
        const lines = uploaded.map(
          (u) => `[Attached file: ${u.path}]`,
        )
        finalMessage = (message ? message + '\n\n' : '') + lines.join('\n')
      } catch (error) {
        setWorkspaceError(errorText(error))
        return
      }
    }

    const continueExistingExecute =
      mode === 'execute' &&
      conversation.open &&
      !conversation.loading &&
      conversation.mode === 'execute' &&
      Boolean(conversation.threadId)

    if (followupForTaskId) {
      const parentId = followupForTaskId
      setFollowupForTaskId('')
      try {
        const result = await createFollowupTask(parentId, {
          prompt: finalMessage,
          recipient_agent_id: recipientAgentId,
          reasoning_effort: reasoningEffort,
        })
        // Optimistically add the new followup task
        const taskId = result?.task_id
        if (taskId) {
          const title = finalMessage.length > 100 ? `${finalMessage.slice(0, 97)}...` : finalMessage
          setTasks((prev) => {
            const updated = prev.map((t) =>
              t.id === parentId ? { ...t, followup_task_id: taskId } : t
            )
            return [{
              id: taskId,
              title,
              status: 'queued',
              assigned_to: null,
              output_dir: null,
              session_id: null,
              created_at: new Date().toISOString(),
              completed_at: null,
              followup_task_id: null,
              predecessor_task_id: parentId,
              thread_id: null,
            }, ...updated]
          })
        }
        // Refresh in background to get server-canonical data
        scheduleTasksRefresh(500)
      } catch (error) {
        setWorkspaceError(errorText(error))
      }
      return
    }

    if (mode === 'execute' && !continueExistingExecute) {
      try {
        const result = await createExecuteTask({
          prompt: finalMessage,
          recipient_agent_id: recipientAgentId,
          reasoning_effort: reasoningEffort,
        })
        // Optimistically add the new task so it appears instantly
        const taskId = result?.task_id
        if (taskId) {
          const title = finalMessage.length > 100 ? `${finalMessage.slice(0, 97)}...` : finalMessage
          setTasks((prev) => [{
            id: taskId,
            title,
            status: 'queued',
            assigned_to: null,
            output_dir: null,
            session_id: null,
            created_at: new Date().toISOString(),
            completed_at: null,
            followup_task_id: null,
            predecessor_task_id: null,
            thread_id: null,
          }, ...prev])
        }
        setActiveTab('feed')
        // Refresh in background to get server-canonical data (e.g. AI-generated title)
        scheduleTasksRefresh(500)
      } catch (error) {
        setWorkspaceError(errorText(error))
      }
      return
    }

    const continueExistingPlan =
      mode === 'plan' &&
      conversation.open &&
      !conversation.loading &&
      conversation.mode === 'plan' &&
      Boolean(conversation.threadId)

    if (mode === 'plan' && !continueExistingPlan) {
      try {
        const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
        if (!runtime) {
          setWorkspaceError('Orchestrator runtime is not available.')
          return
        }
        const result = await createConversationTurn({
          message: finalMessage,
          mode: 'plan',
          harness: runtime.harness,
          model_label: runtime.model_label,
          reasoning_effort: reasoningEffort,
          recipient_agent_id: recipientAgentId || undefined,
        })
        const taskId = result?.task_id
        if (taskId) {
          const title = finalMessage.length > 100 ? `${finalMessage.slice(0, 97)}...` : finalMessage
          setTasks((prev) => [{
            id: taskId,
            title,
            status: 'planning',
            assigned_to: null,
            output_dir: null,
            session_id: null,
            created_at: new Date().toISOString(),
            completed_at: null,
            followup_task_id: null,
            predecessor_task_id: null,
            thread_id: result?.thread_id || null,
          }, ...prev])
        }
        setActiveTab('feed')
        scheduleTasksRefresh(500)
        void loadPlans()
      } catch (error) {
        setWorkspaceError(errorText(error))
      }
      return
    }

    const conversationStatus = String(conversation.taskStatus || '').toLowerCase()
    if (
      (mode === 'chat' || mode === 'plan') &&
      conversation.open &&
      conversation.taskId &&
      isWaitingForHumanResponse(conversationStatus)
    ) {
      try {
        await respondToTask(conversation.taskId, finalMessage)
        setConversation((prev) => ({
          ...prev,
          taskStatus: prev.mode === 'plan' ? 'planning' : 'queued',
          entries: [
            ...prev.entries,
            { id: nextEntryId('user'), type: 'user', content: finalMessage },
            {
              id: nextEntryId('status'),
              type: 'status',
              content: prev.mode === 'plan'
                ? 'Response sent. Continuing plan.'
                : 'Response sent. Task re-queued with the same worker.',
            },
          ],
        }))
        // Optimistically update the task status in the list
        setTasks((prev) =>
          prev.map((t) =>
            t.id === conversation.taskId
              ? { ...t, status: conversation.mode === 'plan' ? 'planning' : 'queued' }
              : t
          )
        )
        scheduleTasksRefresh(500)
      } catch (error) {
        setWorkspaceError(errorText(error))
      }
      return
    }

    const forceContinueOpenChat =
      mode === 'chat' &&
      conversation.open &&
      !conversation.loading &&
      conversation.mode === 'chat' &&
      Boolean(conversation.threadId)

    const forceContinueExisting = forceContinueOpenChat || continueExistingExecute || continueExistingPlan

    if (!forceContinueExisting && !orchestratorRuntime) {
      const refreshedRuntime = await resolveOrchestratorRuntime()
      if (!refreshedRuntime) {
        setWorkspaceError('Orchestrator runtime is not available.')
        return
      }
    }

    const runtime = forceContinueExisting
      ? null
      : orchestratorRuntime ?? (await resolveOrchestratorRuntime())
    if (!forceContinueExisting && !runtime) {
      setWorkspaceError('Orchestrator runtime is not available.')
      return
    }

    const effectiveHarness = forceContinueExisting
      ? conversation.harness
      : runtime.harness
    const effectiveModelLabel = forceContinueExisting
      ? conversation.modelLabel
      : runtime.model_label

    const reuseExisting =
      conversation.open &&
      !conversation.loading &&
      conversation.mode === mode &&
      conversation.harness === effectiveHarness &&
      conversation.modelLabel === effectiveModelLabel

    const nextThreadId = reuseExisting ? conversation.threadId || undefined : undefined
    const nextEntries = reuseExisting ? [...conversation.entries] : []
    nextEntries.push({ id: nextEntryId('user'), type: 'user', content: finalMessage })
    const streamAssistantAgent = runtime ?? orchestratorRuntime ?? null
    const streamAssistantIdentity = {
      agentId: streamAssistantAgent?.id || ORCHESTRATOR_AGENT_ID,
      agentName:
        streamAssistantAgent?.name ||
        streamAssistantAgent?.id ||
        'Orchestrator',
      agentEmoji:
        streamAssistantAgent?.emoji ||
        iconForAgent(streamAssistantAgent?.id || ORCHESTRATOR_AGENT_ID),
    }

    setConversation({
      open: true,
      mode,
      threadId: nextThreadId || '',
      taskId: reuseExisting ? conversation.taskId : '',
      taskStatus: reuseExisting ? conversation.taskStatus : '',
      taskTitle: reuseExisting ? conversation.taskTitle : '',
      harness: effectiveHarness,
      modelLabel: effectiveModelLabel,
      reasoningEffort,
      recipientAgentId:
        mode === 'plan' && reuseExisting ? conversation.recipientAgentId : '',
      entries: nextEntries,
      loading: true,
      error: '',
      planReady: mode === 'plan' ? false : undefined,
    })

    const controller = new AbortController()
    streamAbortRef.current?.abort()
    streamAbortRef.current = controller

    // Track the threadId for this streaming turn so late-arriving events
    // do not leak into a conversation that the user has since navigated away from.
    let streamThreadId = nextThreadId || ''

    try {
      await streamConversationTurn(
        {
          thread_id: nextThreadId,
          message: finalMessage,
          mode,
          harness: effectiveHarness,
          model_label: effectiveModelLabel,
          reasoning_effort: reasoningEffort,
        },
        {
          signal: controller.signal,
          onEvent: ({ event, data }) => {
            setConversation((prev) => {
              if (event === 'thread_started') {
                streamThreadId = data.thread_id
                if (mode === 'chat') {
                  void loadChats()
                }
                if (mode === 'plan') {
                  void loadPlans()
                }
                return {
                  ...prev,
                  threadId: data.thread_id,
                }
              }

              // Guard: drop events targeting a thread the user is no longer viewing.
              if (streamThreadId && prev.threadId && prev.threadId !== streamThreadId) {
                return prev
              }

              if (event === 'assistant_text') {
                return {
                  ...prev,
                  entries: appendAssistantDelta(prev.entries, data.delta, streamAssistantIdentity),
                }
              }

              if (event === 'tool_event') {
                const toolSummary = summarizeToolEvent(data?.name, data?.payload)
                if (!toolSummary) {
                  return prev
                }

                return {
                  ...prev,
                  entries: appendToolEntryStreaming(prev.entries, {
                    id: nextEntryId('tool'),
                    type: 'tool',
                    label: toolSummary.label,
                    summary: toolSummary.summary,
                  }),
                }
              }

              if (event === 'error') {
                return {
                  ...prev,
                  error: data.message,
                }
              }

              return prev
            })
          },
        },
      )
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }

      setConversation((prev) => ({
        ...prev,
        error: errorText(error),
      }))
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null
      }
      setConversation((prev) => {
        // Only update loading/planReady if the conversation still matches the
        // thread that was being streamed; otherwise leave state unchanged.
        if (streamThreadId && prev.threadId && prev.threadId !== streamThreadId) {
          return prev
        }
        return {
          ...prev,
          loading: prev.taskId ? isTaskActivelyRunning(prev.taskStatus) : false,
          planReady: mode === 'plan' ? true : prev.planReady,
        }
      })
      if (mode === 'chat') {
        await loadChats()
      }
      if (mode === 'plan') {
        await loadPlans()
      }
    }
  }

  async function handleExecuteFromPlan() {
    if (!conversation.threadId || conversation.mode !== 'plan') {
      return
    }

    try {
      const planThreadId = conversation.threadId
      const proposal = conversation.planProposal

      if (proposal && Array.isArray(proposal.tasks) && proposal.tasks.length > 0) {
        // Execute via plan proposal (multi-task chain)
        const proposalTasks = proposal.tasks.map((t) => ({
          title: t.title || 'Task',
          prompt: t.prompt || '',
          recipient_agent_id: t.recipient || '',
        }))
        await executePlanProposal(conversation.threadId, {
          tasks: proposalTasks,
          reasoning_effort: conversation.reasoningEffort,
        })
      } else {
        // Fallback to single-task execute
        await executeFromPlanThread(conversation.threadId, {
          recipient_agent_id: conversation.recipientAgentId || undefined,
          reasoning_effort: conversation.reasoningEffort,
        })
      }

      setSidebarPlans((prev) => prev.filter((plan) => plan.id !== planThreadId))
      closeConversationDrawer()
      setActiveTab('feed')
      await Promise.all([loadTasks(), loadPlans()])
    } catch (error) {
      setConversation((prev) => ({
        ...prev,
        error: errorText(error),
      }))
    }
  }

  async function handleDeletePlan() {
    if (!conversation.threadId || conversation.mode !== 'plan') {
      return
    }

    try {
      const planThreadId = conversation.threadId
      const taskId = conversation.taskId
      await deletePlanThread(planThreadId)
      setSidebarPlans((prev) => prev.filter((plan) => plan.id !== planThreadId))
      closeConversationDrawer()
      await loadPlans()
      if (taskId) {
        await loadTasks()
      }
    } catch (error) {
      setConversation((prev) => ({
        ...prev,
        error: errorText(error),
      }))
    }
  }

  async function handleNewChat() {
    const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
    if (!runtime) {
      setWorkspaceError('Orchestrator runtime is not available.')
      return
    }

    // Save current active-chat draft before switching away
    if (conversation.threadId && conversation.mode === 'chat') {
      chatDraftsRef.current[conversation.threadId] = activeChatDraft
    }

    setSelectedServiceId('')
    closeConversationDrawer()
    setActiveTab('new-chat')
  }

  async function handleOpenChat(threadId) {
    if (!threadId) {
      return
    }

    // Save current active-chat draft before switching to a different thread
    if (conversation.threadId && conversation.mode === 'chat') {
      chatDraftsRef.current[conversation.threadId] = activeChatDraft
    }

    viewingChatIdRef.current = threadId
    setSelectedServiceId('')
    setUnreadChatIds((current) => {
      if (!current.has(threadId)) return current
      const next = new Set(current)
      next.delete(threadId)
      return next
    })

    try {
      const data = await fetchConversationThread(threadId)
      if (!data?.thread) {
        setWorkspaceError('Chat thread not found.')
        await loadChats()
        return
      }

      const thread = data.thread
      const entries = buildEntriesFromThreadData(data, agentById)

      // Restore draft for this thread
      setActiveChatDraft(chatDraftsRef.current[thread.id] || '')

      setConversation({
        open: true,
        mode: 'chat',
        threadId: thread.id,
        taskId: '',
        taskStatus: '',
        harness: thread.harness,
        modelLabel: thread.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: '',
        entries,
        loading: hasRunningTurn(data.turns),
        error: '',
      })

      setActiveTab('active-chat')
    } catch (error) {
      setWorkspaceError(errorText(error))
      await loadChats()
    }
  }

  async function handleOpenPlan(threadId) {
    if (!threadId) {
      return
    }
    setSelectedServiceId('')

    try {
      const data = await fetchConversationThread(threadId)
      if (!data?.thread) {
        setWorkspaceError('Plan thread not found.')
        await loadPlans()
        return
      }

      if (data.thread.mode !== 'plan') {
        setWorkspaceError('Thread is not a plan.')
        await loadPlans()
        return
      }

      const entries = buildEntriesFromThreadData(data, agentById)
      const turns = Array.isArray(data.turns) ? data.turns : []
      let selectedRecipientAgentId = ''
      let hasCompletedPlanTurn = false

      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]
        if (!turn || turn.mode !== 'plan' || turn.status !== 'completed') {
          continue
        }
        hasCompletedPlanTurn = true
        if (typeof turn.selected_agent_id === 'string' && turn.selected_agent_id) {
          selectedRecipientAgentId = turn.selected_agent_id
          break
        }
      }

      const latestTurn = turns.filter((t) => t && t.mode === 'plan').at(-1)
      const latestTurnStillRunning = latestTurn?.status === 'running'
      const planReady = hasCompletedPlanTurn && !latestTurnStillRunning

      // Fetch plan proposal
      let proposal = null
      try {
        proposal = await fetchPlanProposal(threadId)
      } catch {
        // Non-critical
      }

      setConversation({
        open: true,
        mode: 'plan',
        threadId: data.thread.id,
        taskId: '',
        taskStatus: '',
        harness: data.thread.harness,
        modelLabel: data.thread.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: selectedRecipientAgentId,
        entries,
        loading: latestTurnStillRunning,
        error: '',
        planReady: proposal ? true : planReady,
        planProposal: proposal,
      })

      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
      await loadPlans()
    }
  }

  async function handleOpenTaskConversation(task, options = {}) {
    const taskId = typeof task?.id === 'string' ? task.id : ''
    if (!taskId) {
      setWorkspaceError('Task is missing a task id.')
      return
    }
    const requestedServiceId =
      typeof options.serviceId === 'string' ? options.serviceId : ''
    setSelectedServiceId(requestedServiceId)

    const threadId = typeof task?.thread_id === 'string' ? task.thread_id : ''
    const title = normalizeTaskTitle(task?.title)
    const status = typeof task?.status === 'string' ? task.status : ''
    if (!title || !status) {
      setWorkspaceError('Task payload is missing required fields.')
      return
    }

    if (!threadId) {
      const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
      if (!runtime) {
        setWorkspaceError('Orchestrator runtime is not available.')
        return
      }
      setConversation({
        open: true,
        mode: 'chat',
        threadId: '',
        taskId,
        taskStatus: status,
        taskTitle: title,
        harness: runtime.harness,
        modelLabel: runtime.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: '',
        entries: [
          {
            id: nextEntryId('status'),
            type: 'status',
            content: `Opened output review for ${title}.`,
          },
        ],
        loading: isTaskActivelyRunning(status),
        error: '',
      })
      setActiveTab('feed')
      return
    }

    try {
      const data = await fetchConversationThread(threadId)
      if (!data?.thread) {
        const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
        if (!runtime) {
          setWorkspaceError('Orchestrator runtime is not available.')
          return
        }
        setConversation({
          open: true,
          mode: 'chat',
          threadId: '',
          taskId,
          taskStatus: status,
          taskTitle: title,
          harness: runtime.harness,
          modelLabel: runtime.model_label,
          reasoningEffort: 'medium',
          recipientAgentId: '',
          entries: [
            {
              id: nextEntryId('status'),
              type: 'status',
              content: `Opened output review for ${title}. Conversation history is unavailable.`,
            },
          ],
          loading: isTaskActivelyRunning(status),
          error: '',
        })
        setActiveTab('feed')
        return
      }

      const thread = data.thread
      const entries = buildEntriesFromThreadData(data, agentById)

      if (thread.mode === 'plan') {
        const turns = Array.isArray(data.turns) ? data.turns : []
        let selectedRecipientAgentId = ''
        let hasCompletedPlanTurn = false

        for (let index = turns.length - 1; index >= 0; index -= 1) {
          const turn = turns[index]
          if (!turn || turn.mode !== 'plan' || turn.status !== 'completed') continue
          hasCompletedPlanTurn = true
          if (typeof turn.selected_agent_id === 'string' && turn.selected_agent_id) {
            selectedRecipientAgentId = turn.selected_agent_id
            break
          }
        }

        const latestTurn = turns.filter((t) => t && t.mode === 'plan').at(-1)
        const latestTurnStillRunning = latestTurn?.status === 'running'
        const planReady = hasCompletedPlanTurn && !latestTurnStillRunning
          && status !== 'waiting_for_question_response'
          && status !== 'waiting_for_help_response'

        let proposal = null
        try {
          proposal = await fetchPlanProposal(thread.id)
        } catch {
          // Non-critical
        }

        setConversation({
          open: true,
          mode: 'plan',
          threadId: thread.id,
          taskId,
          taskStatus: status,
          taskTitle: title,
          harness: thread.harness,
          modelLabel: thread.model_label,
          reasoningEffort: 'medium',
          recipientAgentId: selectedRecipientAgentId,
          entries,
          loading: latestTurnStillRunning,
          error: '',
          planReady: proposal ? true : planReady,
          planProposal: proposal,
        })
        setActiveTab('feed')
        return
      }

      setConversation({
        open: true,
        mode: 'chat',
        threadId: thread.id,
        taskId,
        taskStatus: status,
        taskTitle: title,
        harness: thread.harness,
        modelLabel: thread.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: '',
        entries,
        loading: isTaskActivelyRunning(status),
        error: '',
      })

      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleOpenTaskConversationById(taskId) {
    if (!taskId) {
      return
    }

    const existingTask = tasks.find((task) => task?.id === taskId)
    if (existingTask) {
      await handleOpenTaskConversation(existingTask)
      return
    }

    try {
      const refreshedTasks = await fetchTasks(300)
      setTasks(refreshedTasks)
      const refreshedTask = refreshedTasks.find((task) => task?.id === taskId) || null
      if (refreshedTask) {
        await handleOpenTaskConversation(refreshedTask)
        return
      }
    } catch {
      // Fall through to workspace error.
    }

    setWorkspaceError(`Task not found: ${taskId}.`)
  }

  const VALID_REVIEW_ACTIONS = new Set([
    'approve', 'approve_and_push', 'reopen', 'mark_completed',
    'approve_chain', 'approve_chain_and_push', 'mark_chain_completed',
  ])

  async function handleReviewTask(taskId, action) {
    if (!taskId || !VALID_REVIEW_ACTIONS.has(action)) {
      return
    }

    const reviewResult = await reviewTask(taskId, action)
    const nextStatus = reviewResult.status
    const mergeState = reviewResult.merge_state

    await loadTasks()
    const isApprove = action === 'approve' || action === 'approve_and_push' || action === 'approve_chain' || action === 'approve_chain_and_push'
    if (isApprove && (mergeState === 'merged' || mergeState === 'merged_and_pushed') && nextStatus === 'completed') {
      closeConversationDrawer()
      return
    }

    const isMarkCompleted = action === 'mark_completed' || action === 'mark_chain_completed'
    if (isMarkCompleted && nextStatus === 'completed') {
      closeConversationDrawer()
      return
    }

    setConversation((prev) => {
      if (!prev.open || prev.taskId !== taskId) {
        return prev
      }
      return {
        ...prev,
        taskStatus: nextStatus,
      }
    })
  }

  async function handleAddFollowup(parentTaskId, prompt) {
    if (!parentTaskId || !prompt) {
      return
    }
    try {
      const result = await createFollowupTask(parentTaskId, {
        prompt,
        reasoning_effort: 'high',
      })
      // Optimistically add the new followup task
      const taskId = result?.task_id
      if (taskId) {
        const title = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt
        setTasks((prev) => {
          const updated = prev.map((t) =>
            t.id === parentTaskId ? { ...t, followup_task_id: taskId } : t
          )
          return [{
            id: taskId,
            title,
            status: 'queued',
            assigned_to: null,
            output_dir: null,
            session_id: null,
            created_at: new Date().toISOString(),
            completed_at: null,
            followup_task_id: null,
            predecessor_task_id: parentTaskId,
            thread_id: null,
          }, ...updated]
        })
      }
      scheduleTasksRefresh(500)
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleSetTaskRecipient(taskId, recipientAgentId) {
    if (!taskId || !recipientAgentId) {
      return
    }

    try {
      await setTaskRecipient(taskId, recipientAgentId)
      await loadTasks()
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleDeleteTask(taskId) {
    if (!taskId) {
      return
    }

    try {
      await deleteTask(taskId)
      await loadTasks()
      setConversation((prev) => {
        if (prev.open && prev.taskId === taskId) {
          return { ...prev, open: false }
        }
        return prev
      })
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  function handleHideChat(threadId) {
    if (!threadId || !activeWorkspaceName) {
      return
    }

    setHiddenChatsByWorkspace((prev) => {
      const existing = Array.isArray(prev[activeWorkspaceName]) ? prev[activeWorkspaceName] : []
      if (existing.includes(threadId)) {
        return prev
      }
      return {
        ...prev,
        [activeWorkspaceName]: [...existing, threadId],
      }
    })

    if (activeTab === 'active-chat' && conversation.threadId === threadId) {
      setActiveTab('feed')
    }
  }

  function handleDrawerPromptSubmit(message) {
    const mode = conversation.mode === 'plan' ? 'plan' : 'chat'
    void handleInputSubmit({
      message,
      mode,
      reasoningEffort: conversation.reasoningEffort,
    })
  }

  function handleNewChatSubmit(payload) {
    setNewChatDraft('')
    setActiveChatDraft('')
    setActiveTab('active-chat')
    void handleInputSubmit({
      ...payload,
      mode: 'chat',
    })
  }

  function handleInlineChatSubmit(payload) {
    setActiveChatDraft('')
    if (conversation.threadId) {
      delete chatDraftsRef.current[conversation.threadId]
    }
    void handleInputSubmit({
      ...payload,
      mode: 'chat',
    })
  }

  function handleOpenOrchestratorConfig() {
    setWorkspaceError('')
    if (!orchestratorRuntime) {
      setWorkspaceError('Orchestrator runtime is not available.')
      return
    }

    setActiveTab('feed')
    setOpenOrchestratorConfigRequest((current) => current + 1)
  }

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={activeTab}
        onChange={setActiveTab}
        pendingCount={pendingCount}
        workspaces={workspaces}
        activeWorkspaceName={activeWorkspaceName}
        workspacesLoading={workspacesLoading}
        chats={visibleSidebarChats}
        chatsLoading={sidebarChatsLoading}
        thinkingChatIds={thinkingChatIds}
        unreadChatIds={unreadChatIds}
        activeChatId={activeTab === 'active-chat' && conversation.open && conversation.mode === 'chat' ? conversation.threadId : ''}
        services={visibleRuntimeServices}
        activeServiceId={selectedServiceId}
        onOpenChat={(threadId) => {
          void handleOpenChat(threadId)
        }}
        onOpenService={(service) => {
          void handleOpenRuntimeService(service)
        }}
        onStopService={(serviceId) => {
          void handleStopRuntimeService(serviceId)
        }}
        onHideChat={handleHideChat}
        onNewChat={handleNewChat}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateWorkspace={() => {
          setOnboardingError('')
          setIsOnboardingOpen(true)
        }}
      />

      <main className="main-column">
        {workspaceError && <div className="workspace-error">{workspaceError}</div>}

        {activeTab === 'feed' && (
          <div className="feed-page">
            {conversation.open && (conversation.mode === 'plan' || (conversation.mode === 'chat' && Boolean(conversation.taskId))) ? (
              <ConversationDrawer
                open
                mode={conversation.mode}
                entries={conversation.entries}
                loading={conversation.loading}
                planReady={conversation.planReady}
                error={conversation.error}
                taskId={conversation.taskId}
                taskStatus={conversation.taskStatus}
                taskTitle={conversation.taskTitle}
                headerAgentName={conversationHeaderAgent.name}
                headerAgentEmoji={conversationHeaderAgent.emoji}
                onReviewAction={(taskId, action) => handleReviewTask(taskId, action)}
                onDeleteTask={(taskId) => handleDeleteTask(taskId)}
                isFollowupTask={Boolean(conversation.taskId && tasks.find((t) => t.id === conversation.taskId)?.predecessor_task_id)}
                runtimeService={conversationRuntimeService}
                runtimeServiceLogs={conversationRuntimeService ? selectedRuntimeServiceLogs : []}
                runtimeServiceError={
                  conversationRuntimeService && selectedServiceId ? runtimeServiceStreamError : ''
                }
                onStopRuntimeService={handleStopRuntimeService}
                onServiceStarted={handleRuntimeServiceStarted}
                onClose={closeConversationDrawer}
                recipientAgents={recipientAgents}
                selectedRecipientAgentId={conversation.recipientAgentId}
                onSelectRecipientAgentId={(recipientAgentId) => {
                  setConversation((prev) => ({
                    ...prev,
                    recipientAgentId,
                  }))
                }}
                onPromptSubmit={handleDrawerPromptSubmit}
                onExecute={() => {
                  void handleExecuteFromPlan()
                }}
                onDeletePlan={() => {
                  void handleDeletePlan()
                }}
                executeDisabled={!conversation.threadId || !conversation.planReady}
                onStop={handleStopStream}
                planProposal={conversation.planProposal}
                onUpdatePlanProposal={(updated) => {
                  setConversation((prev) => ({
                    ...prev,
                    planProposal: updated,
                  }))
                }}
              />
            ) : (
              <>
                {!tasksLoading && !tasksError && taskFailureNotice && (
                  <div className="workspace-error">
                    <span>
                      Task failed: {taskFailureNotice.taskTitle}
                    </span>
                    <button
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        void handleOpenTaskConversationById(taskFailureNotice.taskId)
                      }}
                    >
                      Open task
                    </button>
                    <button
                      style={{ marginLeft: 8 }}
                      onClick={() => setTaskFailureNotice(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
                <div className="main-topbar">
                  <h1>Tasks</h1>
                </div>
                <FeedView
                  tasks={tasks}
                  loading={tasksLoading}
                  error={tasksError}
                  recipientAgents={recipientAgents}
                  agentById={agentById}
                  plans={sidebarPlans}
                  onOpenPlan={(threadId) => {
                    void handleOpenPlan(threadId)
                  }}
                  onOpenTaskConversation={(task) => {
                    void handleOpenTaskConversation(task)
                  }}
                  onPickTaskRecipient={(taskId, recipientAgentId) => {
                    void handleSetTaskRecipient(taskId, recipientAgentId)
                  }}
                  onAddFollowup={(parentTaskId, prompt) => {
                    void handleAddFollowup(parentTaskId, prompt)
                  }}
                  followupForTaskId={followupForTaskId}
                  setFollowupForTaskId={setFollowupForTaskId}
                />
                <InputBar
                  disabled={
                    conversation.loading ||
                    workspacesLoading ||
                    agentsLoading ||
                    !activeWorkspaceName
                  }
                  loading={false}
                  onStop={handleStopStream}
                  agents={recipientAgents}
                  preferredMode={conversation.open ? conversation.mode : ''}
                  onSubmit={(payload) => {
                    void handleInputSubmit(payload)
                  }}
                  value={inputBarText}
                  onValueChange={setInputBarText}
                  followupTask={followupForTaskId ? tasks.find((t) => t.id === followupForTaskId) : null}
                  onCancelFollowup={() => setFollowupForTaskId('')}
                />
              </>
            )}
          </div>
        )}

        {activeTab === 'new-chat' && (
          <div className="feed-page">
            <div className="main-topbar">
              <h1>New chat</h1>
            </div>
            <div style={{ flex: 1 }} />
            <InputBar
              disabled={
                conversation.loading ||
                workspacesLoading ||
                agentsLoading ||
                !activeWorkspaceName
              }
              loading={conversation.loading}
              onStop={handleStopStream}
              onOpenOrchestratorConfig={handleOpenOrchestratorConfig}
              hideMode
              lockedMode="chat"
              value={newChatDraft}
              onValueChange={setNewChatDraft}
              onSubmit={(payload) => {
                void handleNewChatSubmit(payload)
              }}
            />
          </div>
        )}

        {activeTab === 'active-chat' && (
          <div className="feed-page">
            <div className="main-topbar">
              <h1>{conversation.entries.find((e) => e.type === 'user')?.content?.slice(0, 60) || 'Chat'}</h1>
            </div>
            <InlineChatView
              entries={conversation.entries}
              loading={conversation.loading}
              error={conversation.error}
              onSubmit={handleInlineChatSubmit}
              onStop={handleStopStream}
              onOpenOrchestratorConfig={handleOpenOrchestratorConfig}
              value={activeChatDraft}
              onValueChange={setActiveChatDraft}
              disabled={
                workspacesLoading ||
                agentsLoading ||
                !activeWorkspaceName
              }
            />
          </div>
        )}

        {activeTab === 'code' && (
          <CodeView
            folders={codeFolders}
            loading={codeLoading}
            error={codeError}
            onCloneRepo={handleCloneCodeRepo}
            onCopyLocalFolder={handleCopyCodeFolderFromLocal}
            onPickLocalFolder={handlePickLocalCodeFolder}
            onPushFolder={handlePushCodeFolder}
          />
        )}
        {activeTab === 'files' && <FilesView />}

        {activeTab === 'context' && (
          <ContextView
            folders={contextData.folders}
            files={contextData.files}
            loading={contextLoading}
            error={contextError}
            onSave={handleSaveContextFile}
            onCreateFile={handleCreateContextFile}
            onCreateFolder={handleCreateContextFolder}
          />
        )}

        {activeTab === 'skills' && <ConnectionsView />}
        {activeTab === 'settings' && (
          <SettingsView
            workspaceName={activeWorkspaceName}
            deleting={deleteWorkspaceLoading}
            error={deleteWorkspaceError}
            onDelete={() => {
              void handleDeleteActiveWorkspace()
            }}
          />
        )}
      </main>

      {activeTab === 'feed' && !(conversation.open && (conversation.mode === 'plan' || (conversation.mode === 'chat' && Boolean(conversation.taskId)))) && (
        <RightPanel
          agents={agents}
          loading={agentsLoading}
          error={agentsError}
          onCreateAgent={handleCreateAgent}
          onUpdateAgent={handleUpdateAgent}
          onDeleteAgent={handleDeleteAgent}
          humans={humans}
          onUpdateHumanEmoji={handleUpdateHumanEmoji}
          openOrchestratorConfigRequest={openOrchestratorConfigRequest}
        />
      )}

      <OnboardingModal
        open={isOnboardingOpen}
        canClose={hasAnyWorkspace}
        onClose={() => setIsOnboardingOpen(false)}
        onSubmit={handleCreateWorkspace}
        loading={onboardingLoading}
        error={onboardingError}
      />
    </div>
  )
}
