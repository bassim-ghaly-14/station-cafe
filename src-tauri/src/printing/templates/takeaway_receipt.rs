use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{footer, header, items_and_totals, WIDTH};
use crate::money::format_minor_for_print;
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
    p.kv_line("التاريخ", &order.opened_at, WIDTH);
    if let Some(c) = customer {
        p.kv_line("العميل", &c.name, WIDTH);
        if let Some(phone) = &c.phone {
            p.kv_line("تليفون", phone, WIDTH);
        }
    }
    if let Some(plate) = car_plate {
        p.kv_line("رقم السيارة", plate, WIDTH);
    }
    let hybrid = order.lines.iter().any(|l| l.department == "CAFE")
        && order.lines.iter().any(|l| l.department == "WASH");
    if !hybrid {
        if let Some(model) = car_model {
            p.kv_line("نوع السيارة", model, WIDTH);
        }
    }
    p.hr(WIDTH);
    let mut first_section = true;
    for (dept, title) in [("CAFE", "الكافيه"), ("WASH", "المغسلة")] {
        let dept_lines: Vec<_> = order
            .lines
            .iter()
            .filter(|l| !hybrid || l.department == dept)
            .collect();
        if hybrid && dept_lines.is_empty() {
            continue;
        }
        if hybrid {
            if !first_section {
                p.hr(WIDTH);
            }
            first_section = false;
            if dept == "WASH" {
                if let Some(model) = car_model {
                    p.kv_line("نوع السيارة", model, WIDTH);
                }
            }
            p.bold(true);
            p.line(title);
            p.bold(false);
        }
        for line in dept_lines {
            p.item(
                &line.product_name,
                &line.quantity.to_string(),
                &format_minor_for_print(line.unit_price),
                &format_minor_for_print(line.line_total),
            );
        }
    }
    p.hr(WIDTH);
    p.financial(
        "الإجمالي الفرعي",
        &format_minor_for_print(totals.subtotal),
        false,
    );
    if totals.discount_minor > 0 {
        p.financial(
            "الخصم",
            &format_minor_for_print(totals.discount_minor),
            false,
        );
    }
    if totals.service_charge_minor > 0 {
        p.financial(
            "خدمة",
            &format_minor_for_print(totals.service_charge_minor),
            false,
        );
    }
    p.bold(true);
    p.size(1, 2);
    p.financial("الإجمالي", &format_minor_for_print(totals.total), true);
    p.size(1, 1);
    p.bold(false);
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
    p.kv_line("التاريخ", &inv.created_at, WIDTH);
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
    let hybrid = lines.iter().any(|l| l.department == "CAFE")
        && lines.iter().any(|l| l.department == "WASH");
    items_and_totals(&mut p, inv, lines, hybrid);
    footer(p)
}
