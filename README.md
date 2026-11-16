# dsh-tool-retry

[![npm](https://img.shields.io/npm/v/@caiyy0823/dsh-tool-retry)](https://www.npmjs.com/package/@caiyy0823/dsh-tool-retry)
[![license](https://img.shields.io/npm/l/@caiyy0823/dsh-tool-retry)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4b5563)](https://github.com/caiyuanyuan0823-cpu/dsh-tool-retry)

**Tool-call retry policy for DeepSeek Harness.** DSH already retries model requests (`llm-retry`) and enforces per-tool deadlines (`timeout-policy`), but nothing retried a *tool call*. This plugin fills that hole at the `tools/execute` waterfall.

装：

```
plugin_manager → install_bundle → target: @caiyy0823/dsh-tool-retry
```

只重试"被判定为瞬时失败、且操作幂等"的工具调用：抖动指数退避、拒绝清单永远优先、重试对会话日志透明，并写一份永不抛错的 JSONL 审计账本。

## 为什么需要它

一个 agent 的失败大部分不是模型错，是网络错：`fetch failed`、`429`、`socket hang up`、MCP server 抖一下。默认行为是把错误原样交给模型，模型再决定要不要重来——多花一轮 token、多一次往返。而"重试"这件事必须做得极保守：重试一个转账工具就是在重复转账。

所以这里的取舍是：**分类驱动 + 严格白名单**。不是"失败了就再来一次"，而是"只有确认是瞬时故障、且确认这个动作重复执行没副作用，才再来一次"。

## 怎么工作

```
tool call ─▶ tools/execute waterfall
              ├─ 名字在白名单/前缀内？ ──否──▶ 放行（不干预）
              ├─ 结果 isError？ ────────否──▶ 放行
              ├─ 错误分类为瞬时？ ──────否──▶ 放行
              └─ 是 ──▶ 退避 400ms×2^n（±20% 抖动）──▶ 重新派发
```

- 重新派发用 `ctx.tools.execute()` 且**不传 `log`**，因此会话日志里这次调用仍只有一对 `tool/call` / `tool/result`——重试是透明的。
- 退避等待监听调用方的 `AbortSignal`，取消即停。
- 返回的永远是最后一次真实执行结果，不伪造、不包装。

## 安装

在 DSH 里：**Plugins → Add plugin**，或让 agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填包名（发布后）或本地 tarball / 目录路径（开发时）。

```bash
# 打包安装（推荐，依赖会正常安装）
npm pack
# 然后把这个 tgz 的绝对路径交给 install_bundle（开发时），或
npm publish --access public   # 发布后直接 install_bundle target=@caiyy0823/dsh-tool-retry
```

## 配置

写在 profile 的 `cordis.patch.yml` 里 `tool-retry-policy` 这一行的 `config`（Settings 里也能改），省略即默认：

| 键 | 默认 | 作用 |
|---|---|---|
| `maxAttempts` | `3` | 单次调用的总尝试次数（含首次）；`1` = 关闭 |
| `initialDelayMs` | `400` | 首次退避，逐次翻倍 |
| `maxDelayMs` | `20000` | 单次退避上限 |
| `jitterRatio` | `0.2` | 抖动比例 |
| `retryTools` | `["web_fetch","web_search"]` | 精确名白名单 |
| `retryToolPrefixes` | `["mcp__"]` | 前缀白名单，默认覆盖全部 MCP 工具 |
| `denyTools` | 见源码 | 精确名拒绝，优先于白名单 |
| `denyPattern` | 见源码 | 名字正则拒绝（`feedback_submit`/`report_issue`/`deepin_shell`/`tavily_research`…） |
| `retryableCodes` | 见源码 | 视为瞬时的错误码 |
| `retryablePattern` | 见源码 | 错误消息兜底正则 |
| `unknownCodeFallsBackToMessage` | `true` | 未知错误码是否交给消息判定 |
| `audit` | `true` | 是否写账本 |
| `auditFile` | 空 | 账本路径，空 = `<home>/.dsh/tool-retry-audit.jsonl` |
| `diagnostics` | `false` | 额外记录每次受覆盖调用的分类结论 |

## 审计账本

```json
{"event":"retry","tool":"web_fetch","attempt":1,"of":3,"delayMs":427.2,"code":"WEB_PROVIDER_ERROR","sessionId":"session-…","callId":"call_…"}
{"event":"exhausted","tool":"web_fetch","attempts":3,"code":"WEB_PROVIDER_ERROR","sessionId":"session-…","callId":"call_…"}
```

写入永不抛错：目录建不出来、盘满、路径非法都只记一条 warn。

## 已知边界

- 只处理 `isError: true` 的结果；把失败写进成功内容的工具不覆盖。
- 重试会**完整重走一遍调用管线**，包括审批——在开了审批的环境里，一次重试可能再问一次。要"重试不重新审批"得改 DSH 核心分发器。
- 单次调用的总耗时上限变成 `maxAttempts × 单次超时 + 退避总和`。
- 账本无轮转，高频失败场景请自行监控体积。

## 源码级出处

设计不是拍脑袋，逐条对应上游实现：

| 决定 | 依据 |
|---|---|
| 先分类再重试 | Hermes `agent/error_classifier.py:35/1118`、`agent/conversation_loop.py:1577` |
| 严格模式，非幂等不重试 | openclaw `src/infra/retry-policy.ts:104-116` `strictShouldRetry` |
| 抖动指数退避 | Hermes `agent/retry_utils.py:121`；openclaw `retry-policy.ts:8-13` |
| 账本永不抛错 | Hermes `cron/scheduler.py` `_write_usage_audit` |

## 开发

```bash
node --check index.js
node --test tests/tool-retry.test.mjs   # 25 cases, no DSH runtime needed
```

MIT License.
