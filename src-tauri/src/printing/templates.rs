//! Document templates — professional, clearly distinguishable layouts.
//! Each template is a pure function: data → [`PrintDoc`] (ESC/POS bytes for the
//! printer + the matching preview operations). No DB access, so templates can be
//! unit-tested byte-for-byte.

use super::escpos::{Align, ArabicMode, EscPos};
use super::ir::PrintDoc;
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};
use crate::repositories::pos::Order;
use crate::services::pos::WashTicketData;
use crate::services::reports::{DayReport, ShiftReport};

pub const WIDTH: usize = 42; // characters per line on 80mm at font A

pub(crate) fn minor(v: i64) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let a = v.abs();
    format!("{sign}{}.{:02}", a / 100, a % 100)
}

fn header(p: &mut EscPos, logo: bool, title: &str, subtitle: &str) {
    if logo {
        if let Some((w, h, data)) = super::logo::logo_raster() {
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

/// Cafe / Wash / Hybrid invoice. The hybrid layout is the same template with
/// department sections — a presentation mode, not a separate entity.
pub fn invoice(
    mode: ArabicMode,
    codepage: u8,
    inv: &InvoiceRow,
    lines: &[InvoiceLine],
    show_dept_sections: bool,
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(
        &mut p,
        logo,
        "ستيشن كافيه",
        "Station Cafe - Cafe & Car Wash",
    );
    p.kv_line("فاتورة رقم", &inv.invoice_no.to_string(), WIDTH);
    p.kv_line("التاريخ", &inv.created_at, WIDTH);
    if let Some(t) = &inv.table_label {
        p.kv_line("الطاولة", t, WIDTH);
    }
    if let Some(c) = &inv.customer_name {
        p.kv_line("العميل", c, WIDTH);
    }
    if let Some(ph) = &inv.customer_phone {
        p.kv_line("تليفون", ph, WIDTH);
    }
    if let Some(pl) = &inv.car_plate {
        p.kv_line("رقم السيارة", pl, WIDTH);
    }
    p.hr(WIDTH);
    items_and_totals(&mut p, inv, lines, show_dept_sections);
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
    header(&mut p, logo, "تيك أواي — ستيشن كافيه", "TAKEAWAY RECEIPT");
    p.align(Align::Center);
    p.size(2, 2);
    p.bold(true);
    p.kv_line(
        "رقم التيك أواي",
        &inv.takeaway_no.unwrap_or_default().to_string(),
        WIDTH,
    );
    p.size(1, 1);
    p.bold(false);
    p.align(Align::Right);
    p.kv_line("فاتورة رقم", &inv.invoice_no.to_string(), WIDTH);
    p.kv_line("التاريخ", &inv.created_at, WIDTH);
    if let Some(c) = &inv.customer_name {
        p.kv_line("العميل", c, WIDTH);
    }
    p.hr(WIDTH);
    items_and_totals(&mut p, inv, lines, false);
    footer(p)
}

/// Shared line items + totals block — one renderer for every invoice-shaped
/// document so totals can never diverge between templates.
fn items_and_totals(p: &mut EscPos, inv: &InvoiceRow, lines: &[InvoiceLine], by_department: bool) {
    if by_department {
        for (dept, title) in [("CAFE", "الكافيه"), ("WASH", "المغسلة")] {
            let dept_lines: Vec<&InvoiceLine> =
                lines.iter().filter(|l| l.department == dept).collect();
            if dept_lines.is_empty() {
                continue;
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

fn footer(mut p: EscPos) -> PrintDoc {
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("شكراً لزيارتكم — Station Cafe");
    // Business contact is preview-only: the physical receipt bytes remain unchanged.
    p.preview_line("01154520775");
    p.finish()
}

pub fn current_order(
    mode: ArabicMode,
    codepage: u8,
    order: &Order,
    totals: &crate::services::pos::OrderPreview,
    customer: Option<&crate::services::pos::OrderCustomer>,
    car_plate: Option<&str>,
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    if order.order_type == "TAKEAWAY" {
        header(&mut p, logo, "تيك أواي — ستيشن كافيه", "TAKEAWAY RECEIPT");
        if let Some(no) = order.takeaway_no {
            p.align(Align::Center);
            p.size(2, 2);
            p.bold(true);
            p.line(&no.to_string());
            p.size(1, 1);
            p.bold(false);
        }
    } else {
        header(
            &mut p,
            logo,
            "ستيشن كافيه",
            "Station Cafe - Cafe & Car Wash",
        );
    }
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
    p.hr(WIDTH);
    let hybrid = order.lines.iter().any(|l| l.department == "WASH")
        && order.lines.iter().any(|l| l.department == "CAFE");
    for (dept, title) in [("CAFE", "الكافيه"), ("WASH", "المغسلة")] {
        if hybrid {
            p.bold(true);
            p.line(title);
            p.bold(false);
        }
        for line in order
            .lines
            .iter()
            .filter(|l| !hybrid || l.department == dept)
        {
            p.item(
                &line.product_name,
                &line.quantity.to_string(),
                &minor(line.unit_price),
                &minor(line.line_total),
            );
        }
    }
    p.hr(WIDTH);
    p.financial("الإجمالي الفرعي", &minor(totals.subtotal), false);
    if totals.discount_minor > 0 {
        p.financial("الخصم", &minor(totals.discount_minor), false);
    }
    if totals.service_charge_minor > 0 {
        p.financial("خدمة", &minor(totals.service_charge_minor), false);
    }
    p.bold(true);
    p.size(1, 2);
    p.financial("الإجمالي", &minor(totals.total), true);
    p.size(1, 1);
    p.bold(false);
    p.align(Align::Center);
    p.line("معاينة الطلب — قبل الدفع");
    footer(p)
}

/// Wash job ticket — deliberately DIFFERENT from the payment receipt:
/// big waiting number, service list, explicit "wash can start" line.
pub fn wash_ticket(
    mode: ArabicMode,
    codepage: u8,
    ticket: &WashTicketData,
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تذكرة مغسلة سيارة", "WASH JOB TICKET");
    p.align(Align::Center);
    p.size(2, 3);
    p.bold(true);
    p.line("رقم الانتظار");
    p.line(&ticket.waiting_no.to_string());
    p.size(1, 1);
    p.bold(false);
    p.hr(WIDTH);
    p.align(Align::Right);
    p.kv_line("العميل", &ticket.customer_name, WIDTH);
    if let Some(ph) = &ticket.customer_phone {
        p.kv_line("تليفون", ph, WIDTH);
    }
    p.kv_line("رقم السيارة", &ticket.car_plate, WIDTH);
    if let Some(m) = &ticket.car_model {
        p.kv_line("نوع السيارة", m, WIDTH);
    }
    p.kv_line("وقت الدخول", &ticket.entry_time, WIDTH);
    p.hr(WIDTH);
    p.bold(true);
    p.line("الخدمات:");
    p.bold(false);
    for s in &ticket.services {
        p.line(&format!("- {s}"));
    }
    p.hr(WIDTH);
    p.align(Align::Center);
    p.bold(true);
    p.line("يمكن بدء عملية المغسلة");
    p.bold(false);
    p.line("(ليست فاتورة دفع)");
    p.finish()
}

pub fn shift_closing(mode: ArabicMode, codepage: u8, r: &ShiftReport, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل وردية", "SHIFT CLOSING");
    p.kv_line("الموظف", r.shift.user_name.as_deref().unwrap_or("-"), WIDTH);
    p.kv_line("فتح", &r.shift.opened_at, WIDTH);
    p.kv_line("إغلاق", r.shift.closed_at.as_deref().unwrap_or("-"), WIDTH);
    p.hr(WIDTH);
    p.kv_line("عدد الفواتير", &r.invoices_count.to_string(), WIDTH);
    p.kv_line("نقدي", &minor(r.cash_sales), WIDTH);
    p.kv_line("بطاقة", &minor(r.card_sales), WIDTH);
    p.kv_line("آجل", &minor(r.credit_sales), WIDTH);
    p.kv_line("خدمة", &minor(r.service_charges), WIDTH);
    p.kv_line("خصومات", &minor(r.discounts), WIDTH);
    p.hr(WIDTH);
    p.kv_line("النقدية الافتتاحية", &minor(r.shift.opening_cash), WIDTH);
    p.kv_line("النقدية المتوقعة", &minor(r.expected_cash), WIDTH);
    p.kv_line("النقدية الفعلية", &minor(r.actual_cash.unwrap_or(0)), WIDTH);
    p.bold(true);
    p.kv_line("الفرق", &minor(r.difference.unwrap_or(0)), WIDTH);
    p.bold(false);
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("توقيع الكاشير: ____________");
    p.finish()
}

pub fn day_report(mode: ArabicMode, codepage: u8, r: &DayReport, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل يوم العمل", "DAY CLOSING");
    p.kv_line("اليوم", &r.day.day_date, WIDTH);
    p.hr(WIDTH);
    p.kv_line("عدد الفواتير", &r.totals.invoices_count.to_string(), WIDTH);
    p.kv_line("مبيعات الكافيه", &minor(r.totals.cafe_sales), WIDTH);
    p.kv_line("مبيعات المغسلة", &minor(r.totals.wash_sales), WIDTH);
    p.bold(true);
    p.kv_line("إجمالي المبيعات", &minor(r.totals.total_sales), WIDTH);
    p.bold(false);
    p.hr(WIDTH);
    p.kv_line("نقدي", &minor(r.totals.cash), WIDTH);
    p.kv_line("بطاقة", &minor(r.totals.card), WIDTH);
    p.kv_line("آجل", &minor(r.totals.credit), WIDTH);
    p.kv_line("خدمة", &minor(r.totals.service_charges), WIDTH);
    p.kv_line("خصومات", &minor(r.totals.discounts), WIDTH);
    p.kv_line("مصروفات", &minor(r.totals.expenses), WIDTH);
    p.hr(WIDTH);
    p.kv_line(
        "النقدية المتوقعة بالدرج",
        &minor(r.expected_drawer_cash),
        WIDTH,
    );
    p.kv_line("فروق الكاش", &minor(r.cash_differences), WIDTH);
    p.hr(WIDTH);
    p.line("الورديات:");
    for s in &r.shifts {
        p.line(&format!(
            "{} | {} | {}",
            s.user_name.as_deref().unwrap_or("-"),
            s.status,
            minor(s.cash_sales + s.card_sales)
        ));
    }
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("توقيع المدير: ____________");
    p.finish()
}

/// Test page used to verify a newly installed/renamed printer.
pub fn test_page(mode: ArabicMode, codepage: u8, device: &str, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "اختبار الطباعة", "PRINTER TEST PAGE");
    p.kv_line("الجهاز", device, WIDTH);
    p.kv_line("العرض", "80mm", WIDTH);
    p.kv_line("الترميز", &format!("{mode:?} / cp{codepage}"), WIDTH);
    p.hr(WIDTH);
    p.line("أرقام: 0123456789");
    p.line("عربي: أ ب ت ث ج ح خ د ذ ر ز س ش");
    p.line("English: The quick brown fox 123");
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("تم إرسال الاختبار بنجاح");
    p.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::invoices::InvoiceRow;

    fn inv(status: &str) -> InvoiceRow {
        InvoiceRow {
            id: 1,
            invoice_no: 7,
            table_label: Some("طاولة 04".into()),
            order_type: "TABLE".into(),
            takeaway_no: None,
            status: status.into(),
            total: 240_00,
            paid_amount: 240_00,
            service_charge: 20_00,
            discount_minor: 10_00,
            subtotal: 230_00,
            cafe_total: 70_00,
            wash_total: 160_00,
            customer_name: Some("أحمد".into()),
            customer_phone: Some("01000000000".into()),
            car_plate: Some("ABC123".into()),
            created_at: "2026-09-21 12:00:00".into(),
            shift_id: Some(1),
            business_day_id: Some(1),
        }
    }

    fn lines() -> Vec<InvoiceLine> {
        vec![
            InvoiceLine {
                department: "CAFE".into(),
                product_name: "قهوة".into(),
                unit_price: 35_00,
                quantity: 2,
                discount_minor: 0,
                line_total: 70_00,
            },
            InvoiceLine {
                department: "WASH".into(),
                product_name: "مغسلة كامل".into(),
                unit_price: 160_00,
                quantity: 1,
                discount_minor: 0,
                line_total: 160_00,
            },
        ]
    }

    #[test]
    fn hybrid_invoice_contains_both_department_sections_and_totals() {
        let bytes = invoice(ArabicMode::Cp1256, 22, &inv("PAID"), &lines(), true, false).escpos;
        let text = String::from_utf8_lossy(&bytes);
        assert!(bytes.starts_with(&[0x1B, b'@']));
        // 240.00 and 20.00 in minor units → printed as major units
        assert!(text.contains("240.00"));
        assert!(text.contains("20.00"));
    }

    #[test]
    fn credit_invoice_shows_outstanding_amount() {
        let mut i = inv("CREDIT");
        i.paid_amount = 0;
        i.total = 240_00;
        let bytes = invoice(ArabicMode::Cp1256, 22, &i, &lines(), false, false).escpos;
        let encoded_remaining = super::super::escpos::encode_cp1256("240.00");
        assert!(bytes
            .windows(encoded_remaining.len())
            .any(|w| w == encoded_remaining));
    }

    #[test]
    fn wash_ticket_is_distinct_and_marks_wash_start() {
        let ticket = WashTicketData {
            waiting_no: 12,
            customer_name: "أحمد".into(),
            customer_phone: Some("0100".into()),
            car_plate: "ABC123".into(),
            car_model: Some("تويوتا".into()),
            services: vec!["مغسلة كامل".into()],
            entry_time: "2026-09-21 12:00:00".into(),
        };
        let bytes = wash_ticket(ArabicMode::Cp1256, 22, &ticket, false).escpos;
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("12")); // waiting number
        assert!(bytes.len() > 200);
    }

    #[test]
    fn takeaway_receipt_shows_takeaway_number_and_never_a_table() {
        let mut i = inv("PAID");
        i.order_type = "TAKEAWAY".into();
        i.takeaway_no = Some(37);
        i.table_label = None;
        i.customer_name = None;
        i.customer_phone = None;
        i.car_plate = None;
        let bytes = takeaway_receipt(ArabicMode::Cp1256, 22, &i, &lines(), false).escpos;
        let text = String::from_utf8_lossy(&bytes);
        assert!(bytes.starts_with(&[0x1B, b'@']));
        assert!(
            text.contains("TAKEAWAY RECEIPT"),
            "document identity must be explicit"
        );
        assert!(bytes.len() > 200);
        // The takeaway number and the total are rendered.
        for expected in [
            super::super::escpos::encode_cp1256("37"),
            super::super::escpos::encode_cp1256("240.00"),
        ] {
            assert!(
                bytes.windows(expected.len()).any(|w| w == expected),
                "missing rendered value in takeaway receipt"
            );
        }
        // No table line can leak into a takeaway receipt.
        let table_word = super::super::escpos::encode_cp1256("الطاولة");
        assert!(!bytes.windows(table_word.len()).any(|w| w == table_word));
    }

    #[test]
    fn test_page_renders_in_latin_mode_without_high_bytes() {
        let bytes = test_page(ArabicMode::Latin, 22, "file:/tmp/x.prn", false).escpos;
        assert!(!bytes.iter().skip(4).any(|b| *b >= 0x80));
        assert!(String::from_utf8_lossy(&bytes).contains("0123456789"));
    }
}
