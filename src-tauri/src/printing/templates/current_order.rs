use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::invoice_format::{close_meta_block, meta_row, meta_timestamp, open_meta_block};
use super::shared::{footer, invoice_header, items_and_totals, DocLine, DocTotals};
use crate::repositories::pos::Order;

/// Pre-payment preview of the current order.
///
/// It carries its own identity (no invoice number, a "before payment" marker)
/// but composes its BODY with the shared composer, so a hybrid order separates
/// the cafe and wash subtotals here exactly as it will on the printed invoice.
pub fn current_order(
    mode: ArabicMode,
    codepage: u8,
    order: &Order,
    totals: &crate::services::pos::OrderPreview,
    customer: Option<&crate::services::pos::OrderCustomer>,
    car_plate: Option<&str>,
    car_model: Option<&str>,
    logo: bool,
) -> PrintDoc {
    if order.order_type == "TAKEAWAY" {
        return super::takeaway_receipt::takeaway_order(
            mode, codepage, order, totals, customer, car_plate, car_model, logo,
        );
    }
    let mut p = EscPos::new(mode, codepage);
    invoice_header(
        &mut p,
        logo,
        "ستيشن كافيه",
        "Station Cafe - Cafe & Car Wash",
    );
    // Same identity block, same width model and same date/time rules as the
    // settled invoice this preview becomes.
    open_meta_block(&mut p);
    meta_timestamp(&mut p, &order.opened_at);
    meta_row(&mut p, "رقم الطلب", &order.id.to_string());
    if let Some(label) = &order.table_label {
        meta_row(&mut p, "الطاولة", label);
    }
    if let Some(c) = customer {
        meta_row(&mut p, "العميل", &c.name);
        if let Some(phone) = &c.phone {
            meta_row(&mut p, "تليفون", phone);
        }
    }
    if let Some(plate) = car_plate {
        meta_row(&mut p, "رقم السيارة", plate);
    }
    if let Some(model) = car_model {
        meta_row(&mut p, "نوع السيارة", model);
    }
    close_meta_block(&mut p);
    // The car model already appears in the identity block above, so the
    // composer is told not to repeat it inside the wash section.
    items_and_totals(
        &mut p,
        &order_doc_lines(&order.lines),
        &DocTotals {
            subtotal: totals.subtotal,
            discount_minor: totals.discount_minor,
            service_charge_minor: totals.service_charge_minor,
            total: totals.total,
            // A live order has no persisted snapshot: each department subtotal
            // is derived from the very line totals printed above it.
            dept_subtotals: None,
            settlement: None,
        },
        None,
    );
    p.align(Align::Center);
    p.line("معاينة الطلب — قبل الدفع");
    footer(p)
}

/// Adapt live order lines to the neutral composer shape.
pub(super) fn order_doc_lines(lines: &[crate::repositories::pos::OrderLine]) -> Vec<DocLine<'_>> {
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
