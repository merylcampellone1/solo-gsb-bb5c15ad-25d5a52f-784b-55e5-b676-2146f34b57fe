# 纸质展品光照额度管理（Light Quota）

面向纸本、拓本等光敏展品的**年度照度时数（剂量，单位 lx·h）额度管理** Web 应用。
Node.js（Express）+ PostgreSQL，本地账号区分两类角色：

- **保管员（conservator）**：登记展品与每年照度时数上限、批准/驳回/复核布展计划、审核计划调整申请、录入并确认实测。
- **布展员（installer）**：创建展出计划（展期、每日开灯时段、预计照度）、对已批准且未开始的计划提交/撤回调整申请、查看额度占用。

## 核心业务规则

1. **按自然年拆分剂量**：以墙上时间（默认中国标准时间 UTC+08:00，固定偏移不处理夏令时）归属年份。
   - 每日开灯时段支持多段、支持跨午夜（如 `20:00-02:00`）；计划可以跨年，剂量自动切到各自然年。
2. **时间重叠不得批准**：同一展品，两条已批准/待复核计划只要**开灯时刻区间相交**即拒绝批准
   （即使展出日期有重叠但开灯时段不相交，也允许）。
3. **批准时合计校验**：
   `已确认实测剂量` + `其他已批准/待复核计划尚未被实测覆盖部分的估算剂量` + `本计划估算剂量`，
   任一自然年超过该展品年度上限即拒绝，并在错误信息与页面中列出**超限年份、上限、各部分占用与超额量（lx·h）**。
4. **并发安全**：批准/确认事务先对展品行加 `SELECT ... FOR UPDATE` 行锁，串行化同展品的并发批准，防止超配。
5. **实测替代估算**：展后保管员在「已批准计划的开灯时段内」录入实测时段与照度，确认后该时段改按实测计量，
   原估算的对应部分自动扣除；已确认测量记录与审批记录保留（不可修改/删除）。
6. **重叠实测拒绝**：实测时段与同展品任何未作废实测时间相交即拒绝（含待确认记录）。
7. **迟到实测导致超限**：确认实测若使某展品某自然年已用剂量超限，
   该展品在**相应年度仍有估算剂量、且尚未开始**的已批准计划自动转为 **待复核（pending_review）**，
   页面展示原因；保管员复核通过时重新执行完整的重叠+额度校验。原审批与测量记录均保留。
8. **校验报错**：非法日期/时间、零时长或互相重叠的开灯时段、非正照度/上限等一律返回明确中文错误。
9. 页面按展品展示**每个自然年的上限、已占用、剩余额度**，以及逐条占用来源
   （已确认实测、各计划估算残余，含按年剂量）。
10. **计划调整申请**：布展员可对「已批准且尚未开始」的计划提交调整申请（新展期、新每日开灯时段、新预计照度）。
    - 同一计划同时只允许**一份待审申请**；撤回或被驳回/拒绝后可重新提交。
    - **待审期间原计划继续占用额度**，计划本身不变；展品详情同时展示原值与拟改值及试算结果。
    - 保管员**批准时在展品锁事务内重新核对**：计划仍已批准且未开始；该计划所有**未作废实测（含待确认）都落在新开灯窗内**；
      新窗口不与同展品其他**已批准/待复核**计划重叠；并按自然年以「新窗口未被已确认实测覆盖部分」的估算量**替换原剩余估算量**，
      任一年超年度上限即拒绝。核对通过才**原子更新计划并写审计**；驳回不改变计划。
    - 核对失败（409）会在错误信息与结构化 `details` 中指出**冲突计划、窗外实测、超额年份与各项数值**，
      申请**保持待审**，布展员可撤回后修改重提（也可在提额后由保管员直接批准原申请）。
11. **下调年度上限（预演 + 凭证提交）**：保管员下调既有自然年的照度时数上限时，可先**预演**：
    - 预演**不改任何状态**，返回一次性**预演凭证**并列出：该年**已确认实测**、各已批准/待复核计划在该年的**估算残余**、
      **预计超额量**，以及超额时**仍有该年估算残余且尚未开始的已批准计划**（下调后将转待复核）。
    - 携凭证正式提交时在同一展品锁事务内**即时重算**：若自预演以来**额度或相关占用已变化**（上限被改、实测确认/录入、
      计划批准/取消/转复核/调整生效等），返回 **409 拒绝并附带最新核算结果与新凭证**，本次不改动任何数据。
    - 沿用旧请求字段直接修改上限（`POST /limits`）时在**同一事务即时重算**，不再要求凭证。
    - 下调成功**原子更新上限**，**原审批记录与实测记录全部保留**；把本次核算列出的未开始计划**转为待复核并写明原因**；
      **已开始的计划不转状态**，剩余超额仍在额度查询/页面中如实显示。后续复核沿用既有的重叠与额度校验，
      不删除占用、不自动取消计划。
12. **成对核准调整申请**：保管员可选取**同一展品的两份待审调整申请**成对核准，用于两条已批准且未开始的计划
    **互换或协同挪动档期**（单份批准无法完成互换：一方的拟改窗必然撞上对方的当前窗口）。
    - 输入**两个不同申请编号**；若**关联同一计划、跨展品、计划已开始或申请已结案**（非待审），一律拒绝并指出原因。
    - **试算与提交口径一致**：以两份拟改开灯窗**同时替换原窗**——新窗**彼此之间**及与**其他已批准/待复核计划**
      均不得重叠；两条计划各自所有**未作废实测**（含待确认）仍须落在**各自新窗**内；按自然年以两份新窗
      **未被已确认实测覆盖部分**的估算残余**同时替换**两份旧残余，超额时列出**年份、各计划贡献与超额量**。
    - 提交在**展品锁事务内重新核对**，全部通过才**原子更新两条计划、结案两份申请并记审计**；
      任一失败则事务回滚，**两份申请仍待审、计划与额度不变**。
13. **停灯登记（blackout）**：保管员可对**已批准或待复核**计划登记**已发生**的停灯时段（原因必填）。
    - 起点须早于终点、**结束不得晚于当前时间**；时段必须**完整落在该计划开灯窗内**；
      不得与同展品**未作废实测（含待确认草稿）**或**其他停灯记录**相交。失败一次性指出全部冲突
      （409，`details.overlappingMeasurements` / `details.overlappingBlackouts`），**不保存**。
    - **停灯记录永久保留，不可修改、不可删除**；计划取消/调整后记录仍在；**布展员只读**。
    - **扣减口径全系统一致**：停灯只从所属计划**未被已确认实测覆盖**的估算时段中扣减
      （按计划预计照度 × 停灯时长，跨年按自然年拆分）；**不减已确认实测**，
      **也不释放原计划的排期占用**（计划开灯窗与计划间重叠判定不变）。
    - 展品年度占用及来源、计划批准与复核、调整试算与核准、上限下调预演均使用**同一扣减口径**
      （估算残余 = 开灯窗 − 已确认实测覆盖 − 本计划停灯）；调整/成对核准还要求**既有停灯仍落在拟改新窗内**。
    - 后续实测**录入或确认碰到停灯时段一律拒绝**。展品详情展示全部停灯记录及**各年扣减量**，
      既有查询字段保持兼容（仅附加新字段）。

## 一键启动（Docker Compose）

前置：已安装 Docker 与 Docker Compose（v2）。

```bash
cd <本项目目录>
docker compose up --build -d
```

启动后访问：

- **应用地址：http://localhost:3000**
- PostgreSQL 仅映射到本机：`localhost:5432`（排查用，可在 compose 中删除 ports 段）

首次启动会自动：建表 → 创建两个默认账号 → 写入一个演示展品与一条跨年已批准计划（可用 `SEED_DEMO=false` 关闭）。

默认账号（**请在生产环境修改**）：

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 保管员 | `custodian` | `guard123` |
| 布展员 | `installer` | `setup123` |

停止与清理：

```bash
docker compose down          # 停止（保留数据卷）
docker compose down -v       # 停止并删除数据库数据卷（完全重置）
docker compose logs -f app   # 查看应用日志
```

## 配置（环境变量）

可在项目根目录放 `.env`（参考 `.env.example`），或 `docker compose up` 前在 shell 中导出：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机映射端口（容器内固定 3000） |
| `DB_PORT` | `5432` | PostgreSQL 映射到宿主机的端口 |
| `PGHOST` | `db` | 数据库主机（Compose 内置网络中的服务名） |
| `PGPORT` | `5432` | 数据库端口 |
| `PGDATABASE` | `lightquota` | 数据库名 |
| `PGUSER` | `lightquota` | 数据库用户 |
| `PGPASSWORD` | `lightquota_secret` | 数据库密码 |
| `TZ_OFFSET_MINUTES` | `480` | 墙上时间相对 UTC 的固定偏移（分钟），中国为 480 |
| `SEED_CONSERVATOR_USERNAME` / `SEED_CONSERVATOR_PASSWORD` | `custodian` / `guard123` | 初始保管员账号（仅首次初始化时创建） |
| `SEED_INSTALLER_USERNAME` / `SEED_INSTALLER_PASSWORD` | `installer` / `setup123` | 初始布展员账号 |
| `SEED_DEMO` | `true` | 是否写入演示展品/计划 |

修改账号相关变量后若库中已存在同名用户不会重复创建；需要重置初始数据可 `docker compose down -v` 后重新启动。

## 本地（非 Docker）运行

```bash
npm install
# 准备一个可访问的 PostgreSQL，然后设置 PG* 环境变量（PGHOST 默认指向 compose 的 db）
PGHOST=127.0.0.1 PGUSER=lightquota PGPASSWORD=lightquota_secret npm start
```

核心剂量算法的离线自测（不需要数据库）：

```bash
npm run test:utils
```

## 使用流程

1. 保管员登录 → 「展品与额度」登记展品，并为相关自然年登记年度上限（lx·h）。
2. 布展员登录 → 「布展计划」选择展品、填展期、每日开灯时段（每行一段 `HH:MM-HH:MM`）、预计照度后提交；
   提交时即检查与已批准计划的开灯时间重叠。
3. 保管员在展品详情中查看按年预计剂量，执行批准/驳回；超限时会列出年份与超额量。
4. 展后保管员在「实测记录」录入已批准计划内的实测时段与照度 → 确认；
   若迟到实测造成年度超限，相应未开始计划转待复核，保管员在详情页复核。
5. 计划尚未开始时，布展员可在「布展计划」对该计划点「申请调整」，改填展期/开灯时段/照度后提交；
   保管员在计划行内查看原值与拟改值对照及核对结果，选择「批准调整」或「驳回」；布展员可撤回自己的待审申请后重提。
6. 两条计划需要**互换或协同挪动档期**时，布展员分别提交调整申请后，保管员在展品详情的
   「成对核准调整申请」中选择这两份待审申请：先「成对试算」查看两份拟改窗同时替换原窗的核对结果
   （彼此/与其他计划重叠、窗外实测、按年两计划贡献与超额），再「提交成对核准」；
   任一核对不通过，两份申请都保持待审、计划不变。
7. 需要**下调**某展品某自然年上限时，保管员在展品详情填写年份与拟定上限后点「下调预演」：
   页面列出该年已确认实测、各计划估算残余、预计超额量，以及将被转待复核的未开始计划；
   确认后在预演结果中点「提交下调」。若预演后占用被他人改动，提交会被拒绝并自动展示最新预演结果。
   已开始计划不会被转状态，剩余超额继续在额度表中红色显示，待复核计划由保管员复核（沿用既有重叠/额度校验）。
8. 「操作流水」保留全部审批、调整、确认、上限下调、状态变更等记录。
9. 展期内发生临时关灯（设备检修、撤展避险等）时，保管员在展品详情「停灯记录」处选择已批准/待复核计划、
   填写已发生的起止时刻与**必填原因**后登记：系统校验起止顺序、结束不晚于当前、完整落在开灯窗内、
   不与未作废实测或其他停灯相交；通过后该时段按计划预计照度从估算中按自然年扣减（不减已确认实测、
   不释放排期）。停灯记录保留、不可改删，布展员只读；之后录入/确认碰到该时段的实测会被拒绝。

## HTTP API（含计划调整申请、成对核准、年度上限下调预演、停灯登记）

所有接口除 `/api/health`、`/api/auth/login` 外都需要登录会话（HttpOnly Cookie `lqsession`）。
统一错误形态：`{ "error": "中文原因", "details": { ... } }`，409 用于冲突（重叠/超额/重复申请）。

### 认证

```bash
# 登录（保存 Cookie）
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"installer","password":"setup123"}'

curl -b cookies.txt http://localhost:3000/api/auth/me
curl -b cookies.txt -X POST http://localhost:3000/api/auth/logout
```

### 既有接口（响应保持兼容，计划对象额外附加调整字段）

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `GET  /api/exhibits` | 登录 | 展品列表 + 年度额度概况 |
| `POST /api/exhibits` | 保管员 | 登记展品 |
| `GET  /api/exhibits/:id` | 登录 | 展品详情：按年额度、占用来源、计划（计划行内联 `pendingAdjustment`）、实测、`blackouts` 停灯记录（逐条带 `yearly`）与 `blackoutDeductionYearly` 各年扣减汇总 |
| `POST /api/exhibits/:id/limits` | 保管员 | 登记/修改某自然年上限；**若为下调，同事务即时重算并把超额年未开始计划转待复核**（成功响应仍为展品详情，另附 `overflows`/`flaggedPlans`） |
| `POST /api/exhibits/:id/limits/preview` | 保管员 | **下调预演**：不改状态，返回凭证与该年实测/各计划估算残余/预计超额/将转复核的计划 |
| `POST /api/exhibits/:id/limits/lower` | 保管员 | **携预演凭证提交下调**；占用已变化返回 409 + 最新结果与新凭证 |
| `GET  /api/plans?exhibitId=` | 登录 | 计划列表（附加 `notStarted`、`pendingAdjustment` 概要） |
| `POST /api/plans` | 布展员 | 创建计划 |
| `GET  /api/plans/:id` | 登录 | 计划详情（待审申请带 `preview` 原值/拟改值试算） |
| `POST /api/plans/:id/approve` | 保管员 | 批准 / 复核通过 |
| `POST /api/plans/:id/reject` | 保管员 | 驳回落计划 |
| `POST /api/plans/:id/cancel` | 登录 | 取消（布展员仅自己未批准的；保管员均可） |
| `GET/POST /api/measurements`、`POST /api/measurements/:id/confirm`、`DELETE /api/measurements/:id` | 保管员 | 实测录入/确认/删草稿 |
| `GET /api/blackouts?exhibitId=&planId=` | 登录 | 停灯记录列表（布展员只读），逐条附 `yearly` 按年扣减量；另返回 `blackoutDeductionByExhibit` |
| `POST /api/blackouts` | 保管员 | 登记已发生停灯时段；成功响应为展品详情（另附 `blackout`）；冲突 409 不保存 |
| `GET /api/audit` | 保管员 | 操作流水（含 `blackout.create`） |

### 计划调整申请 `/api/adjustments`

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/adjustments` | 布展员 | 对已批准且未开始的计划提交调整申请（每计划至多一份待审） |
| `POST /api/adjustments/preview` | 布展员 | 仅试算拟改值，不写库 |
| `GET  /api/adjustments?planId=&exhibitId=&status=&preview=1` | 登录 | 申请列表/历史，带原值 |
| `GET  /api/adjustments/:id` | 登录 | 申请详情（待审带试算） |
| `POST /api/adjustments/:id/approve` | 保管员 | 批准：锁事务内重新核对，通过则原子更新计划 |
| `POST /api/adjustments/:id/reject` | 保管员 | 驳回（计划不变），body 可带 `reason` |
| `POST /api/adjustments/:id/withdraw` | 布展员本人/保管员 | 撤回待审申请，之后可重新提交 |

提交申请（`POST`）请求体：

```json
{
  "planId": 12,
  "startDate": "2030-12-31",
  "endDate": "2031-01-02",
  "periods": ["09:00-12:00", "13:00-17:00"],
  "estimatedLux": 120,
  "reason": "配合跨年活动改期（可选）"
}
```

curl 调用示例（布展员提交 → 保管员核对 → 批准/驳回/撤回）：

```bash
# 1) 布展员提交调整申请（响应里的 preview 为即时试算；申请为 pending）
curl -b cookies.txt -X POST http://localhost:3000/api/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"planId":12,"startDate":"2030-12-31","endDate":"2031-01-02",
       "periods":["09:00-12:00","13:00-17:00"],"estimatedLux":120}'

# 2) 查看申请（原值 original + 拟改值 + preview.conflicts/yearlyReport）
curl -b cookies.txt http://localhost:3000/api/adjustments/1

# 3a) 保管员批准：成功返回更新后的展品详情
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/1/approve

# 3b) 保管员驳回（计划不变）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/1/reject \
  -H 'Content-Type: application/json' -d '{"reason":"与邻厅计划冲突"}'

# 3c) 布展员撤回（之后可用同一 planId 重新提交）
curl -b cookies.txt -X POST http://localhost:3000/api/adjustments/1/withdraw
```

批准核对失败时返回 **409**，申请保持 `pending`，`details.conflicts` 给出全部冲突：

```json
{
  "error": "调整申请 #1 未通过核对：与同展品已批准计划「夜场」(#7) 开灯时间重叠；2031 年：上限 50000，其他占用 12000，原残余 800，拟改残余 40800，合计 52800，超额 2800 lx·h",
  "details": {
    "adjustmentId": 1,
    "conflicts": {
      "notApproved": false,
      "notStarted": false,
      "outsideMeasurements": [{ "id": 31, "status": "confirmed", "start": "2031-01-02 10:00", "end": "2031-01-02 11:00" }],
      "overlappingPlans": [{ "id": 7, "title": "夜场", "status": "approved", "startDate": "2031-01-01", "endDate": "2031-01-03" }],
      "missingLimits": [],
      "overflows": [{
        "year": 2031, "limit": 50000, "usedByOthers": 12000,
        "oldResidue": 800, "newResidue": 40800, "projected": 52800, "excess": 2800
      }]
    },
    "yearlyReport": { "2031": { "...": "每个相关年份的上限/其他占用/原残余/拟改残余/合计/超额" } }
  }
}
```

常见拒绝：越权（保管员提交、非申请人撤回）→ 403；计划非已批准/已开始/无效时段或照度 → 400；
重复待审申请 → 409（`details.existingAdjustmentId`）。

### 成对核准 `/api/adjustments/pair/*`（保管员）

同一展品两份**待审**调整申请（两条不同计划）同时生效：用于两条已批准且未开始的计划互换/协同挪动档期。

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/adjustments/pair/preview` | 保管员 | 成对试算：两份拟改窗同时替换原窗的核对结果，不写库 |
| `POST /api/adjustments/pair/approve` | 保管员 | 成对核准：锁事务内重核，全部通过才原子更新两条计划并结案两份申请 |

请求体均为：

```json
{ "adjustmentIds": [21, 22] }
```

组成性拒绝（**400**，试算与提交一致）：两个编号相同、申请不存在、**关联同一计划**、**跨展品**、
**申请已结案**（非待审）；布展员调用 → 403。

试算响应（`pairPreview`）：

```json
{
  "pairPreview": {
    "exhibitId": 3,
    "adjustments": [
      { "id": 21, "planId": 8, "startDate": "2030-04-01", "...": "拟改值",
        "original": { "title": "计划D", "startDate": "2030-03-01", "...": "原值" } },
      { "id": 22, "planId": 9, "...": "第二份申请（含 original 原值）" }
    ],
    "ok": true,
    "conflicts": {
      "notApproved": [], "notStarted": [], "outsideMeasurements": [],
      "pairOverlap": false, "overlappingPlans": [], "overflows": [], "missingLimits": []
    },
    "items": [
      { "adjustmentId": 21, "planId": 8, "title": "计划D",
        "oldResidueYearly": { "2030": 800 }, "newResidueYearly": { "2030": 800 } }
    ],
    "yearlyReport": {
      "2030": {
        "year": 2030, "limit": 5000, "usedByOthers": 800,
        "oldResidueTotal": 1600, "newResidueTotal": 1600,
        "contributions": [
          { "adjustmentId": 21, "planId": 8, "title": "计划D", "oldResidue": 800, "newResidue": 800 },
          { "adjustmentId": 22, "planId": 9, "title": "计划E", "oldResidue": 800, "newResidue": 800 }
        ],
        "projected": 2400, "remainingAfter": 2600, "excess": null
      }
    }
  }
}
```

curl 调用示例（保管员已登录，Cookie 存于 cookies-custodian.txt）：

```bash
# 1) 成对试算：两份拟改开灯窗同时替换原窗（不写库）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/pair/preview \
  -H 'Content-Type: application/json' \
  -d '{"adjustmentIds":[21,22]}'

# 2) 提交成对核准：成功返回更新后的展品详情（另附 pairApproval 摘要）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/pair/approve \
  -H 'Content-Type: application/json' \
  -d '{"adjustmentIds":[21,22]}'
```

核对失败返回 **409**，**两份申请都保持待审、计划与额度不变**，`details` 指明全部冲突
（`notStarted`/`notApproved` 为逐计划数组，`pairOverlap` 标记两份拟改窗彼此重叠，
`overflows[].contributions` 列出各计划按年贡献与超额量）：

```json
{
  "error": "成对核准（申请 #21 + #22）未通过核对：2030 年：上限 2000，其他占用 0，两份拟改残余合计 2400（计划 #8 贡献 1600，计划 #9 贡献 800），合计 2400，超额 400 lx·h",
  "details": {
    "adjustmentIds": [21, 22],
    "conflicts": {
      "notApproved": [], "notStarted": [], "outsideMeasurements": [],
      "pairOverlap": false, "overlappingPlans": [], "missingLimits": [],
      "overflows": [{
        "year": 2030, "limit": 2000, "usedByOthers": 0,
        "oldResidueTotal": 1600, "newResidueTotal": 2400,
        "contributions": [
          { "adjustmentId": 21, "planId": 8, "title": "计划D", "oldResidue": 800, "newResidue": 1600 },
          { "adjustmentId": 22, "planId": 9, "title": "计划E", "oldResidue": 800, "newResidue": 800 }
        ],
        "projected": 2400, "excess": 400
      }]
    },
    "items": [ "每份申请各自的原/拟改残余（按年）" ],
    "yearlyReport": { "2030": { "...": "每个相关年份的上限/其他占用/两计划旧新残余/各计划贡献/合计/超额" } }
  }
}
```

成功响应与单份批准同构（展品详情字段位于顶层），另附 `pairApproval`
（`adjustmentIds`/`planIds`/`items`/`yearlyReport`）。单份审批与既有查询接口的字段和行为不变。

### 下调年度上限 `/api/exhibits/:id/limits/preview`、`/lower`

保管员下调**已登记**年度上限前先预演（拟定上限必须为正数且**低于现行上限**，否则 400）。
预演不写库，返回一次性、10 分钟有效的凭证（`token`）：

```bash
# 1) 预演：返回 token 与核算明细
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits/preview \
  -H 'Content-Type: application/json' \
  -d '{"year":2032,"limitLxh":800}'
```

响应（`preview`）：

```json
{
  "year": 2032,
  "currentLimit": 10000,
  "proposedLimit": 800,
  "used": 1600,
  "remaining": -800,
  "excess": 800,
  "over": true,
  "confirmedMeasurements": [],
  "planResidues": [
    { "id": 7, "title": "未来计划1", "status": "approved", "startDate": "2032-06-01",
      "endDate": "2032-06-01", "periods": ["09:00-17:00"], "lux": 100,
      "yearResidue": 800, "firstStart": "2032-06-01 09:00", "notStarted": true }
  ],
  "flagCandidates": [ { "id": 7, "title": "未来计划1", "yearResidue": 800, "notStarted": true } ],
  "startedResiduePlans": [],
  "token": "b93e982e4ac7…",
  "tokenExpiresInSeconds": 600
}
```

```bash
# 2) 携凭证提交（字段须与预演一致；token 一次性）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits/lower \
  -H 'Content-Type: application/json' \
  -d '{"year":2032,"limitLxh":800,"token":"b93e982e4ac7…"}'
```

成功响应即**展品详情**（与 `GET /api/exhibits/:id` 同构，保持兼容），并额外附带：

```json
{
  "exhibit": { }, "years": { }, "sources": [ ], "plans": [ ], "measurements": [ ],
  "year": 2032,
  "previousLimit": 10000,
  "newLimit": 800,
  "overflows": [{ "year": 2032, "limit": 800, "previousLimit": 10000,
                  "projected": 1600, "excess": 800 }],
  "flaggedPlans": [
    { "id": 7, "title": "未来计划1", "firstStart": "2032-06-01 09:00",
      "yearResidue": 800, "overflowYears": [2032] }
  ]
}
```

被转待复核的计划会写入中文原因（如“2032 年照度时数上限下调（10000 → 800 lx·h）后预计超额 800 lx·h，
本计划该年估算残余 800 lx·h，转待复核”），`approved_by/approved_at` 与实测记录原样保留。
若预演后额度或相关占用被改动，提交返回 **409**，且 `details.preview` 为**最新核算结果（含新 token）**：

```json
{
  "error": "自预演以来 2032 年额度或相关占用已变化，本次下调未执行；请按最新核算结果确认后重新提交",
  "details": {
    "preview": { "year": 2032, "currentLimit": 100000, "used": 3200, "excess": 1200,
                 "token": "新凭证…", "confirmedMeasurements": [ ] }
  }
}
```

沿用旧接口 `POST /api/exhibits/:id/limits` 直接下调时**不需要凭证**：在同一事务即时重算，
成功响应仍是展品详情（兼容），另附 `overflows` 与 `flaggedPlans`；不超额/上调/首次登记时两者为空、
`limitLowered` 为 `null`。

### 停灯登记 `/api/blackouts`

保管员对**已批准或待复核**计划登记**已发生**的停灯时段（`reason` 必填）。布展员仅有只读权限；
记录一经保存**不可修改/删除**（`PUT/DELETE /api/blackouts/:id` 返回 400）。

登记校验：起点早于终点、结束不晚于当前时间、完整落在计划开灯窗内；不与同展品未作废实测
（含待确认草稿）或其他停灯记录相交。时间/窗口/原因为 400；相交冲突为 **409**，一次性指出全部冲突且不保存。

请求体（起止可跨日，墙上时间，与实测接口同形）：

```json
{
  "planId": 7,
  "startDate": "2032-06-01",
  "startTime": "10:00",
  "endDate": "2032-06-01",
  "endTime": "12:00",
  "reason": "灯具故障临时关灯检修"
}
```

curl 示例（保管员 Cookie 存于 cookies-custodian.txt）：

```bash
# 1) 保管员登记停灯（成功响应 = 更新后的展品详情，另附本次 blackout）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/blackouts \
  -H 'Content-Type: application/json' \
  -d '{"planId":7,"startDate":"2032-06-01","startTime":"10:00",
       "endDate":"2032-06-01","endTime":"12:00","reason":"灯具故障临时关灯检修"}'

# 2) 布展员（或保管员）只读查询停灯记录及各年扣减量
curl -b cookies.txt 'http://localhost:3000/api/blackouts?exhibitId=3'
curl -b cookies.txt 'http://localhost:3000/api/blackouts?planId=7'

# 3) 布展员登记 -> 403；修改/删除 -> 400（停灯记录保留）
curl -b cookies.txt -X DELETE http://localhost:3000/api/blackouts/1
# {"error":"停灯记录保留，不可删除"}
```

成功响应中的停灯对象（展品详情顶层 `blackouts` 为全部记录、`blackoutDeductionYearly` 为各年扣减汇总）：

```json
{
  "id": 1,
  "planId": 7,
  "exhibitId": 3,
  "planTitle": "未来计划1",
  "planStatus": "approved",
  "start": "2032-06-01 10:00",
  "end": "2032-06-01 12:00",
  "reason": "灯具故障临时关灯检修",
  "creatorName": "保管员（默认）",
  "yearly": { "2032": 200 },
  "deductionActive": true
}
```

`yearly` 是该停灯从所属计划**估算**中扣减的按年剂量（计划预计照度 × 窗内停灯时长，按自然年拆分；
已被已确认实测覆盖的部分不重复扣）。所属计划已取消/驳回时记录仍列出，`deductionActive` 为 `false`，
`yearly` 为按当前计划窗计算的名义扣减量，不计入年度占用。

登记冲突（409）响应示例：

```json
{
  "error": "停灯登记失败：与待确认实测 #31（2032-06-01 10:00 ~ 2032-06-01 11:00）相交；与停灯记录 #2（计划「夜场」，2032-06-01 11:30 ~ 2032-06-01 12:30）相交，未保存",
  "details": {
    "overlappingMeasurements": [
      { "id": 31, "planId": 7, "status": "draft", "start": "2032-06-01 10:00", "end": "2032-06-01 11:00" }
    ],
    "overlappingBlackouts": [
      { "id": 2, "planId": 7, "planTitle": "夜场", "start": "2032-06-01 11:30", "end": "2032-06-01 12:30" }
    ]
  }
}
```

后续对停灯时段录入/确认实测同样被拒（409，`details.overlappingBlackoutId`）。
调整申请/成对核准试算的 `conflicts.outsideBlackouts` 会列出落在拟改新窗之外的既有停灯。



```
src/
  server.js        启动入口（等待数据库、初始化、起 HTTP 服务）
  app.js           Express 应用与统一错误处理
  config.js        环境变量配置
  db.js            pg 连接池、事务封装、类型解析
  init.js          建表、初始账号、演示数据
  schema.sql       表结构
  auth.js          会话与角色中间件、bcrypt 登录校验
  audit.js         操作流水写入
  limit-preview.js 下调上限预演凭证（签发/一次性消耗/占用指纹）
  validation.js    中文输入校验（时段/日期/正数等）
  dosing.js        剂量核心算法：时间窗、按年拆分、区间扣除、重叠/包含判断
  service.js       额度占用计算、批准校验、实测窗口校验、待复核筛选、调整申请试算/核对（含成对核准）、下调上限预演核算、停灯登记校验与按年扣减
  routes/          auth/users/exhibits/plans/adjustments/measurements/blackouts/audit 路由
public/            原生 HTML/CSS/JS 单页界面
scripts/test-utils.js  核心算法离线测试
Dockerfile / docker-compose.yml
```
