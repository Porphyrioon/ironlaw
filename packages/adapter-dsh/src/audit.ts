/**
 * Completion audit: a turn may only close when it produced verifiable tool
 * execution evidence — a non-read-only tool that ran without error — rather
 * than a model's own "done" claim or a passive read. A bounded repair loop
 * prevents an agent that keeps failing from turning forever.
 */

const READ_ONLY_TOOL_PATTERNS: RegExp[] = [
  /^(fs_read|read_file|read|glob|grep|search|list|find|get|ls|cat|head|tail|status|doctor|inspect|query)/,
]

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_PATTERNS.some(pattern => pattern.test(name))
}

export interface TurnEvidence {
  toolCalls: number
  toolResults: number
  toolErrors: number
  /** Non-read-only tool calls in the turn (candidates for real verification). */
  verificationCalls: number
  /** Number of repair prompts already steered this turn. */
  repairCount: number
}

export type AuditVerdict = 'verified' | 'repair' | 'failed'

/** Stop steering repair prompts after this many, and let the turn end unverified. */
export const MAX_REPAIRS = 3

export function newTurnEvidence(): TurnEvidence {
  return { toolCalls: 0, toolResults: 0, toolErrors: 0, verificationCalls: 0, repairCount: 0 }
}

export function resetTurnEvidence(evidence: TurnEvidence): void {
  evidence.toolCalls = 0
  evidence.toolResults = 0
  evidence.toolErrors = 0
  evidence.verificationCalls = 0
  evidence.repairCount = 0
}

export function auditTurn(evidence: TurnEvidence, requireEvidence: boolean): AuditVerdict {
  if (!requireEvidence) return 'verified'
  // Require a non-read-only tool call that completed without error. A passive
  // read (glob/grep/read_file) alone must not satisfy the gate.
  if (evidence.verificationCalls > 0 && evidence.toolErrors === 0) return 'verified'
  if (evidence.repairCount >= MAX_REPAIRS) return 'failed'
  return 'repair'
}

export function repairPrompt(evidence: TurnEvidence): string {
  return (
    '[IRONLAW:dsh] 当前不能结束任务：本轮缺少可验证的工具执行证据'
    + ` (tool_calls=${evidence.toolCalls}, tool_results=${evidence.toolResults}, tool_errors=${evidence.toolErrors}, verification_calls=${evidence.verificationCalls}).`
    + ' 请运行真实的验证命令或测试并报告结果，不要把自报结论当作完成。'
  )
}
