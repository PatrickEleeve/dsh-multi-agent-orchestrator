/**
 * Plain-language blocker explanations. Every BLOCKED state maps to what
 * happened, in the user's terms, plus one concrete next step. Internal kinds
 * stay in the record; this is only what a person reads.
 */

const EXPLAIN = {
  awaiting_approval: { what: '评审已通过，等你批准提交。', next: '点聊天里的批准卡片，或说"批准"。' },
  no_verification: { what: '没有可运行的验证命令（也没能从 package.json 推断出来），无法证明改动可用。', next: '说"继续，用 npm test 验证"，或 /orchestrate resume --verify "<命令>"。' },
  verification_required: { what: '验证没有通过，不能交付。', next: '查看失败输出后 /orchestrate resume；或调整任务重新开始。' },
  review_required: { what: '评审没有批准，不能交付。', next: '看评审意见后 /orchestrate resume，或取消。' },
  repair_exhausted: { what: '修了几轮仍未通过验证或评审，已停止以免空转。', next: '看最后一轮的问题；放宽任务或提高 maxFixCycles 后重新开始。' },
  rate_limit: { what: '某个模型的订阅额度用完了（没有切换到付费 API）。', next: '等额度恢复后 /orchestrate resume。' },
  auth: { what: '某个 CLI 没有登录或登录失效。', next: '在终端里重新登录（claude / codex），然后 /orchestrate resume。' },
  billing: { what: '检测到会走付费 API 的配置，已拒绝执行。', next: '改回订阅登录后 /orchestrate resume。' },
  unavailable: { what: '某个后端程序没找到或无法启动。', next: '确认 claude / codex 已安装，/orchestrate test-connections 检查后 resume。' },
  timeout: { what: '某个阶段运行超时。', next: '/orchestrate resume 重试，或把任务拆小。' },
  backend_failed: { what: '后端多次运行失败。', next: '/orchestrate status 查看错误详情后 resume。' },
  isolation_violation: { what: '运行期间原仓库被改动了（可能是你或其他工具），为保证"审的就是交付的"已停下。', next: '确认仓库改动无误后 /orchestrate resume（会以当前状态为新基线）。' },
  tree_changed: { what: '评审之后代码又变了，已拒绝提交未经评审的内容。', next: '/orchestrate resume 重新评审。' },
  instruction_file_modified: { what: '实现者改了会影响其他模型的指令文件（CLAUDE.md / AGENTS.md 等），已拦下。', next: '检查这些文件后取消或重新开始。' },
  path_violation: { what: '改动超出了允许修改的路径范围。', next: '放宽 security.allowedPaths 或调整任务后重新开始。' },
  no_changes: { what: '实现者没有改动任何文件。', next: '把任务描述写得更具体后重新开始。' },
  invalid_review: { what: '评审输出格式不合法，无法判断结论。', next: '/orchestrate resume 重新评审。' },
  crash_recovery: { what: 'DSH 重启时这个工作流还在运行，已暂停在原阶段。', next: '/orchestrate resume 从原阶段继续。' },
}

/** @param {{kind?:string, message?:string}|null|undefined} blocker */
export function explainBlocker(blocker) {
  if (!blocker) return null
  const entry = (typeof blocker.kind === 'string' && Object.hasOwn(EXPLAIN, blocker.kind) ? EXPLAIN[blocker.kind] : undefined) ?? { what: blocker.message ?? '工作流已暂停。', next: '/orchestrate status 查看详情。' }
  return { what: entry.what, next: entry.next, kind: blocker.kind ?? 'unknown' }
}

/**
 * Intent is a guess, so it is three-way: 'review' and 'change' only when the
 * wording is unambiguous, 'ambiguous' otherwise (the caller asks). Wrongly
 * choosing 'change' is the expensive mistake (code gets edited), so any
 * conflict is ambiguous rather than a change.
 */
// No \b around CJK: word boundaries do not exist between Chinese characters.
const REVIEW_WORDS = /(审查|审核|审阅|评审|检查|看看|看一下|找找|有什么问题|有没有问题|code\s*review|\breview\b|\baudit\b)/i
const CHANGE_WORDS = /(修复|修改|实现|添加|新增|重构|改成|改为|改一下|改掉|写一个|加上|加个|加一个|删除|删掉|去掉|优化|更新|升级|替换|迁移|\b(?:fix|implement|add|refactor|write|update|remove|delete|change|rename|migrate|upgrade|improve)\b)/i
// Explicit read-only constraints: "不要修改", "别改", "只审查", "do not fix", "read-only".
const READ_ONLY_WORDS = /(不要|别|不许|不准|无需|不用|勿)\s*(修复|修改|改动|改|动|写|实现)|只(读|看|审查|检查|审)|\b(?:do\s*n[o']t|don't|without|no)\s+(?:fix|chang|modif|edit|touch|writ)|\bread[-\s]?only\b/i

/** @returns {'review'|'change'|'ambiguous'} */
export function classifyIntent(task) {
  const text = String(task ?? '')
  const review = REVIEW_WORDS.test(text)
  const readOnly = READ_ONLY_WORDS.test(text)
  // Strip the negated phrases before looking for change verbs.
  // Global copy: every negated phrase is removed, not just the first one.
  const change = CHANGE_WORDS.test(text.replace(new RegExp(READ_ONLY_WORDS.source, 'gi'), ' '))
  if (readOnly && !change) return 'review'
  if (review && !change) return 'review'
  if (change && !review && !readOnly) return 'change'
  if (!review && !change) return 'change'
  return 'ambiguous'
}

/** Back-compat helper: true only for an unambiguous review request. */
export function looksLikeReview(task) {
  return classifyIntent(task) === 'review'
}
