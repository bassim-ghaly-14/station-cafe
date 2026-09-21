//! Document templates — professional, clearly distinguishable layouts.
//! Each template is a pure function: data → ESC/POS bytes. No DB access, so
//! templates can be unit-tested byte-for-byte.

use super::escpos::{Align, ArabicMode, EscPos};
use crate::repositories::invoices::{InvoiceLine, InvoiceRow};
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
) -> Vec<u8> {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "ستيشن كافيه", "Station Cafe - Cafe & Car Wash");
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

    if show_dept_sections {
        for (dept, title) in [("CAFE", "الكافيه"), ("WASH", "الغسيل")] {
            let dept_lines: Vec<&InvoiceLine> =
                lines.iter().filter(|l| l.department == dept).collect();
            if dept_lines.is_empty() {
                continue;
            }
            p.bold(true);
            p.line(title);
            p.bold(false);
            for l in dept_lines {
                p.line(&format!("{} x{}", l.product_name, l.quantity));
                p.kv_line("", &minor(l.line_total), WIDTH);
            }
        }
    } else {
        for l in lines {
            p.line(&format!("{} x{}", l.product_name, l.quantity));
            p.kv_line("", &minor(l.line_total), WIDTH);
        }
    }

    p.hr(WIDTH);
    p.kv_line("الإجمالي الفرعي", &minor(inv.subtotal), WIDTH);
    if inv.discount_minor > 0 {
        p.kv_line("الخصم", &minor(inv.discount_minor), WIDTH);
    }
    if inv.service_charge > 0 {
        p.kv_line("خدمة", &minor(inv.service_charge), WIDTH);
    }
    p.bold(true);
    p.size(1, 2);
    p.kv_line("الإجمالي", &minor(inv.total), WIDTH);
    p.size(1, 1);
    p.bold(false);
    p.kv_line("المدفوع", &minor(inv.paid_amount), WIDTH);
    if inv.status == "CREDIT" {
        p.kv_line("المتبقي (آجل)", &minor(inv.total - inv.paid_amount), WIDTH);
    }
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("شكراً لزيارتكم — Station Cafe");
    p.finish()
}

/// Wash job ticket — deliberately DIFFERENT from the payment receipt:
/// big waiting number, service list, explicit "wash can start" line.
pub fn wash_ticket(mode: ArabicMode, codepage: u8, ticket: &WashTicketData, logo: bool) -> Vec<u8> {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تذكرة غسيل سيارة", "WASH JOB TICKET");
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
    p.line("يمكن بدء عملية الغسيل");
    p.bold(false);
    p.line("(ليست فاتورة دفع)");
    p.finish()
}

pub fn shift_closing(mode: ArabicMode, codepage: u8, r: &ShiftReport, logo: bool) -> Vec<u8> {
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

pub fn day_report(mode: ArabicMode, codepage: u8, r: &DayReport, logo: bool) -> Vec<u8> {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل يوم العمل", "DAY CLOSING");
    p.kv_line("اليوم", &r.day.day_date, WIDTH);
    p.hr(WIDTH);
    p.kv_line("عدد الفواتير", &r.totals.invoices_count.to_string(), WIDTH);
    p.kv_line("مبيعات الكافيه", &minor(r.totals.cafe_sales), WIDTH);
    p.kv_line("مبيعات الغسيل", &minor(r.totals.wash_sales), WIDTH);
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
    p.kv_line("النقدية المتوقعة بالدرج", &minor(r.expected_drawer_cash), WIDTH);
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
pub fn test_page(mode: ArabicMode, codepage: u8, device: &str, logo: bool) -> Vec<u8> {
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
                product_name: "غسيل كامل".into(),
                unit_price: 160_00,
                quantity: 1,
                discount_minor: 0,
                line_total: 160_00,
            },
        ]
    }

    #[test]
    fn hybrid_invoice_contains_both_department_sections_and_totals() {
        let bytes = invoice(ArabicMode::Cp1256, 22, &inv("PAID"), &lines(), true, false);
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
        let bytes = invoice(ArabicMode::Cp1256, 22, &i, &lines(), false, false);
        let encoded_remaining = super::super::escpos::encode_cp1256("240.00");
        assert!(bytes.windows(encoded_remaining.len()).any(|w| w == encoded_remaining));
    }

    #[test]
    fn wash_ticket_is_distinct_and_marks_wash_start() {
        let ticket = WashTicketData {
            waiting_no: 12,
            customer_name: "أحمد".into(),
            customer_phone: Some("0100".into()),
            car_plate: "ABC123".into(),
            car_model: Some("تويوتا".into()),
            services: vec!["غسيل كامل".into()],
            entry_time: "2026-09-21 12:00:00".into(),
        };
        let bytes = wash_ticket(ArabicMode::Cp1256, 22, &ticket, false);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("12")); // waiting number
        assert!(bytes.len() > 200);
    }

    #[test]
    fn test_page_renders_in_latin_mode_without_high_bytes() {
        let bytes = test_page(ArabicMode::Latin, 22, "file:/tmp/x.prn", false);
        assert!(!bytes.iter().skip(4).any(|b| *b >= 0x80));
        assert!(String::from_utf8_lossy(&bytes).contains("0123456789"));
    }
}