-- 005: 出站 504 定案状态机所需字段
ALTER TABLE messages ADD COLUMN unknown_since TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN last_probe_at TIMESTAMPTZ;
