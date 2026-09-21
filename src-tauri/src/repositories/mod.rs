//! Repository layer — ALL SQL lives here (never in services, never in UI).
pub mod users;

pub use crate::db::Db;