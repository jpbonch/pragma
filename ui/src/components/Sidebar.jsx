import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Zap,
  BookOpen,
  Puzzle,
  Settings,
  ChevronDown,
  Plus,
  CirclePlus,
  Check,
  X,
  Code2,
  Folder,
  FolderGit2,
  TerminalSquare,
  Loader2,
  MessageSquare,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react'

const ITEMS = [
  { id: 'feed', icon: Zap, label: 'Tasks' },
  { id: 'code', icon: Code2, label: 'Code' },
  { id: 'files', icon: Folder, label: 'Files' },
  { id: 'context', icon: BookOpen, label: 'Context' },
  { id: 'skills', icon: Puzzle, label: 'Skills' },
]

function SidebarProcesses({ processes, services, activeServiceId, onOpenService, onStartProcess, onStopProcess, onAddProcess, onDeleteProcess }) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [addLabel, setAddLabel] = useState('')
  const [addCommand, setAddCommand] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState('')

  // Build a map from process_db_id to runtime service for quick lookups
  const runtimeByDbId = useMemo(() => {
    const map = new Map()
    for (const svc of services) {
      if (svc.process_db_id && !map.has(svc.process_db_id)) map.set(svc.process_db_id, svc)
    }
    return map
  }, [services])

  // Filter out task-level processes (only show workspace/repo-level)
  const displayProcesses = useMemo(() => {
    if (!Array.isArray(processes)) return []
    return processes.filter((p) => p && !p.task_id)
  }, [processes])

  async function handleAdd(event) {
    event.preventDefault()
    if (!addLabel.trim() || !addCommand.trim() || addLoading) return
    setAddLoading(true)
    try {
      await onAddProcess({ label: addLabel.trim(), command: addCommand.trim(), cwd: '.', type: 'service' })
      setAddLabel('')
      setAddCommand('')
      setShowAddForm(false)
    } catch {
      // silent
    } finally {
      setAddLoading(false)
    }
  }

  return (
    <section className="sidebar-services">
      <div className="sidebar-services-header">
        <div className="sidebar-services-title">Processes</div>
        <button
          className="sidebar-processes-add-btn"
          title="Add process"
          onClick={() => setShowAddForm(!showAddForm)}
        >
          <Plus size={12} />
        </button>
      </div>
      {showAddForm && (
        <form className="sidebar-process-add-form" onSubmit={handleAdd}>
          <input
            className="sidebar-process-add-input"
            placeholder="Label"
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            autoFocus
          />
          <input
            className="sidebar-process-add-input"
            placeholder="Command"
            value={addCommand}
            onChange={(e) => setAddCommand(e.target.value)}
          />
          <div className="sidebar-process-add-actions">
            <button type="submit" className="sidebar-process-add-submit" disabled={addLoading || !addLabel.trim() || !addCommand.trim()}>
              {addLoading ? 'Adding...' : 'Add'}
            </button>
            <button type="button" className="sidebar-process-add-cancel" onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <div className="sidebar-services-list">
        {displayProcesses.length === 0 && !showAddForm && (
          <div className="sidebar-chat-empty">No processes</div>
        )}
        {displayProcesses.map((proc) => {
          const runtimeSvc = runtimeByDbId.get(proc.id)
          const status = typeof proc.status === 'string' ? proc.status : 'stopped'
          const isRunning = status === 'running' || status === 'ready'
          const isExited = status === 'exited'
          const isStopped = !isRunning && !isExited
          const isActive = runtimeSvc ? activeServiceId === runtimeSvc.id : false
          const isLoading = actionLoading === proc.id
          const isRepoLevel = proc.folder_name && proc.folder_name !== ''
          const IconComponent = isRepoLevel ? FolderGit2 : TerminalSquare

          return (
            <div key={proc.id} className="sidebar-service-row">
              <button
                className={`sidebar-service-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (runtimeSvc) onOpenService?.(runtimeSvc)
                }}
                title={`${proc.label || proc.command} (${status})`}
              >
                <span className={`sidebar-service-dot ${isRunning ? 'running' : ''} ${isExited ? 'exited' : ''}`} />
                <IconComponent size={12} />
                <span className="sidebar-service-title">{proc.label || proc.command}</span>
              </button>
              <div className="sidebar-service-actions">
                {isRunning && (
                  <button
                    className="sidebar-service-action-btn"
                    aria-label="Stop process"
                    title="Stop process"
                    disabled={isLoading}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setActionLoading(proc.id)
                      Promise.resolve(onStopProcess?.(proc.id)).finally(() => setActionLoading(''))
                    }}
                  >
                    <Square size={10} />
                  </button>
                )}
                {isStopped && (
                  <button
                    className="sidebar-service-action-btn sidebar-service-play-btn"
                    aria-label="Start process"
                    title="Start process"
                    disabled={isLoading}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setActionLoading(proc.id)
                      Promise.resolve(onStartProcess?.(proc.id)).finally(() => setActionLoading(''))
                    }}
                  >
                    <Play size={10} />
                  </button>
                )}
                {isExited && (
                  <button
                    className="sidebar-service-action-btn sidebar-service-restart-btn"
                    aria-label="Restart process"
                    title="Restart process"
                    disabled={isLoading}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setActionLoading(proc.id)
                      Promise.resolve(onStartProcess?.(proc.id)).finally(() => setActionLoading(''))
                    }}
                  >
                    <RotateCcw size={10} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function Sidebar({
  activeTab,
  onChange,
  pendingCount = 0,
  workspaces,
  activeWorkspaceName,
  workspacesLoading,
  chats = [],
  chatsLoading = false,
  thinkingChatIds,
  unreadChatIds,
  activeChatId = '',
  onOpenChat,
  onHideChat,
  services = [],
  activeServiceId = '',
  onOpenService,
  onStopService,
  processes = [],
  onStartProcess,
  onStopProcess,
  onAddProcess,
  onDeleteProcess,
  onNewChat,
  onSelectWorkspace,
  onCreateWorkspace,
}) {
  const [wsOpen, setWsOpen] = useState(false)
  const workspaceMenuRef = useRef(null)

  const activeWorkspace = useMemo(() => {
    return workspaces.find((workspace) => workspace.name === activeWorkspaceName) ?? null
  }, [workspaces, activeWorkspaceName])

  const workspaceLabel =
    activeWorkspace?.name || (workspacesLoading ? 'Loading...' : 'No workspace')

  useEffect(() => {
    if (!wsOpen) {
      return
    }

    function handlePointerDown(event) {
      if (!workspaceMenuRef.current) {
        return
      }
      if (!workspaceMenuRef.current.contains(event.target)) {
        setWsOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [wsOpen])

  return (
    <aside className="sidebar">
      <div style={{ position: 'relative' }} ref={workspaceMenuRef}>
        <button className="workspace-btn" onClick={() => setWsOpen(!wsOpen)}>
          <span className="workspace-logo">{workspaceLabel.charAt(0).toUpperCase()}</span>
          <span className="workspace-name">{workspaceLabel}</span>
          <ChevronDown size={12} className={`workspace-chevron-icon ${wsOpen ? 'open' : ''}`} />
        </button>
        {wsOpen && (
          <div className="workspace-dropdown">
            {workspaces.length === 0 && !workspacesLoading && (
              <div className="workspace-option">
                <span className="ws-label">No workspaces yet</span>
              </div>
            )}

            {workspaces.map((ws) => (
              <div
                key={ws.name}
                className={`workspace-option ${ws.active ? 'active' : ''}`}
                onClick={() => {
                  setWsOpen(false)
                  if (!ws.active) {
                    onSelectWorkspace(ws.name)
                  }
                }}
              >
                <span className="workspace-logo">{ws.name.charAt(0).toUpperCase()}</span>
                <span className="ws-label">{ws.name}</span>
                {ws.active && <Check size={12} style={{ marginLeft: 'auto', color: '#2383e2' }} />}
              </div>
            ))}

            <div style={{ borderTop: '1px solid #F0EFEC', marginTop: 4, paddingTop: 4 }}>
              <div
                className="workspace-option"
                style={{ color: '#9B9A97', fontSize: 13 }}
                onClick={() => {
                  setWsOpen(false)
                  onCreateWorkspace()
                }}
              >
                <Plus size={14} style={{ opacity: 0.5 }} /> New workspace
              </div>
            </div>
          </div>
        )}
      </div>

      <nav className="sidebar-nav">
        {ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              className={`sidebar-item ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => onChange(item.id)}
            >
              <Icon size={15} strokeWidth={1.75} />
              <span>{item.label}</span>
              {item.id === 'feed' && pendingCount > 0 && (
                <span className="sidebar-badge">{pendingCount}</span>
              )}
            </button>
          )
        })}
      </nav>

      <SidebarProcesses
        processes={processes}
        services={services}
        activeServiceId={activeServiceId}
        onOpenService={onOpenService}
        onStartProcess={onStartProcess}
        onStopProcess={onStopProcess}
        onAddProcess={onAddProcess}
        onDeleteProcess={onDeleteProcess}
      />

      <section className="sidebar-chats">
        <div className="sidebar-chats-header">
          <div className="sidebar-chats-title">Chats</div>
        </div>
        <div className="sidebar-chats-list">
          <button
            className={`sidebar-new-chat-btn ${activeTab === 'new-chat' ? 'active' : ''}`}
            onClick={() => onNewChat?.()}
            title="New chat"
          >
            <CirclePlus size={14} className="sidebar-new-chat-icon" />
            New chat
          </button>
          {chatsLoading && <div className="sidebar-chat-empty">Loading chats...</div>}
          {!chatsLoading && chats.length === 0 && (
            <div className="sidebar-chat-empty">No chats yet</div>
          )}

          {!chatsLoading &&
            chats.map((chat) => {
              const isThinking = thinkingChatIds?.has(chat.id)
              const isUnread = !isThinking && unreadChatIds?.has(chat.id)
              return (
              <div key={chat.id} className="sidebar-chat-row">
                <button
                  className={`sidebar-chat-item ${activeChatId === chat.id ? 'active' : ''}`}
                  onClick={() => onOpenChat?.(chat.id)}
                  title={chat.chat_title || 'New chat'}
                >
                  <div className="sidebar-chat-item-title">{chat.chat_title || 'New chat'}</div>
                  {isThinking && <Loader2 size={12} className="sidebar-chat-spinner" />}
                  {isUnread && <span className="sidebar-chat-unread-dot" />}
                </button>
                <button
                  className="sidebar-chat-hide"
                  aria-label="Hide chat"
                  title="Hide chat"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onHideChat?.(chat.id)
                  }}
                >
                  <X size={11} />
                </button>
              </div>
              )
            })}
        </div>
      </section>

      <button
        className={`sidebar-item sidebar-footer-settings ${activeTab === 'settings' ? 'active' : ''}`}
        onClick={() => onChange('settings')}
      >
        <Settings size={15} strokeWidth={1.75} />
        <span>Settings</span>
      </button>
    </aside>
  )
}
