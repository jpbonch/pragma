import { useState, useRef, useEffect } from 'react'
import {
  ApiError,
  fetchWorkspaces,
  fetchContextFiles,
  fetchCodeFolders,
  fetchRuntimeServices,
  openRuntimeServiceStream,
  fetchProcesses,
} from '../api'
import { errorText } from '../lib/conversationUtils'

export function useWorkspace() {
  const [workspaces, setWorkspaces] = useState([])
  const [activeWorkspaceName, setActiveWorkspaceName] = useState('')
  const [workspacesLoading, setWorkspacesLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')

  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false)
  const [onboardingError, setOnboardingError] = useState('')
  const [onboardingLoading, setOnboardingLoading] = useState(false)
  const [deleteWorkspaceLoading, setDeleteWorkspaceLoading] = useState(false)
  const [deleteWorkspaceError, setDeleteWorkspaceError] = useState('')
  const [openOrchestratorConfigRequest, setOpenOrchestratorConfigRequest] = useState(0)

  const [contextData, setContextData] = useState({ folders: [], files: [] })
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState('')
  const [codeFolders, setCodeFolders] = useState([])
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeError, setCodeError] = useState('')

  const [runtimeServices, setRuntimeServices] = useState([])
  const [selectedServiceId, setSelectedServiceId] = useState('')
  const [runtimeServiceLogsById, setRuntimeServiceLogsById] = useState(() => ({}))
  const [runtimeServiceStreamError, setRuntimeServiceStreamError] = useState('')
  const [processes, setProcesses] = useState([])
  const [processesLoading, setProcessesLoading] = useState(false)

  const runtimeServicesPollTimerRef = useRef(null)
  const runtimeServiceStreamCloseRef = useRef(null)

  const hasAnyWorkspace = workspaces.length > 0

  async function refreshWorkspaces() {
    const next = await fetchWorkspaces()
    setWorkspaces(next)
    const active = next.find((ws) => ws.active)?.name || ''
    setActiveWorkspaceName(active)
    return { next, active }
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

  async function loadProcesses() {
    setProcessesLoading(true)
    try {
      const next = await fetchProcesses()
      setProcesses(next)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_ACTIVE_WORKSPACE') {
        setProcesses([])
        return
      }
    } finally {
      setProcessesLoading(false)
    }
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
        return
      }
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

  function clearWorkspaceData() {
    setContextData({ folders: [], files: [] })
    setCodeFolders([])
    setCodeLoading(false)
    setContextError('')
    setCodeError('')
    setRuntimeServices([])
    setSelectedServiceId('')
    setRuntimeServiceLogsById({})
    setRuntimeServiceStreamError('')
    setProcesses([])
    setProcessesLoading(false)
    runtimeServiceStreamCloseRef.current?.()
    runtimeServiceStreamCloseRef.current = null
    if (runtimeServicesPollTimerRef.current) {
      clearInterval(runtimeServicesPollTimerRef.current)
      runtimeServicesPollTimerRef.current = null
    }
  }

  // Runtime services polling
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
      void loadProcesses()
    }, 3000)

    return () => {
      if (runtimeServicesPollTimerRef.current) {
        clearInterval(runtimeServicesPollTimerRef.current)
        runtimeServicesPollTimerRef.current = null
      }
    }
  }, [activeWorkspaceName])

  // Runtime service stream
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (runtimeServicesPollTimerRef.current) {
        clearInterval(runtimeServicesPollTimerRef.current)
        runtimeServicesPollTimerRef.current = null
      }
      runtimeServiceStreamCloseRef.current?.()
      runtimeServiceStreamCloseRef.current = null
    }
  }, [])

  return {
    workspaces, setWorkspaces,
    activeWorkspaceName, setActiveWorkspaceName,
    workspacesLoading, setWorkspacesLoading,
    workspaceError, setWorkspaceError,
    hasAnyWorkspace,
    isOnboardingOpen, setIsOnboardingOpen,
    onboardingError, setOnboardingError,
    onboardingLoading, setOnboardingLoading,
    deleteWorkspaceLoading, setDeleteWorkspaceLoading,
    deleteWorkspaceError, setDeleteWorkspaceError,
    openOrchestratorConfigRequest, setOpenOrchestratorConfigRequest,
    contextData, setContextData, contextLoading, contextError, setContextError,
    codeFolders, setCodeFolders, codeLoading, setCodeLoading, codeError, setCodeError,
    runtimeServices, selectedServiceId, setSelectedServiceId,
    runtimeServiceLogsById, runtimeServiceStreamError, setRuntimeServiceStreamError,
    processes, processesLoading,
    refreshWorkspaces, loadContext, loadCode, loadProcesses, loadRuntimeServices,
    upsertRuntimeService, clearWorkspaceData,
    runtimeServicesPollTimerRef,
  }
}
