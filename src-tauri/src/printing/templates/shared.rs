use super::super::escpos::{Align, EscPos};
use super::super::ir::PrintDoc;
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};

pub const WIDTH: usize = 42; // characters per line on 80mm at font A

pub(crate) fn minor(v: i64) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let a = v.abs();
    format!("{sign}{}.{:02}", a / 100, a % 100)
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
                    &minor(l.unit_price),
                    &minor(l.line_total),
                );
            }
            let dept_subtotal: i64 = if dept == "CAFE" {
                inv.cafe_total
            } else {
                inv.wash_total
            };
            p.financial(&format!("{title} الفرعي"), &minor(dept_subtotal), false);
        }
    } else {
        for l in lines {
            p.item(
                &l.product_name,
                &l.quantity.to_string(),
                &minor(l.unit_price),
                &minor(l.line_total),
            );
        }
    }
    p.hr(WIDTH);
    p.financial("الإجمالي الفرعي", &minor(inv.subtotal), false);
    if inv.discount_minor > 0 {
        p.financial("الخصم", &minor(inv.discount_minor), false);
    }
    if inv.service_charge > 0 {
        p.financial("خدمة", &minor(inv.service_charge), false);
    }
    p.bold(true);
    p.size(1, 2);
    p.financial("الإجمالي", &minor(inv.total), true);
    p.size(1, 1);
    p.bold(false);
    p.financial("المدفوع", &minor(inv.paid_amount), false);
    if inv.status == "CREDIT" {
        p.financial("المتبقي (آجل)", &minor(inv.total - inv.paid_amount), false);
    }
}
