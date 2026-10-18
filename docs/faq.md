# 常见问题（FAQ）

## 1. Codex 额度耗尽时工作流会怎样？如何回退到 Claude？

- Codex CLI 是评审者（reviewer），只在需要评审的模式中调用：`balanced`、`thorough`，或 `fast` 加 `--review`。
- Codex 返回 `rate_limit`（额度/用量上限、429）、`unavailable`、`auth` 或 `timeout` 时，若 `roles.reviewer.fallbackBackend` 为 `claude-cli`（默认），本次评审会自动改由已订阅的 Claude CLI 重做：模型为 `roles.reviewer.fallbackModel`（默认 `opus`），使用只读 plan 模式、同一评审提示和同一结果校验。
- 回退会被记录，不是静默替换：写入工作流的 `fallbacks`，阶段标记为 `reviewer:fallback`，并出现在报告（“Reviewer fallbacks”）和通知中。
- 每个工作流最多回退一次。之后的评审（例如修复后的再次评审）仍会先调用 Codex；若 Codex 仍不可用，工作流进入 BLOCKED，状态保留。
- 把 `roles.reviewer.fallbackBackend` 设为 `none` 会关闭回退：Codex 不可用时直接 BLOCKED（fail closed）；Claude CLI 回退本身失败时同样 BLOCKED。
- BLOCKED 时不会丢失进度；修复后端（例如等额度恢复）后运行 `/orchestrate resume <id>` 从原阶段继续。
- `billing` 等错误不会触发回退，最终同样以 BLOCKED 结束；Architect 与 Implementer 角色也没有回退。
- 绝不会回退到付费 API：`fallbackBackend` 只接受 `claude-cli` 或 `none`；配置示例见 `examples/config.yaml`。

## 2. 修复循环最多几轮？耗尽后会怎样？

- 上限由 `orchestrator.maxFixCycles` 控制，默认 3 轮，可设为 0–10 的整数；设为 0 表示不修复，首次失败即停止。
- 验证失败、评审 `REQUEST_CHANGES` 和“未产生改动”都走同一条修复路径；每进入一次 `FIXING` 计为一轮。
- 系统按连续相同失败的指纹计数检测“无进展”；一旦判定无进展，流程会提前停止，即使修复轮次尚未用完。
- 首次出现重复失败时，若模式包含 Architect（`balanced`/`thorough`）、尚未升级且仍有剩余轮次，最多只会升级给 Architect 重新规划一次（回到 `PLANNING`，计数清零，不消耗修复轮次）。
- 轮次用完或判定无进展时，工作流进入 BLOCKED，原因为 `repair_exhausted`；只有 `finish()` 才会提交，因此任务分支上不会提交任何内容。
- 诊断信息保留在工作流目录（默认 `~/.dsh/multi-agent-orchestrator/workflows/<id>`）；`/orchestrate resume` 不会重置修复轮次，编排器也从不合并或推送。
