/**
 * Client half of the Orchestrator bundle.
 *
 * A sidebar entry plus a main panel. Everything it shows comes from the Host
 * `/orchestrate-api` routes; nothing is inferred in the browser. Styling uses
 * only the tokens the Harness theme exposes (`cordis_inspect_query Theme`),
 * so the panel follows the active DSH theme in light and dark.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-multi-agent-orchestrator',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const ID = 'multi-agent-orchestrator'
    const NS = 'plugin.multi-agent-orchestrator'
    const ROUTE = '/orchestrate-api'
    const POLL_MS = 3000

    /** [zh, en] pairs — one source keeps both dictionaries key-identical. */
    const STRINGS = {
      'panel.title': ['多模型编排器', 'Multi-Agent Orchestrator'],
      'panel.subtitle': ['工作流、验证与评审', 'Workflows, verification and review'],
      'common.refresh': ['刷新', 'Refresh'],
      'common.loading': ['加载中…', 'Loading…'],
      'common.empty': ['还没有工作流', 'No workflows yet'],
      'common.emptyHint': ['在聊天里说“用编排器做一个 X”，或运行 /orchestrate <任务>。', 'Ask in chat to orchestrate a task, or run /orchestrate <task>.'],
      'common.networkError': ['无法连接编排器服务', 'Cannot reach the orchestrator service'],
      'common.none': ['—', '—'],
      'common.copy': ['复制', 'Copy'],
      'common.copied': ['已复制', 'Copied'],
      'common.pick': ['从左侧选择一个工作流', 'Select a workflow on the left'],
      'list.title': ['工作流', 'Workflows'],
      'list.running': ['进行中', 'running'],
      'list.blocked': ['阻塞', 'blocked'],
      'list.done': ['完成', 'done'],
      'state.CREATED': ['已创建', 'Created'],
      'state.PLANNING': ['规划', 'Planning'],
      'state.IMPLEMENTING': ['实现', 'Implementing'],
      'state.VERIFYING': ['验证', 'Verifying'],
      'state.REVIEWING': ['评审', 'Reviewing'],
      'state.FIXING': ['修复', 'Fixing'],
      'state.COMPLETED': ['已完成', 'Completed'],
      'state.BLOCKED': ['已阻塞', 'Blocked'],
      'state.FAILED': ['失败', 'Failed'],
      'state.CANCELLED': ['已取消', 'Cancelled'],
      'list.workflows': ['工作流', 'Workflows'],
      'summary.duration': ['耗时', 'Duration'],
      'summary.verification': ['验证', 'Verification'],
      'summary.review': ['评审', 'Review'],
      'summary.fix': ['修复', 'Fix cycles'],
      'summary.passed': ['{pass}/{total} 通过', '{pass}/{total} passed'],
      'detail.unverified': ['未验证', 'unverified'],
      'verify.pass': ['通过', 'PASS'],
      'verify.fail': ['失败', 'FAIL'],
      'usage.input': ['输入 token', 'Input tokens'],
      'usage.output': ['输出 token', 'Output tokens'],
      'usage.reasoning': ['推理 token', 'Reasoning tokens'],
      'usage.notReported': ['未回报', 'not reported'],
      'action.cancelConfirm': ['确认取消？', 'Cancel anyway?'],
      'section.usage': ['用量与成本', 'Usage & cost'],
      'section.timeline': ['状态迁移', 'Timeline'],
      'disclosure.open': ['展开', 'Expand'],
      'disclosure.close': ['收起', 'Collapse'],
      'callout.awaiting': ['评审已通过，等待你批准后才会提交任务分支。', 'Review approved. Nothing is committed until you approve.'],
      'callout.blocked': ['工作流被阻塞。', 'The workflow is blocked.'],
      'meta.loop': ['修复循环 ×{n}', 'repair loop ×{n}'],
      'meta.idCopy': ['复制工作流 ID', 'Copy workflow ID'],
      'notes.tokensLine': ['Token 用量仅显示后端真实回报；空值表示未回报。', 'Token usage shows only what backends report; blanks stay blank.'],
      'notes.costLine': ['付费 API 费用与订阅名义值分列，名义值不是实际扣费。', 'Paid API cost and subscription notional value are listed separately; the notional value is not a charge.'],
      'flow.title': ['阶段流程', 'Stage flow'],
      'flow.legend': ['颜色表示状态；同一阶段重复出现即修复循环。', 'Colour shows state; a repeated stage means a repair loop.'],
      'cards.duration': ['总耗时', 'Duration'],
      'cards.fix': ['修复循环', 'Fix cycles'],
      'cards.reviewRounds': ['评审轮次', 'Review rounds'],
      'cards.verification': ['验证通过率', 'Verification'],
      'cards.paid': ['付费 API', 'Paid API'],
      'cards.subscription': ['订阅名义值', 'Subscription notional'],
      'section.verification': ['验证结果', 'Verification results'],
      'section.review': ['独立评审', 'Independent review'],
      'section.findings': ['评审问题', 'Findings'],
      'section.stages': ['执行记录', 'Stage runs'],
      'section.delivery': ['交付', 'Delivery'],
      'section.transitions': ['状态迁移', 'Transitions'],
      'section.policy': ['策略事件', 'Policy events'],
      'section.notes': ['说明', 'Notes'],
      'detail.notRun': ['未运行', 'not run'],
      'detail.noFindings': ['无', 'None'],
      'detail.blocker': ['阻塞原因', 'Blocker'],
      'detail.backend': ['后端', 'Backend'],
      'detail.model': ['模型', 'Model'],
      'detail.modelUnknown': ['未回报', 'not reported'],
      'detail.duration': ['耗时', 'Duration'],
      'detail.tests': ['测试', 'tests'],
      'delivery.branch': ['分支', 'Branch'],
      'delivery.commit': ['提交', 'Commit'],
      'delivery.files': ['改动文件', 'Files'],
      'delivery.worktree': ['工作树', 'Worktree'],
      'delivery.notMerged': ['未合并、未推送', 'not merged or pushed'],
      'notes.tokens': ['Token 用量（仅报告后端真实回报，缺失即为空）', 'Token usage (only what backends really report; blanks stay blank)'],
      'notes.cost': ['订阅用量按名义列表价单列，绝不等于实际扣费。', 'Subscription usage is listed at notional list price — never a real charge.'],
      'action.approve': ['批准', 'Approve'],
      'action.reject': ['拒绝', 'Reject'],
      'action.cancel': ['取消', 'Cancel'],
      'action.working': ['处理中…', 'Working…'],
      'action.failed': ['操作失败', 'Action failed'],
      'badge.awaiting': ['等待你批准', 'Awaiting your approval'],
      'severity.critical': ['严重', 'Critical'],
      'severity.high': ['高', 'High'],
      'severity.medium': ['中', 'Medium'],
      'severity.low': ['低', 'Low'],
      'severity.info': ['提示', 'Info'],
      'time.seconds': ['{n} 秒', '{n}s'],
      'time.minutes': ['{n} 分', '{n}m'],
      'time.hours': ['{n} 时', '{n}h'],
      'aria.list': ['工作流列表', 'Workflow list'],
    }

    const DICTIONARIES = (() => {
      const zh = {}
      const en = {}
      for (const [key, pair] of Object.entries(STRINGS)) {
        zh[key] = pair[0]
        en[key] = pair[1]
      }
      return { zh, en }
    })()

    /* ------------------------------------------------------------------ *
     * Pure helpers (no DOM, no state)
     * ------------------------------------------------------------------ */

    const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

    function formatDuration(fromIso, toIso, tr) {
      const from = Date.parse(fromIso)
      if (!Number.isFinite(from)) return tr('common.none')
      const seconds = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - from) / 1000))
      if (seconds < 60) return tr('time.seconds', { n: seconds })
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return tr('time.minutes', { n: minutes })
      return tr('time.hours', { n: Math.round((minutes / 60) * 10) / 10 })
    }

    /** The real visited path, with repeat counts (a repeat is a repair loop). */
    function stagePath(history) {
      const nodes = []
      for (const entry of history ?? []) {
        const last = nodes[nodes.length - 1]
        if (last && last.state === entry.to) {
          last.count += 1
        } else {
          nodes.push({ state: entry.to, count: 1, at: entry.at })
        }
      }
      return nodes
    }

    /** Canonical pipeline; the panel shows these five steps, never the raw history. */
    const PIPELINE = ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED']

    /**
     * Per-step status for the pipeline track: done | current | failed | pending,
     * derived from the real transition history and stage runs.
     */
    function pipelineSteps(wf) {
      const visited = new Map()
      for (const entry of wf.history ?? []) visited.set(entry.to, (visited.get(entry.to) ?? 0) + 1)
      const terminal = ['BLOCKED', 'FAILED', 'CANCELLED'].includes(wf.state)
      const activeStep = visited.has(wf.state) ? wf.state : null
      let lastVisited = null
      for (const entry of wf.history ?? []) if (PIPELINE.includes(entry.to)) lastVisited = entry.to
      const durations = stageDurations(wf)
      return PIPELINE.map((step) => {
        let status = 'pending'
        if (wf.state === 'COMPLETED') status = 'done'
        else if (terminal) status = step === lastVisited ? 'failed' : visited.has(step) ? 'done' : 'pending'
        else if (step === activeStep) status = 'current'
        else if (visited.has(step)) status = 'done'
        const loops = step === 'VERIFYING' ? Math.max(0, (visited.get('VERIFYING') ?? 0) - 1) : 0
        return { step, status, loops, durationMs: durations[step] ?? null }
      })
    }

    /** Real duration per pipeline step, from the stage runs (verification summed). */
    function stageDurations(wf) {
      const out = {}
      const add = (step, ms) => {
        if (typeof ms === 'number' && ms >= 0) out[step] = (out[step] ?? 0) + ms
      }
      for (const stage of wf.stages ?? []) {
        if (String(stage.role).startsWith('architect')) add('PLANNING', stage.durationMs)
        else if (String(stage.role).startsWith('implementer')) add('IMPLEMENTING', stage.durationMs)
        else if (String(stage.role).startsWith('reviewer')) add('REVIEWING', stage.durationMs)
      }
      for (const result of wf.verificationResults ?? []) add('VERIFYING', result.durationMs)
      return out
    }

    function formatShortDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      if (ms < 1000) return `${Math.round(ms)}ms`
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
    }

    function verificationCounts(wf) {
      const results = wf.verificationResults ?? []
      return { pass: results.filter((result) => result.passed).length, total: results.length }
    }

    function listTone(state) {
      if (state === 'COMPLETED') return 'success'
      if (state === 'BLOCKED' || state === 'FAILED') return 'error'
      if (state === 'CANCELLED') return 'idle'
      return 'active'
    }

    function modelLabel(stage, tr) {
      if (!stage.model) return tr('detail.modelUnknown')
      return stage.modelVerified ? stage.model : `${stage.model} · ${tr('detail.unverified')}`
    }

    function severityTone(severity) {
      if (severity === 'critical' || severity === 'high') return 'error'
      if (severity === 'medium') return 'warn'
      return 'idle'
    }

    function testSummaryLabel(summary) {
      if (!summary) return ''
      const parts = []
      if (summary.pass !== undefined) parts.push(`pass ${summary.pass}`)
      if (summary.fail !== undefined) parts.push(`fail ${summary.fail}`)
      return parts.join(' · ')
    }

    /* ---------------------------------------------------------------- api */

    async function requestJson(path, options = {}) {
      const url = new URL(ROUTE + path, location.origin)
      if (options.query) for (const [key, value] of Object.entries(options.query)) if (value != null && value !== '') url.searchParams.set(key, String(value))
      let response
      try {
        response = await fetch(url, {
          method: options.method ?? 'GET',
          credentials: 'same-origin',
          signal: options.signal,
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        throw new Error('network')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok === false) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    /* --------------------------------------------------------------- css */

    /**
     * DSH-native styling: 4/8/12/16/24 spacing, 11/12/13/15 type scale,
     * 0.5px hairline dividers instead of boxed cards, tinted state fills via
     * color-mix on theme tokens. No hardcoded colours.
     */
    const CSS = `
.orch-root { box-sizing: border-box; display: flex; container-type: inline-size; height: 100%; min-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); font-size: 13px; line-height: 20px; }
.orch-listCol { display: flex; flex-direction: column; width: 264px; flex: none; min-height: 0;
  background: var(--dsw-specific-sidebar-fill); border-right: 0.5px solid var(--dsw-alias-border-l1); }
.orch-toolbar { display: flex; align-items: center; gap: 8px; height: 32px; flex: none; padding: 0 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.orch-toolbarTitle { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.orch-toolbarCounts { margin-left: auto; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.orch-rows { display: flex; flex-direction: column; min-height: 0; overflow: auto; }
.orch-item { display: flex; flex-direction: column; gap: 2px; width: 100%; min-height: 52px; padding: 8px 12px;
  text-align: left; border: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: transparent;
  color: inherit; font: inherit; cursor: pointer; }
.orch-item:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.orch-item[data-active='true'] { background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.orch-item:focus-visible, .orch-btn:focus-visible, .orch-disclose:focus-visible, .orch-copy:focus-visible, .orch-iconBtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: -1px; }
.orch-itemTop { display: flex; align-items: center; gap: 6px; min-width: 0; }
.orch-itemTask { font-size: 13px; line-height: 18px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.orch-itemMeta { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; }
.orch-itemMeta > span { overflow: hidden; text-overflow: ellipsis; }
.orch-sep { color: var(--dsw-alias-label-caption); }
.orch-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); }
.orch-dot[data-tone='success'] { background: var(--dsw-alias-state-success-primary); }
.orch-dot[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.orch-dot[data-tone='active'] { background: var(--dsw-alias-brand-primary); }
.orch-dot[data-tone='idle'] { background: var(--dsw-alias-state-idle-primary); }
.orch-detailCol { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow: auto; }
.orch-sheet { width: 100%; max-width: 760px; padding: 20px 24px 32px; box-sizing: border-box; }
.orch-titleRow { display: flex; align-items: flex-start; gap: 16px; }
.orch-title { flex: 1; min-width: 0; font-size: 15px; line-height: 22px; font-weight: 600;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.orch-titleActions { display: flex; gap: 8px; flex: none; padding-top: 1px; }
.orch-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary); }
.orch-metaStrong { color: var(--dsw-alias-label-secondary); }
.orch-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.orch-stateTag { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px; border-radius: var(--dsw-radius-xs);
  font-size: 11px; font-weight: 500; }
.orch-stateTag[data-tone='success'] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.orch-stateTag[data-tone='error'] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.orch-stateTag[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.orch-stateTag[data-tone='active'] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.orch-stateTag[data-tone='idle'] { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.orch-btn { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: var(--dsw-radius-sm);
  border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.orch-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--dsw-alias-bg-layer-1)); }
.orch-btn[data-kind='primary'] { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-label-primary-inverted); }
.orch-btn:disabled { opacity: .5; cursor: default; }
.orch-iconBtn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; cursor: pointer; }
.orch-iconBtn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-primary); }
.orch-callout { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 8px 12px;
  border-radius: var(--dsw-radius-lg); font-size: 12px; line-height: 18px; }
.orch-callout[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.orch-callout[data-tone='error'] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.orch-calloutText { flex: 1; min-width: 0; }
.orch-pipeline { display: flex; align-items: stretch; margin-top: 16px; padding: 10px 12px;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); }
.orch-step { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.orch-stepHead { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.orch-glyph { font-size: 11px; line-height: 16px; }
.orch-stepLabel { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.orch-step[data-status='done'] .orch-glyph { color: var(--dsw-alias-state-success-primary); }
.orch-step[data-status='current'] .orch-glyph { color: var(--dsw-alias-brand-primary); }
.orch-step[data-status='failed'] .orch-glyph { color: var(--dsw-alias-state-error-primary); }
.orch-step[data-status='pending'] .orch-glyph { color: var(--dsw-alias-state-idle-primary); }
.orch-step[data-status='current'] .orch-stepLabel { color: var(--dsw-alias-label-primary); font-weight: 500; }
.orch-stepDur { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; min-height: 16px; }
.orch-loopBadge { font-size: 10px; line-height: 16px; color: var(--dsw-alias-state-warn-primary); }
.orch-connector { flex: 1; min-width: 12px; height: 16px; display: flex; align-items: center; }
.orch-connector::before { content: ''; display: block; width: 100%; border-top: 1px solid var(--dsw-alias-border-l2); }
.orch-pulse { animation: orch-pulse 1.7s ease-in-out infinite; }
@keyframes orch-pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .orch-pulse { animation: none; } }
.orch-summary { display: flex; align-items: stretch; margin-top: 16px; }
.orch-summaryItem { flex: 1 1 0; min-width: 0; padding: 0 12px; }
.orch-summaryItem:first-child { padding-left: 0; }
.orch-summaryItem:not(:first-child) { border-left: 0.5px solid var(--dsw-alias-border-l1); }
.orch-summaryLabel { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.orch-summaryValue { font-size: 15px; line-height: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.orch-summaryHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.orch-section { margin-top: 24px; }
.orch-secH { margin: 0; font: inherit; }
.orch-disclose { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px; padding: 4px 8px;
  border: 0; border-top: 0.5px solid var(--dsw-alias-border-l1); border-radius: 0; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; text-align: left; cursor: pointer; }
.orch-disclose:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.orch-discloseCaret { width: 10px; flex: none; color: var(--dsw-alias-label-tertiary); }
.orch-discloseTitle { font-weight: 500; color: var(--dsw-alias-label-secondary); }
.orch-discloseNote { margin-left: auto; color: var(--dsw-alias-label-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.orch-discloseBody { padding: 8px 8px 4px 24px; }
.orch-finding { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0 4px 8px; border-left: 2px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; }
.orch-finding[data-severity='critical'], .orch-finding[data-severity='high'] { border-left-color: var(--dsw-alias-state-error-primary); }
.orch-finding[data-severity='medium'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.orch-finding[data-severity='low'], .orch-finding[data-severity='info'] { border-left-color: var(--dsw-alias-brand-primary); }
.orch-severity { flex: none; font-size: 11px; line-height: 18px; font-weight: 500; }
.orch-severity[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.orch-severity[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.orch-severity[data-tone='idle'] { color: var(--dsw-alias-label-tertiary); }
.orch-findingText { flex: 1; min-width: 0; }
.orch-findingWhere { flex: none; font-family: var(--dsw-font-mono); font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.orch-grid { display: grid; grid-template-columns: minmax(96px, 1.1fr) 88px minmax(80px, 1fr) 64px 56px; gap: 4px 8px; align-items: center; font-size: 12px; line-height: 18px; }
.orch-gridHeadText { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.orch-gridCellFirst { padding-top: 4px; }
.orch-grid > .orch-gridCell { padding-top: 4px; padding-bottom: 4px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.orch-gridCell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orch-bar { height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.orch-barFill { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.orch-num { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.orch-mono { font-family: var(--dsw-font-mono); font-size: 11px; }
.orch-kv { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 4px 12px; font-size: 12px; line-height: 18px; }
.orch-kv dt { color: var(--dsw-alias-label-tertiary); }
.orch-kv dd { margin: 0; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; overflow-wrap: anywhere; }
.orch-copy { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: var(--dsw-radius-xs);
  border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 10px; line-height: 16px; cursor: pointer; }
.orch-copy:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-primary); }
.orch-transition { display: flex; gap: 8px; padding: 2px 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.orch-transition time { flex: none; font-family: var(--dsw-font-mono); color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.orch-note { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); margin-top: 4px; }
@container (max-width: 640px) { .orch-root { flex-direction: column; } .orch-listCol { width: auto; max-height: 42%; border-right: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); } .orch-sheet { padding: 16px 16px 24px; } }
.orch-empty { padding: 32px 24px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.orch-empty b { display: block; margin-bottom: 4px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.orch-error { margin: 8px 12px; padding: 6px 8px; border-radius: var(--dsw-radius-sm); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
`

    /* ------------------------------------------------------------ widgets */

    function Disclosure({ title, note, open, onToggle, children }) {
      return h(
        'div',
        null,
        h(
          'h3',
          { className: 'orch-secH' },
          h(
          'button',
          { type: 'button', className: 'orch-disclose', 'aria-expanded': open ? 'true' : 'false', onClick: onToggle },
          h('span', { className: 'orch-discloseCaret' }, open ? '▾' : '▸'),
          h('span', { className: 'orch-discloseTitle' }, title),
          note ? h('span', { className: 'orch-discloseNote' }, note) : null,
          ),
        ),
        open ? h('div', { className: 'orch-discloseBody' }, children) : null,
      )
    }

    function Pipeline({ steps, tr }) {
      const glyph = { done: '●', current: '◉', failed: '✕', pending: '○' }
      const items = []
      steps.forEach((step, index) => {
        if (index > 0) items.push(h('span', { key: `conn-${index}`, className: 'orch-connector' }))
        items.push(
          h(
            'div',
            { key: `step-${step.step}`, className: 'orch-step', 'data-status': step.status },
            h(
              'span',
              { className: 'orch-stepHead' },
              h('span', { className: `orch-glyph${step.status === 'current' ? ' orch-pulse' : ''}`, 'aria-hidden': 'true' }, glyph[step.status] ?? '○'),
              h('span', { className: 'orch-stepLabel' }, tr(`state.${step.step}`)),
              step.loops > 0 ? h('span', { className: 'orch-loopBadge', title: tr('meta.loop', { n: step.loops }) }, `↻${step.loops}`) : null,
            ),
            h('span', { className: 'orch-stepDur' }, formatShortDuration(step.durationMs)),
          ),
        )
      })
      return h('div', { className: 'orch-pipeline' }, items)
    }

    /* --------------------------------------------------------------- panel */

    function fallbackTranslate(key, vars) {
      const pair = STRINGS[key]
      const text = pair ? pair[1] : key
      return vars ? text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : String(vars[name]))) : text
    }

    const Row = React.memo(
      function Row({ wf, selected, tr, onSelect }) {
        const tone = listTone(wf.state)
        const counts = wf.verificationCounts ?? { pass: 0, total: 0 }
        const meta = [tr(`state.${wf.state}`), wf.mode, formatShortDuration(Date.parse(wf.finishedAt ?? Date.now()) - Date.parse(wf.createdAt))]
        if (counts.total > 0) meta.push(`${counts.pass}/${counts.total} ✓`)
        if (wf.review) meta.push(wf.review)
        return h(
          'li',
          { style: { display: 'contents' } },
          h(
            'button',
            { type: 'button', className: 'orch-item', 'data-active': selected ? 'true' : 'false', 'aria-current': selected ? 'true' : undefined, onClick: () => onSelect(wf.id) },
            h(
              'span',
              { className: 'orch-itemTop' },
              h('span', { className: 'orch-dot', 'data-tone': tone, 'aria-hidden': 'true' }),
              h('span', { className: 'orch-itemTask' }, wf.task),
            ),
            h('span', { className: 'orch-itemMeta' }, meta.flatMap((part, index) => (index > 0
              ? [h('span', { key: `sep-${index}`, className: 'orch-sep', 'aria-hidden': 'true' }, '·'), h('span', { key: `part-${index}` }, part)]
              : [h('span', { key: `part-${index}` }, part)]))),
          ),
        )
      },
      (a, b) => a.wf === b.wf && a.selected === b.selected && a.tr === b.tr && a.onSelect === b.onSelect,
    )

    function Panel(props) {
      const tr = useMemo(() => (typeof props?.t === 'function' ? props.t : fallbackTranslate), [props?.t])

      const [list, setList] = useState({ phase: 'loading', workflows: [], error: null })
      const listSignature = useRef(null)
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [actionPhase, setActionPhase] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [, setListError] = useState(null)
      const [copied, setCopied] = useState(null)
      const [armedCancel, setArmedCancel] = useState(null)
      const [open, setOpen] = useState({}) // disclosure state per section, seeded per detail
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const loadList = useCallback(async (signal) => {
        try {
          const payload = await requestJson('/workflows', { signal })
          if (!alive.current) return
          const signature = JSON.stringify(payload.workflows.map((wf) => [wf.id, wf.state, wf.updatedAt, wf.awaitingApproval]))
          if (signature === listSignature.current) return
          listSignature.current = signature
          setList({ phase: 'ready', workflows: payload.workflows, error: null })
          setSelected((current) => current ?? (payload.workflows[0] ? payload.workflows[0].id : null))
        } catch (error) {
          if (!alive.current) return
          setList((prev) => ({ ...prev, phase: 'error', error: String(error.message ?? error) }))
        }
      }, [])

      const selectedRef = useRef(null)
      selectedRef.current = selected
      const loadDetail = useCallback(async (id, signal) => {
        if (!id) return
        try {
          const payload = await requestJson('/workflow', { query: { id }, signal })
          // A slow reply for a previously selected workflow must never replace
          // the current one.
          if (!alive.current || selectedRef.current !== id) return
          setDetail(payload.workflow)
        } catch (error) {
          if (!alive.current || error?.name === 'AbortError' || selectedRef.current !== id) return
          if (/unknown workflow/i.test(String(error?.message ?? ''))) {
            // The selected workflow is no longer in the list window: fall back.
            listSignature.current = null
            setSelected(null)
            void loadList()
            return
          }
          setListError(String(error.message ?? error))
        }
      }, [])

      useEffect(() => {
        let stopped = false
        let timer
        let controller
        let delay = POLL_MS
        const tick = async () => {
          if (stopped || document.visibilityState === 'hidden') return
          controller = new AbortController()
          try {
            await loadList(controller.signal)
            delay = POLL_MS
          } catch {
            delay = Math.min(delay * 2, 30000)
          }
          if (!stopped) timer = setTimeout(tick, delay)
        }
        const onVisible = () => {
          if (document.visibilityState === 'hidden') return
          clearTimeout(timer)
          void tick()
        }
        document.addEventListener('visibilitychange', onVisible)
        void tick()
        return () => {
          stopped = true
          clearTimeout(timer)
          controller?.abort()
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [loadList])

      useEffect(() => {
        if (!selected) return
        let stopped = false
        let timer
        let controller
        const tick = async () => {
          if (stopped || document.visibilityState === 'hidden') return
          controller = new AbortController()
          try {
            await loadDetail(selected, controller.signal)
          } catch {
            /* transient; the next tick retries */
          }
          if (!stopped) timer = setTimeout(tick, POLL_MS)
        }
        void tick()
        return () => {
          stopped = true
          clearTimeout(timer)
          controller?.abort()
        }
      }, [selected, loadDetail])

      // Re-seed disclosure defaults when the selected workflow changes.
      useEffect(() => {
        if (!detail) return
        const failed = (detail.verificationResults ?? []).some((result) => !result.passed)
        setOpen((current) => (
          current.__for === detail.id
            ? current
            : { __for: detail.id, verification: failed, delivery: detail.state === 'COMPLETED', stages: false, timeline: false, usage: false, policy: false }
        ))
      }, [detail])

      const toggle = useCallback((key) => setOpen((current) => ({ ...current, [key]: !current[key] })), [])

      const runAction = useCallback(async (action) => {
        if (!selected) return
        setActionPhase(action)
        setActionError(null)
        try {
          const payload = await requestJson('/action', { method: 'POST', body: { id: selected, action } })
          if (!alive.current) return
          setDetail(payload.workflow)
          await loadList()
        } catch (error) {
          if (!alive.current) return
          setActionError(`${tr('action.failed')}: ${String(error.message ?? error)}`)
        } finally {
          if (alive.current) setActionPhase(null)
        }
      }, [selected, loadList, tr])

      const copy = useCallback(async (label, value) => {
        try {
          await navigator.clipboard.writeText(String(value))
          setCopied(label)
          setTimeout(() => alive.current && setCopied(null), 1500)
        } catch {
          /* clipboard can be denied; the value stays visible */
        }
      }, [])

      const workflows = list.workflows
      const running = workflows.filter((wf) => ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING'].includes(wf.state)).length
      const blocked = workflows.filter((wf) => wf.state === 'BLOCKED').length
      const done = workflows.filter((wf) => wf.state === 'COMPLETED').length

      const listColumn = h(
        'div',
        { className: 'orch-listCol' },
        h(
          'div',
          { className: 'orch-toolbar' },
          h('span', { className: 'orch-toolbarTitle' }, tr('list.workflows')),
          h('span', { className: 'orch-toolbarCounts' }, `${running} ${tr('list.running')} · ${blocked} ${tr('list.blocked')} · ${done} ${tr('list.done')}`),
        ),
        list.phase === 'error' ? h('div', { className: 'orch-error' }, `${tr('common.networkError')}: ${list.error}`) : null,
        h(
          'ul',
          { className: 'orch-rows', 'aria-label': tr('list.workflows') },
          workflows.length === 0 && list.phase !== 'loading'
            ? h('div', { className: 'orch-empty' }, h('b', null, tr('common.empty')), tr('common.emptyHint'))
            : null,
          workflows.map((wf) => h(Row, { key: wf.id, wf, selected: wf.id === selected, tr, onSelect: setSelected })),        ),
      )

      function detailSheet() {
        if (!detail) return h('div', { className: 'orch-empty' }, h('b', null, tr('common.pick')), tr('list.workflows'))
        const tone = detail.state === 'COMPLETED' ? 'success' : ['BLOCKED', 'FAILED'].includes(detail.state) ? 'error' : detail.state === 'CANCELLED' ? 'idle' : 'active'
        const steps = pipelineSteps(detail)
        const counts = verificationCounts(detail)
        const findings = detail.findings ?? []
        const awaiting = detail.awaitingApproval === true
        const canCancel = ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING', 'BLOCKED'].includes(detail.state)
        const busy = actionPhase !== null
        const metrics = detail.metrics ?? {}
        const notional = metrics.subscriptionNotionalListCostUSD != null ? `$${Number(metrics.subscriptionNotionalListCostUSD).toFixed(4)}` : tr('common.none')
        const maxDuration = Math.max(1, ...(detail.stages ?? []).map((stage) => stage.durationMs ?? 0))

        const actionButtons = []
        if (awaiting) {
          actionButtons.push(h('button', { key: 'approve', type: 'button', className: 'orch-btn', 'data-kind': 'primary', disabled: busy, onClick: () => void runAction('approve') }, busy && actionPhase === 'approve' ? tr('action.working') : tr('action.approve')))
          actionButtons.push(h('button', { key: 'reject', type: 'button', className: 'orch-btn', disabled: busy, onClick: () => void runAction('reject') }, busy && actionPhase === 'reject' ? tr('action.working') : tr('action.reject')))
        } else if (canCancel) {
          actionButtons.push(h('button', {
            key: 'cancel',
            type: 'button',
            className: 'orch-btn',
            disabled: busy,
            onClick: () => {
              if (armedCancel !== detail.id) {
                setArmedCancel(detail.id)
                return
              }
              setArmedCancel(null)
              void runAction('cancel')
            },
          }, busy && actionPhase === 'cancel' ? tr('action.working') : armedCancel === detail.id ? tr('action.cancelConfirm') : tr('action.cancel')))
        }

        const callout = awaiting
          ? h('div', { className: 'orch-callout', 'data-tone': 'warn' },
              h('span', { className: 'orch-calloutText' }, tr('callout.awaiting')),
              actionButtons)
          : detail.blocker
            ? h('div', { className: 'orch-callout', 'data-tone': 'error' },
                h('span', { className: 'orch-calloutText' }, `${tr('callout.blocked')} ${detail.blocker.kind} — ${detail.blocker.message}`))
            : null

        const summary = h(
          'div',
          { className: 'orch-summary' },
          h('div', { className: 'orch-summaryItem' },
            h('div', { className: 'orch-summaryLabel' }, tr('summary.duration')),
            h('div', { className: 'orch-summaryValue' }, formatShortDuration(Date.parse(detail.finishedAt ?? Date.now()) - Date.parse(detail.createdAt)))),
          h('div', { className: 'orch-summaryItem' },
            h('div', { className: 'orch-summaryLabel' }, tr('summary.verification')),
            h('div', { className: 'orch-summaryValue' }, counts.total === 0 ? tr('detail.notRun') : tr('summary.passed', { pass: counts.pass, total: counts.total }))),
          h('div', { className: 'orch-summaryItem' },
            h('div', { className: 'orch-summaryLabel' }, tr('summary.review')),
            h('div', { className: 'orch-summaryValue' }, detail.review ?? tr('detail.notRun')),
            findings.length ? h('div', { className: 'orch-summaryHint' }, `${findings.length} ${tr('section.findings')}`) : null),
          h('div', { className: 'orch-summaryItem' },
            h('div', { className: 'orch-summaryLabel' }, tr('summary.fix')),
            h('div', { className: 'orch-summaryValue' }, `${detail.fixCycles}/${detail.maxFixCycles ?? '?'}`)),
        )

        const findingsBlock = findings.length
          ? h('div', { className: 'orch-section' },
              h('div', { className: 'orch-disclose', style: { borderTop: '0.5px solid var(--dsw-alias-border-l1)', cursor: 'default' } },
                h('span', { className: 'orch-discloseTitle' }, tr('section.findings')),
                h('span', { className: 'orch-discloseNote' }, String(findings.length))),
              h('div', { className: 'orch-discloseBody' }, findings.map((finding, index) =>
                h('div', { key: `${finding.description}-${index}`, className: 'orch-finding', 'data-severity': finding.severity },
                  h('span', { className: 'orch-severity', 'data-tone': severityTone(finding.severity) }, tr(`severity.${finding.severity}`)),
                  h('span', { className: 'orch-findingText' }, finding.description),
                  h('span', { className: 'orch-findingWhere' }, finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''),
                ))))
          : null

        const verificationBlock = h(Disclosure, {
          title: tr('section.verification'),
          note: counts.total === 0 ? tr('detail.notRun') : tr('summary.passed', { pass: counts.pass, total: counts.total }),
          open: open.verification === true,
          onToggle: () => toggle('verification'),
        }, (detail.verificationResults ?? []).length === 0
          ? h('div', { className: 'orch-note' }, tr('detail.notRun'))
          : h('div', null, detail.verificationResults.map((result, index) =>
              h('div', { key: `${result.name}-${index}`, className: 'orch-finding', 'data-severity': result.passed ? 'info' : 'high' },
                h('span', { className: 'orch-severity', 'data-tone': result.passed ? 'idle' : 'error' }, result.passed ? tr('verify.pass') : tr('verify.fail')),
                h('span', { className: 'orch-findingText orch-mono' }, result.name),
                h('span', { className: 'orch-findingWhere' }, `${testSummaryLabel(result.testSummary) || `exit ${result.exitCode}`} · ${formatShortDuration(result.durationMs)}`),
              ))))

        const stageGrid = (detail.stages ?? []).length === 0
          ? h('div', { className: 'orch-note' }, tr('detail.notRun'))
          : h(
              'div',
              { className: 'orch-grid' },
              h('span', { className: 'orch-gridCell orch-gridHeadText' }, tr('section.stages')),
              h('span', { className: 'orch-gridCell orch-gridHeadText' }, tr('detail.backend')),
              h('span', { className: 'orch-gridCell orch-gridHeadText' }, tr('detail.model')),
              h('span', null, ''),
              h('span', { className: 'orch-gridCell orch-gridHeadText' }, tr('detail.duration')),
              (detail.stages ?? []).flatMap((stage, index) => [
                h('span', { key: `role-${index}`, className: 'orch-gridCell orch-gridCellFirst' }, stage.role),
                h('span', { key: `backend-${index}`, className: 'orch-gridCell orch-mono' }, stage.backend),
                h('span', { key: `model-${index}`, className: 'orch-gridCell orch-mono' }, modelLabel(stage, tr)),
                h('span', { key: `bar-${index}`, className: 'orch-bar' }, h('span', { className: 'orch-barFill', style: { width: `${Math.round(((stage.durationMs ?? 0) / maxDuration) * 100)}%` } })),
                h('span', { key: `dur-${index}`, className: 'orch-gridCell orch-num' }, formatShortDuration(stage.durationMs)),
              ]),
            )

        const deliveryBlock = h(Disclosure, {
          title: tr('section.delivery'),
          note: detail.delivery ? detail.delivery.branch : tr('common.none'),
          open: open.delivery === true,
          onToggle: () => toggle('delivery'),
        }, detail.delivery
          ? h('dl', { className: 'orch-kv' },
              h('dt', null, tr('delivery.branch')),
              h('dd', null, h('span', { className: 'orch-mono' }, detail.delivery.branch), h('button', { type: 'button', className: 'orch-copy', title: tr('delivery.branch'), 'aria-label': `${tr('common.copy')} ${tr('delivery.branch')}`, onClick: () => void copy('branch', detail.delivery.branch) }, copied === 'branch' ? tr('common.copied') : tr('common.copy'))),
              h('dt', null, tr('delivery.commit')),
              h('dd', null, h('span', { className: 'orch-mono' }, String(detail.delivery.commit ?? '').slice(0, 12)), h('button', { type: 'button', className: 'orch-copy', title: tr('delivery.commit'), 'aria-label': `${tr('common.copy')} ${tr('delivery.commit')}`, onClick: () => void copy('commit', detail.delivery.commit) }, copied === 'commit' ? tr('common.copied') : tr('common.copy'))),
              h('dt', null, tr('delivery.files')),
              h('dd', null, (detail.delivery.files ?? []).join(' · ')),
              h('dt', null, tr('delivery.worktree')),
              h('dd', null, h('span', { className: 'orch-mono' }, detail.delivery.worktree), h('button', { type: 'button', className: 'orch-copy', title: tr('delivery.worktree'), 'aria-label': `${tr('common.copy')} ${tr('delivery.worktree')}`, onClick: () => void copy('worktree', detail.delivery.worktree) }, copied === 'worktree' ? tr('common.copied') : tr('common.copy'))),
              h('dt', null, ''),
              h('dd', { className: 'orch-note', style: { marginTop: 0 } }, tr('delivery.notMerged')))
          : h('div', { className: 'orch-note' }, tr('common.none')))

        const timelineBlock = h(Disclosure, {
          title: tr('section.timeline'),
          note: String((detail.history ?? []).length),
          open: open.timeline === true,
          onToggle: () => toggle('timeline'),
        }, (detail.history ?? []).map((entry, index) =>
          h('div', { key: `${entry.at}-${index}`, className: 'orch-transition' },
            h('time', { title: entry.at }, new Date(entry.at).toLocaleTimeString()),
            h('span', null, `${tr(`state.${entry.from}`)} → ${tr(`state.${entry.to}`)}`),
            entry.reason ? h('span', { className: 'orch-note', style: { marginTop: 0, flex: 1 } }, entry.reason) : null,
          )))

        const usageBlock = h(Disclosure, {
          title: tr('section.usage'),
          note: metrics.paidApiCostUSD == null ? tr('usage.notReported') : `$${Number(metrics.paidApiCostUSD).toFixed(2)} · ${notional}`,
          open: open.usage === true,
          onToggle: () => toggle('usage'),
        }, h('dl', { className: 'orch-kv' },
          h('dt', null, tr('usage.input')), h('dd', { className: 'orch-num' }, metrics.inputTokens != null ? String(metrics.inputTokens) : tr('usage.notReported')),
          h('dt', null, tr('usage.output')), h('dd', { className: 'orch-num' }, metrics.outputTokens != null ? String(metrics.outputTokens) : tr('usage.notReported')),
          h('dt', null, tr('usage.reasoning')), h('dd', { className: 'orch-num' }, metrics.reasoningTokens != null ? String(metrics.reasoningTokens) : tr('usage.notReported')),
          h('dt', null, tr('cards.paid')), h('dd', { className: 'orch-num', style: { color: 'var(--dsw-alias-label-primary)' } }, metrics.paidApiCostUSD == null ? tr('usage.notReported') : `$${Number(metrics.paidApiCostUSD).toFixed(2)}`),
          h('dt', null, tr('cards.subscription')), h('dd', { className: 'orch-num' }, notional),
          h('dt', null, ''), h('dd', { className: 'orch-note', style: { marginTop: 0 } }, `${tr('notes.tokensLine')} ${tr('notes.costLine')}`)))

        const policyBlock = (detail.violations ?? []).length
          ? h(Disclosure, {
              title: tr('section.policy'),
              note: String(detail.violations.length),
              open: open.policy === true,
              onToggle: () => toggle('policy'),
            }, detail.violations.map((violation, index) =>
              h('div', { key: `${violation.kind}-${index}`, className: 'orch-finding', 'data-severity': 'medium' },
                h('span', { className: 'orch-severity', 'data-tone': 'warn' }, violation.kind),
                h('span', { className: 'orch-findingText' }, violation.detail))))
          : null

        return h(
          'div',
          { className: 'orch-detailCol' },
          h(
            'div',
            { className: 'orch-sheet' },
            h('div', { className: 'orch-titleRow' },
              h('div', { className: 'orch-title' }, detail.task),
              awaiting ? null : h('div', { className: 'orch-titleActions' }, actionButtons)),
            h('div', { className: 'orch-meta' },
              h('span', { className: 'orch-stateTag', 'data-tone': tone }, h('span', { className: 'orch-dot', style: { background: 'currentColor' } }), tr(`state.${detail.state}`)),
              h('span', { className: 'orch-tag' }, detail.mode),
              h('span', null, formatShortDuration(Date.parse(detail.finishedAt ?? Date.now()) - Date.parse(detail.createdAt))),
              h('span', { className: 'orch-sep' }, '·'),
              h('span', { className: 'orch-mono' }, detail.id),
              h('button', { type: 'button', className: 'orch-iconBtn', title: tr('meta.idCopy'), 'aria-label': tr('meta.idCopy'), onClick: () => void copy('id', detail.id) }, copied === 'id' ? '✓' : '⧉'),
            ),
            callout,
            h(Pipeline, { steps, tr }),
            summary,
            findingsBlock,
            h('div', { className: 'orch-section' }, verificationBlock),
            h('div', { className: 'orch-section' }, h(Disclosure, {
              title: tr('section.stages'),
              note: `${(detail.stages ?? []).length}`,
              open: open.stages === true,
              onToggle: () => toggle('stages'),
            }, stageGrid)),
            h('div', { className: 'orch-section' }, deliveryBlock),
            h('div', { className: 'orch-section' }, timelineBlock),
            h('div', { className: 'orch-section' }, usageBlock),
            policyBlock ? h('div', { className: 'orch-section' }, policyBlock) : null,
            actionError ? h('div', { className: 'orch-error', role: 'alert', style: { margin: '12px 0 0' } }, actionError) : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'orch-root' },
        listColumn,
        detailSheet(),
      )
    }

    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const active = props?.active === true
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block', opacity: active ? 1 : 0.92 } },
        h('g', { stroke: 'currentColor', fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('circle', { cx: 12, cy: 4.6, r: 2.2 }),
          h('circle', { cx: 4.8, cy: 18, r: 2.2 }),
          h('circle', { cx: 19.2, cy: 18, r: 2.2 }),
          h('path', { d: 'M12 6.8 5.9 15.9' }),
          h('path', { d: 'M12 6.8 18.1 15.9' }),
          h('path', { d: 'M7 18h10' }),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'orchestrator: client dictionaries')
      // One stylesheet for the bundle's lifetime; re-diffing it on every render
      // is pure overhead.
      if (typeof document !== 'undefined' && document.head) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'orchestrator: client styles')
      }
      const tr = ctx.locale.bind(NS)
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID, locale: NS }, Panel))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: ID, order: 32, locale: NS, label: () => tr('panel.title') }, PanelIcon),
      )
    }

    return { inject: ['slots', 'locale'], apply, __test: { pipelineSteps, stageDurations, formatShortDuration, verificationCounts } }
  },
})
