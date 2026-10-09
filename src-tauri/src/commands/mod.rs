//! Tauri IPC commands exposed to the frontend.
//! Commands stay thin: session resolution → authorization → delegation.
//! Business logic belongs in services; SQL in repositories.

pub mod auth;
pub mod catalog;
pub mod common;
pub mod customers;
pub mod developer;
pub mod employees;
pub mod ops;
pub mod pos;
pub mod recipes;
pub mod sales;
pub mod shifts;
pub mod status;
