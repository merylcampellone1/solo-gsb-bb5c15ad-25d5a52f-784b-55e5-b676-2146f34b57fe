'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// 操作流水：保管员可查，可按对象过滤
router.get('/', requireAuth, requireRole('conservator'), async (req, res, next) => {
  try {
    const targetType = req.query.targetType ? String(req.query.targetType) : null;
    const targetId = req.query.targetId ? Number(req.query.targetId) : null;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const { rows } = await query(
      `SELECT id, actor_id, actor_name, action, target_type, target_id, detail, created_at
         FROM audit_events
        WHERE ($1::text IS NULL OR target_type = $1)
          AND ($2::bigint IS NULL OR target_id = $2)
        ORDER BY id DESC
        LIMIT $3`,
      [targetType, Number.isInteger(targetId) ? targetId : null, limit]
    );
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
