//! Repository layer — ALL SQL lives here (never in services, never in UI).
pub mod analytics;
pub mod catalog;
pub mod customer_analytics;
pub mod customers;
pub mod developer;
pub mod employee_analytics;
pub mod employees;
pub mod expenses;
pub mod invoices;
pub mod ops;
pub mod pos;
pub mod sales_analytics;
pub mod shifts;
pub mod users;

pub use crate::db::Db;
