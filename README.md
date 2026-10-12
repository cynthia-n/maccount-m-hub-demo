# 多账号群组消息平台

「多账号群组消息平台」的后端 + 操作控制台：代管若干服务账号，维护群组与消息时间线，按定时序列发消息，接入一个基于工具调用的自动应答 Agent，操作员通过网页实时查看。

- 后端：Node 20 + TypeScript + Fastify + PostgreSQL（无 ORM，手写 SQL）
- 前端：React 18 + Vite + antd 5 + React Query
- 外部服务（消息网关 / Agent 服务）由仓库内两个**可注入故障的模拟器**提供，接口契约见 `docs/API.md`

## 快速开始

前置：Node ≥ 20、Docker（或本机 PostgreSQL ≥ 14）。

```bash
# 1. 数据库（首次会自动创建 maccount 与 maccount_test 两个库）
docker compose up -d

# 2. 安装依赖
npm install

# 3. 迁移（幂等；可重复执行）
npm run migrate          # 或 npm run migrate:fresh 重建

# 4. 启动（server:8080 + gateway-mock:8081 + agent-mock:8082 + web:5173）
npm run dev
```

打开 http://localhost:5173 ，用 `admin/admin`（全部权限）或 `viewer/viewer`（只读）登录。

后端 API 独立地址：http://localhost:8080 （`GET /api/health` 返回 `{ ok, schemaVersion }`；schema 落后于代码时服务拒绝启动）。

## 测试与冒烟

```bash
npm test     # 单测 + 集成测试（真实 Postgres 测试库 + 进程内 mock），覆盖题面 S1–S8 场景
npm run smoke  # 起真实进程：登录→connect→建群→发消息→断言 sent
```

环境变量见 `.env.example`（`PORT` / `DATABASE_URL` / `GATEWAY_URL` / `AGENT_URL` 及各时序参数，测试内调小）。

## 演示场景（S1–S8 复现开关）

两个模拟器暴露控制端点 `POST /__ctl`，可复现题目要求的外部服务行为：

| 场景 | 开关（`POST http://localhost:8081/__ctl`） |
|---|---|
| S2 事件重复 | `{"op":"setDuplicateEvents","n":2}` |
| S4 限流 | `{"op":"setRateLimit","accountId":"acc-charlie","retryAfterSeconds":3}` |
| S5/A2 504 | `{"op":"setSend504","count":1}`（已接收但 504）/ `setSend504Lost`（真丢） |
| A2 查询不可用 | `{"op":"setByClientId503","ms":1500}` |
| A2 群不可写 | `{"op":"setGroupWriteForbidden","groupId":"g-1"}` |
| A1 终态 | `{"op":"suspendAccount","accountId":"acc-charlie"}` |
| B2 邀请链接 | `{"op":"setInvite","mode":"notReady"\|"expire"}` |
| S6 Agent 坏响应 | `{"op":"scriptAll","steps":[...]}`，POST `:8082/__ctl`；audit：`{"op":"setAudit","mode":"500"}` |

完整开关表与 S1–S8 映射见 `docs/API.md §4`。

## 架构速览

```
web (React)  ──REST + WS──  server (Fastify)
                             ├─ SSE 客户端 ──→ gateway-mock (HTTP+SSE)
                             ├─ Agent 客户端 ─→ agent-mock (tool use 协议)
                             └─ PostgreSQL
```

可靠性设计全部围绕题面总则「任意时刻重启前后行为成立」：

- **inbox**：网关 SSE 事件先幂等落 `gateway_events`（eventId 主键），worker 按 eventId 顺序处理；处理失败不阻塞、不丢失，连续失败推 `inconsistency`
- **outbox**：所有 WS 推送与业务变更同事务写 `ws_outbox`（seq 单调），前端断线用 `sinceSeq` 补齐
- **先落库再外呼**：出站消息 `queued` 先持久化（clientMsgId 生成于落库时），504 → `unknown` 由探测定案，确认未发出才允许重发一次
- **并发正确性靠数据库**：CAS 转移（`UPDATE ... WHERE status=$expectedFrom`）、部分唯一索引兜底「每群至多一个 running 的 agent run / 序列 run」
- **定时逻辑持久化**：一切"过 N 秒做 X"都是 `due_tasks` 表 + 轮询 worker（SKIP LOCKED），重启即恢复
- **Agent 三锚点恢复**：步+历史落库（P1）→ 审计通过的意图落库（P2）→ 结果落库（P3）；重启从锚点续，已产生外部效果的调用不重放

细节：`docs/ARCHITECTURE.md`（表结构 DDL、状态机、循环设计）；需求追溯与决策记录：`docs/PLAN.md`、`docs/DECISIONS.md`。

## 目录

```
server/   后端（routes/ domain/ workers/ gateway/ ws/ migrations/）
web/      前端五页：登录 / 账号 / 群列表·详情 / Agent 运行详情 / 序列
mocks/    gateway-mock、agent-mock（dev 由 npm run dev 拉起，测试进程内启动）
shared/   前后端共用纯 TS：API 类型、错误码、状态转移表、序列变量解析
docs/     架构 / 契约 / 计划 / 决策
scripts/  dev、smoke、compose 初始化
```
