//! Audit logging service. Every sensitive business action funnels through
//! `record()` inside the same transaction as the action itself.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde_json::Value;

/// Record one audit entry. Runs inside the caller's transaction — if the
/// business action rolls back, the audit entry rolls back with it.
pub fn record(
    conn: &Db,
    actor_id: Option<i64>,
    actor_role: Option<&str>,
    action: &str,
    entity_type: &str,
    entity_id: Option<&str>,
    before: Option<&Value>,
    after: Option<&Value>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            actor_id,
            actor_role,
            action,
            entity_type,
            entity_id,
            before.map(|v| v.to_string()),
            after.map(|v| v.to_string()),
        ],
    )?;
    Ok(())
}