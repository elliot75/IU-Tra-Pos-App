-- 僅供維運審閱後手動執行；先執行 001，確認目標資料庫與備份。
-- 遷移角色需有 iutra_pos 的 CREATE 權限。此遷移不會自動執行。
BEGIN;
CREATE TABLE iutra_pos.staff_users (
  id uuid PRIMARY KEY,
  login_name text NOT NULL UNIQUE CHECK (login_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100 AND display_name ~ '[^[:space:]]'),
  password_hash text NOT NULL,
  can_manage_catalog boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE iutra_pos.staff_sessions (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_staff_id_idx ON iutra_pos.staff_sessions (staff_id);
-- 停用後重新啟用也不能復活舊 session。
CREATE FUNCTION iutra_pos.revoke_disabled_staff_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    UPDATE iutra_pos.staff_sessions SET revoked_at = clock_timestamp()
    WHERE staff_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER staff_disable_revoke_sessions AFTER UPDATE OF active ON iutra_pos.staff_users
FOR EACH ROW EXECUTE FUNCTION iutra_pos.revoke_disabled_staff_sessions();
COMMIT;
-- 應用角色需 schema USAGE、staff_users SELECT/UPDATE 與 staff_sessions SELECT/INSERT/UPDATE。
-- 建立員工的維運角色需 schema USAGE 及 staff_users INSERT；請另行配置最小權限。
-- can_manage_catalog 僅為開發階段旗標，完整角色、設備及門市 scope 尚未實作。
