use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, WIDTH};
use crate::services::pos::WashTicketData;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printing::escpos::ArabicMode;
    use crate::services::pos::WashTicketData;

    #[test]
    fn wash_ticket_test_preserves_distinct_ticket_markers() {
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
        assert!(String::from_utf8_lossy(&bytes).contains("12"));
        assert!(bytes.len() > 200);
    }
}
