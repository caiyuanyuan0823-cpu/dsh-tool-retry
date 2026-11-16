# 工具重试策略（Tool retry policy）

给 DSH 补上"工具级重试"这一环。DSH 已经有两层恢复机制：`@deepseek-ai/dsh-llm-retry` 在 `agent/request-error` 上重试**模型请求**，`@deepseek-ai/dsh-tool-call-timeout-policy` 在 `tools/execute` 上为**单次工具调用**装超时闸门；但已装的所有 row 里没有任何一行重试**工具调用本身**。本插件挂在 `tools/execute` 瀑布上补这一层。

## 它做什么

一次工具调用失败后，只有同时满足三个条件才会重试：

1. **工具在白名单内**：精确名（`retryTools`，默认 `web_fetch`、`web_search`）或落在允许的前缀下（`retryToolPrefixes`，默认 `mcp__`，因此所有 MCP 工具默认覆盖）。不匹配的工具永不重试，这是"严格模式"：没有被证明幂等的操作一律不碰。精确名拒绝（`denyTools`）与名字正则拒绝（`denyPattern`）永远优先——MCP 每个 server 都会暴露改状态的工具（`feedback_submit`、`report_issue` 在四个 server 上同名），按名字形状拒绝比逐个列举可靠。
2. **失败被分类为瞬时**：错误码命中 `retryableCodes`（默认含 `TOOL_TIMEOUT`、`ETIMEDOUT`、`ECONNRESET`、`EAI_AGAIN`、`HTTP_429/502/503/504`、`RATE_LIMITED`、`UPSTREAM_UNAVAILABLE`）；码缺失或不在名单里时，默认由 `retryablePattern` 对消息兜底（`fetch failed`、`socket hang up`、`rate limit`、`timed out` 等）。DSH 的 web 工具实际报的是自造的 `WEB_PROVIDER_ERROR`，正是靠这条兜底才判得出"该重试"。
3. **不是决策类失败**：`APPROVAL_REJECTED`、`APPROVAL_CANCELLED`、`TOOL_ABORTED`、`UNKNOWN_TOOL`、`INVALID_ARGUMENTS` 等写死在代码里的黑名单里，即使配进 `retryableCodes` 也不会重试——审批被拒或调用被取消是人的决定，重跑等于替人改主意。

重试间隔是抖动指数退避：`min(initialDelayMs × 2^(n-1), maxDelayMs) × (1 − jitter + 2·jitter·rand)`。调用方 `exec.signal` 一旦 abort，正在等待的退避立刻结束，不再发起下一次。

最终返回**永远是最后一次真实执行的结果**，插件不伪造、不包装错误体；因此模型看到的失败与不装插件时完全一致，只是多试了几次。

## 重试是怎么发起的（重要）

`tools/execute` 瀑布的 `next()` **只能用一次**——DSH 的分发器在第二次调用时直接抛 `next() called multiple times`。所以重试不是"再调一次 next"，而是**重新派发**：用 `ctx.tools.execute()` 提交同一个 call（同 `callId`、同 agent 作用域、同 toolSet），且**不传 `log`**。

这带来三个后果，都是刻意的：

- 重试走完整调用管线，超时策略、guard、审批、post-execute 都对新的一次尝试重新生效；
- `BatchSettlement` 因为拿不到 `log`，不会追加第二份 `tool/call`／`tool/result`，**会话日志里这次调用仍然只有一对事件**，重试对日志是透明的；
- 重试会**再次经过审批**。本机当前审批是关闭的，所以无感；若某环境开了审批弹窗，一次重试可能会再问一次。这是"重试不绕过策略"的代价。

## 审计账本

重试对会话日志透明，所以插件自己记账：每次重试与最终结局各写一行 JSONL，默认落在 `<用户主目录>/.dsh/tool-retry-audit.jsonl`。

写账本遵循"永不抛出"原则：目录建不出来、盘满、路径非法都只记一条 warn，不影响工具调用本身。`audit: false` 可整体关闭；`diagnostics: true` 会额外记录每次受覆盖调用的分类结论（`verdict`），用于确认监听确实接上了。

## 配置

改 `cordis.patch.yml` 里 `tool-retry-policy` 这一行的 `config`，省略的键用默认值：

| 键 | 默认 | 含义 |
|---|---|---|
| `maxAttempts` | `3` | 单次工具调用的总尝试次数（含首次）。设 `1` 等于关闭重试。 |
| `initialDelayMs` | `400` | 第二次尝试前的等待，逐次翻倍。 |
| `maxDelayMs` | `20000` | 单次退避上限。 |
| `jitterRatio` | `0.2` | 抖动比例，0.2 表示每个延迟上下浮动 20%。 |
| `retryTools` | `["web_fetch","web_search"]` | 精确名白名单。 |
| `retryToolPrefixes` | `["mcp__"]` | 前缀白名单；默认覆盖全部 MCP 工具，空数组则只认精确名。 |
| `denyTools` | 见源码 | 精确名拒绝，优先于白名单。 |
| `denyPattern` | 见源码 | 名字正则拒绝（`feedback_submit`/`report_issue`/`deepin_shell`/`deepin_hermes_oneshot`/`deepin_cron_action`/`tavily_research`/`schedule_*`/`send_message`），优先于白名单。 |
| `retryableCodes` | 见源码 | 视为瞬时的错误码。 |
| `retryablePattern` | 见源码 | 错误消息兜底正则（不区分大小写）；设空串关闭兜底。 |
| `unknownCodeFallsBackToMessage` | `true` | 未知错误码是否交给消息兜底判定；设 `false` 则未知码一律不重试。 |
| `audit` | `true` | 是否写审计账本。 |
| `diagnostics` | `false` | 额外记录每次受覆盖调用的分类结论。 |
| `auditFile` | 空 | 账本路径；空表示默认位置。 |

## 已知边界

- 只在**错误结果**上工作：工具返回成功但内容里写着失败（例如某些 CLI 把异常写进 stdout）不会触发重试。
- 白名单之外的工具不重试，这是刻意的保守选择；要覆盖更多工具，请先确认它的重复执行没有副作用，再改 `retryTools`。
- 重试期间的**审批会再走一遍**（见上节）；如果你要求"重试不重新审批"，本插件不满足，需要改动 DSH 核心的分发器而不是插件。
- 被重试的那次尝试如果 defer 了额外上下文，最终只保留最后一次结果携带的上下文。
- 单次尝试的超时仍由 `timeout-policy` 与工具自身的 `timeoutMs` 决定；重试会让一次调用的**总**耗时上限变成 `maxAttempts × 单次超时 + 退避总和`。
- 账本是本地追加文件，没有轮转与容量上限；高频失败场景请自行监控体积。
- 本包以 `link:` 方式安装时，`@deepseek-ai/schemastery` 需要能解析：本机是用 `D:\agent-research\dsh-plugin\node_modules` 的 junction 指向 profile 的 `node_modules` 解决的；换成打包安装则是一个普通依赖。
