//! PrintingService — the single entry point for all printing.
//!
//! Responsibilities: resolve config → render template → duplicate protection
//! → send through the backend → record the job (retry/audit trail).
//! The frontend never sees ESC/POS details.

pub mod backend;
pub mod escpos;
pub mod logo;
pub mod templates;

use crate::error::AppResult;
use crate::repositories::invoices;
use crate::repositories::Db;
use backend::backend_for;
use escpos::ArabicMode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintConfig {
    /// `file:/path`, `share:QueueName`, or a bare queue name.
    pub target: String,
    pub arabic_mode: String, // CP1256 | LATIN
    pub codepage: u8,
    pub logo: bool,
    /// Duplicate-print guard window in seconds (0 = disabled).
    pub duplicate_window_secs: i64,
}

impl Default for PrintConfig {
    fn default() -> Self {
        Self {
            target: "none".into(),
            arabic_mode: "CP1256".into(),
            codepage: 22,
            logo: true,
            duplicate_window_secs: 60,
        }
    }
}

pub fn get_config(conn: &Db) -> AppResult<PrintConfig> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = 'printer'", [], |r| r.get(0))
        .ok();
    match raw {
        Some(v) => Ok(serde_json::from_str(&v).unwrap_or_default()),
        None => Ok(PrintConfig::default()),
    }
}

pub fn set_config(conn: &Db, cfg: &PrintConfig) -> AppResult<()> {
    let json = serde_json::to_string(cfg).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('printer', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = datetime('now')",
        [json],
    )?;
    Ok(())
}

fn mode_of(cfg: &PrintConfig) -> ArabicMode {
    match cfg.arabic_mode.as_str() {
        "LATIN" => ArabicMode::Latin,
        _ => ArabicMode::Cp1256,
    }
}

#[derive(Debug, Serialize)]
pub struct PrintOutcome {
    pub doc_type: String,
    pub target: String,
    pub bytes: usize,
    pub duplicate_suppressed: bool,
}

/// Core send path: duplicate protection + job record + backend send.
fn send(
    conn: &Db,
    doc_type: &str,
    ref_id: Option<i64>,
    bytes: &[u8],
    force: bool,
) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let hash = {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    };

    if !force && cfg.duplicate_window_secs > 0 {
        let recent: i64 = conn.query_row(
            "SELECT COUNT(*) FROM print_jobs
             WHERE content_hash = ?1 AND status = 'PRINTED'
               AND created_at > datetime('now', ?2)",
            rusqlite::params![hash, format!("-{} seconds", cfg.duplicate_window_secs)],
            |r| r.get(0),
        )?;
        if recent > 0 {
            return Ok(PrintOutcome {
                doc_type: doc_type.to_string(),
                target: cfg.target.clone(),
                bytes: bytes.len(),
                duplicate_suppressed: true,
            });
        }
    }

    conn.execute(
        "INSERT INTO print_jobs (doc_type, ref_id, content_hash, status) VALUES (?1, ?2, ?3, 'PENDING')",
        rusqlite::params![doc_type, ref_id, hash],
    )?;
    let job_id = conn.last_insert_rowid();

    match backend_for(&cfg.target).and_then(|b| {
        b.probe()?;
        b.send(bytes)
    }) {
        Ok(()) => {
            conn.execute(
                "UPDATE print_jobs SET status = 'PRINTED', attempts = attempts + 1 WHERE id = ?1",
                [job_id],
            )?;
            Ok(PrintOutcome {
                doc_type: doc_type.to_string(),
                target: cfg.target.clone(),
                bytes: bytes.len(),
                duplicate_suppressed: false,
            })
        }
        Err(e) => {
            conn.execute(
                "UPDATE print_jobs SET status = 'FAILED', attempts = attempts + 1, error = ?2
                 WHERE id = ?1",
                rusqlite::params![job_id, e.to_string()],
            )?;
            Err(e)
        }
    }
}

pub fn print_invoice(conn: &Db, invoice_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let (inv, lines) = invoices::get_invoice_full(conn, invoice_id)?
        .ok_or_else(|| crate::error::AppError::not_found("invoice.not_found"))?;
    let hybrid = lines.iter().any(|l| l.department == "WASH")
        && lines.iter().any(|l| l.department == "CAFE");
    let doc = if hybrid {
        "HYBRID_INVOICE"
    } else if lines.iter().any(|l| l.department == "WASH") {
        "WASH_INVOICE"
    } else {
        "CAFE_INVOICE"
    };
    let bytes = templates::invoice(mode_of(&cfg), cfg.codepage, &inv, &lines, hybrid, true);
    send(conn, doc, Some(invoice_id), &bytes, force)
}

pub fn print_wash_ticket(conn: &Db, order_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let ticket = crate::services::pos::issue_wash_ticket(conn, order_id)?;
    let bytes = templates::wash_ticket(mode_of(&cfg), cfg.codepage, &ticket, true);
    send(conn, "WASH_TICKET", Some(order_id), &bytes, force)
}

pub fn print_shift_closing(conn: &Db, shift_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let report = crate::services::reports::shift_report(conn, shift_id)?;
    let bytes = templates::shift_closing(mode_of(&cfg), cfg.codepage, &report, true);
    send(conn, "SHIFT_REPORT", Some(shift_id), &bytes, force)
}

pub fn print_day_report(conn: &Db, day_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let report = crate::services::reports::day_report(conn, day_id)?;
    let bytes = templates::day_report(mode_of(&cfg), cfg.codepage, &report, true);
    send(conn, "DAY_REPORT", Some(day_id), &bytes, force)
}

pub fn print_test(conn: &Db, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let bytes = templates::test_page(mode_of(&cfg), cfg.codepage, &cfg.target, true);
    send(conn, "TEST", None, &bytes, force)
}

#[derive(Debug, Serialize)]
pub struct PrintJobRow {
    pub id: i64,
    pub doc_type: String,
    pub status: String,
    pub attempts: i64,
    pub error: Option<String>,
    pub created_at: String,
}

/// Recent jobs — surfaces printer failures/retries to the manager UI.
pub fn recent_jobs(conn: &Db, limit: i64) -> AppResult<Vec<PrintJobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, doc_type, status, attempts, error, created_at FROM print_jobs
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit.clamp(1, 200)], |r| {
        Ok(PrintJobRow {
            id: r.get(0)?,
            doc_type: r.get(1)?,
            status: r.get(2)?,
            attempts: r.get(3)?,
            error: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::seed::run_if_empty;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        conn
    }

    #[test]
    fn test_print_writes_bytes_and_records_job() {
        let conn = fresh();
        let path = std::env::temp_dir().join("station_print_test.prn");
        let cfg = PrintConfig {
            target: format!("file:{}", path.display()),
            arabic_mode: "CP1256".into(),
            codepage: 22,
            logo: false,
            duplicate_window_secs: 60,
        };
        set_config(&conn, &cfg).unwrap();
        let out = print_test(&conn, true).unwrap();
        assert!(!out.duplicate_suppressed);
        let written = std::fs::read(&path).unwrap();
        assert_eq!(written.len(), out.bytes);
        let jobs = recent_jobs(&conn, 5).unwrap();
        assert_eq!(jobs[0].status, "PRINTED");
    }

    #[test]
    fn duplicate_print_is_suppressed_inside_the_window() {
        let conn = fresh();
        let path = std::env::temp_dir().join("station_print_dup.prn");
        set_config(
            &conn,
            &PrintConfig { target: format!("file:{}", path.display()), logo: false, ..Default::default() },
        )
        .unwrap();
        let first = print_test(&conn, false).unwrap();
        let second = print_test(&conn, false).unwrap();
        assert!(!first.duplicate_suppressed);
        assert!(second.duplicate_suppressed, "identical document must not print twice");
    }

    #[test]
    fn missing_printer_surfaces_a_typed_error() {
        let conn = fresh();
        set_config(&conn, &PrintConfig::default()).unwrap(); // target = "none"
        let err = print_test(&conn, true).unwrap_err();
        assert_eq!(err.kind(), crate::error::ErrorKind::Printer);
    }
}