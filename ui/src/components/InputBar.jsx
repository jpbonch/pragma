import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, MessageSquare, Play, Plus, Route, Settings } from 'lucide-react'

const MODES = [
  { id: 'plan', icon: Route, label: 'Plan', desc: 'Break work into steps' },
  { id: 'execute', icon: Play, label: 'Execute', desc: 'Run tracked work' },
  { id: 'chat', icon: MessageSquare, label: 'Chat', desc: 'Quick conversation' },
]
const MODE_CYCLE_ORDER = ['plan', 'chat', 'execute']

const REASONING_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'extra_high', label: 'Extra High' },
]

export function InputBar({
  onSubmit,
  onOpenOrchestratorConfig,
  disabled = false,
  preferredMode = '',
  embedded = false,
  lockedMode = '',
  value,
  onValueChange,
}) {
  const [localInput, setLocalInput] = useState('')
  const isControlled = value !== undefined
  const input = isControlled ? value : localInput
  const setInput = isControlled ? onValueChange : setLocalInput
  const [mode, setMode] = useState('execute')
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [openMenu, setOpenMenu] = useState(null)

  const toolsRef = useRef(null)
  const textareaRef = useRef(null)

  const selectedMode = MODES.find((m) => m.id === mode) ?? MODES[0]
  const SelectedModeIcon = selectedMode.icon
  const selectedReasoning =
    REASONING_EFFORTS.find((option) => option.id === reasoningEffort) ?? REASONING_EFFORTS[1]
  const isModeLocked = Boolean(lockedMode && MODES.some((item) => item.id === lockedMode))

  function cycleMode() {
    setMode((current) => {
      const index = MODE_CYCLE_ORDER.indexOf(current)
      if (index === -1) {
        return MODE_CYCLE_ORDER[0]
      }
      return MODE_CYCLE_ORDER[(index + 1) % MODE_CYCLE_ORDER.length]
    })
    setOpenMenu(null)
  }

  useEffect(() => {
    const nextMode = isModeLocked ? lockedMode : preferredMode
    if (!nextMode || !MODES.some((item) => item.id === nextMode)) {
      return
    }
    setMode((current) => (current === nextMode ? current : nextMode))
  }, [preferredMode, lockedMode, isModeLocked])

  useEffect(() => {
    if (!openMenu) {
      return
    }

    function handlePointerDown(event) {
      if (!toolsRef.current) {
        return
      }
      if (!toolsRef.current.contains(event.target)) {
        setOpenMenu(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [openMenu])

  function submitInput() {
    if (disabled) {
      return
    }

    const message = input.trim()
    if (!message) {
      return
    }

    onSubmit?.({
      message,
      mode,
      reasoningEffort,
    })
    setInput('')
    setOpenMenu(null)

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  return (
    <div className={`input-wrap ${embedded ? 'input-wrap-embedded' : ''}`}>
      <div className="input-container">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            mode === 'chat'
              ? 'Ask questions about your project...'
              : mode === 'plan'
                ? 'What should we plan?'
                : 'Kick off a task...'
          }
          rows={1}
          onInput={(e) => {
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && e.shiftKey && !isModeLocked) {
              e.preventDefault()
              cycleMode()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submitInput()
            }
          }}
        />

        <div className="input-bottom-row" ref={toolsRef}>
          <div className="input-left-tools">
            <button className="attach-btn" title="Attach files" aria-label="Attach files" disabled={disabled}>
              <Plus size={14} />
            </button>

            {isModeLocked ? (
              <div className="selector-btn selector-btn-static">
                <SelectedModeIcon size={14} strokeWidth={2} />
                {selectedMode.label}
              </div>
            ) : (
              <div className="input-selector">
                <button className="selector-btn" onClick={() => setOpenMenu(openMenu === 'mode' ? null : 'mode')}>
                  <SelectedModeIcon size={14} strokeWidth={2} />
                  {selectedMode.label}
                  <ChevronDown size={12} style={{ opacity: 0.5 }} />
                </button>
                {openMenu === 'mode' && (
                  <div className="selector-dropdown selector-dropdown-wide">
                    {MODES.map((m) => {
                      const Icon = m.icon
                      return (
                        <div
                          key={m.id}
                          className={`selector-option ${mode === m.id ? 'active' : ''}`}
                          onClick={() => {
                            setMode(m.id)
                            setOpenMenu(null)
                          }}
                        >
                          <Icon size={16} strokeWidth={2} />
                          <div>
                            <div className="selector-option-label">{m.label}</div>
                            <div className="selector-option-desc">{m.desc}</div>
                          </div>
                          {mode === m.id && (
                            <Check size={14} style={{ marginLeft: 'auto', color: '#2383e2' }} />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="input-selector">
              <button
                className="selector-btn"
                onClick={() => setOpenMenu(openMenu === 'reasoning' ? null : 'reasoning')}
              >
                {selectedReasoning.label}
                <ChevronDown size={12} style={{ opacity: 0.5 }} />
              </button>
              {openMenu === 'reasoning' && (
                <div className="selector-dropdown">
                  <div className="selector-dropdown-title">Select reasoning</div>
                  {REASONING_EFFORTS.map((option) => (
                    <div
                      key={option.id}
                      className={`selector-option ${reasoningEffort === option.id ? 'active' : ''}`}
                      onClick={() => {
                        setReasoningEffort(option.id)
                        setOpenMenu(null)
                      }}
                    >
                      <div className="selector-option-label">{option.label}</div>
                      {reasoningEffort === option.id && (
                        <Check size={14} style={{ marginLeft: 'auto', color: '#2383e2' }} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="input-actions">
            <button
              className="input-settings-btn"
              onClick={() => onOpenOrchestratorConfig?.()}
              disabled={disabled}
              title="Open orchestrator settings"
              aria-label="Open orchestrator settings"
            >
              <Settings size={16} strokeWidth={2.1} />
            </button>
            <button
              className="send-btn"
              style={{ background: mode === 'chat' ? '#4B83D6' : '#2383e2' }}
              onClick={() => submitInput()}
              disabled={disabled || !input.trim()}
              title="Send"
            >
              <ArrowUp size={18} strokeWidth={2.6} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
