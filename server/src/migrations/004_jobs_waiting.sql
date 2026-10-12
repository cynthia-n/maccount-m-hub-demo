-- 004: job 等待状态（invite 重试 / join 等事件 / 网关退避）
ALTER TABLE jobs ADD COLUMN waiting_for TEXT;
