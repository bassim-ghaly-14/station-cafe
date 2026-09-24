use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, minor, WIDTH};
use crate::services::reports::ShiftReport;

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
