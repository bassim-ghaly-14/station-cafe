use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{footer, header, WIDTH};
use crate::money::format_minor_for_print;
use crate::repositories::pos::Order;

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
    header(
        &mut p,
        logo,
        "ستيشن كافيه",
        "Station Cafe - Cafe & Car Wash",
    );
    p.align(Align::Right);
    p.kv_line("الطلب", &order.id.to_string(), WIDTH);
    p.kv_line("التاريخ", &order.opened_at, WIDTH);
    if let Some(label) = &order.table_label {
        p.kv_line("الطاولة", label, WIDTH);
    }
    if let Some(c) = customer {
        p.kv_line("العميل", &c.name, WIDTH);
        if let Some(phone) = &c.phone {
            p.kv_line("تليفون", phone, WIDTH);
        }
    }
    if let Some(plate) = car_plate {
        p.kv_line("رقم السيارة", plate, WIDTH);
    }
    if let Some(model) = car_model {
        p.kv_line("نوع السيارة", model, WIDTH);
    }
    p.hr(WIDTH);
    let cafe_lines: Vec<_> = order
        .lines
        .iter()
        .filter(|l| l.department == "CAFE")
        .collect();
    let wash_lines: Vec<_> = order
        .lines
        .iter()
        .filter(|l| l.department == "WASH")
        .collect();
    let hybrid = !cafe_lines.is_empty() && !wash_lines.is_empty();
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
        if hybrid {
            let dept_subtotal: i64 = order
                .lines
                .iter()
                .filter(|l| l.department == dept)
                .map(|l| l.line_total)
                .sum();
            p.financial(
                &format!("{title} الفرعي"),
                &format_minor_for_print(dept_subtotal),
                false,
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
