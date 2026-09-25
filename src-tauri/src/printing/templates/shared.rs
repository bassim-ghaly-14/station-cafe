use super::super::escpos::{Align, EscPos};
use super::super::ir::PrintDoc;
use crate::money::format_minor_for_print;
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};

pub const WIDTH: usize = 42; // characters per line on 80mm at font A

/// Format a stored instant for paper, in Station business time.
///
/// A receipt must never disagree with the screen: both go through the same
/// canonical business-time conversion, so a sale at 17:30 prints 17:30 rather
/// than the raw UTC digits. An unparseable value is passed through unchanged
/// so a document is never left blank.
pub(super) fn stamp(value: &str) -> String {
    crate::time::to_business_datetime(value)
}

pub(super) fn header(p: &mut EscPos, logo: bool, title: &str, subtitle: &str) {
    if logo {
        if let Some((w, h, data)) = super::super::logo::logo_raster() {
            p.align(Align::Center);
            p.raster(*w, *h, data);
        }
    }
    p.align(Align::Center);
    p.bold(true);
    p.line(title);
    p.bold(false);
    p.line(subtitle);
    p.line("المبالغ بالج.م");
    p.hr(WIDTH);
    p.align(Align::Right);
}

pub(super) fn footer(mut p: EscPos) -> PrintDoc {
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("شكراً لزيارتكم — Station Cafe");
    p.preview_line("01154520775");
    p.finish()
}

pub(super) fn items_and_totals(
    p: &mut EscPos,
    inv: &InvoiceRow,
    lines: &[InvoiceLine],
    by_department: bool,
) {
    if by_department {
        let mut first_section = true;
        for (dept, title) in [("CAFE", "الكافيه"), ("WASH", "المغسلة")] {
            let dept_lines: Vec<&InvoiceLine> =
                lines.iter().filter(|l| l.department == dept).collect();
            if dept_lines.is_empty() {
                continue;
            }
            if !first_section {
                p.hr(WIDTH);
            }
            first_section = false;
            if let Some(model) = inv.car_model.as_deref().filter(|_| dept == "WASH") {
                p.kv_line("نوع السيارة", model, WIDTH);
            }
            p.bold(true);
            p.line(title);
            p.bold(false);
            for l in dept_lines {
                p.item(
                    &l.product_name,
                    &l.quantity.to_string(),
                    &format_minor_for_print(l.unit_price),
                    &format_minor_for_print(l.line_total),
                );
            }
            let dept_subtotal: i64 = if dept == "CAFE" {
                inv.cafe_total
            } else {
                inv.wash_total
            };
            p.financial(
                &format!("{title} الفرعي"),
                &format_minor_for_print(dept_subtotal),
                false,
            );
        }
    } else {
        for l in lines {
            p.item(
                &l.product_name,
                &l.quantity.to_string(),
                &format_minor_for_print(l.unit_price),
                &format_minor_for_print(l.line_total),
            );
        }
    }
    p.hr(WIDTH);
    p.financial(
        "الإجمالي الفرعي",
        &format_minor_for_print(inv.subtotal),
        false,
    );
    if inv.discount_minor > 0 {
        p.financial("الخصم", &format_minor_for_print(inv.discount_minor), false);
    }
    if inv.service_charge > 0 {
        p.financial("خدمة", &format_minor_for_print(inv.service_charge), false);
    }
    p.bold(true);
    p.size(1, 2);
    p.financial("الإجمالي", &format_minor_for_print(inv.total), true);
    p.size(1, 1);
    p.bold(false);
    p.financial("المدفوع", &format_minor_for_print(inv.paid_amount), false);
    if inv.status == "CREDIT" {
        p.financial(
            "المتبقي (آجل)",
            &format_minor_for_print(inv.total - inv.paid_amount),
            false,
        );
    }
}
