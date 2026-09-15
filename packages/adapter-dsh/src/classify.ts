import { accessSync, constants, existsSync, statSync } from 'node:fs'

/**
 * Host-side task classification. The type selects which default acceptance
 * evidence template applies (spec §4); it never relaxes a `hard` constraint and
 * never trusts a model's self-declared type. Classification reads only the human
 * request, so a code task cannot reclassify itself as `discussion` to skip
 * verification. When the request is ambiguous or unmatched the result is `code`
 * (the strictest template), failing closed.
 */
export type TaskType = 'discussion' | 'research' | 'docs' | 'code' | 'ops'
export const TASK_TYPES: readonly TaskType[] = ['discussion', 'research', 'docs', 'code', 'ops']

/** Defect / code-change signals: pulling these to `code` first is what stops a bypass. */
const CODE_STRONG = /(bug|报错|错误|异常|崩溃|crash|\berror\b|exception|失败|测试|单测|单元测试|\btest\b|重构|refactor|编译|compile|构建|\bbuild\b|实现|implement|性能|perf|依赖|dependenc|代码|\bcode\b|源码|源文件|脚本|script|算法|algorithm|正则|regex)/i
/** Operation entry points. */
const OPS = /(部署|发布|上线|重启|回滚|运维|deploy|release|publish|restart|rollback|rollout|go-?live)/i
/** Documentation artifacts. A concrete artifact marker outranks a generic verb, so "改 README" is docs. */
const DOC = /(readme|文档|说明书|手册|changelog|规格|\bspec\b|\bdocs?\b|注释|docstring|写一份|写一篇|撰写|document)/i
/** Research / retrieval intent. */
const RESEARCH = /(调研|研究|查一下|查阅|查找|检索|搜一下|资料|综述|survey|research|investigate|look\s?up|评测|对比选型|选型)/i
/** Pure-question / discussion intent. */
const DISCUSSION = /(为什么|为何|怎么看|如何看待|你觉得|是否应该|要不要|解释|讨论|谈谈|聊聊|是什么意思|含义|\bwhy\b|what do you think|should we|explain|discuss|opinion)/i
/** Generic change verbs. Weaker than an artifact marker, so they do not pull a docs object into code. */
const CODE_VERB = /(改|修|修复|修改|新增|添加|删|移除|去掉|调整|优化|重写|change|modif|\bfix\b|update|\badd\b|remove|adjust|optimiz|rewrite)/i

export function isTaskType(v: unknown): v is TaskType {
  return typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v)
}

/**
 * Classify a human request into a task type. Precedence is strictest-first so an
 * ambiguous request never lands on a weaker template:
 * code(defect) > pure discussion > ops > docs > research > code(generic verb) > code(default).
 */
export function classifyTaskType(text: unknown): TaskType {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return 'code'
  if (CODE_STRONG.test(t)) return 'code'
  if (DISCUSSION.test(t) && !CODE_VERB.test(t) && !OPS.test(t) && !DOC.test(t) && !RESEARCH.test(t)) return 'discussion'
  if (OPS.test(t)) return 'ops'
  if (DOC.test(t)) return 'docs'
  if (RESEARCH.test(t)) return 'research'
  if (CODE_VERB.test(t)) return 'code'
  return 'code'
}

/**
 * Host-observed readability: a *regular file* that really exists and can be opened for
 * reading. A directory is readable and "exists", but it is not an artifact: reading one
 * throws EISDIR, and a single directory in the object scope used to collapse the whole
 * object digest to an empty string, which made every acceptance item stale forever.
 */
export function hostReadable(path: unknown): boolean {
  if (typeof path !== 'string' || !path.trim()) return false
  try {
    if (!existsSync(path)) return false
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.R_OK)
    return true
  } catch { return false }
}
