-- 001_init: 全量 schema（docs/ARCHITECTURE §2）。迁移只增不改。
-- 约定：枚举用 TEXT+CHECK；时间一律 TIMESTAMPTZ；UUID 主键 gen_random_uuid()（PG14+ 内置）。

-- ── 认证 ─────────────────────────────────────────────────────
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES auth_sessions(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES auth_sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 账号 ─────────────────────────────────────────────────────
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN
    ('idle','online','rate_limited','disconnected','suspended','session_expired')),
  platform_user_id TEXT UNIQUE,
  rate_limited_until TIMESTAMPTZ,
  last_transition_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 群与成员 ─────────────────────────────────────────────────
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_group_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unreachable','left')),
  creator_account_id TEXT NOT NULL REFERENCES accounts(id),
  agent_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_kick_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES groups(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  platform_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('creator','admin','member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);

-- ── agent ────────────────────────────────────────────────────
CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN
    ('running','finished','failed','blocked','cancelled')),
  end_reason TEXT CHECK (end_reason IN
    ('final','budget_exhausted','wall_clock','protocol_errors','audit_blocked','cancelled')),
  summary TEXT,
  trigger JSONB NOT NULL,
  history JSONB NOT NULL DEFAULT '[]',
  step_count INT NOT NULL DEFAULT 0,
  consecutive_protocol_errors INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  pending_action JSONB,
  pending_message_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 每群至多一个 running（并发/多实例兜底）
CREATE UNIQUE INDEX agent_runs_one_running ON agent_runs(group_id) WHERE status = 'running';

CREATE TABLE agent_steps (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  idx INT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
  tool_use_id TEXT,
  name TEXT,
  input JSONB,
  result_summary TEXT,
  is_error BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  audit_verdict TEXT,
  raw_response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, idx)
);

-- ── 序列 ─────────────────────────────────────────────────────
CREATE TABLE sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sequence_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id),
  sequence_id UUID NOT NULL REFERENCES sequences(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed','stopped')),
  vars JSONB NOT NULL,
  step_vars JSONB NOT NULL,
  current_step_index INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 每群至多一个 running（S7 兜底）
CREATE UNIQUE INDEX sequence_runs_one_running ON sequence_runs(group_id) WHERE status = 'running';

CREATE TABLE sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES sequence_runs(id),
  step_index INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','accepted','sent','skipped','failed')),
  account_id TEXT REFERENCES accounts(id),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  client_msg_id TEXT,
  message_id UUID,
  resolved_vars JSONB NOT NULL,
  var_sources JSONB NOT NULL,
  UNIQUE (run_id, step_index)
);

-- ── 消息时间线（入站+出站一张表）──────────────────────────────
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id),
  msg_id TEXT,
  client_msg_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_platform_user_id TEXT,
  sender_account_id TEXT REFERENCES accounts(id),
  is_own BOOLEAN NOT NULL DEFAULT false,
  text TEXT NOT NULL,
  media_url TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  delivery_status TEXT CHECK (delivery_status IN
    ('queued','accepted','sent','failed','unknown','cancelled')),
  fail_code TEXT,
  accepted_at TIMESTAMPTZ,
  send_attempts INT NOT NULL DEFAULT 0,
  agent_run_id UUID REFERENCES agent_runs(id),
  idempotency_key TEXT,
  sequence_step_id UUID REFERENCES sequence_steps(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_group_msg ON messages(group_id, msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX messages_timeline ON messages(group_id, sent_at DESC, id DESC);
CREATE INDEX outbound_pending ON messages(delivery_status, created_at)
  WHERE delivery_status IN ('queued','unknown');

CREATE TABLE agent_idempotency (
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  idempotency_key TEXT NOT NULL,
  message_id UUID NOT NULL REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, idempotency_key)
);

-- ── inbox：网关事件（幂等入口）────────────────────────────────
CREATE TABLE gateway_events (
  event_id BIGINT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX gateway_events_pending ON gateway_events(event_id) WHERE processed_at IS NULL;

-- ── outbox：WS 事件（与业务同事务写入）────────────────────────
CREATE TABLE ws_outbox (
  seq BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ws_outbox_recent ON ws_outbox(created_at);

-- ── 异步 job ─────────────────────────────────────────────────
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('create_group','leave_all')),
  group_id UUID,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed')),
  params JSONB NOT NULL,
  errors JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_steps (
  job_id UUID NOT NULL REFERENCES jobs(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  detail JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, step)
);

-- ── 通用定时器 ───────────────────────────────────────────────
CREATE TABLE due_tasks (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX due_tasks_due ON due_tasks(run_at) WHERE status = 'pending';

-- ── 内部元数据（SSE 游标等）───────────────────────────────────
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
