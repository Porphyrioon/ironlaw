import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { EvidenceLedger } from './evidence.js'
import { destructiveReason } from './policy.js'
import {
  auditTurn,
  isReadOnlyTool,
  newTurnEvidence,
  repairPrompt,
  resetTurnEvidence,
  type TurnEvidence,
} from './audit.js'

/**
 * IronLaw for DeepSeek Harness.
 *
 * A native Cordis plugin that hangs off the DSH extension points:
 *
 * - `tools/pre-execute` (waterfall): records tool-call intent and, in enforcer
 *   mode, blocks destructive actions before the tool body runs.
 * - `tools/result` (emit): records the tool outcome as durable evidence.
 * - `session/event` (emit): appends every durable session event to the
 *   evidence ledger and tracks per-turn tool evidence.
 * - `agent/turn-stopping` (serial): the completion gate — before an otherwise
 *   completed turn closes, it requires verifiable tool evidence and steers a
 *   repair prompt back into the agent when evidence is missing.
 */
export const name = 'ironlaw'
export const inject = ['tools', 'sessions', 'agents']

export interface IronLawConfig {
  /** 'observe' (default) records only; 'enforcer' also blocks destructive tools. */
  mode?: 'observe' | 'enforcer'
  /** Evidence ledger directory. Defaults to ~/.ironlaw. */
  evidenceRoot?: string
  /** Require tool evidence before a turn may close. Defaults to true. */
  requireEvidence?: boolean
}

function resolveMode(config: IronLawConfig): 'observe' | 'enforcer' {
  if (config.mode === 'enforcer' || config.mode === 'observe') return config.mode
  return process.env.IRONLAW_MODE === 'enforcer' ? 'enforcer' : 'observe'
}

function sessionIdOf(agent: { session?: { id?: unknown } } | undefined): string {
  const id = agent?.session?.id
  return typeof id === 'string' ? id : 'unknown'
}

export function apply(ctx: Context, config: IronLawConfig = {}): void {
  const mode = resolveMode(config)
  const requireEvidence = config.requireEvidence ?? true
  const ledger = new EvidenceLedger(config.evidenceRoot)
  const evidenceBySession = new Map<string, TurnEvidence>()

  const tracker = (sessionId: string): TurnEvidence => {
    let evidence = evidenceBySession.get(sessionId)
    if (!evidence) {
      evidence = newTurnEvidence()
      evidenceBySession.set(sessionId, evidence)
    }
    return evidence
  }

  // 1) Pre-tool: record intent. Blocking is a monotonic guard, not this
  //    short-circuitable waterfall (an earlier listener returning allow would
  //    otherwise bypass IronLaw entirely).
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = sessionIdOf(exec.agent)
    ledger.record(sessionId, 'tool.execute.before', { name: exec.name, arguments: exec.arguments })
    return next()
  })

  if (mode === 'enforcer') {
    ctx.tools.guard(exec => {
      const reason = destructiveReason(exec.name, exec.arguments)
      if (reason) {
        ledger.record(sessionIdOf(exec.agent), 'policy.deny', { name: exec.name, reason })
      }
      return reason
    })
  }

  // 2) Tool result: record the outcome as durable evidence.
  ctx.on('tools/result', (exec, result) => {
    const sessionId = sessionIdOf(exec.agent)
    ledger.record(sessionId, 'tool.execute.after', { name: exec.name, isError: result.isError })
  })

  // 3) Durable session events: append to the ledger and track turn evidence.
  ctx.on('session/event', (session, event) => {
    // assistant/chunk is a high-frequency token stream; assistant/message
    // already summarizes it, so don't synchronously append every chunk.
    if (event.type !== 'assistant/chunk') {
      ledger.record(session.id, `session.${event.type}`, { seq: event.seq, data: event.data })
    }

    const evidence = tracker(session.id)
    if (event.type === 'turn/start') {
      resetTurnEvidence(evidence)
    } else if (event.type === 'tool/call') {
      evidence.toolCalls += 1
      const data = event.data as { name?: string }
      if (typeof data.name === 'string' && !isReadOnlyTool(data.name)) {
        evidence.verificationCalls += 1
      }
    } else if (event.type === 'tool/result') {
      evidence.toolResults += 1
      const data = event.data as {
        error?: { name: string; code: string }
        message?: { content?: Array<{ isError?: boolean }> }
      }
      const infraError = Boolean(data.error)
      const toolError = Boolean(data.message?.content?.[0]?.isError)
      if (infraError || toolError) evidence.toolErrors += 1
    }
  })

  // 4) Completion gate: require verifiable evidence before a turn closes.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : 'unknown'
    const evidence = evidenceBySession.get(sessionId)
    if (!evidence) return

    const verdict = auditTurn(evidence, requireEvidence)
    if (verdict === 'repair') {
      evidence.repairCount += 1
      ledger.record(sessionId, 'completion.repair', { ...evidence })
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: repairPrompt(evidence) }],
        source: { kind: 'user' },
      }
      agent.steer(message as Parameters<typeof agent.steer>[0])
    } else if (verdict === 'failed') {
      ledger.record(sessionId, 'completion.failed_unverified', { ...evidence })
    } else {
      ledger.record(sessionId, 'completion.verified', { ...evidence })
    }
  })
}
