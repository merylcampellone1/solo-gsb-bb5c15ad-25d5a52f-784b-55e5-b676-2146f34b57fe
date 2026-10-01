'use strict';

/** 写一条操作流水。事务 client 可选。 */
async function recordAudit(client, actor, action, targetType, targetId, detail = {}) {
  await client.query(
    `INSERT INTO audit_events (actor_id, actor_name, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      actor ? actor.userId : null,
      actor ? actor.username : null,
      action,
      targetType,
      targetId || null,
      JSON.stringify(detail),
    ]
  );
}

module.exports = { recordAudit };
