# 營運模組與維運操作

本文件對應目前 `src/operations.js`、`src/server.js`、`migrations/004_operations.sql`、`scripts/configure-pos.js` 與 `scripts/backup-pos.js`。這是線上營運開發版本的實際契約，不代表 v1.1 全部需求已完成或獲准營業。需求／驗收缺口見 [implementation-status-v1.1.md](implementation-status-v1.1.md)；v1.1 第 7 章端點為設計稿，不能直接當成已實作路徑。

## 1. 已有能力與啟用邊界

`/operations` 提供登入與設備連接、開關班、購物車核對並保存訂單、付款請求、現金找零、銀行 QR 與人工核帳、會員／本金錢包、儲值與消費、退款、異常覆核與原款補入、製作狀態、列印工作、班次報表、CSV 及稽核。點餐頁轉往工作台不等於已保存訂單；必須先登入、通過設備授權、開班及服務端計價。示範菜單不能建立營運訂單。

- `ENABLE_POS_OPERATIONS` 須恰為 `true` 才啟用 API，預設停用；靜態工作台仍可開啟。
- 錢包預設 `walletEnabled=false`、`memberVerification=null`；退款預設 `refundEnabled=false`、`partialRefunds=false`、`refundMax="0"`，不可因程式已有功能就替營運方核准政策。
- QR 由已核實銀行設定與付款請求快照產生，銀行請求有效期為 10 分鐘。掃碼、顧客截圖及畫面顯示均不是到帳證明；目前沒有銀行自動通知。
- 列印佇列保存收據、逐杯杯貼及現金銷售開櫃工作，但沒有硬體 sender、實體列印或手動開櫃整合；outbox 已寫入事件，沒有完整外部事件派送服務。
- 客顯結帳投影限同瀏覽器／同來源配對分頁；正式獨立雙屏、設備配對、模式持久設定、掃碼及硬體均待驗收。
- 離線收款／同步、跨店錢包與清算、混合付款、電子發票、門市菜單覆寫與排程未完成。

## 2. 手動 migration

所有指令均由專案根目錄執行。以下是供核准後操作的步驟，文件本身不授權對現有門市資料庫變更或清除測試資料。先確認連線目標、現有 schema／資料、保留範圍、備份與變更窗口，在獨立測試副本驗證後才由維運執行。應用啟動、`--check` 及 `--apply` 都不會自動 migration。

| Migration | 條件與作用 |
| --- | --- |
| `001_catalog.sql` | 僅全新安裝；建立 schema、菜單草稿及不可變發布快照。schema 已存在不可重跑。 |
| `002_staff_auth.sql` | 先有 `001`；員工、session、停用時撤銷 session。 |
| `003_order_drafts.sql` | 選用的實驗訂單草稿；營運 `004` 不依賴它。 |
| `004_operations.sql` | 先有 `001`、`002`；建立組織、門市、設備、grant、班次、訂單、收退款、銀行事實、會員／錢包流水、異常、現金、列印、冪等、稽核與 outbox。沒有自動授權既有員工。 |

`psql` 不會讀取 Node 的 `.env`。由維運人員用受控的 PostgreSQL service／PG* 環境與密碼管道選定目標，不把含密碼的連線字串放在命令參數、Git 或日誌。全新測試資料庫的順序為：

```bash
psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=migrations/001_catalog.sql
psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=migrations/002_staff_auth.sql
psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=migrations/004_operations.sql
```

既有資料庫若已安裝 `001/002/003`，只在確認 `004` 尚未安裝且結構相容後執行 `004`。每個 migration 自帶 `BEGIN/COMMIT`，沒有 migration runner 或版本追蹤表，也不是可任意重跑的修復腳本。中途失敗先核實交易是否回滾及實際物件狀態，不 DROP schema 重建；程式回退也不會回退已發生的外部資金。

`GET /api/v1/health` 只做 `SELECT 1`，不能證明 migration、權限、菜單、金鑰或營運資料正確。

## 3. 帳號、門市、設備與 configure

員工先以受控維運帳號建立，密碼從終端輸入、不回顯，至少 12 字元。單一非管理員收銀帳號示例：

```bash
node --env-file-if-exists=.env scripts/create-staff.js cashier '收銀'
```

商品管理帳號才明確加 `--can-manage-catalog`。該旗標不會授予營運權限；營運管理／覆核者同樣要逐設備明確授權。是否多人共用收銀登入與交接責任仍待 T-13，開班自填 `responsibility` 不能證明真實個人身分。

以 [config/pos.example.json](../config/pos.example.json) 為格式參考，另備排除 Git 的 `private/pos-config.json`。範本含無法通過驗證的 `REPLACE` 設備秘密；正式值自行產生，不使用範例 UUID／測試秘密作實際部署。

| 設定 | 格式及效果 |
| --- | --- |
| `organization` | `id` UUID、`name`；門市不能藉由更新改掛其他組織。 |
| `store` | `id`、`name`、有效 IANA `timezone`、`dayCutoff`（午夜後分鐘，整數 0–1439）、`policy`。時區與切點用於新單營業日。 |
| `device` | `id`、`name`、`key`；key 為 32–128 字元的 `[A-Za-z0-9_-]` 隨機秘密，DB 只存 SHA-256。既有設備不能移轉門市。 |
| `grants[]` | 既存且 active 的 `loginName`、`role`（`cashier` 或 `operator`）、不重複的有效 `permissions`。同檔不得重複 loginName。 |

必要 policy 欄位為 `walletEnabled`、`memberVerification`、`refundEnabled`、`partialRefunds`、`refundMax`、`dualApproval`。未決時沿用範本停用值。啟用錢包須明確選 `memberVerification: "pin"`，另設 `verificationAttempts`（1–10）、`verificationLockMinutes`（1–1440）；PIN 為 6–12 位數字。啟用退款須明確設 `refundWindowDays`（1–3650）、金額上限與部分退款／雙人核准政策。這些是實作可接受範圍，不是建議或已核准的營運數值。

```bash
node scripts/configure-pos.js private/pos-config.json --check
node --env-file-if-exists=.env scripts/configure-pos.js private/pos-config.json --apply
```

- `--check` 只讀設定檔並驗證格式，不連線、不寫 DB，不檢查帳號存在、收銀帳號實際旗標、schema 或 SQL 權限。
- `--apply` 使用該次程序的 `DATABASE_URL`，在同一交易 upsert 指定組織、門市、設備及 grants，找不到 active 員工會整筆回滾。重複套用會更新名稱、policy、設備 key hash 與列出的授權，不是唯讀預檢。
- 未列出的既有授權保留；撤權須明確列出該 `loginName`、角色及 `permissions: []` 後再 apply，不可只從檔案刪掉帳號。此工具不提供刪帳號或停用設備命令。
- `cashier` 不能是 `can_manage_catalog=true`，也不能授予 `bank.manage`、`members.manage`、`wallet.adjust`、`refund.approve`、`refund.execute`、`cash.manage`、`audit`、`export`。`role` 是設定時的檢查，DB 目前存的是逐設備 permission 清單，沒有完整角色模板管理介面；不可用 `operator` 規避非管理員收銀需求。
- 設備 key 更新會使舊 key 立即失效。正式環境須先安排設備秘密分發與恢復，不任意重產設定。

完成設定後，以安全管道注入穩定 `POS_REQUEST_HMAC_KEY`，測試環境才設定 `ENABLE_POS_OPERATIONS=true` 並重啟。輸入登入帳密、設備 UUID 與設備 key，確認 `/api/v1/pos/context` 的門市、設備、權限、policy 及班次正確。

## 4. 穩定金鑰與正式最小權限

三種秘密用途不同，應分開產生及保管，不使用文件中的固定字串：

| 秘密 | 要求與恢復 |
| --- | --- |
| `POS_REQUEST_HMAC_KEY` | 至少 32 字元隨機秘密，用於 canonical 命令內容的 HMAC-SHA-256。所有服務實例、重啟及 DB 復原須沿用原值；目前沒有多 key 版本／輪替機制，改值會令既有同鍵重試回 `IDEMPOTENCY_CONFLICT`。 |
| 設備 `key` | 受控設定與設備操作使用，DB 只有雜湊；還原 DB 不會找回明文 key。不要傳入客顯、URL、日誌或 Git。 |
| `POS_BACKUP_KEY_BASE64` | 解碼後恰為 32 bytes 的獨立 AES 金鑰。每份舊備份都要保留對應 key；遺失無法解密，不能藉由設定新 key 恢復。 |

金鑰與 `.env`、設備設定應有備份包以外的受控備援及版本對照；加密包不收錄這些秘密。需要產生時，HMAC 與設備 key 各自獨立執行一次 `openssl rand -hex 32`，備份 key 則另用 `openssl rand -base64 32`。十六進位設備 key 符合允許字元；不要直接用含 `+`、`/`、`=` 的一般 Base64 當設備 key。結果只存秘密管理，不貼入文件或一般日誌。

正式環境必須使用 HTTPS 與可信代理覆寫標頭，設定見 [README](../README.md)。限制應用來源、資料庫網路與備份檔權限，跨網路 DB 使用經驗證的 TLS。`lan-development`／`local-development` 不作正式部署模式。登入限流目前是單程序記憶體，重啟重設，多程序須另配置共同限流。

DDL／物件擁有者與應用角色分離；應用不可為 superuser、schema／table owner，不得有 DDL、`TRUNCATE`、停用觸發器或改寫帳本／稽核的權限。migration 沒有自動 GRANT 以下權限，需按實際部署在獨立環境核對：

| 資料 | 應用需要的表級操作 |
| --- | --- |
| schema `iutra_pos` | `USAGE`，不授予 `CREATE`。 |
| `catalog_state` | `SELECT/UPDATE`；`catalog_releases` 為 `SELECT/INSERT`，禁止更新／刪除／truncate。 |
| `staff_users` | `SELECT/UPDATE`（登入失敗次數等）；`staff_sessions` 為 `SELECT/INSERT/UPDATE`。建立員工用獨立維運角色的 `INSERT`。 |
| `pos_stores`、`pos_devices`、`pos_grants` | 執行時 `SELECT`；配置的 `INSERT/UPDATE` 另給 configure 維運角色，不給一般應用。`pos_organizations` 配置亦由維運處理。 |
| `pos_lock_authorization(uuid,uuid)` | 一般應用需明確取得 `EXECUTE`。004 已撤銷 PUBLIC 執行權；這個 SECURITY DEFINER 函式只鎖定指定設備及其授權關聯、不回資料或修改設定，固定 search_path、無動態 SQL。讓 row lock 不必開放授權資料表的 UPDATE。函式 owner 由受控 migration 角色擔任，一般應用不可更換函式。 |
| `pos_payments`、`pos_bank_transactions`、`pos_wallet_entries`、`pos_cash_movements`、`pos_audit` | `SELECT/INSERT`；`004` 的觸發器拒絕 UPDATE/DELETE，仍須撤除該權限與 `TRUNCATE`，不能僅依賴觸發器。 |
| `pos_operations`、`pos_outbox` | 目前請求程式需要 `SELECT/INSERT`；沒有需要一般業務改寫既有冪等結果的功能。派送角色若新增另審權限。 |
| 其餘營運可變表 | 班次、訂單、會員、錢包、儲值、銀行設定、付款請求、退款、驗證、異常、列印工作按程式需 `SELECT/INSERT/UPDATE`；不授予一般業務 DELETE。 |
| `order_drafts` | 僅啟用實驗 API 時另授 `SELECT/INSERT`。 |

configure 角色需讀員工、upsert 組織／門市／設備／grant 的權限；備份角色需覆蓋整個備份資料庫的讀取及必要連線權限。實際 GRANT、預設權限、函式執行、備份與還原角色必須按部署驗證；此表不是可盲貼的完整授權 SQL。API 透過設備推導 store scope，並未實作 PostgreSQL RLS，不能將 DB 共用連線帳號當成逐店隔離。

## 5. 實際 API 契約

營運端點前綴為 `/api/v1/pos`。每次請求需受保護傳輸、active 員工 session 與有效設備 grant：

```http
Authorization: Bearer <員工登入 token>
X-POS-Device: <設備 UUID>
X-POS-Key: <設備秘密>
```

寫入固定使用 `POST /api/v1/pos/commands/{command}`，加 `Content-Type: application/json` 及 `Idempotency-Key: <UUID>`。不要使用 v1.1 設計稿的 `/shifts` POST 等路徑。伺服器拒絕缺漏及多餘欄位；表中的欄位均必填，空字串允許情況另述。金額使用無千分位的整數 VND 十進位字串（一般 0–1,000,000,000,000，需正額處不得為 0），`expectedVersion` 為 JSON 整數，ID 為 UUID。

成功 JSON 為 `{request_id, data}`；command 的 `data` 為 `{key, command, result}`。輸出財務欄位為字串，DB 欄位多為 snake_case，命令輸入為表列 camelCase。沒有實作通用 202 pending operation 回應；命令在交易提交後回 200。冪等紀錄與業務、稽核在同一交易提交。

### 5.1 命令與權限

| command | body 欄位 | 權限／限制 |
| --- | --- | --- |
| `openShift` | `openingCash, responsibility` | `pos`；一設備僅一 open 班次。 |
| `closeShift` | `id, expectedVersion, countedCash, reason` | `pos`；本設備開班；未決訂單／付款／執行中退款會阻擋。關班不代表核帳簽認。 |
| `cashMovement` | `shiftId, direction, amount, category, reason` | `cash.manage`；開班；`direction=in/out`，正額，只記 other 收支。 |
| `createOrder` | `clientOrderId, shiftId, menuRelease, items` | `pos`；本設備開班，當前非範例發布菜單，重新計價。相同 clientOrderId 不同內容／班次拒絕。 |
| `updateOrder` | `id, expectedVersion, menuRelease, items` | `pos`；本設備開班、draft；目前工作台沒有完整既存訂單編修表單。 |
| `cancelOrder` | `id, expectedVersion, reason` | `pos`；draft／awaiting_payment，沒有未知或進行中資金；終止 pending 請求。已付走退款。 |
| `requestPayment` | `orderId, expectedVersion, method` | `pos`；本設備開班、draft，`cash/bank/wallet`；wallet 另需 `wallet.charge` 與政策，bank 要已核實帳戶。 |
| `cancelPayment` | `id, reason` | `pos`；僅 pending；已到款待入帳儲值不得取消後重收。 |
| `confirmCash` | `id, tendered` | `pos`；原開班、pending cash；實收不足拒絕，保存應付／實收／找零。 |
| `confirmBank` | `id, externalRef, amount, bookedAt, note` | `bank.confirm`；核對店家銀行紀錄；`bookedAt` 為含時區 ISO 時間，不得超前現在一分鐘以上。`externalRef`／`note` 可空，缺可靠識別只入異常。 |
| `creditFundedTopup` | `id, reason` | `bank.confirm` 加 `wallet.topup`；id 是 open `funded_pending_credit` 異常 UUID，沿用原銀行款、原設備、原開班與 pending topup request；詳見恢復流程。 |
| `reviewException` | `id, resolution` | `bank.confirm`；本店 open 異常→reviewed；不產生收款／退款／錢包流水，`funded_pending_credit` 須走專用補入帳。 |
| `setBank` | `bankCode, accountNumber, accountName, verified, reason, expectedVersion, currentPassword` | `bank.manage`；重新驗證登入密碼；六碼 BIN、6–34 位數字帳號；初次版本 0，其後用實際版本。`verified` 為布林，格式合法不等於銀行已核實。 |
| `createMember` | `memberCode, displayName, pin` | `members.manage`；錢包／PIN 政策；建立本金為 0 的本店錢包。 |
| `verifyMember` | `memberId, pin, purpose, paymentRequestId` | `wallet.charge`；`purpose="payment"`，有效 wallet 請求；失敗計數／鎖定持久化，成功 token 兩分鐘且綁會員、請求、帳號、設備。 |
| `topup` | `walletId, shiftId, amount, method` | `wallet.topup`；政策、開班、active 會員／錢包；正額、`cash/bank`，僅建立待收款，確認後才加錢包。 |
| `chargeWallet` | `id, walletId, verificationToken` | `wallet.charge`；政策、原開班與有效驗證；餘額不足整筆拒絕，不混合付款。 |
| `adjustWallet` | `walletId, delta, reference, reason` | `wallet.adjust`；政策、當前開班；非零有號 delta、穩定憑證；追加流水，不是任意覆寫餘額或舊帳匯入 API。 |
| `requestRefund` | `orderId, amount, reason` | `refund.request`；本店已付訂單，政策／期限／限額／部分退款限制；申請起就占用原付款可退額。 |
| `approveRefund` | `id, expectedVersion` | `refund.approve`；requested；若 dualApproval 未設 false，不得由申請者核准。 |
| `startRefund` | `id, expectedVersion` | `refund.execute`；approved、當前開班；現金／銀行先進 processing，錢包同交易退回原錢包並成功。 |
| `finishRefund` | `id, expectedVersion, outcome, externalRef, reason` | `refund.execute`；現金／銀行 processing 或 unknown，原執行設備／開班；`succeeded/failed/unknown`，銀行成功須外部交易識別，其他可空。 |
| `cancelRefund` | `id, expectedVersion, reason` | `refund.request`；僅 requested／approved，不能取消 processing／unknown。 |
| `setProduction` | `orderId, expectedVersion, status` | `pos`；已付訂單；依狀態圖到 preparing／ready／handed_over 或 stopped／wasted，未做逐杯製作管理。 |
| `claimPrint` | `id, expectedVersion` | `print`；本設備 queued／failed→sending，unknown 不可直接重領。 |
| `finishPrint` | `id, expectedVersion, outcome, reason` | `print`；sending／unknown；`printed/failed/unknown`，unknown 不可改成可重試 failed。這只是結果紀錄，非硬體確認。 |
| `reprint` | `id, reason` | `print.reprint`；本設備原工作不是 queued／sending；新工作關聯原工作並標 reprint；drawer 禁止補印。 |

`items` 沿用計價輸入：`productId`、`variantId`、`quantity`、`toppings`（`id, portions`）、`options`（`groupId, valueIds`）、`customerNote`、`internalNote`。價格與合計由服務端按當前發布菜單取得；內部備註不進客顯或列印公開快照。

### 5.2 查詢與資料範圍

| GET 路徑 | 權限／內容 |
| --- | --- |
| `/context` | 有效設備 grant；store、device、permissions、policy、currentShift。 |
| `/operations/{key}` | 原員工＋原設備，並重新檢查該命令主權限；key 是原 `Idempotency-Key`，不是資料表操作紀錄 id。 |
| `/orders[/{id}]`、`/shifts[/{id}]`、`/paymentRequests[/{id}]` | `pos`；本店本設備。 |
| `/members[/{id}]`、`/wallets[/{id}]`、`/entries[/{id}]` | `members`；本店，會員碼／名稱遮罩，列表不回 PIN hash；錢包／流水不能跨店使用。 |
| `/payments[/{id}]`、`/cashMovements[/{id}]` | `reports`；payments 本店，cashMovements 再限本設備。 |
| `/refunds[/{id}]` | `refund.request`；本店。核准／執行權本身不自動包含列表權。 |
| `/exceptions[/{id}]` | `bank.confirm`；本店。 |
| `/printJobs[/{id}]` | `print`；本店本設備。補印權本身不自動包含列表權。 |
| `/audit[/{id}]` | `audit`；本店。 |
| `/banks[/{storeId}]` | `bank.manage`；本店，單筆識別為 store UUID。 |
| `/reports/{shiftId}` | `reports`；本店指定班次，包括同店其他設備班次。 |
| `/exports/{shiftId}` | `export`；本店指定班次 CSV，寫入匯出稽核。 |
| `/qr/{paymentRequestId}` | 透過 `pos` 讀本設備付款請求；只對 pending、未過期 bank request 回 PNG，不是公開客顯 API。 |

一般列表的 `limit` 預設 50、範圍 1–200；`before=<UUID>` 以 `id < before` 分頁，排序為 UUID 降冪，並非發生時間順序。`query` 最長 100 字元，目前只有 members 使用完整會員碼精確搜尋。工作台的選取器與紀錄表提供「載入更多紀錄」，沿用 UUID 游標追加下一批，保留目前選取；「重新載入」回到第一批。顯示為已載入筆數，不稱為最近紀錄。沒有通用日期／錢包 id 篩選、全帳務匯出或異步匯出工作。

班次報表區分 sales、topups、refunds 及付款方式；預期現金＝備用金＋現金銷售＋現金儲值＋其他流入－現金退款－其他流出。儲值收款不加進飲品銷售；銀行／錢包不加進現金。報表永遠保留 `reconciled:false`、`reviewStatus:"not_signed_off"`，關班與 CSV 下載均非帳務負責人簽認。開放異常筆數是提示，未做完整中央對帳簽認。

## 6. 重試、異常及錯誤恢復

### 6.1 逾時與冪等

冪等範圍是 `(staff_id, device_id, key)`，跨 session 重登可用，換員工／設備不可查回別人的結果。同 key 同命令與內容回原結果；不同內容回 409 `IDEMPOTENCY_CONFLICT`。請保留原 key、命令、內容、訂單／付款識別及 request_id，逾時不改用新 key 重新收款。

`GET /operations/{key}` 的 404 不足以證明原請求沒執行，可能仍在提交或登入範圍不符。先核對原帳號／設備與相關訂單／資金紀錄，再按同鍵重試。`verifyMember` 的 token 只在首次成功回覆一次，冪等紀錄不保存 PIN 或 token；重查無法取回 token。`chargeWallet` 的 token、`setBank` 的 currentPassword 不參與內容 HMAC，允許原業務內容經重新驗證後恢復。

工作台送出寫入前先把原 key 與去秘密的 body 保存至 `sessionStorage`。秘密欄位採明確名稱比對，商品 `toppings` 等非秘密內容完整保留。401、403、逾時、斷線或 5xx 保留待確認；403 可能發生在原操作已提交後的權限變更，不能因此丟棄原 key；查詢的 404 也不清除。操作成功回應須對得上原 key／command 才解除阻擋。重新整理後重新輸入原帳號與設備，先查原操作；包含 PIN／密碼／token 的操作需重新驗證，頁面提供原內容恢復流程。不要清除儲存、換新分頁或改新識別來繞過待確認狀態；分頁儲存不是離線交易資料庫，也不能保證關閉瀏覽器後恢復。

服務端僅對 `40P01`（deadlock）、`40001`（serialization failure）整筆交易最多嘗試三次；其他未知 DB 錯誤回 503，不能推定未提交。400 格式錯誤需修正輸入；401 重登；403 核對授權／驗證；409 版本、業務狀態或防重衝突需重讀核對；422 金額不符需核對實際款項；503 暫不可用先查原操作。不得以手動 SQL 改已付旗標、刪帳本或重設餘額處理。

結帳工作台保留 `iutra.pos.workcheckout` 綁定，直到主頁接收完成／取消狀態、清理本地結帳標記並回覆確認。主頁重整或暫離後會重試請求原狀態；已登入的工作台重新讀取伺服器訂單，再重送終態。工作台重整後須重新登入，不能靠廣播自行宣告收款成功。

### 6.2 銀行異常與已到款待入帳

`confirmBank` 以銀行 BIN＋帳號＋`externalRef` 防重，少付 short、多付 over、缺識別 unmatched、重複 duplicate、取消／到期／關班後 late 都保存異常，不自動完成正常收款。核對必須使用店家銀行實際到帳紀錄。工作台「退款與異常」提供選取異常後的「記錄核帳結果」（`reviewException`）與「將原到款補入儲值」（`creditFundedTopup`）表單，按授權、policy 及狀態限制操作。`reviewException {id,resolution}` 只記錄人工處置，不退差額、不產生新收款，也不代表資金已清算；不能用它把未完成資金處理包裝成成功。

工作台允許對已取消或完成的銀行請求登記實際到款，由後端判定異常，不代表再次收款。早於原訂單／儲值建立時間的到款保存為 `unmatched`（僅容許 1 秒的銀行秒級時間精度差）；已有 open `funded_pending_credit` 時，其他來源也獨立保存為 `unmatched`，不取代原待補入款項。

若銀行已在有效期間同額到款，但儲值政策暫停、會員／錢包停用或上限等使入帳不可完成，記為 `funded_pending_credit`，保留原銀行來源，錢包不加額。先修復已核准政策或會員／錢包狀態，再由同時具 `bank.confirm`、`wallet.topup` 者送出：

```http
POST /api/v1/pos/commands/creditFundedTopup
Content-Type: application/json
Idempotency-Key: <此補入帳意圖的 UUID，重試沿用>
Authorization: Bearer <原設備授權員工 token>
X-POS-Device: <原設備 UUID>
X-POS-Key: <原設備秘密>

{"id":"<funded_pending_credit 異常 UUID>","reason":"<核對與恢復依據>"}
```

此命令要求異常仍 open、原請求仍 pending 且為 bank topup、原設備與原班次仍開啟，銀行來源帳戶與金額等於原請求，錢包政策／會員狀態／上限仍通過。同交易追加原款的 payment、錢包流水、餘額及儲值結果，再將異常 reviewed；唯一付款來源、topup 流水及冪等共同防重。這不是再次轉帳／收款，也不是把過期新款當成有效付款；沿用原先已確立的及時到款事實。

`funded_pending_credit` 不可直接 `reviewException`，有該 open 異常的儲值請求也不可 `cancelPayment`。原班次已關、原 request 已變更或來源不符時停止自動補入，交帳務核對與另行審閱修復，不新建 topup 再收一次。

### 本次審查修正的驗證

2026-11-06 修正審查的 9 項問題後，完整 `npm test` 為 147 項通過、0 失敗、0 跳過。新增測試涵蓋權限變更後原 key 保留、配料完整恢復、123 筆列表分頁、結帳終態重送與確認、受限 DB 角色退款、銀行 CAS、歷史款項及額外儲值到款。交接測試採模擬 DOM／BroadcastChannel；SQL 測試採隔離 PGlite。沒有執行真 DB migration，沒有新增實機雙屏或原生 PostgreSQL 多連線驗收證據。

### 6.3 退款、列印及關班

退款從 requested 起連同 approved／processing／unknown／succeeded 占用原可退額；超額拒絕。現金／銀行 `startRefund` 只進 processing，實際交付後才 `finishRefund`；unknown 保留額度，不換新退款。僅核實尚未付出時才記 failed；processing／unknown 不可直接 cancel。現金及銀行人工完成仍綁原執行設備與開班。訂單本金退回、跨管道退款、明細級折扣分攤退款不是目前完整能力。

收款成功同交易保存列印工作；列印失敗不撤銷收款。sending 後中斷需確認紙張及原工作，unknown 不自動重送或改成可重試 failed；補印需權限、原因及新工作，drawer 禁止補印。頁面人工標 printed 不能證明硬體實際列印；沒有 sender 的環境不得以測試按鈕當成實機驗收。

關班前完成或核對未決訂單、付款及退款，保留實點、預期、差異與原因。待核對銀行事實不因關班消失；報表仍未簽認。若頁面待確認線索遺失，依原帳號、設備、訂單、付款與銀行紀錄由授權者交叉核對，不強制清空 DB 解鎖。

## 7. 加密備份與 staging

需要 Node.js 22+、備份專用 DB 讀取權限、可執行且與 DB 相容的 `pg_dump`、圖片目錄及 32-byte `POS_BACKUP_KEY_BASE64`。從專案根目錄執行，工具固定讀取相對路徑 `public/catalog-images/`。父目錄須先由維運建立並限制存取：

```bash
mkdir -p private/backups
chmod 700 private/backups
node --env-file-if-exists=.env scripts/backup-pos.js backup private/backups/pos-20261106.iutrabak
node --env-file-if-exists=.env scripts/backup-pos.js stage-restore private/backups/pos-20261106.iutrabak private/backups/staging-20261106
```

`backup` 使用 `pg_dump --format=custom --no-owner --no-acl`，範圍是 `DATABASE_URL` 指定的整個資料庫，不限 `iutra_pos`。連線字串只經子程序環境 `PGDATABASE` 傳入，不放命令參數或工具日誌。包內包含 `database.dump`、圖片與 `manifest.json`（時間、DB SHA-256、圖片路徑／SHA-256）；不包含外部 HTTPS 圖片內容、`.env`、設備秘密、HMAC key、備份 key、DB 角色／密碼／原 ACL、服務程式或 WAL/PITR。

封裝以串流 AES-256-GCM 加密並驗證，隨機 12-byte IV、認證 tag，目標檔以獨佔建立及 0600 權限寫入，不覆寫同名備份。圖片限受控雜湊檔名及格式，核對內容 SHA-256；備份中檔案改變則失敗。資料庫 dump 與圖片不是同一個原子快照，仍須維運安排相容版本／變更窗口並核對發布參照；工具不會自動檢查全部 DB 圖片引用是否齊全。

工具會在系統暫存目錄短暫寫入未加密 dump／manifest，完成或可捕捉的失敗後清理；暫存儲存亦需受控，程序被強制終止後應檢查殘留。備份失敗先核對工具版本、讀取權限、空間、圖片雜湊與目標路徑，不印出連線憑證排錯。

`stage-restore` 要求目的目錄不存在，先完成 GCM 認證，再檢查路徑白名單、重複路徑、大小、逐檔雜湊及必要檔案；錯誤 key、竄改或缺檔會失敗並清理本次 staging。staging 目錄 0700、檔案 0600，內含未加密 DB dump 與圖片，須按敏感備份管理。它不連資料庫、不執行 `pg_restore`、不還原目前圖片、不建立 DB 角色／權限，也不證明完整營運還原成功。若目錄已存在，用新的路徑，不刪除既有資料來讓命令通過。

## 8. 完整復原與上線驗收

完整還原由維運另行核准執行；目前腳本沒有一鍵正式還原。至少需：

1. 暫停財務寫入，記錄恢復點與外部已收退款，保留原環境、加密備份、對應 HMAC／備份／設備秘密，不讓舊設備繼續提交未知資金操作。
2. 將備份驗證解密至全新 staging；在獨立原生 PostgreSQL 建立還原目標，用受控角色執行經審閱的 `pg_restore` 計劃，另配置角色及最小權限。不得對現行資料庫直接覆蓋演練。
3. 還原圖片至獨立服務目錄或 volume，核對發布快照的全部本機路徑、SHA-256、HTTP 可讀、缺圖替代及重建後持久性。DB 與圖片保持相容版本，歷史發布仍引用的圖片不可任意清除。
4. 核對訂單／收退款筆數與總額、儲值收款和消費分帳、錢包餘額與流水、班次現金／差異、異常、冪等紀錄、銀行版本、列印與 outbox 狀態。復原後 sending／unknown 不盲目重送，確認已發生的實體列印／轉帳。
5. 核對恢復點後銀行、現金、錢包、退款及門市憑證，處理 DB 回復但外部資金已成功的差異，不能將它們當成未發生而重收／重退。先在隔離環境通過，再依核准窗口恢復服務。

排程、異地副本、保存期、WAL/PITR、RPO/RTO、復原責任人與觀察期仍待 T-09/T-11 決策及實測；規格建議 15 分鐘 RPO、4 小時 RTO 不是本工具已達成的保證。正式環境另須原生 PostgreSQL 多連線競爭／死結／提交後斷線、最小權限負向測試、HTTPS、實機雙屏及印表機／錢櫃、銀行實掃核帳與完整還原演練。

## 9. 原商品匯入授權界線

2026-11-06 已完成授權的一次性商品菜單及圖片匯入與發布：來源 64 商品／103 規格／8 分類；保留原資料後 65 商品／9 分類；63 圖片參照、58 去重檔案。圖片位於排除 Git 的 `public/catalog-images/`，部署與備份須另保留；來源有一商品缺圖，正式選項與名稱仍須核對。

本次營運功能、migration、configure、備份工具及文件不擴張匯入授權：會員、卡片、錢包、歷史訂單、收支、庫存、供應商均未授權匯入；`adjustWallet` 不可代替未核准的舊餘額開帳。私密來源與回執留在排除 Git 的 `private/posapp-audit/`，不將個資、憑證或來源明細寫入公開文件。未建立常設 PosApp 同步或官方 API 契約；未驗證舊系統可作持續營業／回退。上線前清測試資料仍須另核時間、範圍及保留項目。
