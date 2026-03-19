import { useState, useMemo } from 'react'
import { ApiError, fetchAgents, fetchHumans } from '../api'
import { ORCHESTRATOR_AGENT_ID, errorText } from '../lib/conversationUtils'

export function useAgents() {
  const [agents, setAgents] = useState([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [agentsError, setAgentsError] = useState('')
  const [humans, setHumans] = useState([])

  const orchestratorRuntime = useMemo(() => {
    return agents.find((agent) => agent?.id === ORCHESTRATOR_AGENT_ID) ?? null
  }, [agents])

  const recipientAgents = useMemo(() => {
    return agents.filter((agent) => agent && agent.id && agent.id !== ORCHESTRATOR_AGENT_ID)
  }, [agents])

  const agentById = useMemo(() => {
    const map = Object.create(null)
    for (const agent of agents) {
      if (!agent || typeof agent.id !== 'string' || !agent.id) continue
      map[agent.id] = agent
    }
    return map
  }, [agents])

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

  async function resolveOrchestratorRuntime() {
    if (orchestratorRuntime) return orchestratorRuntime
    try {
      const latestAgents = await fetchAgents()
      setAgents(latestAgents)
      const runtime = latestAgents.find((agent) => agent?.id === ORCHESTRATOR_AGENT_ID) ?? null
      if (runtime) return runtime
      setAgentsError('Orchestrator agent is missing from this workspace.')
      return null
    } catch (error) {
      setAgentsError(errorText(error))
      return null
    }
  }

  function clearAgentsData() {
    setAgents([])
    setHumans([])
    setAgentsError('')
  }

  return {
    agents, setAgents,
    agentsLoading, agentsError, setAgentsError,
    humans, setHumans,
    orchestratorRuntime, recipientAgents, agentById,
    loadAgents, loadHumans, resolveOrchestratorRuntime, clearAgentsData,
  }
}
