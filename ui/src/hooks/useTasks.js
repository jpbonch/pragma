import { useState, useRef, useEffect, useMemo } from 'react'
import { ApiError, fetchTasks, fetchPlans, fetchChats } from '../api'
import { errorText, getPendingCount, loadHiddenChatsByWorkspace, saveHiddenChatsByWorkspace } from '../lib/conversationUtils'

export function useTasks({ activeWorkspaceName, setWorkspaceError }) {
  const [tasks, setTasks] = useState([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState('')
  const [taskFailureNotice, setTaskFailureNotice] = useState(null)
  const [followupForTaskId, setFollowupForTaskId] = useState('')

  const [sidebarPlans, setSidebarPlans] = useState([])
  const [sidebarPlansLoading, setSidebarPlansLoading] = useState(false)
  const [sidebarChats, setSidebarChats] = useState([])
  const [sidebarChatsLoading, setSidebarChatsLoading] = useState(false)
  const [hiddenChatsByWorkspace, setHiddenChatsByWorkspace] = useState(loadHiddenChatsByWorkspace)
  const [unreadChatIds, setUnreadChatIds] = useState(() => new Set())

  const tasksRefreshTimerRef = useRef(null)
  const tasksRefreshInFlightRef = useRef(false)
  const tasksRefreshQueuedRef = useRef(false)
  const tasksInitialLoadDoneRef = useRef(false)
  const chatsPollTimerRef = useRef(null)
  const tasksRef = useRef(tasks)

  const pendingCount = useMemo(() => getPendingCount(tasks), [tasks])

  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => { setTaskFailureNotice(null) }, [activeWorkspaceName])
  useEffect(() => { saveHiddenChatsByWorkspace(hiddenChatsByWorkspace) }, [hiddenChatsByWorkspace])

  async function loadTasks() {
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
      setWorkspaceError((prev) => prev || errorText(error))
    } finally {
      setSidebarPlansLoading(false)
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
      setWorkspaceError((prev) => prev || errorText(error))
    } finally {
      if (!silent) {
        setSidebarChatsLoading(false)
      }
    }
  }

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

  function clearTasksData() {
    setTasks([])
    tasksInitialLoadDoneRef.current = false
    setTasksError('')
    setSidebarPlans([])
    setSidebarPlansLoading(false)
    setSidebarChats([])
    setSidebarChatsLoading(false)
    if (chatsPollTimerRef.current) {
      clearInterval(chatsPollTimerRef.current)
      chatsPollTimerRef.current = null
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tasksRefreshTimerRef.current) {
        clearTimeout(tasksRefreshTimerRef.current)
        tasksRefreshTimerRef.current = null
      }
      if (chatsPollTimerRef.current) {
        clearInterval(chatsPollTimerRef.current)
        chatsPollTimerRef.current = null
      }
      tasksRefreshQueuedRef.current = false
    }
  }, [])

  return {
    tasks, setTasks,
    tasksLoading, tasksError, setTasksError,
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
  }
}
