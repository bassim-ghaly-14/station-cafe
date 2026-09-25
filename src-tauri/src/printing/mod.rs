//! PrintingService — the single entry point for all printing and previewing.
//!
//! Responsibilities: resolve config → render template → duplicate protection
//! → send through the backend → record the job (retry/audit trail).
//! The frontend never sees ESC/POS details.
//!
//! Preview (`preview_*`) is the read-only twin of printing: it runs the SAME
//! template/data path and returns the recorded drawing operations instead of
//! sending bytes — it never touches the printer, never records a print job and
//! never mutates business data.

pub mod backend;
pub mod escpos;
pub mod ir;
pub mod logo;
pub mod templates;

use crate::error::{AppError, AppResult};
use crate::repositories::invoices;
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};
use crate::repositories::Db;
use backend::backend_for;
use escpos::ArabicMode;
use ir::PrintDoc;
pub use ir::PrintPreview;
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
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'printer'",
            [],
            |r| r.get(0),
        )
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
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = station_now()",
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
        // Cutoff computed from the canonical clock so it compares correctly
        // against the explicit-UTC `created_at` values now stored.
        let cutoff = crate::time::to_db_timestamp(
            crate::time::now_utc() - chrono::Duration::seconds(cfg.duplicate_window_secs),
        );
        let recent: i64 = conn.query_row(
            "SELECT COUNT(*) FROM print_jobs
             WHERE content_hash = ?1 AND status = 'PRINTED'
               AND created_at > ?2",
            rusqlite::params![hash, cutoff],
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

/// Document identity + renderer for every invoice-shaped sale.
///
/// This is the ONLY place the CAFE / WASH / HYBRID / TAKEAWAY selection rule
/// lives: the real print and the read-only preview both call it, so the
/// preview can never pick a different template than the printer.
fn invoice_document(
    cfg: &PrintConfig,
    inv: &InvoiceRow,
    lines: &[InvoiceLine],
) -> (String, PrintDoc) {
    // Takeaway has its own document identity (no table, its own number).
    if inv.order_type == "TAKEAWAY" {
        return (
            "TAKEAWAY_INVOICE".to_string(),
            templates::takeaway_receipt(mode_of(cfg), cfg.codepage, inv, lines, true),
        );
    }
    let hybrid = lines.iter().any(|l| l.department == "WASH")
        && lines.iter().any(|l| l.department == "CAFE");
    let doc = if hybrid {
        "HYBRID_INVOICE"
    } else if lines.iter().any(|l| l.department == "WASH") {
        "WASH_INVOICE"
    } else {
        "CAFE_INVOICE"
    };
    (
        doc.to_string(),
        templates::invoice(mode_of(cfg), cfg.codepage, inv, lines, hybrid, true),
    )
}

/// Read-only preview of the current order. Uses the same EscPos/template
/// architecture as print, but never finalizes, prints, records, or allocates.
pub fn preview_order(
    conn: &Db,
    order_id: i64,
    discount_mode: Option<&str>,
    discount_value: Option<i64>,
    service_charge_minor: Option<i64>,
) -> AppResult<PrintPreview> {
    let cfg = get_config(conn)?;
    let current = crate::services::pos::current_print_order(
        conn,
        order_id,
        discount_mode,
        discount_value,
        service_charge_minor,
    )?;
    let doc = if current.order.order_type == "TAKEAWAY" {
        "TAKEAWAY_INVOICE"
    } else if current.totals.has_wash && current.order.lines.iter().any(|l| l.department == "CAFE")
    {
        "HYBRID_INVOICE"
    } else if current.totals.has_wash {
        "WASH_INVOICE"
    } else {
        "CAFE_INVOICE"
    };
    let rendered = templates::current_order(
        mode_of(&cfg),
        cfg.codepage,
        &current.order,
        &current.totals,
        current.customer.as_ref(),
        current.car_plate.as_deref(),
        current.car_model.as_deref(),
        cfg.logo,
    );
    Ok(PrintPreview::new(doc, &rendered))
}

pub fn print_invoice(conn: &Db, invoice_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let (inv, lines) = invoices::get_invoice_full(conn, invoice_id)?
        .ok_or_else(|| AppError::not_found("invoice.not_found"))?;
    let (doc, rendered) = invoice_document(&cfg, &inv, &lines);
    send(conn, &doc, Some(invoice_id), &rendered.escpos, force)
}

/// Read-only preview of a **persisted** invoice: identical template, identical
/// data snapshot, identical byte-level lines — nothing is sent or recorded.
pub fn preview_invoice(conn: &Db, invoice_id: i64) -> AppResult<PrintPreview> {
    let cfg = get_config(conn)?;
    let (inv, lines) = invoices::get_invoice_full(conn, invoice_id)?
        .ok_or_else(|| AppError::not_found("invoice.not_found"))?;
    let (doc, rendered) = invoice_document(&cfg, &inv, &lines);
    Ok(PrintPreview::new(doc, &rendered))
}

pub fn print_wash_ticket(conn: &Db, order_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let ticket = crate::services::pos::issue_wash_ticket(conn, order_id)?;
    let rendered = templates::wash_ticket(mode_of(&cfg), cfg.codepage, &ticket, true);
    send(conn, "WASH_TICKET", Some(order_id), &rendered.escpos, force)
}

/// Read-only preview of an issued wash ticket: uses the same ticket data
/// source as the printed ticket but NEVER allocates a waiting number.
pub fn preview_wash_ticket(conn: &Db, order_id: i64) -> AppResult<PrintPreview> {
    let cfg = get_config(conn)?;
    let ticket = crate::services::pos::wash_ticket_snapshot(conn, order_id)?;
    let rendered = templates::wash_ticket(mode_of(&cfg), cfg.codepage, &ticket, true);
    Ok(PrintPreview::new("WASH_TICKET", &rendered))
}

pub fn print_shift_closing(conn: &Db, shift_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let report = crate::services::reports::shift_report(conn, shift_id)?;
    let rendered = templates::shift_closing(mode_of(&cfg), cfg.codepage, &report, true);
    send(
        conn,
        "SHIFT_REPORT",
        Some(shift_id),
        &rendered.escpos,
        force,
    )
}

/// Read-only preview of the shift-closing document: identical template and
/// identical report snapshot as `print_shift_closing` — nothing is sent or
/// recorded. The report is the final closed-shift snapshot, so preview and
/// print can never diverge.
pub fn preview_shift_closing(conn: &Db, shift_id: i64) -> AppResult<PrintPreview> {
    let cfg = get_config(conn)?;
    let report = crate::services::reports::shift_report(conn, shift_id)?;
    let rendered = templates::shift_closing(mode_of(&cfg), cfg.codepage, &report, true);
    Ok(PrintPreview::new("SHIFT_REPORT", &rendered))
}

pub fn print_day_report(conn: &Db, day_id: i64, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let report = crate::services::reports::day_report(conn, day_id)?;
    let rendered = templates::day_report(mode_of(&cfg), cfg.codepage, &report, true);
    send(conn, "DAY_REPORT", Some(day_id), &rendered.escpos, force)
}

pub fn preview_day_report(conn: &Db, day_id: i64) -> AppResult<PrintPreview> {
    let cfg = get_config(conn)?;
    let report = crate::services::reports::day_report(conn, day_id)?;
    let rendered = templates::day_report(mode_of(&cfg), cfg.codepage, &report, true);
    Ok(PrintPreview::new("DAY_REPORT", &rendered))
}

pub fn print_test(conn: &Db, force: bool) -> AppResult<PrintOutcome> {
    let cfg = get_config(conn)?;
    let rendered = templates::test_page(mode_of(&cfg), cfg.codepage, &cfg.target, true);
    send(conn, "TEST", None, &rendered.escpos, force)
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
            &PrintConfig {
                target: format!("file:{}", path.display()),
                logo: false,
                ..Default::default()
            },
        )
        .unwrap();
        let first = print_test(&conn, false).unwrap();
        let second = print_test(&conn, false).unwrap();
        assert!(!first.duplicate_suppressed);
        assert!(
            second.duplicate_suppressed,
            "identical document must not print twice"
        );
    }

    #[test]
    fn missing_printer_surfaces_a_typed_error() {
        let conn = fresh();
        set_config(&conn, &PrintConfig::default()).unwrap(); // target = "none"
        let err = print_test(&conn, true).unwrap_err();
        assert_eq!(err.kind(), crate::error::ErrorKind::Printer);
    }

    // ---- print preview ----------------------------------------------------

    use crate::printing::escpos::encode_cp1256;
    use crate::repositories::{catalog, customers, pos as pos_repo};
    use crate::services::checkout::{self, CheckoutInput};
    use crate::services::{auth, pos as pos_svc, shifts as shift_svc};

    fn login(conn: &Connection, name: &str, password: &str) -> auth::User {
        auth::login(
            conn,
            &auth::LoginInput {
                name: name.into(),
                password: password.into(),
            },
        )
        .unwrap()
        .user
    }

    fn open_day_and_shift(conn: &Connection) -> auth::User {
        let manager = login(conn, "manager", "manager123");
        let staff = login(conn, "cashier", "cashier123");
        shift_svc::open_day(conn, &manager).unwrap();
        shift_svc::open_shift(conn, &staff, 0).unwrap();
        staff
    }

    fn product_id(conn: &Connection, dept: &str, name: &str) -> i64 {
        catalog::list(conn, Some(dept), true)
            .unwrap()
            .into_iter()
            .find(|p| p.name == name)
            .expect("seeded product")
            .id
    }

    /// Table order with cafe items only → CAFE_INVOICE.
    fn cafe_invoice(conn: &Connection, staff: &auth::User) -> i64 {
        let table = pos_repo::list_tables(conn, None).unwrap().remove(0);
        pos_svc::open_table(conn, staff, table.id).unwrap();
        let order_id = pos_svc::start_order(conn, staff, table.id).unwrap();
        pos_svc::add_line(
            conn,
            staff,
            order_id,
            product_id(conn, "CAFE", "كرواسون رومي"),
            2,
        )
        .unwrap();
        pay(conn, staff, order_id)
    }

    fn pay(conn: &Connection, staff: &auth::User, order_id: i64) -> i64 {
        checkout::checkout(
            conn,
            staff,
            &CheckoutInput {
                order_id,
                method: "CASH".into(),
                discount_mode: None,
                discount_value: None,
                discount_password: None,
                service_charge_minor: None,
                received: Some(1_000_000),
            },
        )
        .unwrap()
        .invoice_id
    }

    /// Table order holding cafe AND wash items → HYBRID_INVOICE.
    fn hybrid_invoice(conn: &Connection, staff: &auth::User) -> i64 {
        let order_id = order_with_wash(conn, staff);
        pos_svc::add_line(conn, staff, order_id, product_id(conn, "CAFE", "مياه"), 1).unwrap();
        pay(conn, staff, order_id)
    }

    /// Open (unpaid) wash order with customer + car; the ticket is NOT issued.
    fn order_with_wash(conn: &Connection, staff: &auth::User) -> i64 {
        let table = pos_repo::list_tables(conn, None).unwrap().remove(0);
        pos_svc::open_table(conn, staff, table.id).unwrap();
        let order_id = pos_svc::start_order(conn, staff, table.id).unwrap();
        pos_svc::add_line(
            conn,
            staff,
            order_id,
            product_id(conn, "WASH", "غسيل كامل سيدان"),
            1,
        )
        .unwrap();
        let customer_id = customers::insert(conn, "أحمد محمود", Some("01234567890"), None).unwrap();
        let plate = format!("PREVIEW{}", conn.last_insert_rowid());
        customers::insert_car(conn, customer_id, &plate, Some("تويوتا"), None).unwrap();
        pos_svc::attach_customer(conn, order_id, customer_id, Some(&plate)).unwrap();
        order_id
    }

    /// Takeaway order with cafe items → TAKEAWAY_INVOICE.
    fn takeaway_invoice(conn: &Connection, staff: &auth::User) -> i64 {
        let order_id = pos_svc::start_takeaway(conn, staff).unwrap();
        pos_svc::add_line(conn, staff, order_id, product_id(conn, "CAFE", "مياه"), 1).unwrap();
        pay(conn, staff, order_id)
    }

    fn printer_to(conn: &Connection, path: &std::path::Path) {
        set_config(
            conn,
            &PrintConfig {
                target: format!("file:{}", path.display()),
                logo: true,
                ..Default::default()
            },
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// The stored historical snapshot the printer uses.
    fn invoice_of(conn: &Connection, invoice_id: i64) -> (InvoiceRow, Vec<InvoiceLine>) {
        invoices::get_invoice_full(conn, invoice_id)
            .unwrap()
            .unwrap()
    }

    fn text_of(preview: &PrintPreview) -> String {
        preview
            .ops
            .iter()
            .filter_map(|o| match o {
                ir::PreviewOp::Text { text, .. } => Some(text.clone()),
                ir::PreviewOp::Item {
                    name,
                    quantity,
                    unit_price,
                    line_total,
                    ..
                } => Some(format!("{name} x{quantity} {unit_price} {line_total}")),
                ir::PreviewOp::Financial { label, value, .. } => Some(format!("{label} {value}")),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Every previewed line must be literally present in the bytes that go to
    /// the printer — the definition of "the preview cannot drift".
    fn assert_lines_inside(preview: &PrintPreview, printed: &[u8]) {
        for op in &preview.ops {
            match op {
                ir::PreviewOp::Text { text, .. } => {
                    if text == "01154520775" {
                        assert!(
                            !printed
                                .windows(encode_cp1256(text).len())
                                .any(|w| w == encode_cp1256(text)),
                            "preview-only business phone must not alter printer bytes"
                        );
                        continue;
                    }
                    let needle = escpos::encode_cp1256(text);
                    assert!(
                        printed.windows(needle.len()).any(|w| w == needle),
                        "preview line missing from printer bytes: {text}"
                    );
                }
                ir::PreviewOp::Item {
                    name,
                    quantity,
                    line_total,
                    ..
                } => {
                    for (field, value) in [
                        ("item name", name.as_str()),
                        ("quantity", quantity.as_str()),
                        ("line total", line_total.as_str()),
                    ] {
                        let needle = escpos::encode_cp1256(value);
                        assert!(
                            printed.windows(needle.len()).any(|w| w == needle),
                            "preview {field} missing from printer bytes: {value}"
                        );
                    }
                }
                ir::PreviewOp::Financial { value, .. } => {
                    let needle = escpos::encode_cp1256(value);
                    assert!(
                        printed.windows(needle.len()).any(|w| w == needle),
                        "preview financial value missing from printer bytes: {value}"
                    );
                }
                _ => {}
            }
        }
    }

    #[test]
    fn current_order_preview_is_read_only_before_payment() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let table = pos_repo::list_tables(&conn, None).unwrap().remove(0);
        pos_svc::open_table(&conn, &staff, table.id).unwrap();
        let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();
        pos_svc::add_line(
            &conn,
            &staff,
            order_id,
            product_id(&conn, "CAFE", "كرواسون رومي"),
            2,
        )
        .unwrap();
        let before = (
            count(&conn, "invoices"),
            count(&conn, "payments"),
            count(&conn, "wash_tickets"),
            count(&conn, "print_jobs"),
        );
        let preview = preview_order(&conn, order_id, None, None, None).unwrap();
        assert_eq!(preview.doc_type, "CAFE_INVOICE");
        assert!(text_of(&preview).contains("قبل الدفع"));
        assert_eq!(
            (
                count(&conn, "invoices"),
                count(&conn, "payments"),
                count(&conn, "wash_tickets"),
                count(&conn, "print_jobs"),
            ),
            before
        );
        assert!(pos_svc::get_order(&conn, order_id).unwrap().status == "OPEN");
    }

    #[test]
    fn current_wash_and_hybrid_previews_never_allocate_ticket_numbers() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let wash = order_with_wash(&conn, &staff);
        let before = count(&conn, "wash_tickets");
        assert_eq!(
            preview_order(&conn, wash, None, None, None)
                .unwrap()
                .doc_type,
            "WASH_INVOICE"
        );
        assert_eq!(count(&conn, "wash_tickets"), before);
        pos_svc::add_line(&conn, &staff, wash, product_id(&conn, "CAFE", "مياه"), 1).unwrap();
        assert_eq!(
            preview_order(&conn, wash, None, None, None)
                .unwrap()
                .doc_type,
            "HYBRID_INVOICE"
        );
        assert_eq!(count(&conn, "wash_tickets"), before);
    }

    #[test]
    fn current_takeaway_preview_is_available_before_payment() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let order_id = pos_svc::start_takeaway(&conn, &staff).unwrap();
        pos_svc::add_line(
            &conn,
            &staff,
            order_id,
            product_id(&conn, "CAFE", "مياه"),
            1,
        )
        .unwrap();
        let before = (count(&conn, "invoices"), count(&conn, "payments"));
        let preview = preview_order(&conn, order_id, None, None, None).unwrap();
        assert_eq!(preview.doc_type, "TAKEAWAY_INVOICE");
        assert_eq!((count(&conn, "invoices"), count(&conn, "payments")), before);
    }

    #[test]
    fn invoice_preview_is_the_print_document_and_writes_nothing() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let invoice_id = cafe_invoice(&conn, &staff);

        // No printer configured at all: previewing is a pure read.
        set_config(&conn, &PrintConfig::default()).unwrap();
        let preview = preview_invoice(&conn, invoice_id).unwrap();
        assert_eq!(preview.doc_type, "CAFE_INVOICE");
        assert_eq!(preview.paper_mm, 80.0);
        assert_eq!(preview.width_chars, templates::WIDTH);
        assert!(
            preview
                .ops
                .iter()
                .any(|o| matches!(o, ir::PreviewOp::Logo { .. })),
            "the thermal logo is part of the document"
        );
        assert_eq!(preview.ops.last(), Some(&ir::PreviewOp::Cut));
        let text = text_of(&preview);
        // Logical Unicode text is preserved for Arabic-capable firmware shaping.
        assert!(text.contains("ستيشن كافيه"), "document header");
        assert!(
            text.contains("الإجمالي") && text.contains("148.00"),
            "totals block"
        );
        assert!(text.contains("148.00"), "2 × 74.00");

        // Same selector, same operations, same bytes as the real print path.
        let (inv, lines) = invoice_of(&conn, invoice_id);
        let (doc_type, rendered) = invoice_document(&get_config(&conn).unwrap(), &inv, &lines);
        assert_eq!(doc_type, preview.doc_type);
        assert_eq!(preview.ops, rendered.ops);
        assert_lines_inside(&preview, &rendered.escpos);

        // A preview records no print job and needs no printer.
        let jobs = count(&conn, "print_jobs");
        preview_invoice(&conn, invoice_id).unwrap();
        assert_eq!(count(&conn, "print_jobs"), jobs, "no print job recorded");
        assert_eq!(
            print_invoice(&conn, invoice_id, true).unwrap_err().kind(),
            crate::error::ErrorKind::Printer,
            "with no printer the real print fails — the preview does not"
        );
    }

    #[test]
    fn every_invoice_preview_has_one_business_phone_at_the_footer() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let path = std::env::temp_dir().join("station_preview_invoice_footers.prn");
        printer_to(&conn, &path);

        for (label, invoice_id, expected) in [
            ("cafe", cafe_invoice(&conn, &staff), "CAFE_INVOICE"),
            (
                "wash",
                {
                    let order_id = order_with_wash(&conn, &staff);
                    pay(&conn, &staff, order_id)
                },
                "WASH_INVOICE",
            ),
            ("hybrid", hybrid_invoice(&conn, &staff), "HYBRID_INVOICE"),
            (
                "takeaway",
                takeaway_invoice(&conn, &staff),
                "TAKEAWAY_INVOICE",
            ),
        ] {
            let preview = preview_invoice(&conn, invoice_id).unwrap();
            let text = text_of(&preview);
            assert_eq!(preview.doc_type, expected, "{label} document type");
            assert_eq!(
                text.matches("01154520775").count(),
                1,
                "{label} one footer phone"
            );
            let last_text = preview.ops.iter().rev().find_map(|op| match op {
                ir::PreviewOp::Text { text, .. } => Some(text.as_str()),
                _ => None,
            });
            assert_eq!(
                last_text,
                Some("01154520775"),
                "{label} phone is last footer text"
            );
            assert!(preview.paper_mm == 80.0, "{label} 80mm paper");
            assert_eq!(
                preview.width_chars,
                templates::WIDTH,
                "{label} logical width"
            );

            let written = {
                let _ = print_invoice(&conn, invoice_id, true).unwrap();
                std::fs::read(&path).unwrap()
            };
            assert!(!written
                .windows("01154520775".len())
                .any(|w| w == b"01154520775"));
        }
    }

    #[test]
    fn preview_selects_the_same_document_type_as_the_print_path() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let path = std::env::temp_dir().join("station_preview_types.prn");
        printer_to(&conn, &path);

        for (label, invoice_id, expected) in [
            ("cafe", cafe_invoice(&conn, &staff), "CAFE_INVOICE"),
            ("hybrid", hybrid_invoice(&conn, &staff), "HYBRID_INVOICE"),
            (
                "takeaway",
                takeaway_invoice(&conn, &staff),
                "TAKEAWAY_INVOICE",
            ),
        ] {
            let preview = preview_invoice(&conn, invoice_id).unwrap();
            assert_eq!(preview.doc_type, expected, "{label} preview doc type");
            let printed = print_invoice(&conn, invoice_id, true).unwrap();
            assert_eq!(printed.doc_type, expected, "{label} print doc type");
            let written = std::fs::read(&path).unwrap();
            assert_eq!(written.len(), printed.bytes, "{label} printer bytes");
            assert_lines_inside(&preview, &written);
        }
    }

    #[test]
    fn wash_ticket_preview_never_allocates_a_waiting_number() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        let order_id = order_with_wash(&conn, &staff);
        let path = std::env::temp_dir().join("station_preview_ticket.prn");
        printer_to(&conn, &path);

        // Not issued yet → the preview refuses instead of consuming a number.
        let err = preview_wash_ticket(&conn, order_id).unwrap_err();
        assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
        assert_eq!(count(&conn, "wash_tickets"), 0, "no ticket was allocated");

        let issued = pos_svc::issue_wash_ticket(&conn, order_id).unwrap();
        let preview = preview_wash_ticket(&conn, order_id).unwrap();
        assert_eq!(preview.doc_type, "WASH_TICKET");
        let text = text_of(&preview);
        assert!(text.contains(&issued.waiting_no.to_string()), "waiting no");
        assert!(
            !text.contains("01154520775"),
            "wash ticket is not an invoice footer"
        );
        assert!(text.contains("PREVIEW"), "car plate");
        assert!(text.contains("غسيل كامل سيدان"), "wash service");

        // The existing reprint command reuses the SAME waiting number.
        print_wash_ticket(&conn, order_id, true).unwrap();
        let written = std::fs::read(&path).unwrap();
        assert_lines_inside(&preview, &written);
        assert_eq!(count(&conn, "wash_tickets"), 1, "reprint allocates none");
        assert_eq!(
            preview_wash_ticket(&conn, order_id).unwrap().ops,
            preview.ops,
            "reprint preview is idempotent"
        );
    }

    #[test]
    fn tmp_dump_preview_ascii() {
        let conn = fresh();
        let staff = open_day_and_shift(&conn);
        for invoice_id in [cafe_invoice(&conn, &staff), hybrid_invoice(&conn, &staff)] {
            let preview = preview_invoice(&conn, invoice_id).unwrap();
            println!(
                "=== {} — {}mm / {} cells ===",
                preview.doc_type, preview.paper_mm, preview.width_chars
            );
            for op in &preview.ops {
                match op {
                    ir::PreviewOp::Logo {
                        width_dots,
                        height_dots,
                        bits_hex,
                        align,
                    } => println!(
                        "[{align:?} LOGO {width_dots}x{height_dots} = {} hex chars]",
                        bits_hex.len()
                    ),
                    ir::PreviewOp::Text {
                        text,
                        align,
                        bold,
                        width,
                        height,
                    } => println!("[{align:?} bold={bold} {width}x{height}] {text}"),
                    ir::PreviewOp::Item {
                        name,
                        quantity,
                        unit_price,
                        line_total,
                        align,
                    } => println!("[{align:?} ITEM] {name} x{quantity} {unit_price} {line_total}"),
                    ir::PreviewOp::Financial {
                        label,
                        value,
                        total,
                        align,
                    } => println!("[{align:?} FINANCIAL total={total}] {label} {value}"),
                    ir::PreviewOp::Feed { lines } => println!("[FEED {lines}]"),
                    ir::PreviewOp::Cut => println!("[CUT]"),
                }
            }
        }
        let order_id = order_with_wash(&conn, &staff);
        crate::services::pos::issue_wash_ticket(&conn, order_id).unwrap();
        let ticket = preview_wash_ticket(&conn, order_id).unwrap();
        println!("=== {} ===", ticket.doc_type);
        for op in &ticket.ops {
            match op {
                ir::PreviewOp::Text {
                    text,
                    align,
                    bold,
                    width,
                    height,
                } => println!("[{align:?} bold={bold} {width}x{height}] {text}"),
                ir::PreviewOp::Logo {
                    width_dots,
                    height_dots,
                    ..
                } => {
                    println!("[LOGO {width_dots}x{height_dots}]")
                }
                ir::PreviewOp::Item { name, quantity, .. } => {
                    println!("[ITEM] {name} x{quantity}")
                }
                ir::PreviewOp::Financial {
                    label,
                    value,
                    total,
                    ..
                } => {
                    println!("[FINANCIAL total={total}] {label} {value}")
                }
                ir::PreviewOp::Feed { lines } => println!("[FEED {lines}]"),
                ir::PreviewOp::Cut => println!("[CUT]"),
            }
        }
    }

    #[test]
    fn preview_of_a_missing_document_is_a_not_found_error() {
        let conn = fresh();
        assert_eq!(
            preview_invoice(&conn, 4242).unwrap_err().kind(),
            crate::error::ErrorKind::NotFound
        );
    }
}
