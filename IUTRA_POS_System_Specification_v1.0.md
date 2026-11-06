# IUTRA POS 系統規格書

版本 v1.0｜2026-11-05｜繁體中文審閱版

依據：IUTRA_POS_Development_Plan_v1.0.docx

中央資料庫：PostgreSQL（使用者已確認；環境與既有結構待提供）

文件用途：需求審閱、系統設計、開發估工與驗收基準草案。本文件不代表系統已實作、設備已相容、銀行服務已串接或全部營運政策已核准。

> **2026-11-06 需求更新，優先於下文衝突內容：**目前一間門市，未來計劃展店；收銀員使用一個非管理員帳號；顧客螢幕須支援唯讀顯示與觸控點餐兩種模式，因未來分店不一定具備觸控設備。模式設定粒度與切換方式、具體允許哪些點餐操作、雙屏同時操作如何處理、該收銀帳號是否由多人共用及如何記錄交接，仍待釐清。下文「客顯唯讀／不可改單」和「禁止共用未具名收銀帳號」為舊版描述，不能視為最新已確認需求。使用者現有 PostgreSQL 將繼續用於上線，並計畫上線前清除測試資料；清除的時間、範圍及應保留資料尚未確認，不能據此直接執行清除。

## 01 文件控制與需求基線

### 1.1 版本與適用方式

| 項目 | 說明 |
| --- | --- |
| 文件編號 | IUTRA-SRS-001 |
| 版本／日期 | v1.0／2026-11-05 |
| 系統 | IUTRA 多店手搖飲 POS 與總部管理系統 |
| 本版新增確認 | 中央後端資料庫採 PostgreSQL；由使用者後續提供資料庫相關資訊 |
| 範圍效力 | 原開發計劃轉為可檢查的系統規格；新增資料模型與 API 均為設計建議 |
| 修訂原則 | 已確認事項改動需另記決策；設計建議經審閱後才能升級為核准基線 |
| 未執行事項 | 未建置應用程式、資料庫或正式遷移；未驗證實機、銀行到帳與電子發票服務 |

本文件與原計劃書有差異時，已明確取得的使用者指示優先，其次為已確認需求。其餘差異記入決策清單，不能以本文件的技術細化暗示營運方已同意某項政策。

### 1.2 狀態與階段標記

| 標記 | 意義 | 使用方式 |
| --- | --- | --- |
| C 已確認 | 使用者已明確確認的需求 | PostgreSQL、金額儲值、雙屏職責、後台商品及銀行設定等 |
| P 原計劃提案 | 原計劃書提出的功能、規則或目標 | 首版功能包、離線現金、人工核帳、備份目標等 |
| D 設計建議 | 本規格為使開發可落地而補充 | 資料表、端點、狀態代碼、冪等與鎖定實作方式 |
| T 待確認 | 需營運、工程或服務商確認 | 退款政策、跨店清算、會員驗證、硬體介面等 |
| V1 首版候選 | 原計劃首版與本版建議實作範圍 | 先單店試點，資料結構保留多店能力 |
| NEXT／COND | 後續／條件式納入 | 外送、進階行銷；試點必要的電子發票等須提前處理 |

同一需求可標 C/P/D：代表核心意圖已確認，但詳細流程或技術方案仍是提案。本文「應」「不得」描述採用該提案後的預期行為，不改變此處的確認狀態。未逐項另標之第 5–9 章技術細節均為 D，並受對應 P/T 業務決策約束。

### 1.3 來源編號

| 來源 | 原文件主題／補充 | 對應本規格 |
| --- | --- | --- |
| S01 | 專案定位與需求基線 | 第 1、2、12 章 |
| S02 | 門市操作與雙螢幕 | 第 4、5、8、10、11 章 |
| S03 | 商品與多店資料 | 第 4、6、7、11 章 |
| S04 | 銀行 QR 與付款 | 第 4–7、11 章 |
| S05 | 會員儲值與交班 | 第 3–7、11 章 |
| S06 | 設備驗證與系統架構 | 第 2、8、12 章 |
| S07 | 介面與視覺規範提案 | 第 10 章 |
| S08 | 營運完整性與補充需求 | 第 3、6、8、9、11 章 |
| S09 | 執行計劃與投入 | 第 11、12 章 |
| S10 | 驗收與切換 | 第 11 章 |
| S11 | 決策紀錄與參考依據 | 第 1、12 章 |
| U01 | 本次使用者指定 PostgreSQL，後續提供 | 第 2、6、12 章 |

來源 S01–S11 均引用原 Word 文件的主題名稱，不代表原文件有同名數字編號。CLAUDE.md 用於核對確認狀態與證據界線。未取得舊 PosApp API、資料庫定義、完整菜單或歷史匯出；本設計不依賴這些資料。

### 1.4 系統邊界與術語

V1 候選包含：商品與選項後台、基本多店權限、店員 POS、獨立唯讀客顯、現金、銀行 QR 與人工核帳、會員金額儲值、杯貼／收據、交班、匯入匯出、離線現金、同步、稽核及備份。先在一間店試營運，實際門市數量待確認。

NEXT 包含：配方、半成品、完整庫存與採購、跨店調撥、手機自助點餐、外送平台、進階行銷及混合付款。COND 包含銀行自動到帳與電子發票；如為試點必要條件，須取得介面與適用判定後提前納入，不得用一般收據代替法定發票。

| 術語 | 本文件定義 |
| --- | --- |
| 營運主體／組織 | 對資料與資金負責的邊界；是否有多公司或加盟關係待確認 |
| 門市／設備／班次 | 分別標識營業地點、實體 POS 裝置與現金責任期間 |
| 訂單／付款請求 | 訂單記錄購買內容；付款請求記錄某次鎖定金額及收款方式 |
| 收款／退款 | 收款為已確認的資金事實；退款另有申請、保留額、執行與完成紀錄 |
| 錢包／流水 | 金額型儲值帳戶與不可任意覆寫的餘額變動紀錄 |
| 客顯 | 顧客副螢幕，只顯示允許公開的當前交易資訊 |
| 冪等 | 相同業務操作重試後只產生一次財務效果 |
| 快照 | 保留交易當時的商品、價格、選項或銀行資訊，避免日後設定改動影響舊單 |
| 營業日 | 依門市時區及營業日切點計算的歸帳日期，與 UTC 日期不同 |

## 02 系統架構與責任

### 2.1 邏輯組成

中央資料庫 PostgreSQL 為 C/U01。下列其餘分層為 D，沿用 S06 的模組化中央服務及本機作業方向；不指定尚未核准的前後端框架。

| 元件 | 核心責任 | 邊界 |
| --- | --- | --- |
| 店員 POS | 選品、計價、結帳、會員驗證、班次、設備狀態 | 不直接連中央資料庫；不可由客顯反向修改交易 |
| 客顯模組 | 訂單摘要、金額、QR、完成或異常提示 | 只訂閱白名單投影，不鏡像完整主屏 |
| 本機持久化 | 已發布菜單、現金訂單、同步與列印佇列 | 不作中央錢包餘額的可離線扣款副本 |
| 設備轉接層 | 獨立顯示、收據、杯貼、錢櫃 | 依實測採 SDK／指令協定，不假定各機型相容 |
| 總部網頁後台 | 商品發布、銀行設定、權限、查詢、對帳、匯出 | 所有資料請求經 API 權限檢查 |
| 中央 API 服務 | 交易規則、授權、冪等、錢包、退款、同步 | 建議模組化單體；共用 PostgreSQL 交易界線 |
| PostgreSQL | 主資料、正式交易、帳本、稽核、事件待送箱 | 僅後端及受控維運可存取；測試與正式環境分離 |
| 外部介接 | QR 編碼／銀行、電子發票、簡訊等 | 接入前驗證服務商與合約；失敗不抹除收款事實 |

資料流：後台設定經 API 寫入 PostgreSQL，發布版本後由門市下載。門市同機狀態直接驅動主副屏。線上結帳經 API 持久化交易；離線現金先在本機提交，再補傳。列印由已持久化的交易事件驅動，與銀行或錢包交易解耦。

### 2.2 架構限制

Android 原生／原生橋接、Kotlin 外殼、TypeScript 網頁後台及本機資料庫種類均為候選，須通過獨立雙屏與中越文列印驗證後選定。PostgreSQL 是資料儲存選型，並未一併指定後端語言、API 框架或部署供應商。

付款、錢包與退款由中央服務掌握交易規則；前端金額不可直接作為未核對的入帳依據。線上新單依已發布版本驗證；離線歷史成交依其有效快取版本與當時快照驗證，不能套用最新價格重算。

不預設使用者提供的是空資料庫。收到 PostgreSQL 環境後，先盤點版本、schema、既有資料與可變更範圍，再決定新建 schema 或映射既有結構；須先備份與審閱遷移，不直接覆寫。

## 03 角色、權限與稽核

### 3.1 角色矩陣建議

狀態 P/D；來源 S03、S05、S08。下列是建議角色模板，實際權限可拆分授予；帳務負責人等驗收角色不自動變成系統角色。

| 操作 | 店員 | 店長／主管 | 總部／系統管理 |
| --- | --- | --- | --- |
| 開單、收現金、列印 | 本設備授權班次 | 本店 | 按門市授權 |
| 銀行人工核帳 | 另授核帳權限 | 本店核帳權限 | 指定門市核帳權限 |
| 查會員、使用儲值 | 遮罩查詢＋會員驗證 | 同規則 | 不因管理職免驗證 |
| 特殊折扣、退款 | 提出申請 | 限額及門市內核准 | 依資金權限核准 |
| 錢包人工調整 | 禁止 | 原則不授予 | 專屬帳務權限＋理由 |
| 商品／價格發布 | 無；可授售罄 | 本店售罄／允許的覆寫 | 共用菜單及發布 |
| 銀行帳戶變更 | 禁止 | 原則禁止 | 專屬權限＋重新驗證 |
| 關班與報表 | 本班／本人範圍 | 本店 | 授權跨店 |
| 會員／帳務匯出 | 預設禁止 | 限必要欄位 | 專屬匯出權限 |
| 帳號、設備、備份管理 | 禁止 | 可申請停用設備 | 系統維運；不自動含退款權 |

### 3.2 AUTH-01 存取與門市隔離

狀態 P/D，V1。前置條件為有效使用者、有效設備及授權範圍。後端從登入身分與設備綁定解析組織／門市，檢查 URL、查詢條件及每筆物件的 scope；不得信任客戶端傳入的 store_id 即放行。未登入回 401，權限不足回 403；對不應揭露存在性的跨範圍物件統一回 404。

禁止共用未具名收銀帳號。交接操作者須切換身分；主管覆核記錄申請人與核准人，不以借用主管登入取代核准紀錄。退款限額、折扣限額及是否要求雙人覆核列 T-06。

### 3.3 AUD-01 稽核規則

敏感事件至少記錄 event_id、時間、組織／門市、設備、操作者、必要時核准人、動作、物件 ID、原因、前後差異摘要及 request_id。改價、銀行變更、退款、調整、補印、開櫃、權限與匯出均受稽核。

稽核不寫入 PIN、OTP、密碼、完整連線字串或完整銀行憑證。一般應用帳號無刪除稽核及改寫帳本權限；正式維運權限另管控。離線稽核先本機持久化，補傳時保留發生時間與中央接收時間。

## 04 功能需求

### 4.1 CAT-01 商品、容量與配料

狀態 C/P/D，V1；來源 S01、S03。角色為總部商品管理者及受限門市管理者。輸入包含中越文名稱、分類、圖片、啟用狀態、適用門市、容量、完整售價、配料售價、販售單位及份數上限。

每個商品容量是一個可售規格，直接綁定完整售價；容量價格不是加到另一個基礎價上的差額。配料依份數計價。停售採停用或版本變更，不刪除已被交易引用的資料。圖片失敗不影響文字點餐。

驗收：烏龍茶 700 ml 售價 24,000đ，加一份 5,000đ 配料為 29,000đ。500 ml 為 22,000đ。這些僅為來源截圖的測試範例，正式菜單需另確認。

### 4.2 CAT-02 選項、單位與計價

狀態 P/D/T，V1；來源 S03。選項群組含甜度、杯內冰量、另附冰等，可設定必選、預設、最少／最多選擇及互斥條件。配料限制須同時檢查商品適用性、售罄與數量上限；無效組合不得送出結帳。

建議 V1 飲品杯數與配料份數為正整數，其他可售單位日後若需小數，必須先定義精度及捨入。庫存單位、販售單位及換算關係分離，不把一份假設成固定 g 或 ml。不加冰是否補茶、另附冰是否加價均為待定營運規則。

計價建議：明細原價＝杯數 ×（容量完整售價＋每杯配料份數 × 配料單價之合計）；訂單原價＝明細原價合計；應付額＝原價－核准折扣＋經核准的稅／費用。金額以整數 VND 計算；未設定的稅費不得憑空加入，依法必須者需在試點前配置。

折扣順序、可疊加及稅費算法待 T-05/T-08。建議折扣先分配到明細，再按杯分配整數尾差，固定依明細序號由前至後分配餘數，保證分攤總額等於訂單折扣。保存分攤快照供退款使用；正式政策未定前禁用組合折扣。

### 4.3 CAT-03 菜單版本與發布

狀態 P/D，V1；來源 S03、S08。後台先驗證草稿，再建立不可變發布版本。輸入含門市範圍、生效時間與原因；記錄成功、等待與失敗設備。分店售價覆寫須有權限與來源優先序，建議已發布門市覆寫優先於共用價。

離線使用最後已啟用的版本；未確認到達生效時間的版本不能僅憑未校時的裝置時鐘自行啟用。回線下載並確認版本後，新開單採新版本，既有單保留快照。舊單重開或換品時應明確提示重新計價範圍。

### 4.4 POS-01 開單、修改與快照

狀態 C/P/D，V1；來源 S02、S03。前置條件為登入、有效班次與可用菜單。店員選商品、容量、加料、甜度冰量、杯數及備註；同款不同規格分開明細。複製後的明細須可獨立修改。

保存品名、容量、單位、單價、每杯配料、選項、折扣分攤及菜單版本快照。內部備註與可對顧客展示的備註分欄。結帳後鎖定版本與金額；已收款訂單不得直接改價，需走退款、補收或重開的授權流程。補收屬獨立關聯交易，具體操作需 T-06 核准。

POS-02 取消：未收款且無資金結果不明時可取消，必填原因；有付款嘗試時撤下 QR 並終止該請求。已收款以退款處理；資金結果不明先查原交易，不允許立即換付款方式再扣一次。

### 4.5 DISP-01 雙螢幕

狀態 C/P/D，V1；來源 S01、S02。店員主屏可操作，客顯唯讀且獨立顯示。即使副屏具觸控，亦不暴露新增、刪除、改價、確認付款或管理操作。

客顯白名單包含當前訂單識別、商品名稱與規格、杯數、公開備註、折扣、總額、取餐號、必要遮罩會員資訊，以及適用時的銀行／戶名／金額／QR。禁止傳入密碼、完整電話、營收報表、銀行管理頁、會員驗證碼及內部備註。

正常同機更新目標為 1 秒內（P，須實測）。副屏斷線時主屏警示，不能顯示「QR 已展示」；重連先清空再取當前快照。完成後短暫顯示取餐號，清除客戶資料；停留秒數屬可設定提案。

### 4.6 PAY-01 現金收款

狀態 P/D，V1；來源 S04、S05。店員輸入實收金額；實收小於應付額時阻擋完成，實收大於或等於時算找零。保存應付、實收、找零及付款操作者。現金財務入帳額為應付額，不是顧客交付的紙鈔額。

收款與本機／中央持久化完成後才顯示成功、安排列印及必要開櫃。失敗或回應逾時須先查原請求；重按不得重複產生收款。離線現金依第 8 章處理。

### 4.7 PAY-02 銀行設定與 QR

狀態 C/P/D，V1；來源 S01、S04。授權管理者設定銀行、帳號及收款戶名；建議保存銀行識別、門市範圍、生效狀態、驗證結果及版本。啟用前應核對帳號與實際收款戶，不以格式正確代表可收款。

店員選銀行付款後，建立付款請求，鎖定訂單版本、金額、幣別與銀行版本，產生對應 QR。VietQR 為候選格式，仍須確認銀行及實掃相容性。銀行設定變更影響新請求，舊請求保留當時資訊供追查。

改單、取消或切換付款方式時，先終止舊請求並撤碼，再建立新識別。收款完成立即撤碼。QR 到期只是系統停止接受該請求的自動匹配條件，不能阻止銀行轉帳。

### 4.8 PAY-03 人工核帳與異常

狀態 P/D，V1；來源 S04。前置條件為具名操作者有核帳權限，且已從店家銀行到帳紀錄核對戶名／帳戶、金額、時間與付款識別。輸入銀行交易識別、實際入帳額、核對時間與備註；不得僅憑顧客截圖或掃碼動作確認成功。

同銀行帳戶下同一銀行交易識別只能認列一次。若無可靠唯一交易識別或無法確定所屬付款請求，先建立待核對款，不直接確認。V1 不提供任意分攤一筆轉帳至多張訂單；如需分攤另設計核帳分配模型。

少付、多付、重複付款、過期碼晚到、取消後到款及通知遲到均記為異常。異常資料記錄實際資金事實、候選訂單及人工處置，不能靜默忽略或自動套入新單。尚無可靠銀行識別時保存觀察金額、幣別、收款帳戶及觀察時間；取得識別後關聯經去重的正式銀行交易，合併重複觀察，不能因此新增第二次收款。少付／多付的補款、退差額及訂單放行政策待 T-03/T-06；未定前不自動標成正常已付。

PAY-04 自動通知為 COND。若啟用，須檢查簽章／來源、帳戶、金額、幣別、交易識別與重放；只有與有效請求明確匹配才認列。事件先可靠保存再回應服務商，重複事件無第二次財務效果。

### 4.9 MEM-01 會員與使用驗證

狀態 P/D/T，V1；來源 S05。支援會員識別資料與停用狀態；電話、會員碼或卡片的正式選擇待 T-04。查到會員不等於可扣款，需 PIN、OTP 或經核准的驗證方式。驗證失敗次數與鎖定規則須在上線前設定。

只提供必要遮罩資料給客顯；完整個資查閱及匯出另受授權。會員停用不刪除帳務歷史。驗證憑證不以明碼存入一般會員欄位或日誌。

### 4.10 WAL-01 儲值入帳與消費

狀態 C/P/D，V1；來源 S05。錢包以金額儲值，新增及消費皆需中央連線。儲值必須先確認現金或銀行收款；儲值收款目的標記為 topup，不能再用同筆資金建立第二次入帳。

已確認儲值收款、錢包增加及帳本追加，在同一 PostgreSQL 交易提交。若資金已到但無法完成入帳，資金核對事實保留並顯示待入帳；重試同業務識別，不重新收款。

消費前核對會員驗證、錢包狀態、門市可用範圍及餘額。以原子交易完成餘額扣減、消費流水、付款與訂單狀態；餘額不足整筆拒絕。網路逾時保持「結果待確認」，查原操作後再繼續，不能把逾時當成失敗而改收現金。

同營運主體共用錢包僅為提案，跨店功能預設未啟用，待政策與清算責任確認後開放。本金與贈金資料預留分帳；V1 建議只啟用本金，贈金規則未定時餘額固定為零，不提供贈送活動。

### 4.11 WAL-02 調整、舊餘額與退款

狀態 P/D/T，V1；來源 S05。禁止直接覆寫餘額。調整須專屬權限、原因、來源憑證及必要覆核，新增正負向流水；修正使用沖正或補正，不刪除原流水。

舊餘額移轉只接受可核實名單及憑證，經負責人核准後建立有來源批次的 opening 流水；相同來源明細不得重複匯入。無佐證的金額列待核對，不推估。缺乏舊 PosApp 匯出不是自動補額的理由。

訂單退款與儲值本金退回是兩種不同業務。前者回沖原消費並按核准方式歸還；後者涉及已儲本金能否退現、贈金限制及帳務責任。T-04 未決前，不開放自助本金退回。

### 4.12 REF-01 訂單退款

狀態 P/D/T，V1；來源 S04、S05、S08。輸入原訂單／收款、退款明細或金額、原因與核准資料。建議支援全額及明細級部分退款，但是否啟用部分退款、權限與退款期限仍待 T-06。

退款額以原交易快照與已保存折扣分攤計算，不能按現價。累計已完成及已保留的退款不得超過原可退額。申請獲准後保留退款額；待銀行轉帳、現金交付或錢包入帳真正完成才標 succeeded。執行逾時列 unknown，不釋放額度，也不另開一次退款。

現金退款記錄執行班次與交付確認；銀行退款記錄實際交易識別；錢包退款關聯原扣款，限制回入原資金類別。結果不明先核對原操作。尚未執行的退款可取消，若已保留額度須同一交易釋放；processing／unknown 不得直接取消，須核實未付款才可判失敗並釋放。已成功退款不能直接改為取消。

退款與製作狀態分離。已製作商品不自動回補實體庫存；未來庫存模組以報廢、損耗或核准沖回處理。已付訂單退款後保留原銷售與負向退款事實。

### 4.13 PRN-01 列印與錢櫃

狀態 P/D，V1；來源 S02、S06、S10。預設收款成功後產生杯貼與收據工作；每杯可用穩定識別區分。杯貼包括取餐號、杯序、品項、容量、甜度冰量及配料；收據包括店名、訂單識別、明細、折扣、總額及付款方式，正式版型與紙寬待實機確認。

補印需權限、原因及次數，明顯標記「補印」。缺紙可重試未執行工作；送出後連線中斷屬結果未知，先請店員核對，不能無限制自動再送。不能以軟體唯一鍵保證實體紙張只印一次。

現金結帳與主管手動開櫃各自留紀錄。開櫃失敗不撤銷收款；付款重試不再次自動開櫃，必要時依手動授權處理。

### 4.14 SHIFT-01 班次、現金與報表

狀態 P/D，V1；來源 S05、S10。開班輸入備用金與責任人；建議每台設備同時僅一個開啟班次，是否多人共用須營運確認。現金收支須分類、金額與原因，不可借由一般收支改寫銷售或儲值。

預期現金＝備用金＋現金銷售＋現金儲值＋其他核准流入－現金退款－其他核准流出。實收鈔票減找零後才是現金銷售入櫃額；銀行、錢包付款不混入現金實收。關班保存實點、預期額、差異、說明及確認人。

飲品銷售、銷售退款、儲值收款、儲值消費、銀行轉帳與待核對款分別呈現，禁止將儲值收款與之後消費重複計為銷售。報表同時區分發生時間、營業日與同步狀態。

離線可先本機關班，但標示待同步；中央缺交易時不能出具「對帳完成」。班次所有交易已確認接收後封存中央報表，晚到更正以調整紀錄或新版本報表呈現，不默改已簽認結果。

### 4.15 DATA-01 匯入匯出

狀態 P/D，V1；來源 S03、S05。商品、容量價格、配料與選項提供欄位範本及預檢結果；錯誤列示原列號、欄位與原因，預設整批驗證通過後套用，不做未告知的半批更新。

訂單、錢包流水、班次與核帳異常可依授權範圍匯出。匯出附時間範圍、幣別、時區與篩選條件；會員個資依權限遮罩。CSV／試算表輸出需防止名稱或備註成為可執行公式，並保存匯出稽核。

## 05 狀態模型與交易流程

### 5.1 訂單與資金狀態分離

狀態 D；來源 S02、S04、S05。訂單狀態記錄操作進度，收款與退款各有獨立資金事實，製作／列印／發票不共用同一個完成旗標。

| 對象 | 狀態／允許轉移 | 關鍵限制 |
| --- | --- | --- |
| 訂單 | draft → awaiting_payment → completed；未收款可 cancelled | awaiting_payment 回 draft 前須終止舊請求，且無資金結果不明 |
| 付款請求 | pending → processing → succeeded；pending 可 cancelled／expired；processing 可 failed／unknown | succeeded 不撤銷；unknown 需查核後轉 succeeded／failed |
| 銀行待收 | pending → succeeded，或轉異常處理 | 少付、多付、晚到不能直接轉正常成功 |
| 退款 | requested → approved → processing → succeeded／failed／unknown；未核准可 rejected；尚未執行可 cancelled | unknown 保留額度；未執行取消或核實未付款的明確失敗，在同一交易釋放保留額 |
| 製作 | not_started → preparing → ready → handed_over；可記 stopped／wasted | 退款不自動回到未製作 |
| 列印 | queued → sending → printed／failed／unknown | unknown 核對後補印；補印為新工作且關聯原工作 |
| 同步 | local_committed → queued → sending → acknowledged／conflict | acknowledged 後可保留資料再依政策清理 |
| 發票（條件式） | not_required／pending／issued／failed／void_pending／voided | 發票失敗不將已收款訂單變回未付 |

訂單 payment_summary 由收款及退款推導為 unpaid、pending、paid、partially_refunded、refunded 或 exception。若作為快取欄位，須與帳務交易同步更新並可重建，禁止前端直接覆寫。

### 5.2 現金與銀行主流程

現金：選品 → 保存快照 → 鎖定結帳版本 → 輸入實收與找零 → 持久化收款及現金流水 → 完成訂單 → 列印／開櫃事件 → 清除客顯。離線時前段在本機交易中完成，回線補傳後保留同一業務識別。

銀行：保存訂單 → 建立含銀行快照的付款請求 → 客顯確認展示 → 顧客轉帳 → 店員核對店家銀行紀錄 → 去重與金額核對 → 原子認列收款及完成訂單 → 撤碼／列印。找不到明確匹配時移入異常佇列，不能要求系統「先當成已付」。

等待付款改單需先檢查原操作是否 processing／unknown；若是，先查核。若尚未發生資金操作，終止舊請求、撤碼、增加訂單版本，再產生新請求。任何舊款仍有原始記錄與處置路徑。

### 5.3 儲值扣款與重試時序

建議 API 使用 scoped Idempotency-Key。首次請求驗證授權、會員驗證及內容雜湊；在 PostgreSQL 交易內鎖定訂單與錢包，檢查餘額與門市政策，寫入扣款流水、餘額、付款與訂單結果，再提交。任何一步失敗全部回滾；提交成功但回應丟失時，以同鍵取回原成功結果。

所有相關交易採固定鎖定順序以降低死結；死結／序列化失敗可由服務端有限次重試整個交易，不能只重試部分寫入。逾時未決由狀態查詢解除，不在 UI 重建另一筆請求。

### 5.4 財務不變量

| 編號 | 不變量 | 驗證方式 |
| --- | --- | --- |
| INV-01 | 每次已確認收款、錢包變動及退款效果只有一次 | 業務唯一鍵＋冪等結果＋重送測試 |
| INV-02 | 錢包可用本金／贈金不得為負數 | 列鎖或條件更新＋CHECK＋併發測試 |
| INV-03 | 現有餘額等於有效流水累積結果 | 開帳／調整皆入流水；每日對帳與還原核對 |
| INV-04 | 退款成功額＋未決保留額不超過可退款額 | 鎖定原付款並檢查保留與成功紀錄 |
| INV-05 | 歷史應付與折扣分攤不隨商品改價變動 | 訂單快照與退款測試 |
| INV-06 | 一筆來源資金不可重複入儲值或同時當銷售收款 | 收款 purpose 與 funding_payment 唯一關聯 |
| INV-07 | 門市／組織關聯一致 | 複合外鍵、服務授權與跨店負向測試 |
| INV-08 | 列印、發票與通知失敗不抹除已收款事實 | 交易外事件待送箱與故障測試 |

## 06 PostgreSQL 資料規格

### 6.1 通用規則

PostgreSQL 為 C/U01，實際版本與部署待提供。本章 schema、表名、型別與約束均為 D，供後續對接時審閱，並非宣稱資料庫已存在。

| 類別 | 建議規格 |
| --- | --- |
| 識別 | 主鍵 UUID，由服務／裝置依責任產生；裝置交易 ID 必須可在離線生成且避免碰撞 |
| 金額 | VND 使用 bigint 整數；金額不得使用 real／double precision；業務上限另設且避免溢位 |
| API 金額 | 以十進位字串傳送，例如 "29000"，避免 JavaScript 大整數精度損失 |
| 數量／換算 | 飲品杯數 integer；配料規格依核准單位，換算用 numeric(18,6)，不得浮點累加 |
| 時間 | 事件與稽核用 timestamptz；營業日另存 date；門市時區預設建議 Asia/Ho_Chi_Minh |
| 共同欄位 | id、organization_id、created_at 必填；可變主資料加 updated_at、version；交易加 occurred_at、received_at |
| 字串 | 名稱 text 加長度驗證；幣別 char(3) 限 VND；狀態 text 加 CHECK 或受控參照表 |
| JSONB | 僅放版本化快照、非核心選項與事件內容；金額、關聯與核心狀態使用明確欄位 |
| 空值 | 下表未標 ? 的核心欄位必填；? 代表 nullable，且仍受情境約束 |
| 刪除 | 交易、帳本與稽核禁止業務硬刪；主資料停用，關鍵外鍵 ON DELETE RESTRICT |
| 多店隔離 | 子表帶 organization_id；門市資料帶 store_id；使用組織＋物件 ID 複合外鍵防串接到他組織 |
| 版本衝突 | 可變訂單／設定用 version 條件更新；失敗回衝突並重讀，不覆蓋他人修改 |

### 6.2 實體關係摘要

組織包含門市、會員及主資料；門市包含設備與班次。商品有多個容量規格並套用選項群組；發布版本將商品／選項／門市價格整理為不可變內容。訂單包含明細及加料／選項快照，對應付款請求、收款與退款。會員對應錢包，錢包對應追加式流水；儲值及退款各關聯原資金事實。

班次對應現金收支與交易。列印工作引用訂單快照；同步事件引用裝置與本機交易 ID。稽核記錄使用者操作；事件待送箱保存已提交交易待通知的事件。

### 6.3 組織、權限與商品資料字典

以下列核心欄位，通用欄位依 6.1 繼承。顯示標籤可翻譯，API 與資料庫代碼保持穩定。

| 表 | 核心欄位與型別 | 主要約束／用途 |
| --- | --- | --- |
| organizations | name:text；status:text | 法人／營運邊界待確認；先支援單一組織 |
| stores | code:text；name:text；timezone:text；day_cutoff:time；status:text | UNIQUE(organization_id, code)；時區及營業日切點需有效 |
| devices | store_id:uuid；device_code:text；status:text；credential_ref:text；last_seen_at?:timestamptz | 組織內設備碼唯一；憑證僅保存安全參照或雜湊 |
| users | login_name:text；display_name:text；auth_ref:text；status:text | 組織內登入名稱唯一；不存明碼密碼 |
| roles | code:text；name:text | 組織內 code 唯一 |
| role_permissions | role_id:uuid；permission_code:text | UNIQUE(role_id, permission_code) |
| user_role_scopes | user_id:uuid；role_id:uuid；scope_kind:text；store_id?:uuid | organization 範圍時 store_id 為空；store 範圍時必填；以分別部分唯一索引防重 |
| categories | code:text；name_zh:text；name_vi:text；sort_order:integer；active:boolean | 名稱必填語言依正式語言政策驗證 |
| products | category_id:uuid；code:text；name_zh:text；name_vi:text；image_ref?:text；active:boolean | 組織內商品碼唯一；停用不影響舊單 |
| product_variants | product_id:uuid；code:text；capacity_value:numeric(18,6)；capacity_unit:text；base_price:bigint；active:boolean | 售價非負；容量值正數；規格碼唯一 |
| units | code:text；label_zh:text；label_vi:text；dimension:text | 份、杯、g、ml 等分類；不同維度不得直接換算 |
| unit_conversions | item_kind:text；item_id:uuid；from_unit:text；to_unit:text；factor:numeric(18,6)；version:integer | factor > 0；物件型別關聯由服務驗證；僅保留後續換算能力 |
| toppings | code:text；name_zh:text；name_vi:text；sale_unit:text；price:bigint；max_portions:integer；active:boolean | 售價非負、上限正數；庫存對應不代表已實作庫存 |
| product_toppings | product_id:uuid；topping_id:uuid；max_portions:integer | 同商品配料唯一；覆寫上限仍需合理 |
| option_groups | code:text；kind:text；min_select:integer；max_select:integer；active:boolean | 0 ≤ min_select ≤ max_select；互斥規則須版本化 |
| option_values | group_id:uuid；code:text；label_zh:text；label_vi:text；active:boolean | 群組內 code 唯一；加價如需要須顯式設計，不能暗中套用 |
| product_option_groups | product_id:uuid；group_id:uuid；defaults:jsonb；rules:jsonb | 組合唯一；預設值須屬群組且符合規則 |
| store_catalog_overrides | store_id:uuid；entity_kind:text；entity_id:uuid；price?:bigint；sold_out:boolean；effective_at:timestamptz | 門市與物件關聯驗證；改價授權與版本由服務控制 |
| menu_releases | release_no:text；schema_version:integer；content:jsonb；content_hash:text；published_at:timestamptz | 發布後不可改；保留計價驗證所需完整內容 |
| store_menu_assignments | store_id:uuid；release_id:uuid；effective_at:timestamptz；status:text | 每店啟用版本由明確啟用事件決定 |
| device_menu_acks | device_id:uuid；release_id:uuid；downloaded_at:timestamptz；activated_at?:timestamptz | UNIQUE(device_id, release_id)；追蹤發布落地 |

unit_conversions、store_catalog_overrides 等具多型引用的表不能依一般外鍵同時指向多種資料表；實作時應改為明確類型子表或受控服務驗證。本版保留概念欄位，不宣稱已形成完整可執行 DDL。

### 6.4 訂單、付款與帳務表概覽

| 表 | 核心欄位與型別 | 主要約束／用途 |
| --- | --- | --- |
| shifts | store_id:uuid；device_id:uuid；opened_by:uuid；opened_at:timestamptz；closed_at?:timestamptz；opening_cash:bigint；counted_cash?:bigint；status:text | 同設備 open 班次部分唯一；關班與對帳狀態分離 |
| orders | store_id:uuid；device_id:uuid；shift_id:uuid；client_order_id:uuid；business_date:date；menu_release_id:uuid；status:text；version:integer；subtotal:bigint；discount:bigint；tax_fee:bigint；total:bigint；currency:char(3) | UNIQUE(organization_id, device_id, client_order_id)；total = subtotal - discount + tax_fee；非負 |
| order_items | order_id:uuid；line_no:integer；product_variant_id:uuid；quantity:integer；unit_price:bigint；line_subtotal:bigint；discount_allocated:bigint；tax_fee_allocated:bigint；line_total:bigint；snapshot:jsonb；internal_note?:text | UNIQUE(order_id, line_no)；quantity > 0；包含 per-cup 分攤快照供退款 |
| order_item_options | order_item_id:uuid；kind:text；source_id?:uuid；quantity:numeric(18,6)；unit_price:bigint；snapshot:jsonb | kind 區分配料／選項；不依來源現值重算歷史 |
| bank_accounts | store_scope:jsonb；bank_code:text；account_number:text；account_name:text；status:text；version:integer；verified_at?:timestamptz | 完整帳號只供授權與 QR 需要；每次變更新增版本或版本快照 |
| payment_requests | order_id?:uuid；topup_id?:uuid；purpose:text；method:text；amount:bigint；currency:char(3)；status:text；order_version?:integer；bank_snapshot?:jsonb；expires_at?:timestamptz | 目的 sales/topup；order_id 與 topup_id 恰有一個；有效請求限制見 6.6 |
| payments | request_id:uuid；purpose:text；method:text；amount:bigint；status:text；confirmed_by:uuid；confirmed_at:timestamptz；bank_transaction_id?:uuid；wallet_entry_id?:uuid；cash_tendered?:bigint；change_given?:bigint | 只記已確認資金；每 request 單一成功收款（V1 無混合付款） |
| bank_transactions | bank_account_id:uuid；external_ref:text；amount:bigint；currency:char(3)；booked_at:timestamptz；observed_by?:uuid；source:text | UNIQUE(organization_id, bank_account_id, external_ref)；來源可人工核實或服務商 |
| payment_exceptions | bank_transaction_id?:uuid；request_id?:uuid；bank_account_id?:uuid；observed_amount?:bigint；currency?:char(3)；booked_at?:timestamptz；observed_at:timestamptz；kind:text；status:text；resolution?:jsonb；assigned_to?:uuid | short/over/duplicate/late/unmatched；無銀行識別時必填觀察金額、幣別及收款帳戶；實際到帳時間未知可空，另保留觀察時間 |
| members | member_code:text；display_name?:text；phone_normalized?:text；auth_ref?:text；status:text | 組織內會員碼唯一；電話是否唯一取決於會員政策 |
| wallet_topups | member_id:uuid；wallet_id:uuid；store_id:uuid；shift_id:uuid；amount:bigint；status:text；funding_payment_id?:uuid | funding_payment_id 非空時唯一；status 區分 awaiting_funds/credited/exception |
| cash_movements | shift_id:uuid；kind:text；direction:text；amount:bigint；source_kind:text；source_id:uuid；reason?:text | 財務來源唯一映射；銷售/儲值/退款不重複新增一般收支 |
| production_records | order_item_id:uuid；cup_no:integer；status:text；changed_by:uuid；changed_at:timestamptz | UNIQUE(order_item_id, cup_no)；狀態與退款分離 |

訂單各明細合計與訂單總額、付款與目的金額一致，屬跨列不變量，不能只靠單列 CHECK。以服務端同一交易、鎖定與必要約束觸發器維護，並以對帳查詢驗證。資料庫外鍵也須檢查班次、設備及門市一致。

### 6.5 錢包與退款詳細欄位

wallet_accounts：每筆帳戶對應一會員與明確使用範圍。以下核心欄位均非空，store_id 為條件式空值。

| 欄位 | 型別／空值 | 規則 |
| --- | --- | --- |
| id／organization_id／member_id | uuid／必填 | 主鍵與同組織會員外鍵 |
| scope_kind／store_id | text；uuid? | organization 或 store；僅店限定時 store_id 必填 |
| currency | char(3) | VND；同帳戶不得混幣 |
| principal_balance | bigint | ≥ 0；本金可用餘額 |
| bonus_balance | bigint | ≥ 0；V1 未啟用贈金時為 0 |
| status／version | text；integer | active/frozen/closed；原子更新版本 |
| created_at／updated_at | timestamptz | 伺服器時間 |

同會員同組織錢包與同會員同店錢包分別用部分唯一索引防重，避免 nullable store_id 使一般 UNIQUE 失效。是否允許兩種範圍同時存在、如何移轉錢包，須於跨店政策核准後設計；V1 不自動合併。

wallet_entries：追加式帳本，無業務 UPDATE／DELETE。以下 principal_delta、bonus_delta 為帶正負號整數，其餘財務金額依語意非負。

| 欄位 | 型別／空值 | 規則 |
| --- | --- | --- |
| id／organization_id／wallet_id | uuid／必填 | 同組織錢包外鍵 |
| entry_kind | text／必填 | opening/topup/debit/refund/adjustment/reversal |
| principal_delta／bonus_delta | bigint／必填 | 兩者不可同時 0；V1 bonus_delta 為 0 |
| principal_after／bonus_after | bigint／必填 | ≥ 0；鎖定帳戶後的快照，便於核對 |
| business_key | text／必填 | UNIQUE(organization_id, business_key)；避免同業務重複入帳 |
| order_id／payment_id／refund_id | uuid? | debit 必填訂單與付款；refund 必填退款；opening／adjustment 可全空但須有下列獨立來源 |
| topup_id／reverses_entry_id | uuid? | topup 必填且唯一；reversal 必填原流水並防超額沖正 |
| import_batch_id／source_line_key | uuid?；text? | opening 必填；同來源明細唯一，保留憑證參照 |
| adjustment_reference | text? | adjustment 必填調整憑證；依政策另填 approval_id |
| store_id／shift_id／actor_id | uuid／必填 | 財務責任來源；系統作業也要有可識別服務主體 |
| reason／approval_id | text?；uuid? | 人工調整必填原因與依政策核准 |
| occurred_at／created_at | timestamptz／必填 | 操作時間與入帳時間 |

payments 與 wallet_entries 若互相引用，應在同一交易中先產生 UUID，使用可延後的外鍵或調整寫入順序，不以永久空外鍵規避一致性。循環引用是否保留於最終 DDL 階段審閱。

refunds：獨立退款工作及退款額度保留。

| 欄位 | 型別／空值 | 規則 |
| --- | --- | --- |
| id／organization_id／order_id | uuid／必填 | 對應原訂單 |
| original_payment_id | uuid／必填 | 原已確認收款；同組織 |
| amount／currency | bigint；char(3)／必填 | amount > 0；幣別同原收款 |
| destination_method | text／必填 | cash/bank/wallet；依核准原資金路徑 |
| status | text／必填 | 第 5 章退款狀態 |
| idempotency_key | text／必填 | 組織與操作範圍內唯一 |
| requested_by／reason | uuid；text／必填 | 原因不可空白 |
| approved_by／approved_at | uuid?；timestamptz? | approved 後必填 |
| executed_store_id／executed_shift_id | uuid? | 現金交付時必填，保留實際執行責任 |
| external_ref／completed_at | text?；timestamptz? | 銀行退款成功時有核對證據；成功必填完成時間 |

refund_items 記錄 refund_id、order_item_id、cup_no 或退款份數、原分攤金額及退款額；同一杯可退額不得重複占用。退款與項目合計在同一鎖定交易驗證。錢包本金退回另用 wallet_redemptions（後續／條件式），不以訂單 refunds 冒充。

### 6.6 工作佇列、索引與完整性

| 表 | 核心欄位 | 約束／策略 |
| --- | --- | --- |
| print_jobs | order_id、device_id、printer_id、document_kind、cup_key?、attempt_no、status、reprint_of?、snapshot、reason? | 同原始文件與杯序只有一個初始工作；補印新 ID 並關聯來源 |
| sync_events | device_id、client_event_id、entity_id、payload_hash、schema_version、status、received_at | UNIQUE(organization_id, device_id, client_event_id)；同 ID 不同內容拒絕 |
| idempotency_records | actor_scope、operation、key、request_hash、status、result_ref?、expires_at? | UNIQUE(organization_id, actor_scope, operation, key)；財務業務唯一鍵長期保留 |
| outbox_events | event_id、aggregate_type、aggregate_id、event_type、payload、created_at、delivered_at?、attempts | 與業務同交易插入；消費端 event_id 去重 |
| audit_events | actor_id、approver_id?、store_id?、device_id?、action、object_type、object_id、reason?、safe_diff、request_id | 追加式；敏感欄位遮罩 |
| approval_requests | action、object_id、requested_by、approved_by?、status、reason、approved_payload_hash | 核准綁定內容與版本；修改內容後重核准 |
| import_batches | kind、source_hash、status、created_by、validation_report、approved_by? | 同一來源明細以穩定鍵防重；不只以檔名判定 |

建議索引：orders(organization_id, store_id, business_date, created_at)；payments(organization_id, confirmed_at)；wallet_entries(wallet_id, created_at, id)；refunds(original_payment_id, status)；audit_events(organization_id, created_at)；未送 outbox／待印工作用狀態部分索引。所有高頻外鍵依實際查詢補索引，先以試點資料做 EXPLAIN 驗證，不預設分區或分片。

付款請求對同一訂單在 pending/processing/unknown 狀態最多一筆，以部分唯一索引及訂單鎖共同防護；同筆訂單已收款後禁止建立第二筆正常銷售收款。終止舊請求必須先確認沒有進行中的錢包／現金資金操作。銀行晚到另入異常，不由此唯一索引阻止記錄真實資金。

CHECK 用於單列非負、合法狀態、互斥空值及基本計算；跨列餘額、退款上限、明細合計與權限必須用交易邏輯驗證。避免將未驗證 JSONB 視為可計價的正式資料。

### 6.7 交易邊界與復原

| 操作 | 同一 PostgreSQL 交易內 | 交易外工作 |
| --- | --- | --- |
| 線上現金結帳 | 鎖訂單、收款、現金流水、完成狀態、稽核、outbox | 實體列印與開櫃 |
| 銀行人工確認 | 銀行去重、請求核對、收款／異常、訂單、稽核、outbox | 實際銀行到帳已在外部發生 |
| 現金／銀行儲值入帳 | 來源收款、儲值狀態、錢包增加、帳本、現金流水（如適用） | 列印、客顯通知 |
| 錢包消費 | 鎖訂單／錢包、扣餘額、流水、付款、訂單、outbox | 列印及通知 |
| 錢包退款 | 鎖原付款／退款／錢包、退款額度檢查、回入流水、完成 | 通知與收據 |
| 銀行／現金退款 | 先保留額度；確認執行結果後另交易完成及記現金流 | 外部轉帳／現金交付不能放在資料庫鎖內等待 |
| 離線單補傳 | 事件去重、完整驗證、訂單明細、收款、現金流水、接收結果 | 不能再次觸發原始列印或開櫃 |

建議一般隔離級別 READ COMMITTED 搭配明確列鎖／條件更新與唯一約束；需要更強隔離時依測試調整，不以全域 SERIALIZABLE 取代業務設計。退款、錢包、結帳皆須測死結及提交後斷線。

資料庫還原後，先停止財務寫入並核對恢復點之後的銀行、錢包、門市及同步事件，再重開服務。RPO 遺失區間內已對外成功的儲值不能僅因資料庫回復而當成從未發生；需外部紀錄與事件核對。備份、WAL 封存與恢復策略須依使用者提供的環境落實。

## 07 API 與事件契約建議

### 7.1 共通契約

狀態 D。API 基底建議 `/api/v1`，HTTPS、JSON、UTF-8。認證方案待框架選定，使用短效憑證並能停用設備；不在 URL 傳送密碼或會員驗證資料。下列金額欄位均為字串、ID 為 UUID、時間為含時區 ISO 8601。

所有財務 POST、離線補傳及可重試的寫入必須帶 Idempotency-Key；key 作用域包含組織、操作及穩定操作者／設備範圍，不綁短效登入 token。重試仍重新驗證目前授權，再回原操作結果。同鍵不同內容回 409 IDEMPOTENCY_CONFLICT；進行中回 202 與 operation_id；查詢端點取得最終結果。

樂觀鎖使用 body.expected_version，失配回 409 VERSION_CONFLICT。Idempotency-Key 控制重試，expected_version 控制並行修改，二者不可互相取代。每次回應附 request_id，列表使用 cursor 與明確範圍、預設 50 筆及最大 200 筆（D，待效能驗證）。

| HTTP／錯誤碼 | 意義 | 前端行為 |
| --- | --- | --- |
| 400 VALIDATION_ERROR | 格式或必要欄位缺漏 | 顯示欄位錯誤，不盲目重試 |
| 401 UNAUTHENTICATED／403 FORBIDDEN | 身分／權限不符 | 重新登入或請主管處理 |
| 404 NOT_FOUND | 不存在或不允許揭露 | 不推測其他門市資料 |
| 409 VERSION_CONFLICT／IDEMPOTENCY_CONFLICT | 版本或同鍵內容衝突 | 重讀並人工核對，不自動覆寫 |
| 409 INSUFFICIENT_BALANCE／PAYMENT_STATE_CONFLICT | 餘額不足／交易狀態不允許 | 阻擋扣款或先查原操作 |
| 422 AMOUNT_MISMATCH／INVALID_OPTION | 金額與版本不符／選項不合法 | 回到核對或異常處理 |
| 429 RATE_LIMITED | 過量請求／驗證嘗試 | 依 Retry-After 等待 |
| 503 TEMPORARILY_UNAVAILABLE | 服務暫不可用 | 財務請求以同鍵查詢／重試，不能當成未扣款 |

### 7.2 端點清單

路徑為設計稿；路徑中的 organization/store 範圍仍需後端身分驗證。表內省略通用 request_id、稽核及冪等處理。

| 端點／方法 | 輸入 → 輸出 | 權限／關鍵規則 |
| --- | --- | --- |
| POST /sessions | credentials、device_id → session、scopes | 員工登入；不回傳密碼資料 |
| GET /me | 無 → 身分、角色、門市、能力 | 有效 session |
| GET /stores/{id}/catalog | current_version? → release、hash、資料 | 門市設備或後台讀取權 |
| POST /catalog/products | 商品／容量／選項 → 草稿版本 | 商品管理權；匯入同樣驗證 |
| PATCH /catalog/products/{id} | expected_version、變更 → 新版本 | 不修改已發布歷史 |
| POST /catalog/releases | 門市、版本、生效時間 → release_id | 發布權；列出預檢結果 |
| POST /devices/{id}/menu-acks | release_id、狀態 → ack | 僅綁定設備 |
| POST /shifts | device_id、opening_cash → shift_id | 本設備開班；防重複 open |
| POST /shifts/{id}/close | counted_cash、原因、expected_version → 結果 | 關班權；未同步則待核對 |
| POST /orders | client_order_id、shift_id、menu_release_id、items → order、totals | 門市開單；伺服器驗證計價 |
| PATCH /orders/{id} | expected_version、items → 新 totals | 僅可修改狀態；使舊結帳失效 |
| POST /orders/{id}/cancel | expected_version、reason → cancelled | 無已付／未知資金；否則拒絕 |
| POST /orders/{id}/payment-requests | method、expected_version → request_id、amount、QR? | 鎖定金額與銀行快照 |
| POST /payment-requests/{id}/cash-confirm | tendered → payment、change | 現金收款權；同鍵只一次 |
| POST /payment-requests/{id}/bank-confirm | bank_ref、amount、booked_at、note? → payment 或 exception | 核帳權；識別與金額去重驗證 |
| POST /payment-requests/{id}/wallet-charge | wallet_id、verification_token → payment 或 operation | 驗證 token 綁會員／用途／有效期 |
| GET /operations/{id} | 無 → pending/succeeded/failed、result | 僅可查授權範圍原操作 |
| GET /members | 搜尋條件 → 遮罩會員清單 | 會員讀取權；限制查詢速率 |
| POST /members/{id}/verify | 驗證資料 → verification_token | 方法待選定；不入一般日誌 |
| POST /wallet-topups | wallet_id、amount、method、shift_id → topup、payment_request | 線上與儲值權；確認沿用 cash/bank-confirm |
| GET /wallets/{id}/entries | cursor、日期 → balance、entries | 帳務讀取權；跨店規則檢查 |
| POST /wallets/{id}/adjustments | delta、reason、approval_id → entry | 專屬調整權；追加流水 |
| POST /orders/{id}/refunds | items/amount、reason → refund_id | 申請權；計算可退額 |
| POST /refunds/{id}/approve | expected_version、approval → approved | 主管權；保留退款額度 |
| POST /refunds/{id}/execute | execution_key、核對資料 → 狀態 | 執行權；未知結果保留額度 |
| POST /orders/{id}/reprints | document_kind、cup_key?、reason → print_job | 補印權；新工作關聯原工作 |
| POST /sync/batches | device_id、events → 逐事件結果 | 設備授權；每個事件獨立原子提交 |
| GET /payment-exceptions | 範圍、狀態 → 異常清單 | 核帳權；附處置歷程 |
| POST /payment-exceptions/{id}/resolve | action、evidence、approval? → resolution | 不直接覆寫收款／退款狀態 |
| POST /bank-accounts | 設定、驗證資料 → 帳戶版本 | 專屬權限；核對後才啟用 |
| POST /imports/validate | kind、檔案參照 → validation_report | 匯入權；驗證不套用 |
| POST /imports/{id}/apply | report_version、approval? → batch_result | 同批次防重；不得套用變更過內容 |
| GET /reports/shift/{id} | 無 → 班次銷售、儲值、退款、差異 | 本班／本店／跨店按權限 |
| POST /exports | kind、filter → export_job | 匯出權；遮罩、稽核與到期下載 |

一般主資料 CRUD、匯出下載及設備管理的完整欄位在實作前以 OpenAPI 補齊，依本文件權限與資料字典衍生；本表先定義核心交易契約，並非已部署 API。

### 7.3 財務回應範例

以下為建議現金確認成功回應。金額以字串表示，示意識別不是正式交易資料。

```json
{
  "request_id": "6c7664e9-1d34-45f1-96db-df3b97b46111",
  "data": {
    "payment_id": "37f7f58a-d161-4cfa-b643-a11711ae9222",
    "status": "succeeded",
    "method": "cash",
    "currency": "VND",
    "amount": "51000",
    "tendered": "100000",
    "change": "49000",
    "order_status": "completed"
  }
}
```

失敗回應共通形狀為 error.code、error.message、error.field_errors（如適用）、request_id。財務逾時若無法確定結果，回應或前端狀態標為未知，不能偽造明確 failed。

### 7.4 客顯與後端事件

| 事件 | 必要欄位 | 接收規則 |
| --- | --- | --- |
| display.snapshot | session_id、order_id?、revision、phase、public_items、totals、payment_display? | 建議同機 IPC；僅白名單，舊 revision 丟棄 |
| display.clear | session_id、revision、reason | 完成／取消／換單先撤碼；不同 session 清空重取 |
| display.ack | session_id、revision、display_state | 主屏確認實際展示；未 ack 顯警示 |
| order.paid | event_id、order_id、payment_id、version | outbox 發出；消費端去重產生列印初始工作 |
| wallet.changed | event_id、wallet_id、entry_id、version | 僅授權客戶端；不可直接廣播完整個資 |
| menu.published | event_id、store_id、release_id、effective_at | 門市下載驗證後回報，不直接改舊單 |
| refund.completed | event_id、refund_id、original_payment_id | 更新報表及必要收據；不再次執行退款 |

客顯本機事件不必經中央服務；支付成功畫面必須來自已提交的收款結果。事件傳遞採可重試、至少一次的設計，由穩定 event_id 去重，不宣稱所有外部設備具備 exactly-once 能力。

## 08 離線同步與設備規格

### 8.1 OFF-01 能力矩陣

狀態 P/D；來源 S06、S08、S10。

| 功能 | 在線 | 離線 |
| --- | --- | --- |
| 選品／主副屏 | 當前已發布版本 | 最後已啟用快取版本；同機同步可用 |
| 現金銷售 | 可用 | 可用，持久化後完成並待補傳 |
| 銀行 QR 收款 | 已驗證帳戶與人工核帳 | V1 建議停用新銀行收款；不得自行擴大離線範圍 |
| 儲值新增／消費 | 中央交易確認 | 停用，不以快取餘額扣款 |
| 退款／錢包調整 | 授權後執行 | V1 建議停用；人工應變另經核准 |
| 商品發布／銀行修改 | 後台可用 | 停用；不允許快取管理變更直接生效 |
| 列印／開櫃 | 依本機設備可用 | 依本機設備可用，稽核待同步 |
| 關班／報表 | 可完成中央對帳 | 可本機關班；標待同步，不能稱中央已對帳 |

### 8.2 OFF-02 本機交易與補傳

現金結帳需在同一本機交易寫入訂單、明細、收款、現金收支、待同步事件及待列印工作，再顯示完成。未寫成功不得只在畫面上當作已收款；如店員已收現金，應顯示人工核對流程並保留可恢復證據。

重啟時恢復 local_committed 交易及佇列，未確認結果先查本機日誌／中央識別，不自行新建第二張單。補傳每個事件含 organization/device/store/shift 關聯、client_event_id、發生時間、菜單版本、完整快照與內容 hash；中央驗證設備範圍及不可變內容。

中央逐事件原子提交，回 acknowledged、duplicate_same_payload、conflict 或 rejected_with_reason。批次可部分成功，但每張訂單不得半寫；本機只對明確已確認事件標完成。相同 ID 不同內容不覆蓋，進入人工核對；保持原始本機資料，不因失敗刪除。

回線同步不重新觸發原始列印、開櫃或再次收款。中央檢查過期菜單、已關班、設備停用或時間異常時，保留事件供帳務審閱；拒絕自動入帳不等於現金沒有發生。

### 8.3 OFF-03 安全與邊界

離線登入憑證、可離線時長及主管權限快取為 T-09。建議只有近期成功登入且已開班的授權設備能離線收現金；不允許首次離線登入或離線擴權。設備中央停用在離線期間不可能即時送達，須以租期／回線檢查限制，而非宣稱可即時遠端阻擋。

本機資料須防未授權讀取，敏感資料最小化；本機憑證使用 OS 安全儲存。中央備份不涵蓋尚未同步資料；POS 裝置故障或儲存遺失可能使未同步現金單需人工補登，須由班次紀錄與編號收據協助核對。

### 8.4 HW-01 設備驗證矩陣

設備型號來自原單據，不代表已確認在用或相容。所有項目須以實機取得證據後才選定 SDK／部署方案。

| 設備／場景 | 待確認內容 | 通過條件 |
| --- | --- | --- |
| iMin Swan 2 主機 | 實際型號、OS、安裝權限、資源、解析度 | 可安裝、穩定運行與重啟恢復 |
| 獨立雙螢幕 | 顯示 API／SDK、觸控、重連 | 兩屏不同內容；管理頁不外洩；觸控不改單 |
| Zywell ZY303 | USB/LAN/Bluetooth、協定、紙寬、裁切 | 收據中越文字與金額清楚；缺紙可辨識 |
| XP-365B | 指令集、紙材、標籤間距、校準 | 每杯標籤正確、不截字、補印可識別 |
| M411 錢櫃 | 控制來源、電氣訊號與接線 | 收現金及授權開櫃可追查，失敗不重收款 |
| 異常復原 | 拔線、缺紙、卡紙、斷電、副屏重連 | 待處理工作恢復；未知列印結果可核對 |
| QR 掃描 | 副屏亮度、解析度、常用手機／銀行 App | 掃碼帳戶、金額、識別與當前請求一致 |

無法獨立雙屏時，先評估官方 SDK／顯示介面；顯示橋接設備僅為需另核成本的備案，不默認購買新主機。

## 09 安全、效能、備份與維運

### 9.1 NFR-01 安全與資料保護

狀態 P/D/T；來源 S08。API 及資料庫跨網路連線加密，資料庫不對 POS 或公開網際網路直接開放。應用角色使用最小權限，DDL 遷移帳號與執行帳號分離；正式資料庫存取採受控網路及稽核。

管理帳號採強驗證，建議 MFA；收銀快速登入仍須識別操作者，不能降低資金操作的授權要求。會員驗證設速率限制、失敗鎖定及安全雜湊／驗證服務。伺服器端查詢參數化，檔案匯入限制大小／格式，圖片與附件不得被當作可執行內容。

個資、銀行設定、備份與匯出有分級存取。資料留存、會員資料更正／刪除、會計資料保存期限與跨境要求由營運方及當地顧問確認；在期限未定前不自行清除財務歷史。需去識別時保留必要會計關聯與核准紀錄。

可評估 PostgreSQL RLS 作第二層防護，但不取代 API 授權；若啟用，必須驗證連線池設定、維運角色與 bypass 行為，避免將設定存在等同隔離有效。

### 9.2 NFR-02 品質目標

| 項目 | 目標／狀態 | 量測方式 |
| --- | --- | --- |
| 客顯更新 | 同機正常狀態 ≤ 1 秒，P | 測商品／金額變更到副屏顯示；記錄環境與樣本 |
| 正確性 | 重試無重複收款、錢包無超扣，P/D | 併發、斷線與故障注入案例 |
| 線上 API 延遲 | T；依設備／網路及交易量設定 | 觀察 p50/p95/p99，區分銀行外部耗時 |
| 尖峰吞吐 | 建議測預估尖峰兩倍，P | 先確認門市、設備、每分鐘訂單與同時扣款數 |
| 備份 RPO | 建議 15 分鐘，P/T | 實測可恢復至何時，不只看排程成功 |
| 復原 RTO | 建議 4 小時，P/T | 含還原、核對與恢復營業演練 |
| 可用率／支援時段 | T | 由預算、營業時段及維護合約決定 |
| 試營運對帳 | 連續至少 5 個營業日，P | 每日銷售、現金、銀行、錢包與異常清單簽認 |

### 9.3 NFR-03 備份與復原

依 PostgreSQL 實際供應方式設計全量備份、增量／WAL 與時間點復原。備份應加密並有異地副本；保存期、權限、金鑰管理及費用由 T-09 決策。備份成功通知不是還原成功證據。

至少在獨立環境演練還原，核對訂單筆數、收退款總額、錢包餘額與流水、班次及關鍵版本。還原後須處理第 6.7 節資金核對，避免舊狀態再次執行已成功的外部退款／入帳。

### 9.4 NFR-04 監控、部署與更新

監控同步延遲與積壓、未知支付結果、待核對銀行款、錢包對帳差異、列印失敗、設備離線、備份與還原演練狀態。每筆操作有 request_id，跨資料表及事件可追溯；記錄錯誤不洩漏密鑰。

環境至少區分開發／測試／正式（D），正式帳戶由營運方掌握。更新先試點再分批，營業中不強制重啟。資料庫遷移採可回復或向前修正設計，先備份、驗證相容性，再切換；不能假設回滾程式即可回滾已發生資金。

門市裝置可能暫時離線使用舊版客戶端，API 與事件 schema 必須有相容窗口及版本拒絕規則。停用舊版前確認待同步交易已處理。

## 10 畫面與操作規格

### 10.1 UI-01 頁面清單

狀態 P/D，核心客顯角色為 C；來源 S02、S07。畫面規格以資訊與行為為主，本版不提供已核准視覺稿。

| 畫面 | 主要欄位／操作 | 空白、錯誤及限制 |
| --- | --- | --- |
| 登入／開班 | 操作者、設備、門市、備用金 | 無授權設備不能直接進收銀 |
| 商品選擇 | 分類、搜尋、容量、配料、甜度冰量 | 售罄禁選；無菜單提示下載／管理者處理 |
| 訂單小結 | 每杯規格、杯數、原價、折扣、應付 | 重複飲品可分開修改；內部備註不出客顯 |
| 結帳 | 現金／銀行／儲值、鎖定金額、確認來源 | 處理中停用重複提交；未知結果提供查詢 |
| 會員／錢包 | 遮罩搜尋、驗證、可用餘額、流水 | 查到會員仍須驗證；離線明示不可用 |
| 退款／異常 | 原資金、可退額、原因、核准、執行狀態 | 待處理與已完成分開；不得手動改已付旗標 |
| 列印中心 | 佇列、印表機、錯誤、補印原因 | unknown 必須先核對，不自動無限補印 |
| 交班 | 預期額、實點、差異、未同步與未核帳 | 未同步不得顯示中央對帳完成 |
| 後台商品 | 分類、容量價格、配料單位、選項、版本 | 預檢阻擋錯誤發布 |
| 後台管理 | 門市、角色、銀行版本、會員、報表、稽核 | 按權限隱藏並由 API 再驗證 |

### 10.2 UI-02 客顯六種狀態

| 狀態 | 必顯示 | 禁止／切換行為 |
| --- | --- | --- |
| 待機 | 品牌與點餐提示 | 無上一位會員／付款資料 |
| 點餐中 | 品項、每杯規格、數量、價格與小計 | 無管理內容與操作按鈕 |
| 核對 | 明細、折扣、應付額 | 與主屏同一 revision |
| 等待付款 | 當前方式；銀行時顯 QR／戶名／金額／識別 | 現金／儲值不留銀行碼 |
| 完成 | 明確成功、取餐號 | 立即撤碼；短暫停留後清空 |
| 取消／異常 | 取消或請洽店員提示 | 清除舊碼；不可把未知結果標失敗／成功 |

### 10.3 視覺與無障礙提案

magpie 在此代表清楚層級、少量品牌色、大片觸控與安靜背景的 IUTRA 設計方向，並非某個已指定的官方設計系統。原提案色彩：品牌紅 #B9232B、茶金 #F4B82C、正文 #20252B、次要字 #616B75、背景 #F3F5F7、白 #FFFFFF。

中越文可採可離線封裝的 Noto Sans／Noto Sans TC 或同等授權字體。正文約 18–20 px、主要操作 22–28 px、客顯應付 40–56 px；常用觸控目標約 48×48 邏輯像素，再依實機調整。一般文字對比目標 4.5:1，選取與錯誤不只靠顏色，支援焦點與減少動態效果。

QR 採黑白、保留必要留白，不加入 Logo 或漸層干擾；以實機掃描驗收。主副屏語言可分開設定是提案，正式支援語言與預設值仍待 T-05；規格使用繁體中文不代表產品語言定案。

## 11 驗收、追溯與試點切換

### 11.1 驗收方法

下表是未來系統驗收案例，本次僅完成規格文件，不代表任何案例已在系統執行。案例需保留版本、測試資料、裝置／網路條件、步驟、結果與佐證。正式核准後才轉為開發與驗收基線。

| 案例／對應需求 | 操作與預期結果 | 來源／佐證 |
| --- | --- | --- |
| AT-01 CAT-01/POS-01 | 700 ml 24,000＋配料 5,000＝29,000；另一杯 500 ml 22,000；總計 51,000，各杯甜度獨立 | S03/S10；雙屏、明細、杯貼 |
| AT-02 CAT-02 | 必選缺漏、互斥選項或超過配料上限時阻擋；容量不被重複加價 | S03；驗證錯誤與計價紀錄 |
| AT-03 CAT-03/POS-01 | 後台改價並發布，新單使用新價，既有單與退款仍用原快照 | S03/S10；版本與金額比較 |
| AT-04 DISP-01 | 主屏登入／會員／後台不外洩；副屏不可改單；正常同步目標 ≤ 1 秒 | S02/S10；實機錄影與時間量測 |
| AT-05 DISP-01 | 副屏拔線主屏告警，重連只顯示當前單，完成後清除個資 | S02/S06；實機紀錄 |
| AT-06 PAY-01 | 應付 51,000，實收 100,000，找零 49,000；現金入櫃只增加 51,000 | S04/S05；收據與現金流水 |
| AT-07 PAY-02 | 掃碼帳戶／金額／識別正確；改單撤舊碼並建立新請求；掃碼不等於已付 | S04/S10；實掃與請求版本 |
| AT-08 PAY-03 | 同一銀行交易兩次確認，只一筆收款；缺唯一識別進待核對 | S04；收款／異常／稽核 |
| AT-09 PAY-03 | 少付、多付、取消後或舊碼晚到保留實際金額，不套入新單 | S04/S10；異常處置證據 |
| AT-10 WAL-01 | 錢包 100,000，同時兩筆各 70,000，僅一筆成功，餘額 30,000 | S05/S10；併發結果與帳本 |
| AT-11 WAL-01 | 扣款已提交但回應丟失，同鍵重試回原成功結果；不再扣款或改收現金 | S05；故障注入與唯一鍵 |
| AT-12 WAL-01 | 同筆資金重試儲值僅入帳一次；離線新增與扣款明確阻擋 | S05；topup、payments、entries |
| AT-13 MEM-01/AUTH-01 | 僅查到電話不能扣款；未授權店員不能調整；跨店範圍未開不能消費 | S05/S08；權限負向測試 |
| AT-14 REF-01 | 兩筆併發退款不可超過原額；待銀行結果時不顯已退，unknown 不釋放額度 | S04/S05；退款與保留額 |
| AT-15 REF-01 | 部分退款依原折扣分攤；已製作退款不自動回補實物 | S03/S08；退款與製作紀錄 |
| AT-16 OFF-02 | 離線現金可收款列印，斷電重啟可恢復；重送無重複單／收款／開櫃 | S08/S10；本機及中央紀錄 |
| AT-17 OFF-02 | 相同事件 ID 不同內容回衝突，原資料不覆寫；晚到關班資料可核對 | S08；同步與班次報表 |
| AT-18 PRN-01 | 缺紙顯待處理；送出結果未知須核對；補印標記與原因／次數完整 | S06/S10；紙本與佇列 |
| AT-19 SHIFT-01 | 現金銷售、儲值、退款、一般收支與實點可核對；銀行錢包不算現金 | S05/S10；班次對帳表 |
| AT-20 AUTH-01/AUD-01 | 跨組織／門市 ID、匯出、銀行修改、主管操作越權均阻擋並可追查 | S03/S08；API 與稽核 |
| AT-21 DATA-01 | 錯誤匯入不半批套用；同一舊餘額來源不重複入帳；匯出依權限遮罩 | S03/S05；預檢及匯入紀錄 |
| AT-22 NFR-03 | 獨立環境還原成功，核對餘額與流水；確認恢復點後資金差異處置 | S08/S10；還原報告與計時 |
| AT-23 NFR-02 | 以核准尖峰目標及建議兩倍量測延遲、錯誤率與併發資金正確性 | S10；負載報告 |
| AT-24 HW-01 | 四類設備實測中越文、紙寬、開櫃、雙屏、拔線與重啟 | S06；型號、版本、照片與結果 |
| AT-25 PAY-04/發票 | 若條件式啟用，通知驗真／防重、發票失敗補開而不重收款 | S04/S08；服務商測試紀錄 |
| AT-26 API/INV-01 | 同鍵同內容回原結果，同鍵改內容回 409；過期 session 不能取得他人操作 | D；API 整合測試 |

### 11.2 試點前置門檻

試點前至少完成：實機獨立雙屏與關鍵列印；商品價格與選項核對；銀行戶名／帳號及經授權的小額實測；會員驗證、儲值及退款政策；使用者權限；備份還原；離線與人工備援；必要電子發票適用確認。

原計劃切換檢查提及期初庫存，但完整庫存模組屬後續。只有試點實際納入庫存時才將期初庫存作為該模組切換條件；不因此默認 V1 已含完整配方／庫存。

上線由門市負責人核對操作、工程方確認設備與復原、帳務負責人確認付款／儲值。連續至少 5 個營業日完成對帳，重要異常均有處置方式，再決定擴店。發生資金重複扣款、客顯洩漏或關鍵列印不可用時停止擴店並重驗。

### 11.3 切換與營業備援

正式資料初始化須核對商品、銀行、員工、設備、門市、期初現金及有憑證的會員餘額。依需求決定匯入批次與切換時間，保存核准人及來源。舊 PosApp 已過期，不能當作可用回退系統。

備援使用現金人工單與編號收據，人工期間暫停儲值扣款；恢復後以固定來源識別補登並防重，與當日現金核對。若依法需電子發票，使用服務商核准的應變流程。系統回復前先處理結果不明的付款／退款，避免要求顧客重付。

### 11.4 交付與估工界線

未來系統開發交付建議包含原始碼、部署／復原說明、設備設定、完整資料字典與匯入範本、操作手冊、測試／驗收紀錄及已知限制。本次交付只有系統規格書及同內容文字版。

原計劃 9–15 週以兩名可涵蓋設備／Android 與後端／網頁的工程師、兼任設計測試及門市即時配合為前提，不是本規格的交付承諾。新增付款服務、電子發票、混合付款或實機限制需重估；維護、費用與服務時段另議。

## 12 待決策事項與資料庫接入

### 12.1 決策清單

| 編號／議題 | 目前狀態與建議 | 最晚決策點／影響 |
| --- | --- | --- |
| T-01 門市與主體 | 店數、公司／加盟關係未定；先單店試點，資料支援多店 | 資料隔離與錢包範圍定稿前 |
| T-02 實機與技術棧 | 原設備優先；OS、SDK、介面未知；框架未定 | 技術估工及設備整合前 |
| T-03 銀行與付款 | 銀行／戶名／帳號待給；先人工核實；異常款處置待訂 | 正式 QR 收款前 |
| T-04 儲值政策 | 跨店、會員驗證、本金／贈金、期限、退款、舊餘額憑證未定 | 儲值開發定稿及試點前 |
| T-05 商品與語言 | 完整菜單、甜度冰量、另附冰、單位、正式語言及折扣稅費算法未定 | 原型／計價實作前 |
| T-06 授權與退款 | 角色、限額、雙人核准、部分退款、補收及先做後付待定 | 付款與權限驗收前 |
| T-07 混合付款 | 建議後續；若現況必要則提前納入支付分攤 | V1 範圍凍結前 |
| T-08 電子發票與合規 | 會計／顧問判定義務，服務商及介面未選 | 試點准入前；必要則調整範圍 |
| T-09 維運與離線 | 留存、備份、RPO/RTO、離線租期、支援時段未定 | 部署與試點前 |
| T-10 尖峰與規模 | 設備數、同時使用者、尖峰訂單量未給 | 容量與壓測計劃前 |
| T-11 PostgreSQL 環境 | 選型已確認；環境、版本與既有 schema 待提供 | 實作資料存取／遷移前 |
| T-12 自動通知及其他介接 | 銀行通知、簡訊、外送等尚無介面承諾 | 對應模組估工前 |

待決事項不阻止本規格完成；它們限制對應功能的最終實作與上線。未決功能應保留停用或受限狀態，不以猜測填補財務政策。

### 12.2 後續提供 PostgreSQL 的資訊

現在無須提供連線資料即可閱讀及審閱本文件。後續接入時先取得以下資訊，機密透過安全設定管道提供。

| 類別 | 需要確認的資料 | 用途 |
| --- | --- | --- |
| 環境歸屬 | 自架／託管、負責人、開發／測試／正式 | 決定維運與變更責任 |
| 版本與能力 | PostgreSQL major/minor、extensions、encoding、collation | 確認 SQL、索引、排序與遷移相容性 |
| 既有內容 | database/schema 清單、結構文件、是否已有正式資料 | 決定映射、新建及保留方式 |
| 連線與網路 | host、port、database、VPN／白名單、SSL 模式與 CA | 建立受控加密連線；不要求直接公開資料庫 |
| 帳號權限 | 應用帳號、遷移帳號、唯讀檢視權限 | 分離最小執行與 schema 變更權限 |
| 資源限制 | 連線上限、CPU/RAM、儲存、連線池／代理 | 容量、逾時與效能設計 |
| 備份與復原 | 備份方式、WAL/PITR、保存期、加密、演練方式 | 落實核准 RPO/RTO |
| 變更窗口 | 可操作時段、審核人、測試副本與回復方法 | 遷移前風險控制與驗證 |
| 機密管理 | 憑證／密碼注入方式、輪替與存取責任 | 不寫入 Word、Git 或一般日誌 |

### 12.3 參考與證據界線

主要依據為原計劃書、專案 CLAUDE.md 及本次 PostgreSQL 指示。原計劃提及的 IUTRA 網址 https://iutra.posapp.vn/ 僅曾取得動態頁面外殼，不能視為完整菜單已取得。

PosApp 公開網站 https://posapp.vn/en/ 與原文中的 iPOS、KiotViet、MISA CUKCUK 研究連結只作產品方向參考，不構成 API 授權、資料結構、服務可用性、價格或硬體相容承諾。本文件未宣稱恢復舊資料，亦未新增未驗證的越南稅率或法規結論。

本版交付驗證聚焦內容可追溯、計價／帳務規則一致、Word 與文字版內容一致及文件排版。實際資料庫、應用程式、設備、銀行與負載驗證須在後續實作及取得環境後執行。
