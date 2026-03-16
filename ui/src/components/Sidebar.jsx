import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Zap,
  BookOpen,
  Puzzle,
  Settings,
  ChevronDown,
  Plus,
  Check,
  X,
  Code2,
  Folder,
  TerminalSquare,
  Loader2,
  MessageSquare,
} from 'lucide-react'

const ITEMS = [
  { id: 'feed', icon: Zap, label: 'Tasks' },
  { id: 'code', icon: Code2, label: 'Code' },
  { id: 'files', icon: Folder, label: 'Files' },
  { id: 'context', icon: BookOpen, label: 'Context' },
  { id: 'skills', icon: Puzzle, label: 'Skills' },
]

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
  activeChatId = '',
  onOpenChat,
  onHideChat,
  services = [],
  activeServiceId = '',
  onOpenService,
  onStopService,
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
                <span style={{ fontSize: 14 }}>📁</span>
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

      <section className="sidebar-services">
        <div className="sidebar-services-title">Processes</div>
        <div className="sidebar-services-list">
          {services.length === 0 && (
            <div className="sidebar-chat-empty">No running processes</div>
          )}
          {services.map((service) => {
            const isActive = activeServiceId === service.id
            const status = typeof service.status === 'string' ? service.status : ''
            return (
              <div key={service.id} className="sidebar-service-row">
                <button
                  className={`sidebar-service-item ${isActive ? 'active' : ''}`}
                  onClick={() => onOpenService?.(service)}
                  title={`${service.label || service.command} (${status})`}
                >
                  <span className={`sidebar-service-dot ${status === 'running' ? 'running' : ''}`} />
                  <TerminalSquare size={12} />
                  <span className="sidebar-service-title">{service.label || service.command}</span>
                </button>
                {status === 'running' && (
                  <button
                    className="sidebar-service-stop"
                    aria-label="Stop process"
                    title="Stop process"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onStopService?.(service.id)
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="sidebar-chats">
        <div className="sidebar-chats-header">
          <div className="sidebar-chats-title">Chats</div>
          <button
            className="sidebar-new-chat-btn"
            onClick={() => onNewChat?.()}
            title="New chat"
          >
            <Plus size={12} />
            New chat
          </button>
        </div>
        <div className="sidebar-chats-list">
          {chatsLoading && <div className="sidebar-chat-empty">Loading chats...</div>}
          {!chatsLoading && chats.length === 0 && (
            <div className="sidebar-chat-empty">No chats yet</div>
          )}

          {!chatsLoading &&
            chats.map((chat) => {
              const isThinking = thinkingChatIds?.has(chat.id)
              return (
              <div key={chat.id} className="sidebar-chat-row">
                <button
                  className={`sidebar-chat-item ${activeChatId === chat.id ? 'active' : ''}`}
                  onClick={() => onOpenChat?.(chat.id)}
                  title={chat.chat_title || 'New chat'}
                >
                  <div className="sidebar-chat-item-title">{chat.chat_title || 'New chat'}</div>
                  {isThinking && <Loader2 size={12} className="sidebar-chat-spinner" />}
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
