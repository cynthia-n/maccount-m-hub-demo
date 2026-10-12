-- 002: due_tasks 重试计数
ALTER TABLE due_tasks ADD COLUMN attempts INT NOT NULL DEFAULT 0;
