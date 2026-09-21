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
    conn.execute(
        "INSERT INTO customers (name, phone, notes) VALUES (?1, ?2, ?3)",
        params![name, phone, notes],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update(conn: &Db, id: i64, name: &str, phone: Option<&str>, notes: Option<&str>) -> AppResult<()> {
    conn.execute(
        "UPDATE customers SET name = ?2, phone = ?3, notes = ?4, updated_at = datetime('now')
         WHERE id = ?1",
        params![id, name, phone, notes],
    )?;
    Ok(())
}

const CUST_COLS: &str = "id, name, phone, notes";

fn cust_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Customer> {
    Ok(Customer { id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, notes: r.get(3)? })
}

/// Search by name / phone / plate — one endpoint for the POS lookup box.
pub fn search(conn: &Db, q: &str) -> AppResult<Vec<CustomerWithCars>> {
    let like = format!("%{q}%");
    let mut stmt = conn.prepare(&format!(
        "SELECT {CUST_COLS} FROM customers
         WHERE name LIKE ?1 OR phone LIKE ?1
            OR id IN (SELECT customer_id FROM cars WHERE plate_no LIKE ?1)
         ORDER BY name LIMIT 30"
    ))?;
    let mut out = Vec::new();
    for c in stmt.query_map(params![like], cust_row)? {
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
    let mut stmt = conn.prepare(
        "SELECT c.id, c.customer_id, c.plate_no, c.car_model, c.notes,
                k.id, k.name, k.phone, k.notes
         FROM cars c JOIN customers k ON k.id = c.customer_id
         WHERE c.plate_no LIKE ?1 ORDER BY c.plate_no LIMIT 20",
    )?;
    let rows = stmt.query_map([format!("%{plate}%")], |r| {
        Ok((
            Car {
                id: r.get(0)?,
                customer_id: r.get(1)?,
                plate_no: r.get(2)?,
                car_model: r.get(3)?,
                notes: r.get(4)?,
            },
            Customer { id: r.get(5)?, name: r.get(6)?, phone: r.get(7)?, notes: r.get(8)? },
        ))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Exact plate lookup (used to attach a car to an order).
pub fn find_car(conn: &Db, plate_no: &str) -> AppResult<Option<Car>> {
    let mut stmt = conn.prepare(
        "SELECT id, customer_id, plate_no, car_model, notes FROM cars WHERE plate_no = ?1",
    )?;
    let mut rows = stmt.query([plate_no])?;
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

pub fn insert_car(
    conn: &Db,
    customer_id: i64,
    plate_no: &str,
    car_model: Option<&str>,
    notes: Option<&str>,
) -> AppResult<Option<i64>> {
    let n = conn.execute(
        "INSERT INTO cars (customer_id, plate_no, car_model, notes) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(plate_no) DO NOTHING",
        params![customer_id, plate_no, car_model, notes],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}