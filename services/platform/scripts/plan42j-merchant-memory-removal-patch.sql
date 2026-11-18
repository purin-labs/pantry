-- Plan 42J Brain: remove the merchant_memory table and its index.
--
-- Run only on a database where plan42j-merchant-memory-preflight.sql lists
-- the table and its row count is zero. A database without the table needs no
-- patch, and this file fails there without changing anything.
--
-- The patch checks emptiness again itself: the insert below fails its CHECK
-- when the table holds any row. A remote file runs as one unit, so a failure
-- leaves the database as it was, rows included.
--
-- Run from services/platform:
--   pnpm exec wrangler d1 execute <binding> --env production --remote --file scripts/plan42j-merchant-memory-removal-patch.sql
-- Then run the preflight again. It must return no row.
CREATE TABLE plan_42g_merchant_memory_guard (
  merchant_memory_rows INTEGER NOT NULL,
  CONSTRAINT merchant_memory_must_be_empty CHECK (merchant_memory_rows = 0)
);
INSERT INTO plan_42g_merchant_memory_guard SELECT COUNT(*) FROM merchant_memory;
DROP TABLE plan_42g_merchant_memory_guard;

DROP INDEX idx_merchant_memory_active;
DROP TABLE merchant_memory;
