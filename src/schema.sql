-- 纸质展品光照额度管理：数据库结构
-- 剂量单位统一为 lx·h（照度小时积），按墙上时间（配置的固定 UTC 偏移）归属自然年。

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('conservator', 'installer')),
    display_name    TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exhibits (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    accession_no    TEXT,
    medium          TEXT,
    note            TEXT,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每件展品每个自然年的年度照度时数上限（lx·h）
CREATE TABLE IF NOT EXISTS annual_limits (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    limit_lxh       NUMERIC(12,3) NOT NULL CHECK (limit_lxh > 0),
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (exhibit_id, year)
);

-- 布展计划
-- status: submitted 待批准 / approved 已批准 / rejected 已驳回 / cancelled 已取消 /
--         pending_review 待复核（迟到实测超额导致）
CREATE TABLE IF NOT EXISTS plans (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL CHECK (end_date >= start_date),
    -- 每日开灯时段，形如 ["09:00-12:00","13:00-17:00"]
    light_periods   JSONB NOT NULL,
    estimated_lux   NUMERIC(10,2) NOT NULL CHECK (estimated_lux > 0),
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','approved','rejected','cancelled','pending_review')),
    review_reason   TEXT,
    created_by      BIGINT REFERENCES users(id),
    approved_by     BIGINT REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plans_exhibit_status ON plans (exhibit_id, status);

-- 计划调整申请（布展员对“已批准且尚未开始”的计划提交，保管员审核）
-- status: pending 待审 / approved 已通过 / rejected 已驳回 / withdrawn 已撤回
-- 同一计划同时只允许一份 pending 申请（部分唯一索引保证）。
-- 待审期间原计划继续占用额度；通过后原子更新 plans 的展期/开灯时段/预计照度。
CREATE TABLE IF NOT EXISTS plan_adjustments (
    id                    BIGSERIAL PRIMARY KEY,
    plan_id               BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id            BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_date            DATE NOT NULL,
    end_date              DATE NOT NULL CHECK (end_date >= start_date),
    light_periods         JSONB NOT NULL,
    estimated_lux         NUMERIC(10,2) NOT NULL CHECK (estimated_lux > 0),
    reason                TEXT,
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','withdrawn')),
    reject_reason         TEXT,
    created_by            BIGINT REFERENCES users(id),
    reviewed_by           BIGINT REFERENCES users(id),
    reviewed_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同一计划同时只允许一份待审申请；已结案（通过/驳回/撤回）的记录保留。
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_pending_per_plan
    ON plan_adjustments (plan_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_adjustment_exhibit ON plan_adjustments (exhibit_id, status);
CREATE INDEX IF NOT EXISTS idx_adjustment_plan ON plan_adjustments (plan_id, id);

-- 实测记录：先录入（draft），保管员确认（confirmed）后以实测替代估算；
-- annulled 表示登记作废（原始记录保留）。
CREATE TABLE IF NOT EXISTS measurements (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    actual_lux      NUMERIC(10,2) NOT NULL CHECK (actual_lux > 0),
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','confirmed','annulled')),
    created_by      BIGINT REFERENCES users(id),
    confirmed_by    BIGINT REFERENCES users(id),
    confirmed_at    TIMESTAMPTZ,
    annulled_by     BIGINT REFERENCES users(id),
    annulled_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meas_exhibit_status ON measurements (exhibit_id, status);
CREATE INDEX IF NOT EXISTS idx_meas_plan ON measurements (plan_id);

-- 停灯记录：保管员对已批准/待复核计划登记“已发生”的停灯时段（必填原因）。
-- 停灯时段只从所属计划“未被已确认实测覆盖”的估算时段中扣减剂量（按墙上自然年拆分），
-- 不减已确认实测、不释放原计划的排期占用（计划开灯窗与重叠判定均不变）。
-- 记录一经写入永久保留：不提供修改/删除接口；计划取消/调整后记录仍保留。
-- 不变量（由登记/实测/调整核对共同保证）：
--   * 起止为正时长、起点早于终点、结束不晚于登记当时；
--   * 完整落在登记时所属计划的开灯窗内（计划调整核对要求停灯仍落在新窗内）；
--   * 不与同展品任何未作废实测（含草稿）相交；
--   * 不与同展品其他停灯记录相交。
CREATE TABLE IF NOT EXISTS blackouts (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    reason          TEXT NOT NULL,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blackout_exhibit ON blackouts (exhibit_id, id);
CREATE INDEX IF NOT EXISTS idx_blackout_plan ON blackouts (plan_id, id);

-- 操作流水（审批、确认、状态变更等全部保留）
CREATE TABLE IF NOT EXISTS audit_events (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        BIGINT REFERENCES users(id),
    actor_name      TEXT,
    action          TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_id       BIGINT,
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at);
