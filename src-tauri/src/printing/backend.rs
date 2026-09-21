//! Printer backends — raw ESC/POS delivery.
//!
//! The production path on Windows is a RAW write to the Xprinter's shared
//! queue (`\\localhost\<ShareName>`); on macOS/Linux the device node
//! (`/dev/usb/lp*`) or a `lp -o raw` job is used. A `File` backend exists for
//! development (writes the exact byte stream) and for diagnosing layout.

use crate::error::{AppError, AppResult};
use std::io::Write;
use std::path::{Path, PathBuf};

pub trait PrinterBackend: Send + Sync {
    fn name(&self) -> &str;
    /// Send raw bytes to the printer. Must be atomic per document.
    fn send(&self, bytes: &[u8]) -> AppResult<()>;
    /// Verify the target is reachable before queueing work.
    fn probe(&self) -> AppResult<()>;
}

/// Writes bytes to a file path (development / diagnostics / Windows RAW share).
pub struct FileBackend {
    path: PathBuf,
}

impl FileBackend {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl PrinterBackend for FileBackend {
    fn name(&self) -> &str {
        self.path.to_str().unwrap_or("file")
    }

    fn send(&self, bytes: &[u8]) -> AppResult<()> {
        let mut f = std::fs::File::create(&self.path)
            .map_err(|e| AppError::printer(format!("printer.open_failed: {e}")))?;
        f.write_all(bytes)
            .map_err(|e| AppError::printer(format!("printer.write_failed: {e}")))?;
        f.flush().map_err(|e| AppError::printer(format!("printer.flush_failed: {e}")))?;
        Ok(())
    }

    fn probe(&self) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(AppError::printer("printer.unavailable"));
            }
        }
        Ok(())
    }
}

/// Sends through the OS spooler using `lp` (macOS/Linux, offline-safe).
pub struct LprBackend {
    queue: String,
}

impl LprBackend {
    pub fn new(queue: impl Into<String>) -> Self {
        Self { queue: queue.into() }
    }
}

impl PrinterBackend for LprBackend {
    fn name(&self) -> &str {
        &self.queue
    }

    fn send(&self, bytes: &[u8]) -> AppResult<()> {
        use std::process::{Command, Stdio};
        let mut child = Command::new("lp")
            .args(["-d", &self.queue, "-o", "raw"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::printer(format!("printer.spool_failed: {e}")))?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::printer("printer.spool_failed"))?
            .write_all(bytes)
            .map_err(|e| AppError::printer(format!("printer.write_failed: {e}")))?;
        let out = child
            .wait_with_output()
            .map_err(|e| AppError::printer(format!("printer.spool_failed: {e}")))?;
        if !out.status.success() {
            return Err(AppError::printer(format!(
                "printer.job_rejected: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(())
    }

    fn probe(&self) -> AppResult<()> {
        // The queue must be configured; a failed job surfaces as a print error
        // on send, which the UI turns into a retry affordance.
        Ok(())
    }
}

/// Collects output in memory — used by tests and the "preview" feature.
pub struct MemoryBackend {
    pub last: std::sync::Mutex<Vec<u8>>,
}

impl Default for MemoryBackend {
    fn default() -> Self {
        Self { last: std::sync::Mutex::new(Vec::new()) }
    }
}

impl PrinterBackend for MemoryBackend {
    fn name(&self) -> &str {
        "memory"
    }
    fn send(&self, bytes: &[u8]) -> AppResult<()> {
        *self
            .last
            .lock()
            .map_err(|_| AppError::internal("printer buffer poisoned"))? = bytes.to_vec();
        Ok(())
    }
    fn probe(&self) -> AppResult<()> {
        Ok(())
    }
}

/// Build the backend for the configured target string:
/// - `file:/path/to/out.prn`  → FileBackend (also used for Windows shares)
/// - `share:Name` / bare name → OS spooler (`lp -d Name`)
/// - `none`                   → not configured (printing disabled)
pub fn backend_for(target: &str) -> AppResult<Box<dyn PrinterBackend>> {
    if let Some(rest) = target.strip_prefix("file:") {
        return Ok(Box::new(FileBackend::new(Path::new(rest))));
    }
    if let Some(rest) = target.strip_prefix("share:") {
        return Ok(Box::new(LprBackend::new(rest)));
    }
    if target.is_empty() || target == "none" {
        return Err(AppError::printer("printer.not_configured"));
    }
    Ok(Box::new(LprBackend::new(target)))
}