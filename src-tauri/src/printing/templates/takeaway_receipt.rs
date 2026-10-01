use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::invoice_format::{
    close_meta_block, meta_row, meta_timestamp, open_meta_block, party_identity,
};
use super::shared::{footer, invoice_header, items_and_totals, DocSettlement, DocTotals};
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
    invoice_header(
        &mut p,
        logo,
        "طلبات خارجية — ستيشن كافيه",
        "TAKEAWAY RECEIPT",
    );
    takeaway_identity(&mut p, order.takeaway_no);
    open_meta_block(&mut p);
    meta_timestamp(&mut p, &order.opened_at);
    meta_row(&mut p, "رقم الطلب", &order.id.to_string());
    if let Some(c) = customer {
        meta_row(&mut p, "العميل", &c.name);
        if let Some(phone) = &c.phone {
            meta_row(&mut p, "تليفون", phone);
        }
    }
    if let Some(plate) = car_plate {
        meta_row(&mut p, "رقم السيارة", plate);
    }
    // The car model belongs to the wash section, and the shared composer prints
    // it there for a hybrid document — so it is only stated in the identity
    // block when this order has no wash items of its own.
    let has_wash = order.lines.iter().any(|l| l.department == "WASH");
    if !has_wash {
        if let Some(model) = car_model {
            meta_row(&mut p, "نوع السيارة", model);
        }
    }
    close_meta_block(&mut p);
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
    invoice_header(
        &mut p,
        logo,
        "طلبات خارجية — ستيشن كافيه",
        "TAKEAWAY RECEIPT",
    );
    takeaway_identity(&mut p, inv.takeaway_no);
    open_meta_block(&mut p);
    meta_timestamp(&mut p, &inv.created_at);
    meta_row(&mut p, "رقم الفاتورة", &inv.invoice_no.to_string());
    // The shared department renderer places the car model beside the WASH
    // section for hybrid documents, so the identity block only states it when
    // this receipt has no wash items of its own — exactly as before, and never
    // printing the immutable snapshot twice.
    let model_without_wash = (!lines.iter().any(|l| l.department == "WASH"))
        .then(|| inv.car_model.as_deref())
        .flatten();
    party_identity(
        &mut p,
        inv.cashier_name.as_deref(),
        inv.customer_name.as_deref(),
        inv.customer_phone.as_deref(),
        inv.car_plate.as_deref(),
        model_without_wash,
    );
    close_meta_block(&mut p);
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
