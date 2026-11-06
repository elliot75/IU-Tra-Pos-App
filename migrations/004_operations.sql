-- 先在獨立測試副本審閱及驗證；正式資料庫須先盤點、備份及核准。
-- 不會自動執行。不改寫或清除既有菜單、員工或草稿。先安裝 001/002。
BEGIN;
CREATE TABLE iutra_pos.pos_organizations (
  id uuid PRIMARY KEY, name text NOT NULL
);
CREATE TABLE iutra_pos.pos_stores (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES iutra_pos.pos_organizations(id),
  name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  day_cutoff integer NOT NULL DEFAULT 0 CHECK(day_cutoff BETWEEN 0 AND 1439),
  active boolean NOT NULL DEFAULT true,
  policy jsonb NOT NULL DEFAULT '{"walletEnabled":false,"memberVerification":null,"refundEnabled":false,"partialRefunds":false,"refundMax":"0","dualApproval":true}',
  UNIQUE(organization_id,id)
);
CREATE TABLE iutra_pos.pos_devices (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES iutra_pos.pos_stores(id),
  name text NOT NULL, key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL DEFAULT true, UNIQUE(store_id,id)
);
CREATE TABLE iutra_pos.pos_grants (
  staff_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  device_id uuid NOT NULL REFERENCES iutra_pos.pos_devices(id),
  permissions text[] NOT NULL DEFAULT '{pos}', PRIMARY KEY(staff_id,device_id)
);
-- Lock-only capability: the application does not need UPDATE on authorization tables.
-- No dynamic SQL, no returned data, fixed search_path; only explicitly granted roles may call.
CREATE FUNCTION iutra_pos.pos_lock_authorization(p_device uuid,p_staff uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,iutra_pos AS $$
BEGIN
  PERFORM 1 FROM iutra_pos.pos_devices d
    JOIN iutra_pos.pos_stores s ON s.id=d.store_id
    JOIN iutra_pos.pos_grants g ON g.device_id=d.id
    JOIN iutra_pos.staff_users u ON u.id=g.staff_id
    WHERE d.id=p_device AND g.staff_id=p_staff
    FOR UPDATE OF d FOR SHARE OF s,g,u;
END;
$$;
REVOKE ALL ON FUNCTION iutra_pos.pos_lock_authorization(uuid,uuid) FROM PUBLIC;
CREATE TABLE iutra_pos.pos_shifts (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL,
  opened_by uuid NOT NULL REFERENCES iutra_pos.staff_users(id), responsibility text NOT NULL,
  opening_cash bigint NOT NULL CHECK(opening_cash BETWEEN 0 AND 1000000000000),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz, counted_cash bigint CHECK(counted_cash>=0), expected_cash bigint,
  difference bigint, close_reason text, closed_by uuid REFERENCES iutra_pos.staff_users(id),
  FOREIGN KEY(store_id,device_id) REFERENCES iutra_pos.pos_devices(store_id,id), UNIQUE(store_id,device_id,id)
);
CREATE UNIQUE INDEX pos_one_open_shift ON iutra_pos.pos_shifts(device_id) WHERE status='open';
CREATE TABLE iutra_pos.pos_orders (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL, shift_id uuid NOT NULL,
  client_order_id uuid NOT NULL, staff_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  business_date date NOT NULL, menu_release text NOT NULL REFERENCES iutra_pos.catalog_releases(release),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','awaiting_payment','completed','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  subtotal bigint NOT NULL CHECK(subtotal BETWEEN 0 AND 1000000000000),
  total bigint NOT NULL CHECK(total=subtotal), currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
  quote jsonb NOT NULL, request jsonb NOT NULL, reason text,
  production_status text NOT NULL DEFAULT 'not_started' CHECK(production_status IN ('not_started','preparing','ready','handed_over','stopped','wasted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(store_id,device_id,shift_id) REFERENCES iutra_pos.pos_shifts(store_id,device_id,id),
  UNIQUE(device_id,client_order_id), UNIQUE(store_id,id)
);
CREATE INDEX pos_orders_store_date ON iutra_pos.pos_orders(store_id,business_date,created_at,id);
CREATE TABLE iutra_pos.pos_members (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES iutra_pos.pos_stores(id),
  member_code text NOT NULL, display_name text NOT NULL,
  pin_hash text NOT NULL, active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(store_id,member_code), UNIQUE(store_id,id)
);
CREATE TABLE iutra_pos.pos_wallets (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, member_id uuid NOT NULL,
  principal_balance bigint NOT NULL DEFAULT 0 CHECK(principal_balance BETWEEN 0 AND 1000000000000),
  bonus_balance bigint NOT NULL DEFAULT 0 CHECK(bonus_balance=0),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','frozen','closed')),
  version integer NOT NULL DEFAULT 1, UNIQUE(store_id,member_id), UNIQUE(store_id,id),
  FOREIGN KEY(store_id,member_id) REFERENCES iutra_pos.pos_members(store_id,id)
);
CREATE TABLE iutra_pos.pos_topups (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL, shift_id uuid NOT NULL,
  wallet_id uuid NOT NULL, amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 1000000000000),
  status text NOT NULL DEFAULT 'awaiting_funds' CHECK(status IN ('awaiting_funds','credited','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(store_id,id),
  FOREIGN KEY(store_id,wallet_id) REFERENCES iutra_pos.pos_wallets(store_id,id),
  FOREIGN KEY(store_id,device_id,shift_id) REFERENCES iutra_pos.pos_shifts(store_id,device_id,id)
);
CREATE TABLE iutra_pos.pos_banks (
  store_id uuid PRIMARY KEY REFERENCES iutra_pos.pos_stores(id),
  bank_code text NOT NULL, account_number text NOT NULL, account_name text NOT NULL,
  verified boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES iutra_pos.staff_users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE iutra_pos.pos_payment_requests (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL, shift_id uuid NOT NULL,
  order_id uuid, topup_id uuid, order_version integer,
  purpose text NOT NULL CHECK(purpose IN ('sales','topup')),
  method text NOT NULL CHECK(method IN ('cash','bank','wallet')),
  amount bigint NOT NULL CHECK(amount BETWEEN 0 AND 1000000000000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','unknown','succeeded','cancelled','expired','failed')),
  bank_snapshot jsonb, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(store_id,id),
  CHECK((purpose='sales' AND order_id IS NOT NULL AND topup_id IS NULL AND order_version IS NOT NULL) OR
        (purpose='topup' AND order_id IS NULL AND topup_id IS NOT NULL AND method IN ('cash','bank'))),
  FOREIGN KEY(store_id,order_id) REFERENCES iutra_pos.pos_orders(store_id,id),
  FOREIGN KEY(store_id,topup_id) REFERENCES iutra_pos.pos_topups(store_id,id),
  FOREIGN KEY(store_id,device_id,shift_id) REFERENCES iutra_pos.pos_shifts(store_id,device_id,id)
);
CREATE UNIQUE INDEX pos_one_live_payment ON iutra_pos.pos_payment_requests(order_id) WHERE status IN ('pending','processing','unknown');
CREATE TABLE iutra_pos.pos_bank_transactions (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES iutra_pos.pos_stores(id),
  bank_identity text NOT NULL, external_ref text NOT NULL, amount bigint NOT NULL CHECK(amount>=0),
  booked_at timestamptz NOT NULL, observed_by uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bank_identity,external_ref), UNIQUE(store_id,id)
);
CREATE TABLE iutra_pos.pos_payments (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, request_id uuid NOT NULL UNIQUE,
  purpose text NOT NULL CHECK(purpose IN ('sales','topup')), method text NOT NULL CHECK(method IN ('cash','bank','wallet')),
  amount bigint NOT NULL CHECK(amount BETWEEN 0 AND 1000000000000), tendered bigint, change_given bigint,
  wallet_id uuid, bank_transaction_id uuid UNIQUE,
  confirmed_by uuid NOT NULL REFERENCES iutra_pos.staff_users(id), confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK((method='cash' AND tendered>=amount AND change_given=tendered-amount) OR (method<>'cash' AND tendered IS NULL AND change_given IS NULL)),
  FOREIGN KEY(store_id,request_id) REFERENCES iutra_pos.pos_payment_requests(store_id,id),
  FOREIGN KEY(store_id,wallet_id) REFERENCES iutra_pos.pos_wallets(store_id,id),
  FOREIGN KEY(store_id,bank_transaction_id) REFERENCES iutra_pos.pos_bank_transactions(store_id,id), UNIQUE(store_id,id)
);
CREATE TABLE iutra_pos.pos_refunds (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, order_id uuid NOT NULL, payment_id uuid NOT NULL,
  amount bigint NOT NULL CHECK(amount>0), method text NOT NULL CHECK(method IN ('cash','bank','wallet')),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','processing','succeeded','failed','unknown','cancelled','rejected')),
  version integer NOT NULL DEFAULT 1, requested_by uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  approved_by uuid REFERENCES iutra_pos.staff_users(id), executed_by uuid REFERENCES iutra_pos.staff_users(id),
  executed_shift_id uuid REFERENCES iutra_pos.pos_shifts(id), reason text NOT NULL, external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  FOREIGN KEY(store_id,order_id) REFERENCES iutra_pos.pos_orders(store_id,id),
  FOREIGN KEY(store_id,payment_id) REFERENCES iutra_pos.pos_payments(store_id,id), UNIQUE(store_id,id)
);
CREATE UNIQUE INDEX pos_bank_refund_reference ON iutra_pos.pos_refunds(store_id,external_ref) WHERE method='bank' AND status='succeeded';
CREATE TABLE iutra_pos.pos_wallet_entries (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, wallet_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('topup','debit','refund','adjustment')),
  delta bigint NOT NULL CHECK(delta<>0), balance_after bigint NOT NULL CHECK(balance_after>=0),
  business_key text NOT NULL UNIQUE, payment_id uuid, refund_id uuid, topup_id uuid UNIQUE,
  shift_id uuid NOT NULL, device_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  reference text, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(store_id,wallet_id) REFERENCES iutra_pos.pos_wallets(store_id,id),
  FOREIGN KEY(store_id,payment_id) REFERENCES iutra_pos.pos_payments(store_id,id),
  FOREIGN KEY(store_id,refund_id) REFERENCES iutra_pos.pos_refunds(store_id,id),
  FOREIGN KEY(store_id,topup_id) REFERENCES iutra_pos.pos_topups(store_id,id),
  FOREIGN KEY(store_id,device_id,shift_id) REFERENCES iutra_pos.pos_shifts(store_id,device_id,id)
);
CREATE INDEX pos_wallet_history ON iutra_pos.pos_wallet_entries(wallet_id,created_at,id);
CREATE TABLE iutra_pos.pos_verifications (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, member_id uuid NOT NULL, request_id uuid NOT NULL,
  staff_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id), device_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz,
  FOREIGN KEY(store_id,member_id) REFERENCES iutra_pos.pos_members(store_id,id),
  FOREIGN KEY(store_id,request_id) REFERENCES iutra_pos.pos_payment_requests(store_id,id),
  FOREIGN KEY(store_id,device_id) REFERENCES iutra_pos.pos_devices(store_id,id)
);
CREATE TABLE iutra_pos.pos_exceptions (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, request_id uuid NOT NULL,
  bank_transaction_id uuid, observed_amount bigint NOT NULL CHECK(observed_amount>=0),
  kind text NOT NULL, note text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewed')),
  resolution text, observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(store_id,request_id) REFERENCES iutra_pos.pos_payment_requests(store_id,id),
  FOREIGN KEY(store_id,bank_transaction_id) REFERENCES iutra_pos.pos_bank_transactions(store_id,id)
);
CREATE TABLE iutra_pos.pos_cash_movements (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL, shift_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('in','out')), amount bigint NOT NULL CHECK(amount>0),
  kind text NOT NULL CHECK(kind IN ('sales','topup','refund','other')), source_id uuid NOT NULL,
  category text, reason text, actor_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,source_id),
  FOREIGN KEY(store_id,device_id,shift_id) REFERENCES iutra_pos.pos_shifts(store_id,device_id,id)
);
CREATE TABLE iutra_pos.pos_print_jobs (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL, order_id uuid NOT NULL,
  document_kind text NOT NULL CHECK(document_kind IN ('receipt','label','drawer')), cup_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','printed','failed','unknown')),
  version integer NOT NULL DEFAULT 1, reprint_of uuid REFERENCES iutra_pos.pos_print_jobs(id),
  reason text, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(store_id,order_id) REFERENCES iutra_pos.pos_orders(store_id,id),
  FOREIGN KEY(store_id,device_id) REFERENCES iutra_pos.pos_devices(store_id,id)
);
CREATE UNIQUE INDEX pos_initial_print_unique ON iutra_pos.pos_print_jobs(order_id,document_kind,cup_key) WHERE reprint_of IS NULL;
CREATE INDEX pos_print_queue ON iutra_pos.pos_print_jobs(device_id,created_at) WHERE status IN ('queued','failed','unknown');
CREATE TABLE iutra_pos.pos_operations (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL,
  staff_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id), key uuid NOT NULL,
  command text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(staff_id,device_id,key),
  FOREIGN KEY(store_id,device_id) REFERENCES iutra_pos.pos_devices(store_id,id)
);
CREATE TABLE iutra_pos.pos_audit (
  id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES iutra_pos.staff_users(id), shift_id uuid REFERENCES iutra_pos.pos_shifts(id),
  action text NOT NULL, object_id uuid, reason text, safe_data jsonb NOT NULL,
  request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(store_id,device_id) REFERENCES iutra_pos.pos_devices(store_id,id)
);
CREATE INDEX pos_audit_store ON iutra_pos.pos_audit(store_id,created_at,id);
CREATE TABLE iutra_pos.pos_outbox (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES iutra_pos.pos_stores(id),
  aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE FUNCTION iutra_pos.pos_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only financial record'; END;
$$;
CREATE TRIGGER pos_audit_immutable BEFORE UPDATE OR DELETE ON iutra_pos.pos_audit FOR EACH ROW EXECUTE FUNCTION iutra_pos.pos_append_only();
CREATE TRIGGER pos_wallet_entries_immutable BEFORE UPDATE OR DELETE ON iutra_pos.pos_wallet_entries FOR EACH ROW EXECUTE FUNCTION iutra_pos.pos_append_only();
CREATE TRIGGER pos_payments_immutable BEFORE UPDATE OR DELETE ON iutra_pos.pos_payments FOR EACH ROW EXECUTE FUNCTION iutra_pos.pos_append_only();
CREATE TRIGGER pos_cash_immutable BEFORE UPDATE OR DELETE ON iutra_pos.pos_cash_movements FOR EACH ROW EXECUTE FUNCTION iutra_pos.pos_append_only();
CREATE TRIGGER pos_bank_transactions_immutable BEFORE UPDATE OR DELETE ON iutra_pos.pos_bank_transactions FOR EACH ROW EXECUTE FUNCTION iutra_pos.pos_append_only();
COMMIT;
-- 角色權限、門市、設備與 policy 另經維運明確配置；不自動授權既有員工。
-- 執行帳號不可擁有 schema/表、DDL、TRUNCATE、觸發器停用或稽核 DELETE 權限。
