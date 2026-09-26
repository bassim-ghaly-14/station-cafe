use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{footer, header, items_and_totals, stamp, DocSettlement, DocTotals, WIDTH};
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};
use crate::repositories::pos::Order;
use crate::services::pos::{OrderCustomer, OrderPreview};

/// Keep the Takeaway identity compact and identical for both document paths.
/// A separate label line avoids scaling a long Arabic `kv_line` across 42
/// logical columns, while the number remains the visual focal point.
fn takeaway_identity(p: &mut EscPos, takeaway_no: Option<i64>) {
    if let Some(no) = takeaway_no {
        p.align(Align::Center);
        p.bold(true);
        p.line("رقم الطلب الخارجي");
        p.bold(false);
        p.size(2, 2);
        p.bold(true);
        p.line(&no.to_string());
        p.size(1, 1);
        p.bold(false);
    }
}

/// Current-order takeaway composition. Kept beside the persisted takeaway
/// receipt so both preview entry points share takeaway-specific ownership.
pub(crate) fn takeaway_order(
    mode: ArabicMode,
    codepage: u8,
    order: &Order,
    totals: &OrderPreview,
    customer: Option<&OrderCustomer>,
    car_plate: Option<&str>,
    car_model: Option<&str>,
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(
        &mut p,
        logo,
        "طلبات خارجية — ستيشن كافيه",
        "TAKEAWAY RECEIPT",
    );
    takeaway_identity(&mut p, order.takeaway_no);
    p.align(Align::Right);
    p.kv_line("الطلب", &order.id.to_string(), WIDTH);
    p.kv_line("التاريخ", &stamp(&order.opened_at), WIDTH);
    if let Some(c) = customer {
        p.kv_line("العميل", &c.name, WIDTH);
        if let Some(phone) = &c.phone {
            p.kv_line("تليفون", phone, WIDTH);
        }
    }
    if let Some(plate) = car_plate {
        p.kv_line("رقم السيارة", plate, WIDTH);
    }
    // The car model belongs to the wash section, and the shared composer prints
    // it there for a hybrid document — so it is only stated in the identity
    // block when this order has no wash items of its own.
    let has_wash = order.lines.iter().any(|l| l.department == "WASH");
    if !has_wash {
        if let Some(model) = car_model {
            p.kv_line("نوع السيارة", model, WIDTH);
        }
    }
    p.hr(WIDTH);
    items_and_totals(
        &mut p,
        &super::current_order::order_doc_lines(&order.lines),
        &DocTotals {
            subtotal: totals.subtotal,
            discount_minor: totals.discount_minor,
            service_charge_minor: totals.service_charge_minor,
            total: totals.total,
            dept_subtotals: None,
            settlement: None,
        },
        car_model.filter(|_| has_wash),
    );
    p.align(Align::Center);
    p.line("معاينة الطلب — قبل الدفع");
    footer(p)
}

/// Takeaway receipt — a distinct document identity for an order that has no
/// table: the takeaway number replaces the table line and the header states
/// the context explicitly. Same items/totals renderer as the invoices.
pub fn takeaway_receipt(
    mode: ArabicMode,
    codepage: u8,
    inv: &InvoiceRow,
    lines: &[InvoiceLine],
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(
        &mut p,
        logo,
        "طلبات خارجية — ستيشن كافيه",
        "TAKEAWAY RECEIPT",
    );
    takeaway_identity(&mut p, inv.takeaway_no);
    p.align(Align::Right);
    p.kv_line("فاتورة رقم", &inv.invoice_no.to_string(), WIDTH);
    p.kv_line("التاريخ", &stamp(&inv.created_at), WIDTH);
    if let Some(c) = &inv.customer_name {
        p.kv_line("العميل", c, WIDTH);
    }
    if let Some(phone) = &inv.customer_phone {
        p.kv_line("تليفون", phone, WIDTH);
    }
    if let Some(plate) = &inv.car_plate {
        p.kv_line("رقم السيارة", plate, WIDTH);
    }
    // The shared department renderer places the car model beside the WASH
    // section for hybrid documents. Keep the model out of the metadata here
    // to avoid printing the immutable snapshot twice.
    if inv.car_model.is_some() && !lines.iter().any(|l| l.department == "WASH") {
        p.kv_line(
            "نوع السيارة",
            inv.car_model.as_deref().unwrap_or_default(),
            WIDTH,
        );
    }
    p.hr(WIDTH);
    items_and_totals(
        &mut p,
        &super::invoice::doc_lines(lines),
        &DocTotals {
            subtotal: inv.subtotal,
            discount_minor: inv.discount_minor,
            service_charge_minor: inv.service_charge,
            total: inv.total,
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
