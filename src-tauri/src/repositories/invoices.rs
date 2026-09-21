//! Invoices, payments & credit repository. Invoice rows are full snapshots.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceLine {
    pub department: String,
    pub product_name: String,
    pub unit_price: i64,
    pub quantity: i64,
    pub discount_minor: i64,
    pub line_total: i64,
}

/// Insert a full invoice + lines inside the caller's transaction.
#[allow(clippy::too_many_arguments)]
pub fn insert_invoice(
    conn: &Db,
    invoice_no: i64,
    order_id: i64,
    table_label: &str,
    business_day_id: i64,
    shift_id: Option<i64>,
    user_id: i64,
    customer_id: Option<i64>,
    subtotal: i64,
    discount_minor: i64,
    discount_mode: Option<&str>,
    discount_value: Option<i64>,
    service_charge: i64,
    total: i64,
    cafe_total: i64,
    wash_total: i64,
    lines: &[InvoiceLine],
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO invoices (invoice_no, order_id, table_label, business_day_id, shift_id,
            user_id, customer_id, subtotal, discount_minor, discount_mode, discount_value,
            service_charge, total, cafe_total, wash_total)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            invoice_no, order_id, table_label, business_day_id, shift_id, user_id, customer_id,
            subtotal, discount_minor, discount_mode, discount_value, service_charge, total,
            cafe_total, wash_total
        ],
    )?;
    let inv = conn.last_insert_rowid();
    let mut stmt = conn.prepare(
        "INSERT INTO invoice_lines (invoice_id, department, product_name, unit_price, quantity,
            discount_minor, line_total) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    )?;
    for l in lines {
        stmt.execute(params![
            inv, l.department, l.product_name, l.unit_price, l.quantity, l.discount_minor, l.line_total
        ])?;
    }
    Ok(inv)
}

/// Snapshot customer/car data at transaction time.
pub fn insert_invoice_customer(
    conn: &Db,
    invoice_id: i64,
    name: &str,
    phone: Option<&str>,
    plate: Option<&str>,
    model: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO invoice_customers (invoice_id, customer_name, customer_phone, car_plate, car_model)
         VALUES (?1,?2,?3,?4,?5)",
        params![invoice_id, name, phone, plate, model],
    )?;
    Ok(())
}

/// Atomically take the next sequential invoice number.
pub fn next_invoice_no(conn: &Db) -> AppResult<i64> {
    // Stored as TEXT in app_settings; parse defensively.
    let raw: String = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'invoice.next_number'",
        [],
        |r| r.get(0),
    )?;
    let n: i64 = raw
        .trim()
        .parse()
        .map_err(|_| crate::error::AppError::internal("invoice.next_number corrupt"))?;
    conn.execute(
        "UPDATE app_settings SET value = ?1, updated_at = datetime('now')
         WHERE key = 'invoice.next_number'",
        [(n + 1).to_string()],
    )?;
    Ok(n)
}

pub fn insert_payment(
    conn: &Db,
    invoice_id: i64,
    method: &str,
    amount: i64,
    received: Option<i64>,
    change_given: Option<i64>,
    user_id: i64,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO payments (invoice_id, method, amount, received, change_given, user_id)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![invoice_id, method, amount, received, change_given, user_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Update invoice paid amount + status after a payment; returns new status.
pub fn apply_payment_to_invoice(conn: &Db, invoice_id: i64, amount: i64) -> AppResult<String> {
    let (total, paid): (i64, i64) = conn.query_row(
        "SELECT total, paid_amount FROM invoices WHERE id = ?1",
        [invoice_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let new_paid = paid + amount;
    let status = if new_paid >= total { "PAID" } else { "PARTIALLY_PAID" };
    conn.execute(
        "UPDATE invoices SET paid_amount = ?2, status = ?3,
            paid_at = COALESCE(paid_at, CASE WHEN ?3 = 'PAID' THEN datetime('now') END)
         WHERE id = ?1",
        params![invoice_id, new_paid, status],
    )?;
    Ok(status.to_string())
}

pub fn mark_invoice_credit(conn: &Db, invoice_id: i64) -> AppResult<()> {
    conn.execute("UPDATE invoices SET status = 'CREDIT' WHERE id = ?1", [invoice_id])?;
    Ok(())
}

pub fn cancel_invoice(conn: &Db, invoice_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE invoices SET status = 'CANCELLED', cancelled_at = datetime('now') WHERE id = ?1",
        [invoice_id],
    )?;
    Ok(())
}

// ---- SEARCH ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceRow {
    pub id: i64,
    pub invoice_no: i64,
    pub table_label: Option<String>,
    pub status: String,
    pub total: i64,
    pub paid_amount: i64,
    pub service_charge: i64,
    pub discount_minor: i64,
    pub subtotal: i64,
    pub cafe_total: i64,
    pub wash_total: i64,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub car_plate: Option<String>,
    pub created_at: String,
    pub shift_id: Option<i64>,
    pub business_day_id: Option<i64>,
}

const INV_COLS: &str = "i.id, i.invoice_no, i.table_label, i.status, i.total, i.paid_amount,
    i.service_charge, i.discount_minor, i.subtotal, i.cafe_total, i.wash_total,
    k.name, k.phone, ic.car_plate, i.created_at, i.shift_id, i.business_day_id";

fn inv_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<InvoiceRow> {
    Ok(InvoiceRow {
        id: r.get(0)?,
        invoice_no: r.get(1)?,
        table_label: r.get(2)?,
        status: r.get(3)?,
        total: r.get(4)?,
        paid_amount: r.get(5)?,
        service_charge: r.get(6)?,
        discount_minor: r.get(7)?,
        subtotal: r.get(8)?,
        cafe_total: r.get(9)?,
        wash_total: r.get(10)?,
        customer_name: r.get(11)?,
        customer_phone: r.get(12)?,
        car_plate: r.get(13)?,
        created_at: r.get(14)?,
        shift_id: r.get(15)?,
        business_day_id: r.get(16)?,
    })
}

/// Today's-invoice search: number / table / customer / phone / plate / status / method.
pub fn search_invoices(
    conn: &Db,
    business_day_id: Option<i64>,
    q: Option<&str>,
    status: Option<&str>,
    method: Option<&str>,
) -> AppResult<Vec<InvoiceRow>> {
    let mut sql = format!(
        "SELECT {INV_COLS} FROM invoices i
         LEFT JOIN customers k ON k.id = i.customer_id
         LEFT JOIN invoice_customers ic ON ic.invoice_id = i.id
         WHERE i.status != 'CANCELLED'"
    );
    let mut args: Vec<String> = Vec::new();
    if let Some(d) = business_day_id {
        args.push(d.to_string());
        sql.push_str(&format!(" AND i.business_day_id = ?{}", args.len()));
    }
    if let Some(qq) = q {
        args.push(format!("%{qq}%"));
        sql.push_str(&format!(
            " AND (CAST(i.invoice_no AS TEXT) LIKE ?{n} OR k.name LIKE ?{n} OR k.phone LIKE ?{n}
              OR ic.car_plate LIKE ?{n} OR i.table_label LIKE ?{n})",
            n = args.len()
        ));
    }
    if let Some(s) = status {
        args.push(s.to_string());
        sql.push_str(&format!(" AND i.status = ?{}", args.len()));
    }
    if let Some(m) = method {
        args.push(m.to_string());
        sql.push_str(&format!(
            " AND i.id IN (SELECT invoice_id FROM payments WHERE method = ?{})",
            args.len()
        ));
    }
    sql.push_str(" ORDER BY i.id DESC LIMIT 200");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> =
        args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), inv_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Full invoice with its snapshot lines (used by printing + UI detail).
pub fn get_invoice_full(
    conn: &Db,
    invoice_id: i64,
) -> AppResult<Option<(InvoiceRow, Vec<InvoiceLine>)>> {
    let row = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {INV_COLS} FROM invoices i
             LEFT JOIN customers k ON k.id = i.customer_id
             LEFT JOIN invoice_customers ic ON ic.invoice_id = i.id
             WHERE i.id = ?1"
        ))?;
        let mut rows = stmt.query([invoice_id])?;
        match rows.next()? {
            Some(r) => inv_row(r)?,
            None => return Ok(None),
        }
    };
    let mut stmt = conn.prepare(
        "SELECT department, product_name, unit_price, quantity, discount_minor, line_total
         FROM invoice_lines WHERE invoice_id = ?1 ORDER BY id",
    )?;
    let lines = stmt
        .query_map([invoice_id], |r| {
            Ok(InvoiceLine {
                department: r.get(0)?,
                product_name: r.get(1)?,
                unit_price: r.get(2)?,
                quantity: r.get(3)?,
                discount_minor: r.get(4)?,
                line_total: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some((row, lines)))
}

// ---- CREDIT ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditAccount {
    pub id: i64,
    pub customer_id: i64,
    pub original_total: i64,
    pub paid_total: i64,
    pub status: String,
    pub created_at: String,
    pub customer_name: Option<String>,
}

/// (id, original_total, paid_total) of the open credit account, if any.
pub fn credit_account_for(conn: &Db, customer_id: i64) -> AppResult<Option<(i64, i64, i64)>> {
    Ok(conn
        .query_row(
            "SELECT id, original_total, paid_total FROM credit_accounts
             WHERE customer_id = ?1 AND status != 'PAID'",
            [customer_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok())
}

/// Add to the customer's outstanding credit (one open account per customer).
pub fn open_or_extend_credit(conn: &Db, customer_id: i64, amount: i64) -> AppResult<i64> {
    match credit_account_for(conn, customer_id)? {
        Some((id, _, _)) => {
            conn.execute(
                "UPDATE credit_accounts SET original_total = original_total + ?2,
                    status = CASE WHEN paid_total = 0 THEN 'UNPAID' ELSE 'PARTIALLY_PAID' END,
                    updated_at = datetime('now') WHERE id = ?1",
                params![id, amount],
            )?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO credit_accounts (customer_id, original_total) VALUES (?1, ?2)",
                params![customer_id, amount],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

/// Add a settlement payment; returns the account's new status.
pub fn pay_credit(conn: &Db, account_id: i64, amount: i64, user_id: i64) -> AppResult<String> {
    let (orig, paid): (i64, i64) = conn.query_row(
        "SELECT original_total, paid_total FROM credit_accounts WHERE id = ?1",
        [account_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if paid + amount > orig {
        return Err(crate::error::AppError::business("credit.overpay"));
    }
    conn.execute(
        "INSERT INTO credit_payments (credit_account_id, amount, user_id) VALUES (?1,?2,?3)",
        params![account_id, amount, user_id],
    )?;
    let new_paid = paid + amount;
    let status = if new_paid == orig { "PAID" } else { "PARTIALLY_PAID" };
    conn.execute(
        "UPDATE credit_accounts SET paid_total = ?2, status = ?3, updated_at = datetime('now')
         WHERE id = ?1",
        params![account_id, new_paid, status],
    )?;
    Ok(status.to_string())
}

pub fn list_credit_accounts(conn: &Db) -> AppResult<Vec<CreditAccount>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.customer_id, c.original_total, c.paid_total, c.status, c.created_at, k.name
         FROM credit_accounts c JOIN customers k ON k.id = c.customer_id
         ORDER BY c.status, k.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CreditAccount {
            id: r.get(0)?,
            customer_id: r.get(1)?,
            original_total: r.get(2)?,
            paid_total: r.get(3)?,
            status: r.get(4)?,
            created_at: r.get(5)?,
            customer_name: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn invoice_by_order(conn: &Db, order_id: i64) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row("SELECT id FROM invoices WHERE order_id = ?1", [order_id], |r| r.get(0))
        .ok())
}