//! Thin error type shared across backend modules.
//! Full error taxonomy (validation / business-rule / db / printer / auth)
//! is defined in Phase 1; this keeps the foundation compiling cleanly.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("business rule violation: {0}")]
    BusinessRule(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("printer error: {0}")]
    Printer(String),
}

impl AppError {
    /// Machine-readable kind used by the frontend to pick an Arabic message.
    pub fn kind(&self) -> ErrorKind {
        match self {
            AppError::Db(_) => ErrorKind::Db,
            AppError::Io(_) => ErrorKind::Internal,
            AppError::Internal(_) => ErrorKind::Internal,
            AppError::Validation(_) => ErrorKind::Validation,
            AppError::BusinessRule(_) => ErrorKind::BusinessRule,
            AppError::Unauthorized(_) => ErrorKind::Unauthorized,
            AppError::Conflict(_) => ErrorKind::Conflict,
            AppError::NotFound(_) => ErrorKind::NotFound,
            AppError::Printer(_) => ErrorKind::Printer,
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }
    pub fn business(msg: impl Into<String>) -> Self {
        AppError::BusinessRule(msg.into())
    }
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        AppError::Unauthorized(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError::Conflict(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }
    pub fn printer(msg: impl Into<String>) -> Self {
        AppError::Printer(msg.into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Internal(msg.into())
    }
}

// { kind, message, code } — `message` is a stable machine key (not raw text)
// for business/validation errors so the UI can translate them to Arabic.
// Serialize errors into a stable shape for the frontend:
// { kind, message, code? } — `message` is a stable machine key (not raw text)
// for business/validation errors so the UI can translate them to Arabic.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind().as_str())?;
        match self {
            // Business/validation/conflict/not-found errors carry a stable
            // machine code (e.g. "shift.already_open") for Arabic mapping.
            AppError::BusinessRule(m)
            | AppError::Validation(m)
            | AppError::Conflict(m)
            | AppError::NotFound(m) => {
                s.serialize_field("message", m)?;
                s.serialize_field("code", &self.kind().as_str())?;
            }
            AppError::Unauthorized(m) => {
                s.serialize_field("message", m)?;
                s.serialize_field("code", &self.kind().as_str())?;
            }
            // Technical errors: log full details, expose a generic message.
            _ => {
                log::error!("backend error [{}]: {}", self.kind().as_str(), self);
                s.serialize_field("message", "internal_error")?;
                s.serialize_field("code", &self.kind().as_str())?;
            }
        }
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Stable machine-readable error kinds for the frontend.
/// The UI maps these to Arabic messages; raw strings are never shown as-is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Validation,
    BusinessRule,
    Unauthorized,
    Conflict,
    NotFound,
    Printer,
    Db,
    Internal,
}

impl ErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorKind::Validation => "validation",
            ErrorKind::BusinessRule => "business_rule",
            ErrorKind::Unauthorized => "unauthorized",
            ErrorKind::Conflict => "conflict",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Printer => "printer",
            ErrorKind::Db => "db",
            ErrorKind::Internal => "internal",
        }
    }
}
