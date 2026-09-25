//! Repository layer — ALL SQL lives here (never in services, never in UI).
pub mod analytics;
pub mod catalog;
pub mod customers;
pub mod developer;
pub mod invoices;
pub mod ops;
pub mod pos;
pub mod shifts;
pub mod users;

pub use crate::db::Db;
