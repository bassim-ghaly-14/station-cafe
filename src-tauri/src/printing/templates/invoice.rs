use super::super::escpos::{ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::invoice_format::{close_meta_block, meta_row, meta_timestamp, open_meta_block};
use super::shared::{footer, invoice_header, items_and_totals, DocLine, DocSettlement, DocTotals};
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};

/// Cafe / Wash / Hybrid invoice. The hybrid layout is the shared composer with
/// department sections — a presentation mode, not a separate entity, and not a
/// second rendering path.
///
/// Cafe, wash and hybrid are ONE template: the same invoice header, the same
/// print-layer currency statement, the same full-width metadata block and the
/// same date/time presentation, whatever departments the document carries.
pub fn invoice(
    mode: ArabicMode,
    codepage: u8,
    inv: &InvoiceRow,
    lines: &[InvoiceLine],
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    invoice_header(
        &mut p,
        logo,
        "ستيشن كافيه",
        "Station Cafe - Cafe & Car Wash",
    );
    // The identity block: full printable width, print-specific date & time.
    open_meta_block(&mut p);
    meta_timestamp(&mut p, &inv.created_at);
    meta_row(&mut p, "رقم الفاتورة", &inv.invoice_no.to_string());
    if let Some(t) = &inv.table_label {
        meta_row(&mut p, "الطاولة", t);
    }
    if let Some(c) = &inv.customer_name {
        meta_row(&mut p, "العميل", c);
    }
    if let Some(ph) = &inv.customer_phone {
        meta_row(&mut p, "تليفون", ph);
    }
    if let Some(pl) = &inv.car_plate {
        meta_row(&mut p, "رقم السيارة", pl);
    }
    if let Some(model) = &inv.car_model {
        meta_row(&mut p, "نوع السيارة", model);
    }
    close_meta_block(&mut p);
    items_and_totals(
        &mut p,
        &doc_lines(lines),
        &DocTotals {
            subtotal: inv.subtotal,
            discount_minor: inv.discount_minor,
            service_charge_minor: inv.service_charge,
            total: inv.total,
            // The stored snapshot: a historical invoice always prints the
            // department subtotals it was settled with.
            dept_subtotals: Some((inv.cafe_total, inv.wash_total)),
            settlement: Some(DocSettlement {
                paid_amount: inv.paid_amount,
                credit_remaining: (inv.status == "CREDIT").then_some(inv.total - inv.paid_amount),
            }),
        },
        None,
    );
    footer(p)
}

/// Adapt persisted invoice lines to the neutral composer shape.
pub(super) fn doc_lines(lines: &[InvoiceLine]) -> Vec<DocLine<'_>> {
    lines
        .iter()
        .map(|l| DocLine {
            department: &l.department,
            product_name: &l.product_name,
            unit_price: l.unit_price,
            quantity: l.quantity,
            line_total: l.line_total,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printing::escpos::{encode_cp1256, ArabicMode};
    use crate::printing::ir::PreviewOp;

    fn bytes_has(bytes: &[u8], needle: &str) -> bool {
        let encoded = encode_cp1256(needle);
        bytes.windows(encoded.len()).any(|w| w == encoded)
    }

    #[test]
    fn invoice_tests_preserve_hybrid_layout_and_totals() {
        let inv = crate::repositories::invoices::InvoiceRow {
            id: 1,
            invoice_no: 7,
            table_label: Some("طاولة 04".into()),
            order_type: "TABLE".into(),
            takeaway_no: None,
            status: "PAID".into(),
            total: 240_00,
            paid_amount: 240_00,
            service_charge: 20_00,
            discount_minor: 10_00,
            subtotal: 230_00,
            cafe_total: 70_00,
            wash_total: 160_00,
            customer_name: None,
            customer_phone: None,
            car_plate: None,
            car_model: Some("تويوتا".into()),
            created_at: "2026-09-21 12:00:00".into(),
            shift_id: Some(1),
            business_day_id: Some(1),
        };
        let lines = vec![
            crate::repositories::invoices::InvoiceLine {
                department: "CAFE".into(),
                product_name: "قهوة".into(),
                unit_price: 35_00,
                quantity: 2,
                discount_minor: 0,
                line_total: 70_00,
            },
            crate::repositories::invoices::InvoiceLine {
                department: "WASH".into(),
                product_name: "مغسلة كامل".into(),
                unit_price: 160_00,
                quantity: 1,
                discount_minor: 0,
                line_total: 160_00,
            },
        ];
        let doc = invoice(ArabicMode::Cp1256, 22, &inv, &lines, false);
        // Hybrid: each department is separated and states its own subtotal.
        assert!(bytes_has(&doc.escpos, "إجمالي الكافيه الفرعي"));
        assert!(bytes_has(&doc.escpos, "إجمالي المغسلة الفرعي"));
        assert!(bytes_has(&doc.escpos, "70.00"));
        assert!(bytes_has(&doc.escpos, "160.00"));
        assert!(bytes_has(&doc.escpos, "تويوتا"));
        assert!(String::from_utf8_lossy(&doc.escpos).contains("240.00"));
        let hrs = doc
            .ops
            .iter()
            .filter(
                |op| matches!(op, PreviewOp::Text { text, .. } if text.chars().all(|c| c == '-')),
            )
            .count();
        assert_eq!(hrs, 5);
    }

    /// The printed timestamp must be Station business time, not the raw UTC
    /// digits that are stored. This is the receipt-agrees-with-screen rule —
    /// expressed in the print layer's own date and time formats.
    #[test]
    fn printed_timestamp_is_business_local_time_not_utc() {
        let mut inv = crate::repositories::invoices::InvoiceRow {
            id: 1,
            invoice_no: 7,
            table_label: None,
            order_type: "TAKEAWAY".into(),
            takeaway_no: Some(1),
            status: "PAID".into(),
            total: 100_00,
            paid_amount: 100_00,
            service_charge: 0,
            discount_minor: 0,
            subtotal: 100_00,
            cafe_total: 100_00,
            wash_total: 0,
            customer_name: None,
            customer_phone: None,
            car_plate: None,
            car_model: None,
            // A sale made at 17:30 in Cairo is stored as 14:30 UTC.
            created_at: "2026-09-25 14:30:00Z".into(),
            shift_id: Some(1),
            business_day_id: Some(1),
        };
        let lines = vec![];
        let doc = invoice(ArabicMode::Cp1256, 22, &inv, &lines, false);
        assert!(
            bytes_has(&doc.escpos, "25/09/2026"),
            "the receipt prints the Cairo calendar day, in the invoice date format"
        );
        assert!(
            bytes_has(&doc.escpos, "05:30 PM"),
            "the receipt must print 05:30 PM (Cairo), not 14:30 (UTC)"
        );
        assert!(!bytes_has(&doc.escpos, "14:30"));
        // The invoice never inherits the screen's `YYYY-MM-DD HH:MM` shape.
        assert!(!bytes_has(&doc.escpos, "2026-09-25 17:30"));

        // A legacy unmarked value converts identically — same instant, same
        // printed result, so historical invoices reprint consistently.
        inv.created_at = "2026-09-25 14:30:00".into();
        let legacy = invoice(ArabicMode::Cp1256, 22, &inv, &lines, false);
        assert!(bytes_has(&legacy.escpos, "25/09/2026"));
        assert!(bytes_has(&legacy.escpos, "05:30 PM"));
    }

    /// The invoice states its currency in full, in the print layer, and never
    /// carries the application's global currency abbreviation.
    #[test]
    fn printed_currency_is_egp_and_never_the_app_currency_abbreviation() {
        let inv = crate::repositories::invoices::InvoiceRow {
            id: 1,
            invoice_no: 7,
            table_label: None,
            order_type: "TABLE".into(),
            takeaway_no: None,
            status: "PAID".into(),
            total: 100_00,
            paid_amount: 100_00,
            service_charge: 0,
            discount_minor: 0,
            subtotal: 100_00,
            cafe_total: 100_00,
            wash_total: 0,
            customer_name: None,
            customer_phone: None,
            car_plate: None,
            car_model: None,
            created_at: "2026-09-25 14:30:00Z".into(),
            shift_id: Some(1),
            business_day_id: Some(1),
        };
        let doc = invoice(ArabicMode::Cp1256, 22, &inv, &[], false);
        assert!(bytes_has(&doc.escpos, "المبالغ بالجنيه المصري"));
        assert!(!bytes_has(&doc.escpos, "ج.م"));
    }

    /// The identity block is a full-width two-column section, not a stack of
    /// lines hugging one side: every metadata row occupies the same printable
    /// width as the item table below it.
    #[test]
    fn the_metadata_block_uses_the_full_printable_width() {
        let inv = crate::repositories::invoices::InvoiceRow {
            id: 1,
            invoice_no: 7,
            table_label: Some("طاولة 04".into()),
            order_type: "TABLE".into(),
            takeaway_no: None,
            status: "PAID".into(),
            total: 100_00,
            paid_amount: 100_00,
            service_charge: 0,
            discount_minor: 0,
            subtotal: 100_00,
            cafe_total: 100_00,
            wash_total: 0,
            customer_name: Some("أحمد".into()),
            customer_phone: Some("0100000000".into()),
            car_plate: Some("ABC123".into()),
            car_model: None,
            created_at: "2026-09-25 14:30:00Z".into(),
            shift_id: Some(1),
            business_day_id: Some(1),
        };
        let doc = invoice(ArabicMode::Cp1256, 22, &inv, &[], false);

        let metadata: Vec<&PreviewOp> = doc
            .ops
            .iter()
            .filter(|op| matches!(op, PreviewOp::Meta { .. }))
            .collect();
        // date, time, invoice number, table, customer, phone, plate.
        assert_eq!(metadata.len(), 7);
        for op in metadata {
            let PreviewOp::Meta { align, .. } = op else {
                unreachable!()
            };
            assert_eq!(
                *align,
                crate::printing::escpos::Align::Right,
                "the identity block shares the body's alignment"
            );
        }

        // Every physical metadata line spans the whole 42-cell printable width,
        // which is what makes the block read as a section rather than a column.
        let rows = super::super::invoice_format::printed_text_lines(&doc);
        for row in &rows {
            assert!(
                row.chars().count() <= crate::printing::templates::WIDTH,
                "no printed line may exceed the printable width: {row:?}"
            );
        }
        // One full-width physical line per metadata row, plus the dividers.
        let full_width = rows
            .iter()
            .filter(|row| row.chars().count() == crate::printing::templates::WIDTH)
            .count();
        assert!(
            full_width >= 7,
            "each of the 7 metadata rows must reach both edges of the paper: {full_width}"
        );
    }
}
