import { useState, useRef, useEffect, useMemo } from 'react'
import {
  fetchConversationThread,
  fetchPlanProposal,
  openConversationThreadStream,
} from '../api'
import {
  ORCHESTRATOR_AGENT_ID,
  appendAssistantDelta,
  appendToolEntryStreaming,
  buildEntriesFromThreadData,
  hasRunningTurn,
  isTaskActivelyRunning,
  nextEntryId,
  resolveConversationHeaderAgent,
  summarizeToolEvent,
} from '../lib/conversationUtils'
import { iconForAgent } from '../lib/agentIcon'

const INITIAL_CONVERSATION = {
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
}

export { INITIAL_CONVERSATION }

export function useConversation({ agentById, tasks }) {
  const [conversation, setConversation] = useState(INITIAL_CONVERSATION)

  const streamAbortRef = useRef(null)
  const threadIdRef = useRef(conversation.threadId)
  const conversationSyncInFlightRef = useRef(false)
  const conversationSyncPendingRef = useRef(false)
  const conversationSyncRetryTimerRef = useRef(null)
  const viewingChatIdRef = useRef('')
  const prevThinkingChatIdsRef = useRef(new Set())

  const conversationHeaderAgent = useMemo(() => {
    return resolveConversationHeaderAgent({ conversation, tasks, agentById })
  }, [conversation, tasks, agentById])

  const activePlanThreadId =
    conversation.open && conversation.mode === 'plan' ? conversation.threadId : ''

  useEffect(() => {
    threadIdRef.current = conversation.threadId
  }, [conversation.threadId])

  // SSE conversation thread stream
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
    let throttledSyncTimer = null
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
      if (cancelled) return
      if (conversationSyncInFlightRef.current) {
        conversationSyncPendingRef.current = true
        return
      }
      conversationSyncInFlightRef.current = true
      try {
        conversationSyncPendingRef.current = false
        const currentThreadId = threadIdRef.current
        if (!currentThreadId || cancelled) return
        const data = await fetchConversationThread(currentThreadId)
        if (!data?.thread || cancelled) return

        const nextEntries = buildEntriesFromThreadData(data, agentById)
        const turnsRunning = hasRunningTurn(data.turns)

        let proposal = null
        if (data.thread.mode === 'plan') {
          try { proposal = await fetchPlanProposal(currentThreadId) } catch {}
        }

        setConversation((prev) => {
          if (!prev.open || prev.threadId !== threadIdRef.current || cancelled) return prev
          const nextLoading = prev.taskId ? isTaskActivelyRunning(prev.taskStatus) : turnsRunning
          return {
            ...prev,
            harness: data.thread.harness,
            modelLabel: data.thread.model_label,
            loading: nextLoading,
            entries: nextEntries,
            ...(data.thread.mode === 'plan' && proposal ? { planProposal: proposal, planReady: true } : {}),
          }
        })
      } catch {} finally {
        conversationSyncInFlightRef.current = false
        if (conversationSyncPendingRef.current) {
          conversationSyncPendingRef.current = false
          scheduleConversationRetry(150)
        }
      }
    }

    const throttledSync = () => {
      if (cancelled || throttledSyncTimer) return
      throttledSyncTimer = setTimeout(() => {
        throttledSyncTimer = null
        void syncOpenConversation()
      }, 2000)
    }

    const resolveAgentIdentity = (workerAgentId) => {
      const resolvedId = (typeof workerAgentId === 'string' && workerAgentId) || ORCHESTRATOR_AGENT_ID
      const agent = agentById && typeof agentById === 'object' ? agentById[resolvedId] : null
      return {
        agentId: resolvedId,
        agentName: (agent?.name) || (resolvedId === ORCHESTRATOR_AGENT_ID ? 'Orchestrator' : '') || resolvedId,
        agentEmoji: (agent?.emoji) || iconForAgent(resolvedId),
      }
    }

    const closeStream = openConversationThreadStream(conversation.threadId, {
      onReady: () => { void syncOpenConversation() },
      onThreadUpdated: () => { throttledSync() },
      onEvent: ({ event, data }) => {
        setConversation((prev) => {
          if (!prev.open || prev.threadId !== threadIdRef.current || cancelled) return prev

          if (event === 'worker_text' || event === 'assistant_text') {
            const delta = typeof data?.delta === 'string' ? data.delta : ''
            if (!delta) return prev
            const workerAgentId = typeof data?.worker_agent_id === 'string' ? data.worker_agent_id : ''
            const identity = resolveAgentIdentity(workerAgentId)
            return { ...prev, entries: appendAssistantDelta(prev.entries, delta, identity) }
          }

          if (event === 'worker_tool_event' || event === 'tool_event') {
            const summary = summarizeToolEvent(data?.name, data?.payload)
            if (!summary) return prev
            return {
              ...prev,
              entries: appendToolEntryStreaming(prev.entries, {
                id: nextEntryId('tool'), type: 'tool',
                label: summary.label, summary: summary.summary,
              }),
            }
          }

          if (event === 'error') {
            return { ...prev, error: typeof data?.message === 'string' ? data.message : 'Task error' }
          }

          return prev
        })
      },
      onError: () => {},
    })

    void syncOpenConversation()

    return () => {
      cancelled = true
      if (conversationSyncRetryTimerRef.current) {
        clearTimeout(conversationSyncRetryTimerRef.current)
        conversationSyncRetryTimerRef.current = null
      }
      if (throttledSyncTimer) {
        clearTimeout(throttledSyncTimer)
        throttledSyncTimer = null
      }
      conversationSyncPendingRef.current = false
      closeStream()
    }
  }, [conversation.open, conversation.mode, conversation.taskId, conversation.threadId, agentById])

  // Sync conversation task status from tasks list
  useEffect(() => {
    if (!conversation.taskId) return
    const currentTaskId = conversation.taskId
    const match = tasks.find((task) => task.id === currentTaskId)
    const nextStatus = typeof match?.status === 'string' ? match.status : ''
    const nextThreadId = typeof match?.thread_id === 'string' ? match.thread_id : ''
    if ((!nextStatus || nextStatus === conversation.taskStatus) && (!nextThreadId || conversation.threadId)) return

    setConversation((prev) => {
      if (prev.taskId !== currentTaskId) return prev
      const updates = {}
      if (nextStatus && prev.taskStatus !== nextStatus) {
        updates.taskStatus = nextStatus
        updates.loading = isTaskActivelyRunning(nextStatus)
      }
      if (!prev.threadId && nextThreadId) {
        updates.threadId = nextThreadId
      }
      if (Object.keys(updates).length === 0) return prev
      return { ...prev, ...updates }
    })
  }, [tasks, conversation.taskId, conversation.taskStatus, conversation.threadId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
      if (conversationSyncRetryTimerRef.current) {
        clearTimeout(conversationSyncRetryTimerRef.current)
        conversationSyncRetryTimerRef.current = null
      }
      conversationSyncPendingRef.current = false
    }
  }, [])

  function closeConversationDrawer() {
    viewingChatIdRef.current = ''
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setConversation(INITIAL_CONVERSATION)
  }

  return {
    conversation, setConversation,
    conversationHeaderAgent,
    activePlanThreadId,
    streamAbortRef, threadIdRef,
    viewingChatIdRef,
    prevThinkingChatIdsRef,
    closeConversationDrawer,
  }
}
