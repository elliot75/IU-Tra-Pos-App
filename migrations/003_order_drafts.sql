-- POS-01 僅供開發用未付款訂單草稿，不啟用正式交易或收款。
-- 先執行 001、002；確認目標資料庫及備份後，由維運人員手動審閱並執行。
BEGIN;
CREATE TABLE iutra_pos.order_drafts (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  operation_id uuid NOT NULL,
  menu_release text NOT NULL REFERENCES iutra_pos.catalog_releases(release),
  request jsonb NOT NULL,
  quote jsonb NOT NULL,
  total_vnd bigint NOT NULL CHECK (total_vnd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, operation_id)
);
COMMIT;
