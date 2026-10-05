//! Customers & cars repository.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Car {
    pub id: i64,
    pub customer_id: i64,
    pub plate_no: String,
    pub car_model: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerWithCars {
    #[serde(flatten)]
    pub customer: Customer,
    pub cars: Vec<Car>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerPhoneEntry {
    pub id: i64,
    pub name: String,
    pub phone: String,
    /// Normalized identity used for dedupe; never exported itself.
    #[serde(skip_serializing, skip_deserializing, default)]
    pub phone_key: String,
}

/// Phone export rows for customer communication workflows.
///
/// Identity columns only — no financial figures, no notes, no internal ids
/// beyond the row id used for deterministic ordering. `customer_ids` selects
/// an explicit subset (the UI's checked rows); `None` means every eligible
/// customer. Rows are ordered by `name, id` so the export is deterministic
/// and reuses the page's own ordering. Deduplication by normalized
/// `phone_key` happens in the service so SQL stays a plain read.
pub fn export_phones(conn: &Db, customer_ids: Option<&[i64]>) -> AppResult<Vec<CustomerPhoneEntry>> {
    let mut sql = String::from(
        "SELECT id, name, phone, phone_key FROM customers
         WHERE phone IS NOT NULL AND TRIM(phone) <> ''",
    );
    let mut args: Vec<i64> = Vec::new();
    if let Some(ids) = customer_ids {
        // An explicit empty selection exports nothing — it must never fall
        // through to "every customer".
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        sql.push_str(&format!(" AND id IN ({placeholders})"));
        args.extend(ids.iter().copied());
    }
    sql.push_str(" ORDER BY name COLLATE NOCASE, id");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, phone, phone_key) = row?;
        // Skip rows whose raw phone normalizes to nothing (whitespace-only,
        // separators-only): they would otherwise produce empty export entries.
        // Fall back to the trimmed raw value when the stored key predates the
        // normalization backfill, so legacy rows are still exported.
        let key = phone_key
            .filter(|k| !k.trim().is_empty())
            .or_else(|| crate::normalize::normalize_phone(&phone))
            .unwrap_or_else(|| phone.trim().to_string());
        if key.trim().is_empty() {
            continue;
        }
        out.push(CustomerPhoneEntry {
            id,
            name,
            phone,
            phone_key: key,
        });
    }
    Ok(out)
}

pub fn insert(conn: &Db, name: &str, phone: Option<&str>, notes: Option<&str>) -> AppResult<i64> {
    let phone_key = crate::normalize::normalize_phone(phone.unwrap_or(""));
    if let Some(key) = &phone_key {
        if find_by_phone_key(conn, key)?.is_some() {
            return Err(crate::error::AppError::conflict("customers.phone_taken"));
        }
    }
    conn.execute(
        "INSERT INTO customers (name, phone, notes, phone_key) VALUES (?1, ?2, ?3, ?4)",
        params![name, phone, notes, phone_key],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update(
    conn: &Db,
    id: i64,
    name: &str,
    phone: Option<&str>,
    notes: Option<&str>,
) -> AppResult<()> {
    let phone_key = crate::normalize::normalize_phone(phone.unwrap_or(""));
    if let Some(key) = &phone_key {
        if let Some(owner) = find_by_phone_key(conn, key)? {
            if owner != id {
                return Err(crate::error::AppError::conflict("customers.phone_taken"));
            }
        }
    }
    conn.execute(
        "UPDATE customers SET name = ?2, phone = ?3, notes = ?4, phone_key = ?5, updated_at = station_now()
         WHERE id = ?1",
        params![id, name, phone, notes, phone_key],
    )?;
    Ok(())
}

/// Identity lookup used for duplicate prevention. `None` means the phone
/// number is not registered to any customer yet.
pub fn find_by_phone_key(conn: &Db, key: &str) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM customers WHERE phone_key = ?1",
            [key],
            |r| r.get(0),
        )
        .ok())
}

const CUST_COLS: &str = "id, name, phone, notes";

fn cust_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Customer> {
    Ok(Customer {
        id: r.get(0)?,
        name: r.get(1)?,
        phone: r.get(2)?,
        notes: r.get(3)?,
    })
}

/// One endpoint for the POS customer picker: an empty query lists the
/// registered customers (no search required to browse), otherwise it matches by
/// name / phone / plate. Comparison always runs against the normalized
/// identity keys, so "أ ب ج ١٢٣٤" and "أبج 1234" find the same vehicle.
pub fn search(conn: &Db, q: &str) -> AppResult<Vec<CustomerWithCars>> {
    let trimmed = q.trim();
    let mut stmt = if trimmed.is_empty() {
        conn.prepare(&format!(
            "SELECT {CUST_COLS} FROM customers ORDER BY name LIMIT 60"
        ))?
    } else {
        conn.prepare(&format!(
            "SELECT {CUST_COLS} FROM customers
             WHERE name LIKE ?1
                OR phone_key LIKE ?1
                OR id IN (SELECT customer_id FROM cars WHERE plate_key LIKE ?1)
             ORDER BY name LIMIT 30"
        ))?
    };
    let mut out = Vec::new();
    let rows = if trimmed.is_empty() {
        stmt.query_map([], cust_row)?
    } else {
        stmt.query_map(params![format!("%{}%", trimmed)], cust_row)?
    };
    for c in rows {
        let c = c?;
        let cars = cars_of(conn, c.id)?;
        out.push(CustomerWithCars { customer: c, cars });
    }
    Ok(out)
}

pub fn cars_of(conn: &Db, customer_id: i64) -> AppResult<Vec<Car>> {
    let mut stmt = conn.prepare(
        "SELECT id, customer_id, plate_no, car_model, notes FROM cars WHERE customer_id = ?1",
    )?;
    let rows = stmt.query_map([customer_id], |r| {
        Ok(Car {
            id: r.get(0)?,
            customer_id: r.get(1)?,
            plate_no: r.get(2)?,
            car_model: r.get(3)?,
            notes: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Find cars by (partial) plate with owner info — wash workflow lookup.
pub fn find_cars_by_plate(conn: &Db, plate: &str) -> AppResult<Vec<(Car, Customer)>> {
    let key = crate::normalize::normalize_plate(plate).unwrap_or_default();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.customer_id, c.plate_no, c.car_model, c.notes,
                k.id, k.name, k.phone, k.notes
         FROM cars c JOIN customers k ON k.id = c.customer_id
         WHERE c.plate_key LIKE ?1 ORDER BY c.plate_no LIMIT 20",
    )?;
    let rows = stmt.query_map([format!("%{key}%")], |r| {
        Ok((
            Car {
                id: r.get(0)?,
                customer_id: r.get(1)?,
                plate_no: r.get(2)?,
                car_model: r.get(3)?,
                notes: r.get(4)?,
            },
            Customer {
                id: r.get(5)?,
                name: r.get(6)?,
                phone: r.get(7)?,
                notes: r.get(8)?,
            },
        ))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Exact plate lookup (used to attach a car to an order). Matching runs on
/// the normalized plate so a formatting difference never detaches a vehicle.
pub fn find_car(conn: &Db, plate_no: &str) -> AppResult<Option<Car>> {
    let key = crate::normalize::normalize_plate(plate_no).unwrap_or_default();
    let mut stmt = conn.prepare(
        "SELECT id, customer_id, plate_no, car_model, notes FROM cars WHERE plate_key = ?1",
    )?;
    let mut rows = stmt.query([key])?;
    match rows.next()? {
        Some(r) => Ok(Some(Car {
            id: r.get(0)?,
            customer_id: r.get(1)?,
            plate_no: r.get(2)?,
            car_model: r.get(3)?,
            notes: r.get(4)?,
        })),
        None => Ok(None),
    }
}

pub fn find_by_id(conn: &Db, id: i64) -> AppResult<Option<Customer>> {
    let mut stmt = conn.prepare(&format!("SELECT {CUST_COLS} FROM customers WHERE id = ?1"))?;
    let mut rows = stmt.query([id])?;
    match rows.next()? {
        Some(r) => Ok(Some(cust_row(r)?)),
        None => Ok(None),
    }
}

/// Insert a vehicle. Returns `None` when the plate is already registered —
/// the caller turns that into the Arabic "plate already taken" conflict, so a
/// duplicate can never be created by racing two requests either (the unique
/// index on `plate_key` is the final authority).
pub fn insert_car(
    conn: &Db,
    customer_id: i64,
    plate_no: &str,
    car_model: Option<&str>,
    notes: Option<&str>,
) -> AppResult<Option<i64>> {
    let key = crate::normalize::normalize_plate(plate_no).unwrap_or_default();
    let n = conn.execute(
        "INSERT INTO cars (customer_id, plate_no, car_model, notes, plate_key)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(plate_key) DO NOTHING",
        params![customer_id, plate_no, car_model, notes, key],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

/// The references that make a customer undeletable.
///
/// `cars` is deliberately ABSENT: a vehicle is an owned registration with no
/// history of its own — an invoice never reads a car's row, it snapshots the
/// plate into `invoice_customers` — so cars are deleted with their owner.
///
/// Everything listed here is a live `REFERENCES customers(id)` foreign key
/// holding real business history, and none of it may be cascaded.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DeleteBlockers {
    /// Open or settled POS orders.
    pub orders: i64,
    /// Invoices of any status, because an invoice is a numbered document in the
    /// sequence the moment it is raised.
    pub invoices: i64,
    /// The credit account row. Its payments are a money history in their own
    /// right, so an account with ANY history blocks deletion even when the
    /// balance is fully settled.
    pub credit_accounts: i64,
}

impl DeleteBlockers {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

pub fn delete_blockers(conn: &Db, id: i64) -> AppResult<DeleteBlockers> {
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM orders          WHERE customer_id = ?1),
            (SELECT COUNT(*) FROM invoices        WHERE customer_id = ?1),
            (SELECT COUNT(*) FROM credit_accounts WHERE customer_id = ?1)",
        params![id],
        |r| {
            Ok(DeleteBlockers {
                orders: r.get(0)?,
                invoices: r.get(1)?,
                credit_accounts: r.get(2)?,
            })
        },
    )
    .map_err(Into::into)
}

/// Remove the customer's vehicles. An owned registration, not history, so it
/// goes with the owner rather than orphaning a plate nothing can reach.
pub fn delete_cars_of(conn: &Db, customer_id: i64) -> AppResult<usize> {
    conn.execute(
        "DELETE FROM cars WHERE customer_id = ?1",
        params![customer_id],
    )
    .map_err(Into::into)
}

/// Physically remove the customer row. Reached only after [`delete_blockers`]
/// proved there is no history. The caller owns the transaction.
pub fn delete(conn: &Db, id: i64) -> AppResult<usize> {
    conn.execute("DELETE FROM customers WHERE id = ?1", params![id])
        .map_err(Into::into)
}
