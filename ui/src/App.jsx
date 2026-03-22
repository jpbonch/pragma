import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createAgent,
  createConversationTurn,
  createExecuteTask,
  createFollowupTask,
  cloneCodeRepo,
  copyCodeFolderFromLocal,
  createContextFile,
  createContextFolder,
  deleteAgent,
  deleteTask,
  deletePlanThread,
  executeFromPlanThread,
  executePlanProposal,
  fetchConversationThread,
  fetchPlanProposal,
  fetchTasks,
  fetchWorkspaces,
  createWorkspace,
  deleteWorkspace,
  openTasksStream,
  pickLocalCodeFolder,
  pushCodeFolder,
  respondToTask,
  reviewTask,
  setActiveWorkspace,
  stopTask,
  stopRuntimeService as stopRuntimeServiceApi,
  streamConversationTurn,
  setTaskRecipient,
  updateAgent,
  updateContextFile,
  updateHuman,
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
import { OnboardingModal } from './components/OnboardingModal'
import { RightPanel } from './components/RightPanel'
import { SettingsView } from './components/SettingsView'
import { AutomationsView } from './components/AutomationsView'
import { Sidebar } from './components/Sidebar'
import { iconForAgent } from './lib/agentIcon'
import {
  ORCHESTRATOR_AGENT_ID,
  appendAssistantDelta,
  appendToolEntryStreaming,
  buildEntriesFromThreadData,
  errorText,
  hasRunningTurn,
  isTaskActivelyRunning,
  isWaitingForHumanResponse,
  nextEntryId,
  normalizeTaskTitle,
  summarizeToolEvent,
} from './lib/conversationUtils'
import { useWorkspace } from './hooks/useWorkspace'
import { useTasks } from './hooks/useTasks'
import { useConversation, INITIAL_CONVERSATION } from './hooks/useConversation'
import { useAgents } from './hooks/useAgents'

export default function App() {
  const [activeTab, setActiveTab] = useState('feed')
  const [inputBarText, setInputBarText] = useState('')

  // Draft messages preserved across tab switches
  const chatDraftsRef = useRef({})
  const [newChatDraft, setNewChatDraft] = useState('')
  const [activeChatDraft, setActiveChatDraft] = useState('')

  // --- Workspace hook ---
  const workspace = useWorkspace()
  const {
    workspaces, activeWorkspaceName, workspacesLoading, workspaceError,
    setWorkspacesLoading, setWorkspaceError, setWorkspaces, setActiveWorkspaceName,
    hasAnyWorkspace,
    isOnboardingOpen, setIsOnboardingOpen, onboardingError, setOnboardingError,
    onboardingLoading, setOnboardingLoading,
    deleteWorkspaceLoading, deleteWorkspaceError, setDeleteWorkspaceLoading, setDeleteWorkspaceError,
    openOrchestratorConfigRequest, setOpenOrchestratorConfigRequest,
    contextData, contextLoading, contextError,
    codeFolders, codeLoading, codeError,
    runtimeServices, selectedServiceId, setSelectedServiceId,
    runtimeServiceLogsById, runtimeServiceStreamError,
    refreshWorkspaces, loadContext, loadCode, loadRuntimeServices,
    upsertRuntimeService, clearWorkspaceData,
  } = workspace

  // --- Agents hook ---
  const agentsHook = useAgents()
  const {
    agents, agentsLoading, agentsError,
    humans,
    orchestratorRuntime, recipientAgents, agentById,
    loadAgents, loadHumans, resolveOrchestratorRuntime,
    clearAgentsData,
  } = agentsHook

  // --- Tasks hook ---
  const tasksHook = useTasks({ activeWorkspaceName, setWorkspaceError })
  const {
    tasks, setTasks,
    tasksLoading, tasksError,
    taskFailureNotice, setTaskFailureNotice,
    followupForTaskId, setFollowupForTaskId,
    pendingCount,
    sidebarPlans, setSidebarPlans, sidebarPlansLoading,
    sidebarChats, sidebarChatsLoading,
    hiddenChatsByWorkspace, setHiddenChatsByWorkspace,
    unreadChatIds, setUnreadChatIds,
    tasksRef, chatsPollTimerRef,
    loadTasks, loadPlans, loadChats,
    scheduleTasksRefresh, clearTasksData,
  } = tasksHook

  // --- Conversation hook ---
  const conversationHook = useConversation({ agentById, tasks })
  const {
    conversation, setConversation,
    conversationHeaderAgent,
    streamAbortRef,
    viewingChatIdRef,
    prevThinkingChatIdsRef,
    closeConversationDrawer,
  } = conversationHook

  // --- Derived state ---
  const selectedRuntimeService = useMemo(() => {
    if (!selectedServiceId) return null
    return runtimeServices.find((service) => service.id === selectedServiceId) || null
  }, [runtimeServices, selectedServiceId])

  const selectedRuntimeServiceLogs = useMemo(() => {
    if (!selectedServiceId) return []
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
      if (service?.status === 'running') return true
      return service?.id === selectedServiceId
    })
  }, [runtimeServices, selectedServiceId])

  const visibleSidebarChats = useMemo(() => {
    const hiddenIds = new Set(hiddenChatsByWorkspace[activeWorkspaceName] || [])
    if (hiddenIds.size === 0) return sidebarChats
    return sidebarChats.filter((chat) => !hiddenIds.has(chat.id))
  }, [sidebarChats, hiddenChatsByWorkspace, activeWorkspaceName])

  const thinkingChatIds = useMemo(() => {
    const ids = new Set()
    if (conversation.mode === 'chat' && conversation.loading && conversation.threadId) {
      ids.add(conversation.threadId)
    }
    for (const chat of sidebarChats) {
      if (chat.latest_turn_status === 'running') ids.add(chat.id)
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
        for (const id of newlyDone) next.add(id)
        return next
      })
    }
    prevThinkingChatIdsRef.current = new Set(thinkingChatIds)
  }, [thinkingChatIds, conversation.open, conversation.mode, conversation.threadId])

  // Poll sidebar chats while any chat has a running turn
  useEffect(() => {
    if (chatsPollTimerRef.current) {
      clearInterval(chatsPollTimerRef.current)
      chatsPollTimerRef.current = null
    }
    if (thinkingChatIds.size === 0 || !activeWorkspaceName) return
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

  // --- Bootstrap ---
  useEffect(() => { void bootstrap() }, [])

  useEffect(() => {
    if (activeTab !== 'feed' && openOrchestratorConfigRequest !== 0) {
      setOpenOrchestratorConfigRequest(0)
    }
  }, [activeTab, openOrchestratorConfigRequest])

  // Tasks stream effect
  useEffect(() => {
    if (!activeWorkspaceName) return

    const closeStream = openTasksStream({
      onReady: () => { scheduleTasksRefresh(0) },
      onTaskStatusChanged: (event) => {
        const taskId = typeof event?.task_id === 'string' ? event.task_id : ''
        const status = typeof event?.status === 'string' ? event.status : ''
        const threadId = typeof event?.thread_id === 'string' ? event.thread_id : ''
        const title = typeof event?.title === 'string' ? event.title : ''

        if (taskId && status) {
          setTasks((prev) =>
            prev.map((task) => {
              if (task.id !== taskId) return task
              const updates = { ...task, status }
              if (threadId && !task.thread_id) updates.thread_id = threadId
              if (title) updates.title = title
              return updates
            }),
          )
          setConversation((prev) => {
            if (prev.taskId !== taskId || prev.taskStatus === status) return prev
            const nextLoading = isTaskActivelyRunning(status)
            const updates = { ...prev, taskStatus: status, loading: nextLoading }
            if (!prev.threadId && threadId) updates.threadId = threadId
            return updates
          })
        }

        if (taskId && status === 'failed') {
          const latestTasks = Array.isArray(tasksRef.current) ? tasksRef.current : []
          const task = latestTasks.find((item) => item?.id === taskId) || null
          const rawTitle = typeof task?.title === 'string' ? task.title : ''
          const normalizedTitle = rawTitle ? normalizeTaskTitle(rawTitle) : ''
          setTaskFailureNotice({ taskId, taskTitle: normalizedTitle || taskId })
        }

        scheduleTasksRefresh(250)

        if (status === 'planned' || status === 'planning' || status === 'waiting_for_question_response') {
          void loadPlans()
        }
      },
    })

    return () => {
      closeStream()
    }
  }, [activeWorkspaceName])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
    }
  }, [])

  // --- Data loading ---
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
        clearAllData()
        return
      }
      if (!active) {
        setWorkspaceError('No active workspace selected.')
        clearAllData()
        return
      }
      await loadWorkspaceData()
    } catch (error) {
      setWorkspaceError(errorText(error))
      clearAllData()
    } finally {
      setWorkspacesLoading(false)
    }
  }

  function clearAllData() {
    clearTasksData()
    clearAgentsData()
    clearWorkspaceData()
    closeConversationDrawer()
  }

  async function loadWorkspaceData() {
    await Promise.all([
      loadTasks(), loadAgents(), loadHumans(),
      loadContext(), loadCode(), loadPlans(), loadChats(),
      loadRuntimeServices(),
    ])
  }

  // --- Workspace handlers ---
  async function handleSelectWorkspace(name) {
    if (!name || name === activeWorkspaceName) return
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
    if (!name || !name.trim()) { setOnboardingError('Workspace name is required.'); return }
    if (!orchestrator_harness) { setOnboardingError('Select an orchestrator CLI.'); return }

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
    if (!activeWorkspaceName) return
    const confirmed = window.confirm(
      `Delete workspace "${activeWorkspaceName}" and all its files? This cannot be undone.`,
    )
    if (!confirmed) return

    setDeleteWorkspaceLoading(true)
    setDeleteWorkspaceError('')
    setWorkspaceError('')

    try {
      await deleteWorkspace(activeWorkspaceName)
      const { next, active } = await refreshWorkspaces()

      if (next.length === 0) {
        clearAllData()
        setActiveWorkspaceName('')
        setIsOnboardingOpen(true)
        setActiveTab('feed')
        return
      }
      if (!active) {
        clearAllData()
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

  // --- Context/Code handlers ---
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
    if (!result || typeof result !== 'object') throw new Error('Invalid folder picker response.')
    if (result.cancelled === true) return ''
    return typeof result.path === 'string' ? result.path : ''
  }

  async function handlePushCodeFolder(folderName) {
    await pushCodeFolder(folderName)
    await loadCode()
  }

  // --- Agent handlers ---
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

  async function handleUpdateHumanEmoji(id, emoji) {
    try {
      await updateHuman(id, emoji)
      await loadHumans()
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  // --- Runtime service handlers ---
  function handleRuntimeServiceStarted(service) {
    upsertRuntimeService(service)
    if (service?.id) setSelectedServiceId(service.id)
  }

  async function handleStopRuntimeService(serviceId) {
    if (!serviceId) return
    try {
      const result = await stopRuntimeServiceApi(serviceId)
      if (result?.service) upsertRuntimeService(result.service)
      else await loadRuntimeServices()
      if (selectedServiceId === serviceId) setSelectedServiceId('')
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleOpenRuntimeService(service) {
    if (!service || typeof service !== 'object') return
    const serviceId = typeof service.id === 'string' ? service.id : ''
    const taskId = typeof service.task_id === 'string' ? service.task_id : ''
    if (!serviceId) return

    setSelectedServiceId(serviceId)

    if (!taskId) return

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
    } catch { refreshedTask = null }
    if (refreshedTask) {
      await handleOpenTaskConversation(refreshedTask, { serviceId })
      return
    }
    setWorkspaceError(`Task not found for service task ${taskId}.`)
  }

  // --- Task handlers ---
  const VALID_REVIEW_ACTIONS = new Set([
    'approve', 'approve_and_push', 'reopen', 'mark_completed',
    'approve_chain', 'approve_chain_and_push', 'mark_chain_completed',
  ])

  async function handleReviewTask(taskId, action) {
    if (!taskId || !VALID_REVIEW_ACTIONS.has(action)) return

    const reviewResult = await reviewTask(taskId, action)
    const nextStatus = reviewResult.status
    const mergeState = reviewResult.merge_state

    await loadTasks()
    const isApprove = action === 'approve' || action === 'approve_and_push' || action === 'approve_chain' || action === 'approve_chain_and_push'
    if (isApprove && (mergeState === 'merged' || mergeState === 'merged_and_pushed') && nextStatus === 'completed') {
      closeConversationDrawer()
      return
    }
    if (isApprove && mergeState === 'conflict_retry_enqueued' && nextStatus === 'merging') {
      closeConversationDrawer()
      return
    }

    const isMarkCompleted = action === 'mark_completed' || action === 'mark_chain_completed'
    if (isMarkCompleted && nextStatus === 'completed') {
      closeConversationDrawer()
      return
    }

    setConversation((prev) => {
      if (!prev.open || prev.taskId !== taskId) return prev
      return { ...prev, taskStatus: nextStatus }
    })
  }

  async function handleAddFollowup(parentTaskId, prompt) {
    if (!parentTaskId || !prompt) return
    try {
      const result = await createFollowupTask(parentTaskId, { prompt, reasoning_effort: 'high' })
      const taskId = result?.task_id
      if (taskId) {
        const title = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt
        setTasks((prev) => {
          const updated = prev.map((t) =>
            t.id === parentTaskId ? { ...t, followup_task_id: taskId } : t
          )
          return [{
            id: taskId, title, status: 'queued', assigned_to: null,
            output_dir: null, session_id: null, created_at: new Date().toISOString(),
            completed_at: null, followup_task_id: null, predecessor_task_id: parentTaskId,
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
    if (!taskId || !recipientAgentId) return
    try {
      await setTaskRecipient(taskId, recipientAgentId)
      await loadTasks()
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleDeleteTask(taskId) {
    if (!taskId) return
    try {
      await deleteTask(taskId)
      await loadTasks()
      setConversation((prev) => {
        if (prev.open && prev.taskId === taskId) return { ...prev, open: false }
        return prev
      })
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  function handleHideChat(threadId) {
    if (!threadId || !activeWorkspaceName) return
    setHiddenChatsByWorkspace((prev) => {
      const existing = Array.isArray(prev[activeWorkspaceName]) ? prev[activeWorkspaceName] : []
      if (existing.includes(threadId)) return prev
      return { ...prev, [activeWorkspaceName]: [...existing, threadId] }
    })
    if (activeTab === 'active-chat' && conversation.threadId === threadId) {
      setActiveTab('feed')
    }
  }

  // --- Conversation handlers ---
  function handleStopStream() {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setConversation((prev) => ({ ...prev, loading: false }))
  }

  async function handleStopTask() {
    if (!conversation.taskId) return
    try {
      await stopTask(conversation.taskId)
      setConversation((prev) => ({ ...prev, taskStatus: 'waiting_for_question_response', loading: false }))
      setTasks((prev) =>
        prev.map((t) =>
          t.id === conversation.taskId ? { ...t, status: 'waiting_for_question_response' } : t
        )
      )
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleInputSubmit({ message, mode, reasoningEffort, attachments, recipientAgentId }) {
    setWorkspaceError('')

    let finalMessage = message
    if (attachments && attachments.length > 0) {
      try {
        const uploaded = await Promise.all(attachments.map((att) => uploadFile(att.file)))
        const lines = uploaded.map((u) => `[Attached file: ${u.path}]`)
        finalMessage = (message ? message + '\n\n' : '') + lines.join('\n')
      } catch (error) {
        setWorkspaceError(errorText(error))
        return
      }
    }

    const continueExistingExecute =
      mode === 'execute' && conversation.open && !conversation.loading &&
      conversation.mode === 'execute' && Boolean(conversation.threadId)

    if (followupForTaskId) {
      const parentId = followupForTaskId
      setFollowupForTaskId('')
      try {
        const result = await createFollowupTask(parentId, {
          prompt: finalMessage, recipient_agent_id: recipientAgentId, reasoning_effort: reasoningEffort,
        })
        const taskId = result?.task_id
        if (taskId) {
          const title = finalMessage.length > 100 ? `${finalMessage.slice(0, 97)}...` : finalMessage
          setTasks((prev) => {
            const updated = prev.map((t) => t.id === parentId ? { ...t, followup_task_id: taskId } : t)
            return [{
              id: taskId, title, status: 'queued', assigned_to: null, output_dir: null,
              session_id: null, created_at: new Date().toISOString(), completed_at: null,
              followup_task_id: null, predecessor_task_id: parentId, thread_id: null,
            }, ...updated]
          })
        }
        scheduleTasksRefresh(500)
      } catch (error) { setWorkspaceError(errorText(error)) }
      return
    }

    if (mode === 'execute' && !continueExistingExecute) {
      try {
        const result = await createExecuteTask({
          prompt: finalMessage, recipient_agent_id: recipientAgentId, reasoning_effort: reasoningEffort,
        })
        const taskId = result?.task_id
        if (taskId) {
          const title = finalMessage.length > 100 ? `${finalMessage.slice(0, 97)}...` : finalMessage
          setTasks((prev) => [{
            id: taskId, title, status: 'queued', assigned_to: null, output_dir: null,
            session_id: null, created_at: new Date().toISOString(), completed_at: null,
            followup_task_id: null, predecessor_task_id: null, thread_id: null,
          }, ...prev])
        }
        setActiveTab('feed')
        scheduleTasksRefresh(500)
      } catch (error) { setWorkspaceError(errorText(error)) }
      return
    }

    const continueExistingPlan =
      mode === 'plan' && conversation.open && !conversation.loading &&
      conversation.mode === 'plan' && Boolean(conversation.threadId)

    if (mode === 'plan' && !continueExistingPlan) {
      try {
        const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
        if (!runtime) { setWorkspaceError('Orchestrator runtime is not available.'); return }
        const result = await createConversationTurn({
          message: finalMessage, mode: 'plan', harness: runtime.harness,
          model_label: runtime.model_label, reasoning_effort: reasoningEffort,
          recipient_agent_id: recipientAgentId || undefined,
        })
        const taskId = result?.task_id
        if (taskId) {
          const title = finalMessage.length > 100 ? `${finalMessage.slice(0, 97)}...` : finalMessage
          setTasks((prev) => [{
            id: taskId, title, status: 'planning', assigned_to: null, output_dir: null,
            session_id: null, created_at: new Date().toISOString(), completed_at: null,
            followup_task_id: null, predecessor_task_id: null, thread_id: result?.thread_id || null,
          }, ...prev])
        }
        setActiveTab('feed')
        scheduleTasksRefresh(500)
        void loadPlans()
      } catch (error) { setWorkspaceError(errorText(error)) }
      return
    }

    const conversationStatus = String(conversation.taskStatus || '').toLowerCase()
    if (
      (mode === 'chat' || mode === 'plan') && conversation.open && conversation.taskId &&
      (isWaitingForHumanResponse(conversationStatus) || conversationStatus === 'completed')
    ) {
      try {
        await respondToTask(conversation.taskId, finalMessage)
        setConversation((prev) => ({
          ...prev,
          taskStatus: prev.mode === 'plan' ? 'planning' : 'queued',
          loading: true,
          entries: [
            ...prev.entries,
            { id: nextEntryId('user'), type: 'user', content: finalMessage },
            {
              id: nextEntryId('status'), type: 'status',
              content: prev.mode === 'plan' ? 'Response sent. Continuing plan.' : 'Follow-up sent. Resuming worker.',
            },
          ],
        }))
        setTasks((prev) =>
          prev.map((t) =>
            t.id === conversation.taskId
              ? { ...t, status: conversation.mode === 'plan' ? 'planning' : 'queued' }
              : t
          )
        )
        scheduleTasksRefresh(500)
      } catch (error) { setWorkspaceError(errorText(error)) }
      return
    }

    if (
      mode === 'chat' && conversation.open && conversation.taskId &&
      isTaskActivelyRunning(conversationStatus)
    ) {
      try {
        await stopTask(conversation.taskId, finalMessage)
        setConversation((prev) => ({
          ...prev, taskStatus: 'queued', loading: true,
          entries: [
            ...prev.entries,
            { id: nextEntryId('user'), type: 'user', content: finalMessage },
            { id: nextEntryId('status'), type: 'status', content: 'Task redirected with your message.' },
          ],
        }))
        setTasks((prev) =>
          prev.map((t) => t.id === conversation.taskId ? { ...t, status: 'queued' } : t)
        )
        scheduleTasksRefresh(500)
      } catch (error) { setWorkspaceError(errorText(error)) }
      return
    }

    const forceContinueOpenChat =
      mode === 'chat' && conversation.open && !conversation.loading &&
      conversation.mode === 'chat' && Boolean(conversation.threadId)

    const forceContinueExisting = forceContinueOpenChat || continueExistingExecute || continueExistingPlan

    if (!forceContinueExisting && !orchestratorRuntime) {
      const refreshedRuntime = await resolveOrchestratorRuntime()
      if (!refreshedRuntime) { setWorkspaceError('Orchestrator runtime is not available.'); return }
    }

    const runtime = forceContinueExisting
      ? null
      : orchestratorRuntime ?? (await resolveOrchestratorRuntime())
    if (!forceContinueExisting && !runtime) {
      setWorkspaceError('Orchestrator runtime is not available.')
      return
    }

    const effectiveHarness = forceContinueExisting ? conversation.harness : runtime.harness
    const effectiveModelLabel = forceContinueExisting ? conversation.modelLabel : runtime.model_label

    const reuseExisting =
      conversation.open && !conversation.loading && conversation.mode === mode &&
      conversation.harness === effectiveHarness && conversation.modelLabel === effectiveModelLabel

    const nextThreadId = reuseExisting ? conversation.threadId || undefined : undefined
    const nextEntries = reuseExisting ? [...conversation.entries] : []
    nextEntries.push({ id: nextEntryId('user'), type: 'user', content: finalMessage })
    const streamAssistantAgent = runtime ?? orchestratorRuntime ?? null
    const streamAssistantIdentity = {
      agentId: streamAssistantAgent?.id || ORCHESTRATOR_AGENT_ID,
      agentName: streamAssistantAgent?.name || streamAssistantAgent?.id || 'Orchestrator',
      agentEmoji: streamAssistantAgent?.emoji || iconForAgent(streamAssistantAgent?.id || ORCHESTRATOR_AGENT_ID),
    }

    setConversation({
      open: true, mode, threadId: nextThreadId || '',
      taskId: reuseExisting ? conversation.taskId : '',
      taskStatus: reuseExisting ? conversation.taskStatus : '',
      taskTitle: reuseExisting ? conversation.taskTitle : '',
      harness: effectiveHarness, modelLabel: effectiveModelLabel, reasoningEffort,
      recipientAgentId: mode === 'plan' && reuseExisting ? conversation.recipientAgentId : '',
      entries: nextEntries, loading: true, error: '',
      planReady: mode === 'plan' ? false : undefined,
    })

    const controller = new AbortController()
    streamAbortRef.current?.abort()
    streamAbortRef.current = controller
    let streamThreadId = nextThreadId || ''

    try {
      await streamConversationTurn(
        {
          thread_id: nextThreadId, message: finalMessage, mode,
          harness: effectiveHarness, model_label: effectiveModelLabel,
          reasoning_effort: reasoningEffort,
        },
        {
          signal: controller.signal,
          onEvent: ({ event, data }) => {
            setConversation((prev) => {
              if (event === 'thread_started') {
                streamThreadId = data.thread_id
                if (mode === 'chat') void loadChats()
                if (mode === 'plan') void loadPlans()
                return { ...prev, threadId: data.thread_id }
              }
              if (streamThreadId && prev.threadId && prev.threadId !== streamThreadId) return prev
              if (event === 'assistant_text') {
                return { ...prev, entries: appendAssistantDelta(prev.entries, data.delta, streamAssistantIdentity) }
              }
              if (event === 'tool_event') {
                const toolSummary = summarizeToolEvent(data?.name, data?.payload)
                if (!toolSummary) return prev
                return {
                  ...prev,
                  entries: appendToolEntryStreaming(prev.entries, {
                    id: nextEntryId('tool'), type: 'tool',
                    label: toolSummary.label, summary: toolSummary.summary,
                  }),
                }
              }
              if (event === 'error') return { ...prev, error: data.message }
              return prev
            })
          },
        },
      )
    } catch (error) {
      if (controller.signal.aborted) return
      setConversation((prev) => ({ ...prev, error: errorText(error) }))
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null
      setConversation((prev) => {
        if (streamThreadId && prev.threadId && prev.threadId !== streamThreadId) return prev
        return {
          ...prev,
          loading: prev.taskId ? isTaskActivelyRunning(prev.taskStatus) : false,
          planReady: mode === 'plan' ? true : prev.planReady,
        }
      })
      if (mode === 'chat') await loadChats()
      if (mode === 'plan') await loadPlans()
    }
  }

  async function handleExecuteFromPlan() {
    if (!conversation.threadId || conversation.mode !== 'plan') return
    try {
      const planThreadId = conversation.threadId
      const proposal = conversation.planProposal

      if (proposal && Array.isArray(proposal.tasks) && proposal.tasks.length > 0) {
        const proposalTasks = proposal.tasks.map((t) => ({
          title: t.title || 'Task', prompt: t.prompt || '', recipient_agent_id: t.recipient || '',
        }))
        await executePlanProposal(conversation.threadId, {
          tasks: proposalTasks, reasoning_effort: conversation.reasoningEffort,
        })
      } else {
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
      setConversation((prev) => ({ ...prev, error: errorText(error) }))
    }
  }

  async function handleDeletePlan() {
    if (!conversation.threadId || conversation.mode !== 'plan') return
    try {
      const planThreadId = conversation.threadId
      const taskId = conversation.taskId
      await deletePlanThread(planThreadId)
      setSidebarPlans((prev) => prev.filter((plan) => plan.id !== planThreadId))
      closeConversationDrawer()
      await loadPlans()
      if (taskId) await loadTasks()
    } catch (error) {
      setConversation((prev) => ({ ...prev, error: errorText(error) }))
    }
  }

  async function handleNewChat() {
    const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
    if (!runtime) { setWorkspaceError('Orchestrator runtime is not available.'); return }
    if (conversation.threadId && conversation.mode === 'chat') {
      chatDraftsRef.current[conversation.threadId] = activeChatDraft
    }
    setSelectedServiceId('')
    closeConversationDrawer()
    setActiveTab('new-chat')
  }

  async function handleOpenChat(threadId) {
    if (!threadId) return
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
      setActiveChatDraft(chatDraftsRef.current[thread.id] || '')
      setConversation({
        open: true, mode: 'chat', threadId: thread.id, taskId: '', taskStatus: '',
        harness: thread.harness, modelLabel: thread.model_label, reasoningEffort: 'medium',
        recipientAgentId: '', entries, loading: hasRunningTurn(data.turns), error: '',
      })
      setActiveTab('active-chat')
    } catch (error) {
      setWorkspaceError(errorText(error))
      await loadChats()
    }
  }

  async function handleOpenPlan(threadId) {
    if (!threadId) return
    setSelectedServiceId('')
    try {
      const data = await fetchConversationThread(threadId)
      if (!data?.thread) { setWorkspaceError('Plan thread not found.'); await loadPlans(); return }
      if (data.thread.mode !== 'plan') { setWorkspaceError('Thread is not a plan.'); await loadPlans(); return }

      const entries = buildEntriesFromThreadData(data, agentById)
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

      let proposal = null
      try { proposal = await fetchPlanProposal(threadId) } catch {}

      setConversation({
        open: true, mode: 'plan', threadId: data.thread.id, taskId: '', taskStatus: '',
        harness: data.thread.harness, modelLabel: data.thread.model_label,
        reasoningEffort: 'medium', recipientAgentId: selectedRecipientAgentId,
        entries, loading: latestTurnStillRunning, error: '',
        planReady: proposal ? true : planReady, planProposal: proposal,
      })
      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
      await loadPlans()
    }
  }

  async function handleOpenTaskConversation(task, options = {}) {
    const taskId = typeof task?.id === 'string' ? task.id : ''
    if (!taskId) { setWorkspaceError('Task is missing a task id.'); return }
    const requestedServiceId = typeof options.serviceId === 'string' ? options.serviceId : ''
    setSelectedServiceId(requestedServiceId)

    const threadId = typeof task?.thread_id === 'string' ? task.thread_id : ''
    const title = normalizeTaskTitle(task?.title)
    const status = typeof task?.status === 'string' ? task.status : ''
    if (!title || !status) { setWorkspaceError('Task payload is missing required fields.'); return }

    if (!threadId) {
      const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
      if (!runtime) { setWorkspaceError('Orchestrator runtime is not available.'); return }
      setConversation({
        open: true, mode: 'chat', threadId: '', taskId, taskStatus: status,
        taskTitle: title, harness: runtime.harness, modelLabel: runtime.model_label,
        reasoningEffort: 'medium', recipientAgentId: '',
        entries: [{ id: nextEntryId('status'), type: 'status', content: `Opened output review for ${title}.` }],
        loading: isTaskActivelyRunning(status), error: '',
      })
      setActiveTab('feed')
      return
    }

    try {
      const data = await fetchConversationThread(threadId)
      if (!data?.thread) {
        const runtime = orchestratorRuntime ?? (await resolveOrchestratorRuntime())
        if (!runtime) { setWorkspaceError('Orchestrator runtime is not available.'); return }
        setConversation({
          open: true, mode: 'chat', threadId: '', taskId, taskStatus: status,
          taskTitle: title, harness: runtime.harness, modelLabel: runtime.model_label,
          reasoningEffort: 'medium', recipientAgentId: '',
          entries: [{ id: nextEntryId('status'), type: 'status', content: `Opened output review for ${title}. Conversation history is unavailable.` }],
          loading: isTaskActivelyRunning(status), error: '',
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
        try { proposal = await fetchPlanProposal(thread.id) } catch {}

        setConversation({
          open: true, mode: 'plan', threadId: thread.id, taskId, taskStatus: status,
          taskTitle: title, harness: thread.harness, modelLabel: thread.model_label,
          reasoningEffort: 'medium', recipientAgentId: selectedRecipientAgentId,
          entries, loading: latestTurnStillRunning, error: '',
          planReady: proposal ? true : planReady, planProposal: proposal,
        })
        setActiveTab('feed')
        return
      }

      setConversation({
        open: true, mode: 'chat', threadId: thread.id, taskId, taskStatus: status,
        taskTitle: title, harness: thread.harness, modelLabel: thread.model_label,
        reasoningEffort: 'medium', recipientAgentId: '', entries,
        loading: isTaskActivelyRunning(status), error: '',
      })
      setActiveTab('feed')
    } catch (error) {
      setWorkspaceError(errorText(error))
    }
  }

  async function handleOpenTaskConversationById(taskId) {
    if (!taskId) return
    const existingTask = tasks.find((task) => task?.id === taskId)
    if (existingTask) { await handleOpenTaskConversation(existingTask); return }
    try {
      const refreshedTasks = await fetchTasks(300)
      setTasks(refreshedTasks)
      const refreshedTask = refreshedTasks.find((task) => task?.id === taskId) || null
      if (refreshedTask) { await handleOpenTaskConversation(refreshedTask); return }
    } catch {}
    setWorkspaceError(`Task not found: ${taskId}.`)
  }

  function handleDrawerPromptSubmit(message) {
    const mode = conversation.mode === 'plan' ? 'plan' : 'chat'
    void handleInputSubmit({ message, mode, reasoningEffort: conversation.reasoningEffort })
  }

  function handleNewChatSubmit(payload) {
    setNewChatDraft('')
    setActiveChatDraft('')
    setActiveTab('active-chat')
    void handleInputSubmit({ ...payload, mode: 'chat' })
  }

  function handleInlineChatSubmit(payload) {
    setActiveChatDraft('')
    if (conversation.threadId) delete chatDraftsRef.current[conversation.threadId]
    void handleInputSubmit({ ...payload, mode: 'chat' })
  }

  function handleOpenOrchestratorConfig() {
    setWorkspaceError('')
    if (!orchestratorRuntime) { setWorkspaceError('Orchestrator runtime is not available.'); return }
    setActiveTab('feed')
    setOpenOrchestratorConfigRequest((current) => current + 1)
  }

  // --- Render ---
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
        onOpenChat={(threadId) => { void handleOpenChat(threadId) }}
        onOpenService={(service) => { void handleOpenRuntimeService(service) }}
        onStopService={(serviceId) => { void handleStopRuntimeService(serviceId) }}
        onHideChat={handleHideChat}
        onNewChat={handleNewChat}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateWorkspace={() => { setOnboardingError(''); setIsOnboardingOpen(true) }}
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
                runtimeServiceError={conversationRuntimeService && selectedServiceId ? runtimeServiceStreamError : ''}
                onStopRuntimeService={handleStopRuntimeService}
                onServiceStarted={handleRuntimeServiceStarted}
                onClose={closeConversationDrawer}
                recipientAgents={recipientAgents}
                onPromptSubmit={handleDrawerPromptSubmit}
                onExecute={() => { void handleExecuteFromPlan() }}
                onDeletePlan={() => { void handleDeletePlan() }}
                executeDisabled={!conversation.threadId || !conversation.planReady}
                onStop={conversation.taskId && conversation.mode !== 'plan' ? handleStopTask : handleStopStream}
                planProposal={conversation.planProposal}
                onUpdatePlanProposal={(updated) => { setConversation((prev) => ({ ...prev, planProposal: updated })) }}
              />
            ) : (
              <>
                {!tasksLoading && !tasksError && taskFailureNotice && (
                  <div className="workspace-error">
                    <span>Task failed: {taskFailureNotice.taskTitle}</span>
                    <button style={{ marginLeft: 8 }} onClick={() => { void handleOpenTaskConversationById(taskFailureNotice.taskId) }}>Open task</button>
                    <button style={{ marginLeft: 8 }} onClick={() => setTaskFailureNotice(null)}>Dismiss</button>
                  </div>
                )}
                <div className="main-topbar"><h1>Tasks</h1></div>
                <FeedView
                  tasks={tasks}
                  loading={tasksLoading}
                  error={tasksError}
                  recipientAgents={recipientAgents}
                  agentById={agentById}
                  plans={sidebarPlans}
                  onOpenPlan={(threadId) => { void handleOpenPlan(threadId) }}
                  onOpenTaskConversation={(task) => { void handleOpenTaskConversation(task) }}
                  onPickTaskRecipient={(taskId, recipientAgentId) => { void handleSetTaskRecipient(taskId, recipientAgentId) }}
                  onAddFollowup={(parentTaskId, prompt) => { void handleAddFollowup(parentTaskId, prompt) }}
                  followupForTaskId={followupForTaskId}
                  setFollowupForTaskId={setFollowupForTaskId}
                />
                <InputBar
                  disabled={conversation.loading || workspacesLoading || agentsLoading || !activeWorkspaceName}
                  loading={false}
                  onStop={handleStopStream}
                  agents={recipientAgents}
                  orchestratorEmoji={orchestratorRuntime?.emoji || ''}
                  preferredMode={conversation.open ? conversation.mode : ''}
                  onSubmit={(payload) => { void handleInputSubmit(payload) }}
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
            <div className="main-topbar"><h1>New chat</h1></div>
            <div style={{ flex: 1 }} />
            <InputBar
              disabled={conversation.loading || workspacesLoading || agentsLoading || !activeWorkspaceName}
              loading={conversation.loading}
              onStop={handleStopStream}
              onOpenOrchestratorConfig={handleOpenOrchestratorConfig}
              hideMode
              lockedMode="chat"
              value={newChatDraft}
              onValueChange={setNewChatDraft}
              onSubmit={(payload) => { void handleNewChatSubmit(payload) }}
            />
          </div>
        )}

        {activeTab === 'active-chat' && (
          <div className="feed-page">
            <div className="main-topbar">
              <h1>{sidebarChats.find((c) => c.id === conversation.threadId)?.chat_title || 'Chat'}</h1>
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
              disabled={workspacesLoading || agentsLoading || !activeWorkspaceName}
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
        {activeTab === 'automations' && <AutomationsView />}
        {activeTab === 'settings' && (
          <SettingsView
            workspaceName={activeWorkspaceName}
            deleting={deleteWorkspaceLoading}
            error={deleteWorkspaceError}
            onDelete={() => { void handleDeleteActiveWorkspace() }}
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
