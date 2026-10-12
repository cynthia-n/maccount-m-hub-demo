-- 003: due_tasks 允许 running（claim 中间态）
ALTER TABLE due_tasks DROP CONSTRAINT due_tasks_status_check;
ALTER TABLE due_tasks ADD CONSTRAINT due_tasks_status_check
  CHECK (status IN ('pending','running','done','cancelled'));
