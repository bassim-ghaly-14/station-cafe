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
