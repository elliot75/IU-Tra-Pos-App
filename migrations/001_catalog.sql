-- 手動執行：使用前確認目標資料庫、盤點現有 iutra_pos schema 並完成備份。
-- 此檔是全新安裝，若 schema 已存在會失敗；不會自動遷移或讀取既有資料。
-- 請由具適當權限的維運人員審閱並手動執行整個檔案。
BEGIN;
CREATE SCHEMA iutra_pos;
CREATE TABLE iutra_pos.catalog_releases (
  release text PRIMARY KEY,
  catalog jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION iutra_pos.reject_catalog_release_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'catalog releases are immutable';
END;
$$;
CREATE TRIGGER catalog_releases_immutable
BEFORE UPDATE OR DELETE ON iutra_pos.catalog_releases
FOR EACH ROW EXECUTE FUNCTION iutra_pos.reject_catalog_release_mutation();
CREATE TRIGGER catalog_releases_no_truncate
BEFORE TRUNCATE ON iutra_pos.catalog_releases
FOR EACH STATEMENT EXECUTE FUNCTION iutra_pos.reject_catalog_release_mutation();
CREATE TABLE iutra_pos.catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
  catalog jsonb NOT NULL,
  current_release text REFERENCES iutra_pos.catalog_releases(release)
);
INSERT INTO iutra_pos.catalog_state (singleton, revision, catalog)
VALUES (true, 0, '{"categories":[],"products":[]}'::jsonb);
COMMIT;
-- 正式部署應另以最小權限配置應用與維運角色；擁有者仍可變更物件或停用 trigger。
