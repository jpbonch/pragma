import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  copyCodeFolderFromLocal,
  createAgent,
  cloneCodeRepo,
  createContextFile,
  createContextFolder,
  createExecuteJob,
  createWorkspace,
  deleteWorkspace,
  executeFromPlanThread,
  fetchAgents,
  fetchChats,
  fetchCodeFolders,
  fetchPlans,
  fetchContextFiles,
  fetchConversationThread,
  fetchJobs,
  pickLocalCodeFolder,
  openConversationThreadStream,
  openJobsStream,
  fetchWorkspaces,
  respondToJob,
  reviewJob,
  setJobRecipient,
  setActiveWorkspace,
  streamConversationTurn,
  updateAgent,
  updateContextFile,
} from './api'
import { CodeView } from './components/CodeView'
import { ContextView } from './components/ContextView'
import { ConversationDrawer } from './components/ConversationDrawer'
import { EmptyPane } from './components/EmptyPane'
import { FeedView } from './components/FeedView'
import { InputBar } from './components/InputBar'
import { RightPanel } from './components/RightPanel'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { iconForAgent } from './lib/agentIcon'

const ORCHESTRATOR_AGENT_ID = 'salmon-orchestrator'

function getPendingCount(jobs) {
  return jobs.filter((job) => {
    const status = String(job.status).toLowerCase()
    return (
      status === 'pending_review' ||
      status === 'waiting_for_recipient' ||
      status === 'waiting_for_question_response' ||
      status === 'waiting_for_help_response'
    )
  }).length
}

function isWaitingForHumanResponse(status) {
  return status === 'waiting_for_question_response' || status === 'waiting_for_help_response'
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function nextEntryId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
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
      return { label: type, summary: payload.file_path }
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
    return input.file_path.trim()
  }
  if (Array.isArray(input.paths) && input.paths.length > 0) {
    return input.paths.join(', ')
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

function normalizeJobTitle(value) {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) {
    return ''
  }
  return title.replace(/^execute:\s*/i, '')
}

function resolveConversationHeaderAgent({ conversation, jobs, agentById }) {
  const currentConversation = conversation && typeof conversation === 'object' ? conversation : null
  const allJobs = Array.isArray(jobs) ? jobs : []
  const entries = Array.isArray(currentConversation?.entries) ? currentConversation.entries : []

  let resolvedAgentId = ''
  if (typeof currentConversation?.jobId === 'string' && currentConversation.jobId) {
    const currentJob = allJobs.find((job) => job?.id === currentConversation.jobId)
    if (currentJob && typeof currentJob.assigned_to === 'string' && currentJob.assigned_to.trim()) {
      resolvedAgentId = currentJob.assigned_to.trim()
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
  return timeline.map((item) => item.entry)
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
  if (name === 'job_reopened') {
    return 'Task marked as not completed. Re-running.'
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

const HIDDEN_CHATS_STORAGE_KEY = 'salmon.hidden_sidebar_chats.v1'

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

function OnboardingModal({ open, canClose, onClose, onSubmit, loading, error }) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setGoal('')
    }
  }, [open])

  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>Create workspace</h2>
        <p>Pick a workspace name and define the initial goal.</p>

        <label className="modal-label">Workspace Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Product Launch"
        />

        <label className="modal-label">Goal</label>
        <textarea
          className="modal-textarea"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          placeholder="Describe what this workspace should achieve"
        />

        {error && <div className="error">Error: {error}</div>}

        <div className="modal-actions">
          {canClose && (
            <button className="modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
          )}
          <button
            className="modal-create"
            onClick={() => onSubmit({ name, goal })}
            disabled={loading}
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

  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobsError, setJobsError] = useState('')

  const [agents, setAgents] = useState([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [agentsError, setAgentsError] = useState('')

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
  const [hiddenChatsByWorkspace, setHiddenChatsByWorkspace] = useState(() =>
    loadHiddenChatsByWorkspace(),
  )

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
    jobId: '',
    jobStatus: '',
    harness: '',
    modelLabel: '',
    reasoningEffort: 'medium',
    recipientAgentId: '',
    entries: [],
    loading: false,
    error: '',
  })

  const streamAbortRef = useRef(null)
  const jobsRefreshTimerRef = useRef(null)
  const conversationSyncInFlightRef = useRef(false)
  const conversationSyncPendingRef = useRef(false)
  const conversationSyncRetryTimerRef = useRef(null)
  const jobsRefreshInFlightRef = useRef(false)
  const jobsRefreshQueuedRef = useRef(false)
  const pendingCount = useMemo(() => getPendingCount(jobs), [jobs])
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
      jobs,
      agentById,
    })
  }, [conversation, jobs, agentById])
  const visibleSidebarChats = useMemo(() => {
    const hiddenIds = new Set(hiddenChatsByWorkspace[activeWorkspaceName] || [])
    if (hiddenIds.size === 0) {
      return sidebarChats
    }
    return sidebarChats.filter((chat) => !hiddenIds.has(chat.id))
  }, [sidebarChats, hiddenChatsByWorkspace, activeWorkspaceName])

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
      if (jobsRefreshTimerRef.current) {
        clearTimeout(jobsRefreshTimerRef.current)
        jobsRefreshTimerRef.current = null
      }
      if (conversationSyncRetryTimerRef.current) {
        clearTimeout(conversationSyncRetryTimerRef.current)
        conversationSyncRetryTimerRef.current = null
      }
      conversationSyncPendingRef.current = false
      jobsRefreshQueuedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (
      !conversation.open ||
      conversation.mode !== 'chat' ||
      !conversation.jobId ||
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

        const data = await fetchConversationThread(conversation.threadId)
        if (!data?.thread || cancelled) {
          return
        }

        const nextEntries = buildEntriesFromThreadData(data, agentById)
        setConversation((prev) => {
          if (!prev.open || prev.threadId !== conversation.threadId || cancelled) {
            return prev
          }
          return {
            ...prev,
            harness: data.thread.harness,
            modelLabel: data.thread.model_label,
            entries: nextEntries,
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
  }, [conversation.open, conversation.mode, conversation.jobId, conversation.threadId, agentById])

  async function flushJobsRefresh() {
    if (jobsRefreshInFlightRef.current) {
      jobsRefreshQueuedRef.current = true
      return
    }

    jobsRefreshInFlightRef.current = true
    try {
      do {
        jobsRefreshQueuedRef.current = false
        await loadJobs()
      } while (jobsRefreshQueuedRef.current)
    } finally {
      jobsRefreshInFlightRef.current = false
    }
  }

  function scheduleJobsRefresh(delayMs = 250) {
    if (jobsRefreshTimerRef.current) {
      clearTimeout(jobsRefreshTimerRef.current)
    }
    jobsRefreshTimerRef.current = setTimeout(() => {
      jobsRefreshTimerRef.current = null
      void flushJobsRefresh()
    }, delayMs)
  }

  useEffect(() => {
    if (!activeWorkspaceName) {
      return
    }

    const closeStream = openJobsStream({
      onReady: () => {
        scheduleJobsRefresh(0)
      },
      onJobStatusChanged: (event) => {
        const jobId = typeof event?.job_id === 'string' ? event.job_id : ''
        const status = typeof event?.status === 'string' ? event.status : ''

        if (jobId && status) {
          setJobs((prev) =>
            prev.map((job) => (job.id === jobId ? { ...job, status } : job)),
          )
          setConversation((prev) => {
            if (prev.jobId !== jobId || prev.jobStatus === status) {
              return prev
            }
            return {
              ...prev,
              jobStatus: status,
            }
          })
        }

        scheduleJobsRefresh(250)
      },
    })

    return () => {
      if (jobsRefreshTimerRef.current) {
        clearTimeout(jobsRefreshTimerRef.current)
        jobsRefreshTimerRef.current = null
      }
      jobsRefreshQueuedRef.current = false
      closeStream()
    }
  }, [activeWorkspaceName])

  useEffect(() => {
    if (!conversation.jobId) {
      return
    }

    const match = jobs.find((job) => job.id === conversation.jobId)
    const nextStatus = typeof match?.status === 'string' ? match.status : ''
    const nextThreadId = typeof match?.thread_id === 'string' ? match.thread_id : ''
    if (
      (!nextStatus || nextStatus === conversation.jobStatus) &&
      (!nextThreadId || conversation.threadId)
    ) {
      return
    }

    setConversation((prev) => {
      if (prev.jobId !== conversation.jobId) {
        return prev
      }

      const updates = {}
      if (nextStatus && prev.jobStatus !== nextStatus) {
        updates.jobStatus = nextStatus
      }
      if (!prev.threadId && nextThreadId) {
        updates.threadId = nextThreadId
      }
      if (Object.keys(updates).length === 0) {
        return prev
      }

      return {
        ...prev,
        ...updates,
      }
    })
  }, [jobs, conversation.jobId, conversation.jobStatus, conversation.threadId])

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
    setJobs([])
    setAgents([])
    setContextData({ folders: [], files: [] })
    setCodeFolders([])
    setCodeLoading(false)
    setSidebarPlans([])
    setSidebarPlansLoading(false)
    setSidebarChats([])
    setSidebarChatsLoading(false)
    setJobsError('')
    setAgentsError('')
    setContextError('')
    setCodeError('')
    closeConversationDrawer()
  }

  async function loadWorkspaceData() {
    await Promise.all([loadJobs(), loadAgents(), loadContext(), loadCode(), loadPlans(), loadChats()])
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
      // Keep existing list if fetch fails and surface in workspace error area.
      setWorkspaceError((prev) => prev || errorText(error))
    } finally {
      setSidebarPlansLoading(false)
    }
  }

  async function loadJobs() {
    setJobsLoading(true)
    setJobsError('')
    try {
      setJobs(await fetchJobs(300))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setJobs([])
        setJobsError('No active workspace.')
        return
      }
      setJobsError(errorText(error))
    } finally {
      setJobsLoading(false)
    }
  }

  async function loadChats() {
    setSidebarChatsLoading(true)
    try {
      setSidebarChats(await fetchChats(20))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setSidebarChats([])
        return
      }
      // Keep existing list if fetch fails and surface in workspace error area.
      setWorkspaceError((prev) => prev || errorText(error))
    } finally {
      setSidebarChatsLoading(false)
    }
  }

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

  async function handleCreateAgent(agent) {
    await createAgent(agent)
    await loadAgents()
  }

  async function handleUpdateAgent(id, updates) {
    await updateAgent(id, updates)
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

  async function handleCreateWorkspace({ name, goal }) {
    setOnboardingError('')

    if (!name || !name.trim() || !goal || !goal.trim()) {
      setOnboardingError('Workspace name and goal are required.')
      return
    }

    setOnboardingLoading(true)
    try {
      await createWorkspace({ name, goal })
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

  function closeConversationDrawer() {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setConversation({
      open: false,
      mode: 'chat',
      threadId: '',
      jobId: '',
      jobStatus: '',
      harness: '',
      modelLabel: '',
      reasoningEffort: 'medium',
      recipientAgentId: '',
      entries: [],
      loading: false,
      error: '',
    })
  }

  async function handleInputSubmit({ message, mode, reasoningEffort }) {
    setWorkspaceError('')

    if (mode === 'execute') {
      try {
        await createExecuteJob({
          prompt: message,
          reasoning_effort: reasoningEffort,
        })
        await loadJobs()
        setActiveTab('feed')
      } catch (error) {
        setWorkspaceError(errorText(error))
      }
      return
    }

    const conversationStatus = String(conversation.jobStatus || '').toLowerCase()
    if (
      mode === 'chat' &&
      conversation.open &&
      conversation.jobId &&
      isWaitingForHumanResponse(conversationStatus)
    ) {
      try {
        await respondToJob(conversation.jobId, message)
        setConversation((prev) => ({
          ...prev,
          jobStatus: 'queued',
          entries: [
            ...prev.entries,
            { id: nextEntryId('user'), type: 'user', content: message },
            {
              id: nextEntryId('status'),
              type: 'status',
              content: 'Response sent. Job re-queued with the same worker.',
            },
          ],
        }))
        await loadJobs()
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

    if (!forceContinueOpenChat && !orchestratorRuntime) {
      const refreshedRuntime = await resolveOrchestratorRuntime()
      if (!refreshedRuntime) {
        setWorkspaceError('Orchestrator runtime is not available.')
        return
      }
    }

    const runtime = forceContinueOpenChat
      ? null
      : orchestratorRuntime ?? (await resolveOrchestratorRuntime())
    if (!forceContinueOpenChat && !runtime) {
      setWorkspaceError('Orchestrator runtime is not available.')
      return
    }

    const effectiveHarness = forceContinueOpenChat
      ? conversation.harness
      : runtime.harness
    const effectiveModelLabel = forceContinueOpenChat
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
    nextEntries.push({ id: nextEntryId('user'), type: 'user', content: message })
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
      jobId: '',
      jobStatus: '',
      harness: effectiveHarness,
      modelLabel: effectiveModelLabel,
      reasoningEffort,
      recipientAgentId:
        mode === 'plan' && reuseExisting ? conversation.recipientAgentId : '',
      entries: nextEntries,
      loading: true,
      error: '',
    })

    const controller = new AbortController()
    streamAbortRef.current?.abort()
    streamAbortRef.current = controller

    try {
      await streamConversationTurn(
        {
          thread_id: nextThreadId,
          message,
          mode,
          harness: effectiveHarness,
          model_label: effectiveModelLabel,
          reasoning_effort: reasoningEffort,
        },
        {
          signal: controller.signal,
          onEvent: ({ event, data }) => {
            setConversation((prev) => {
              if (!prev.open) {
                return prev
              }

              if (event === 'thread_started') {
                if (mode === 'plan') {
                  void loadPlans()
                }
                return {
                  ...prev,
                  threadId: data.thread_id,
                }
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
                  entries: [
                    ...prev.entries,
                    {
                      id: nextEntryId('tool'),
                      type: 'tool',
                      label: toolSummary.label,
                      summary: toolSummary.summary,
                    },
                  ],
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
      setConversation((prev) => ({
        ...prev,
        loading: false,
      }))
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
      await executeFromPlanThread(conversation.threadId, {
        recipient_agent_id: conversation.recipientAgentId || undefined,
        reasoning_effort: conversation.reasoningEffort,
      })
      setSidebarPlans((prev) => prev.filter((plan) => plan.id !== planThreadId))
      closeConversationDrawer()
      setActiveTab('feed')
      await Promise.all([loadJobs(), loadPlans()])
    } catch (error) {
      setConversation((prev) => ({
        ...prev,
        error: errorText(error),
      }))
    }
  }

  async function handleOpenChat(threadId) {
    if (!threadId) {
      return
    }

    try {
      const data = await fetchConversationThread(threadId)
      if (!data?.thread) {
        setWorkspaceError('Chat thread not found.')
        await loadChats()
        return
      }

      const thread = data.thread
      const entries = buildEntriesFromThreadData(data, agentById)

      setConversation({
        open: true,
        mode: 'chat',
        threadId: thread.id,
        jobId: '',
        jobStatus: '',
        harness: thread.harness,
        modelLabel: thread.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: '',
        entries,
        loading: false,
        error: '',
      })

      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
      await loadChats()
    }
  }

  async function handleOpenPlan(threadId) {
    if (!threadId) {
      return
    }

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

      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]
        if (!turn || turn.mode !== 'plan' || turn.status !== 'completed') {
          continue
        }
        if (typeof turn.selected_agent_id === 'string' && turn.selected_agent_id) {
          selectedRecipientAgentId = turn.selected_agent_id
          break
        }
      }

      setConversation({
        open: true,
        mode: 'plan',
        threadId: data.thread.id,
        jobId: '',
        jobStatus: '',
        harness: data.thread.harness,
        modelLabel: data.thread.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: selectedRecipientAgentId,
        entries,
        loading: false,
        error: '',
      })

      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
      await loadPlans()
    }
  }

  async function handleOpenJobConversation(job) {
    const jobId = typeof job?.id === 'string' ? job.id : ''
    if (!jobId) {
      setWorkspaceError('Task is missing a job id.')
      return
    }

    const threadId = typeof job?.thread_id === 'string' ? job.thread_id : ''
    const title = normalizeJobTitle(job?.title)
    const status = typeof job?.status === 'string' ? job.status : ''
    if (!title || !status) {
      setWorkspaceError('Job payload is missing required fields.')
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
        jobId,
        jobStatus: status,
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
        loading: false,
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
          jobId,
          jobStatus: status,
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
          loading: false,
          error: '',
        })
        setActiveTab('feed')
        return
      }

      const thread = data.thread
      const entries = buildEntriesFromThreadData(data, agentById)

      setConversation({
        open: true,
        mode: 'chat',
        threadId: thread.id,
        jobId,
        jobStatus: status,
        harness: thread.harness,
        modelLabel: thread.model_label,
        reasoningEffort: 'medium',
        recipientAgentId: '',
        entries,
        loading: false,
        error: '',
      })

      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleReviewJob(jobId, action) {
    if (!jobId || (action !== 'approve' && action !== 'reopen')) {
      return
    }

    const reviewResult = await reviewJob(jobId, action)
    const nextStatus = reviewResult.status
    const mergeState = reviewResult.merge_state

    await loadJobs()
    if (action === 'approve' && mergeState === 'merged' && nextStatus === 'completed') {
      closeConversationDrawer()
      return
    }

    setConversation((prev) => {
      if (!prev.open || prev.jobId !== jobId) {
        return prev
      }
      return {
        ...prev,
        jobStatus: nextStatus,
      }
    })
  }

  async function handleSetJobRecipient(jobId, recipientAgentId) {
    if (!jobId || !recipientAgentId) {
      return
    }

    try {
      await setJobRecipient(jobId, recipientAgentId)
      await loadJobs()
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
  }

  function handleDrawerPromptSubmit(message) {
    const mode = conversation.mode === 'plan' ? 'plan' : 'chat'
    void handleInputSubmit({
      message,
      mode,
      reasoningEffort: conversation.reasoningEffort,
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
        plans={sidebarPlans}
        plansLoading={sidebarPlansLoading}
        chats={visibleSidebarChats}
        chatsLoading={sidebarChatsLoading}
        activePlanThreadId={activePlanThreadId}
        onOpenPlan={(threadId) => {
          void handleOpenPlan(threadId)
        }}
        onOpenChat={(threadId) => {
          void handleOpenChat(threadId)
        }}
        onHideChat={handleHideChat}
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
            <div className="main-topbar">
              <h1>Feed</h1>
            </div>
            <FeedView
              jobs={jobs}
              loading={jobsLoading}
              error={jobsError}
              recipientAgents={recipientAgents}
              onOpenJobConversation={(job) => {
                void handleOpenJobConversation(job)
              }}
              onPickJobRecipient={(jobId, recipientAgentId) => {
                void handleSetJobRecipient(jobId, recipientAgentId)
              }}
            />
            <ConversationDrawer
              open={conversation.open && (conversation.mode === 'chat' || conversation.mode === 'plan')}
              mode={conversation.mode}
              entries={conversation.entries}
              loading={conversation.loading}
              error={conversation.error}
              jobId={conversation.jobId}
              jobStatus={conversation.jobStatus}
              headerAgentName={conversationHeaderAgent.name}
              headerAgentEmoji={conversationHeaderAgent.emoji}
              onReviewAction={(jobId, action) => handleReviewJob(jobId, action)}
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
              executeDisabled={!conversation.threadId}
            />
            {!(conversation.open && (conversation.mode === 'chat' || conversation.mode === 'plan')) && (
              <InputBar
                disabled={
                  conversation.loading ||
                  workspacesLoading ||
                  agentsLoading ||
                  !activeWorkspaceName
                }
                onOpenOrchestratorConfig={handleOpenOrchestratorConfig}
                preferredMode={conversation.open ? conversation.mode : ''}
                onSubmit={(payload) => {
                  void handleInputSubmit(payload)
                }}
              />
            )}
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
          />
        )}
        {activeTab === 'files' && <EmptyPane title="Files" />}

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

        {activeTab === 'connections' && <EmptyPane title="Connections" />}
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

      {activeTab === 'feed' && (
        <RightPanel
          agents={agents}
          loading={agentsLoading}
          error={agentsError}
          onCreateAgent={handleCreateAgent}
          onUpdateAgent={handleUpdateAgent}
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
