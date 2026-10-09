//! Printer backends — raw ESC/POS delivery.
//!
//! The production path on macOS/Linux is a RAW job handed to the OS spooler
//! (`lp -o raw`); on Windows it is a RAW job handed to the Windows spooler
//! through the documented printer-handle sequence
//! (`OpenPrinterW` → `StartDocPrinterW` → `StartPagePrinter` → `WritePrinter`
//! → `EndPagePrinter` → `EndDocPrinter` → `ClosePrinter`), which is the
//! documented way to send printer-ready data such as ESC/POS. A `File` backend
//! exists for development (writes the exact byte stream) and for diagnosing
//! layout.

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
        f.flush()
            .map_err(|e| AppError::printer(format!("printer.flush_failed: {e}")))?;
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
        Self {
            queue: queue.into(),
        }
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

/// Sends a RAW job to the Windows print spooler.
///
/// The Xprinter is addressed by its Windows printer/queue name (for example
/// `Xprinter XP-80`, or the last segment of a `\\localhost\Share` path). RAW is
/// mandatory for ESC/POS: a rendered job is already printer-ready, so Windows
/// must not reinterpret, paginate or re-encode it — which is exactly what
/// `DOC_INFO_1W.pDatatype = "RAW"` guarantees.
#[cfg(windows)]
pub struct WindowsRawBackend {
    /// The Windows printer/queue name, already reduced by
    /// [`spool_queue_name`] (a `\\localhost\Share` path is accepted and
    /// normalized, because that is how the setting is naturally written down
    /// next to the machine).
    queue: String,
}

#[cfg(windows)]
impl WindowsRawBackend {
    pub fn new(queue: impl Into<String>) -> Self {
        Self {
            queue: queue.into(),
        }
    }
}

/// A printer handle closed on drop.
///
/// Every early return in the send path still has to release the handle, and
/// `ClosePrinter` is the documented way to do it. Doing it in `Drop` means no
/// error path can leak one, and the happy path is unchanged.
#[cfg(windows)]
struct PrinterHandle(windows_sys::Win32::Graphics::Printing::PRINTER_HANDLE);

#[cfg(windows)]
impl Drop for PrinterHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by `OpenPrinterW` in `send`/`probe` and
        // is closed exactly once, here. A failed `ClosePrinter` has nothing
        // useful to do about and cannot be recovered from.
        unsafe {
            windows_sys::Win32::Graphics::Printing::ClosePrinter(self.0);
        }
    }
}

/// NUL-terminated UTF-16, the only string form the Win32 printing API accepts.
#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The last Win32 error as a stable `win32=<code>` fragment.
///
/// `GetLastError` is only meaningful immediately after the failing call, so it
/// is read at the call site and formatted there, never stored for later. It is
/// a numeric code, not a path or a SQL string, so it is safe to record on the
/// print job for diagnosis.
#[cfg(windows)]
fn last_error() -> u32 {
    // SAFETY: `GetLastError` takes no arguments and cannot fail.
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

#[cfg(windows)]
impl PrinterBackend for WindowsRawBackend {
    fn name(&self) -> &str {
        &self.queue
    }

    fn send(&self, bytes: &[u8]) -> AppResult<()> {
        use windows_sys::Win32::Graphics::Printing::{
            EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW, StartPagePrinter,
            WritePrinter, DOC_INFO_1W, PRINTER_HANDLE,
        };

        if bytes.len() > u32::MAX as usize {
            return Err(AppError::printer(
                "printer.write_failed: document too large",
            ));
        }
        let queue = wide(&self.queue);
        // A stable job name so a manager can find the job in the Windows print
        // queue; it carries no business data beyond what is already on paper.
        let mut doc_name = wide("Station");
        // "RAW" — the documented datatype for printer-ready data, built by the
        // same `wide` helper as every other string handed to the spooler, so it
        // is a NUL-terminated, caller-owned `Vec<u16>` that outlives the
        // `StartDocPrinterW` call. (It is deliberately NOT built from
        // `windows_sys::core::w!`: in windows-sys 0.61 that macro expands to
        // `OUTPUT.as_ptr()`, a `*const u16` into a `'static` array, which is
        // neither a `[u16; 4]` to copy out of nor a mutable `PWSTR` for
        // `DOC_INFO_1W`.)
        let mut datatype = wide("RAW");

        // SAFETY: every call below is one step of Microsoft's documented RAW
        // sequence (OpenPrinterW → StartDocPrinterW → StartPagePrinter →
        // WritePrinter → EndPagePrinter → EndDocPrinter → ClosePrinter). The
        // handle comes from a successful `OpenPrinterW` and is released exactly
        // once by `PrinterHandle`. The `DOC_INFO_1W` fields point at buffers
        // that outlive the call, and the same page/document are always ended in
        // the same order, on the success path and on every early return.
        unsafe {
            let mut handle = PRINTER_HANDLE::default();
            if OpenPrinterW(queue.as_ptr(), &mut handle, std::ptr::null()) == 0 {
                return Err(AppError::printer(format!(
                    "printer.open_failed: win32={}",
                    last_error()
                )));
            }
            // Owned immediately after a successful open, so no later return can
            // leak the handle.
            let _owned = PrinterHandle(handle);

            let doc = DOC_INFO_1W {
                pDocName: doc_name.as_mut_ptr(),
                pOutputFile: std::ptr::null_mut(),
                pDatatype: datatype.as_mut_ptr(),
            };
            // Level 1: `pDocInfo` points at a DOC_INFO_1W.
            if StartDocPrinterW(handle, 1, &doc) == 0 {
                return Err(AppError::printer(format!(
                    "printer.spool_failed: start_doc win32={}",
                    last_error()
                )));
            }
            if StartPagePrinter(handle) == 0 {
                // The document is already open, so it is still closed here.
                let _ = EndDocPrinter(handle);
                return Err(AppError::printer(format!(
                    "printer.spool_failed: start_page win32={}",
                    last_error()
                )));
            }

            let mut written: u32 = 0;
            let ok = WritePrinter(
                handle,
                bytes.as_ptr() as *const std::ffi::c_void,
                bytes.len() as u32,
                &mut written,
            );
            // Both closers run on every path, in the documented order, and
            // their own failures cannot be acted on: the bytes are already
            // with the spooler or already lost.
            let _ = EndPagePrinter(handle);
            let _ = EndDocPrinter(handle);

            if ok == 0 {
                return Err(AppError::printer(format!(
                    "printer.write_failed: win32={}",
                    last_error()
                )));
            }
            // A short write is a truncated receipt. It is reported rather than
            // treated as success, because a half-printed invoice is worse than
            // an explicit failure the UI can offer a retry for.
            if written as usize != bytes.len() {
                return Err(AppError::printer(format!(
                    "printer.flush_failed: {written}/{}",
                    bytes.len()
                )));
            }
        }
        Ok(())
    }

    fn probe(&self) -> AppResult<()> {
        use windows_sys::Win32::Graphics::Printing::{OpenPrinterW, PRINTER_HANDLE};

        let queue = wide(&self.queue);
        // SAFETY: the handle is closed exactly once by `PrinterHandle`, and a
        // NULL `pDefault` requests the default `PRINTER_ACCESS_USE` rights —
        // printing only, never printer administration.
        unsafe {
            let mut handle = PRINTER_HANDLE::default();
            if OpenPrinterW(queue.as_ptr(), &mut handle, std::ptr::null()) == 0 {
                return Err(AppError::printer(format!(
                    "printer.unavailable: win32={}",
                    last_error()
                )));
            }
            drop(PrinterHandle(handle));
        }
        Ok(())
    }
}

/// Collects output in memory — used by tests and the "preview" feature.
pub struct MemoryBackend {
    pub last: std::sync::Mutex<Vec<u8>>,
}

impl Default for MemoryBackend {
    fn default() -> Self {
        Self {
            last: std::sync::Mutex::new(Vec::new()),
        }
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

/// What a configured target string resolves to, before any platform decision.
///
/// Splitting this from [`backend_for`] is what keeps the *reading* of the
/// setting (which never changes) separate from the *transport* it selects (which
/// is the platform's business), so a new platform cannot quietly reinterpret an
/// existing value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrinterTarget {
    /// `file:/path` — raw bytes to a file (development / diagnostics).
    File(PathBuf),
    /// `share:Name` or a bare name — a spooler queue.
    Queue(String),
    /// `none` or empty — printing is not configured on this device.
    Disabled,
}

/// Read a configured target string. The accepted vocabulary is unchanged.
pub fn parse_target(target: &str) -> AppResult<PrinterTarget> {
    if let Some(rest) = target.strip_prefix("file:") {
        return Ok(PrinterTarget::File(Path::new(rest).to_path_buf()));
    }
    if let Some(rest) = target.strip_prefix("share:") {
        return named_queue(rest);
    }
    if target.is_empty() || target == "none" {
        return Ok(PrinterTarget::Disabled);
    }
    named_queue(target)
}

/// A queue name must actually name something. `share:` with nothing after it is
/// a half-finished setting, and it is refused here — with the same code a
/// missing target produces — instead of reaching a spooler call that would fail
/// with something far less obvious.
fn named_queue(raw: &str) -> AppResult<PrinterTarget> {
    if raw.trim().is_empty() {
        return Err(AppError::printer("printer.not_configured"));
    }
    Ok(PrinterTarget::Queue(raw.to_string()))
}

/// Reduce a configured queue to the name `OpenPrinterW` accepts.
///
/// Windows addresses a printer by exactly two documented forms:
///
/// - a LOCAL queue, named by its bare queue name (`Xprinter XP-80`);
/// - a REMOTE or shared queue, named by a UNC path (`\\SERVER\PrinterName`,
///   or `\\SERVER\Share\PrinterName` on a print server).
///
/// So a LOCAL path written down next to the machine (`\\localhost\Xprinter`,
/// `\\127.0.0.1\Xprinter`, `\\*\Xprinter`, the `\\localhost\Xprinter$` share
/// convention) must lose everything up to and including the last separator,
/// because a local queue has no server to qualify it, and the trailing `$` is a
/// share convention rather than part of a local printer name.
///
/// A UNC path naming a REAL server is left intact. Stripping `\\SERVER\Share`
/// down to `Share` would ask Windows for a *local* queue called `Share`, which
/// does not exist, so a shared printer would fail as if it were switched off.
/// Only a local machine is ever reduced; a remote one is a printer genuinely
/// somewhere else, and reaching it is the whole point of naming it.
///
/// A plain name is returned unchanged, so an existing correct setting keeps
/// working. The result is always a printer NAME: the reduction can never
/// introduce a drive letter, a device path or a command.
pub fn spool_queue_name(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    let unc = match trimmed.strip_prefix("\\\\") {
        Some(rest) => Some(rest),
        None => trimmed.strip_prefix("//"),
    };
    if let Some(unc) = unc {
        let (server, tail) = match unc.find(['\\', '/']) {
            Some(i) => (&unc[..i], &unc[i + 1..]),
            None => (unc, ""),
        };
        // A local machine — or the `\\*\` "any server" form, which is a
        // discovery wildcard and is never a usable OpenPrinterW name — is not a
        // real server, so only its last segment names the local queue.
        if is_local_server(server) {
            return local_queue_name(tail);
        }
        // A real server: the UNC path IS the printer name, so it is preserved.
        let server = server.trim();
        let tail = tail.trim_matches(['\\', '/']).trim();
        return if tail.is_empty() {
            format!("\\\\{server}")
        } else {
            format!("\\\\{server}\\{tail}")
        };
    }
    local_queue_name(trimmed)
}

/// Is this UNC server component the local machine, or a discovery wildcard?
fn is_local_server(server: &str) -> bool {
    matches!(
        server.trim().to_ascii_lowercase().as_str(),
        "" | "." | "*" | "localhost" | "127.0.0.1" | "::1"
    )
}

/// A LOCAL queue name: the last segment, without the trailing share `$`.
fn local_queue_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('$')
        .trim()
        .to_string()
}

/// Build the backend for the configured target string:
/// - `file:/path/to/out.prn`  → FileBackend (diagnostics)
/// - `share:Name` / bare name → the platform's spooler: a RAW job to the Windows
///   print queue on Windows, `lp -o raw` elsewhere
/// - `none`                   → not configured (printing disabled)
///
/// The READING of the setting is [`parse_target`], identical on every platform;
/// only the transport is platform-specific, so one setting means the same thing
/// everywhere and no existing value is reinterpreted.
pub fn backend_for(target: &str) -> AppResult<Box<dyn PrinterBackend>> {
    match parse_target(target)? {
        PrinterTarget::File(path) => Ok(Box::new(FileBackend::new(path))),
        PrinterTarget::Queue(queue) => Ok(queue_backend(queue)),
        PrinterTarget::Disabled => Err(AppError::printer("printer.not_configured")),
    }
}

/// The spooler transport for the current platform.
///
/// Windows gets [`WindowsRawBackend`], which speaks the documented Win32 RAW
/// sequence to the print queue. Every other platform keeps the existing `lp`
/// path, unchanged, including the exact queue string it is handed.
#[cfg(windows)]
fn queue_backend(queue: String) -> Box<dyn PrinterBackend> {
    // A `\\localhost\Share` style setting is reduced to the printer name here,
    // and only here, so the POSIX path keeps receiving the raw string it always
    // did.
    Box::new(WindowsRawBackend::new(spool_queue_name(&queue)))
}

#[cfg(not(windows))]
fn queue_backend(queue: String) -> Box<dyn PrinterBackend> {
    Box::new(LprBackend::new(queue))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The settings vocabulary is the contract with whoever configures the
    /// till. These run on every platform, so a Windows-only build still proves
    /// the same target strings mean the same thing.
    #[test]
    fn target_vocabulary_is_read_the_same_way_everywhere() {
        assert_eq!(
            parse_target("file:/tmp/out.prn").unwrap(),
            PrinterTarget::File(PathBuf::from("/tmp/out.prn"))
        );
        assert_eq!(
            parse_target("share:XP80").unwrap(),
            PrinterTarget::Queue("XP80".into())
        );
        assert_eq!(
            parse_target("XP80").unwrap(),
            PrinterTarget::Queue("XP80".into())
        );
        assert_eq!(parse_target("none").unwrap(), PrinterTarget::Disabled);
        assert_eq!(parse_target("").unwrap(), PrinterTarget::Disabled);
    }

    #[test]
    fn a_half_finished_share_setting_is_refused_rather_than_spooled() {
        // `share:` names nothing. Reaching the spooler with an empty queue would
        // fail as a generic spool error and send the manager looking in the
        // wrong place, so it is refused with the code that means "no printer
        // configured".
        for target in ["share:", "share:   "] {
            let err = parse_target(target).unwrap_err();
            assert_eq!(
                err.to_string(),
                crate::error::AppError::printer("printer.not_configured").to_string(),
                "{target} must be refused as not configured"
            );
        }
    }

    /// Windows addresses printers by NAME. A path written next to the machine
    /// must be reduced to that name — and to nothing else, ever.
    /// A LOCAL queue is addressed by its bare name, so a local path written
    /// next to the machine must be reduced to exactly that name.
    #[test]
    fn a_local_share_path_reduces_to_the_printer_name() {
        for (configured, queue) in [
            ("XP80", "XP80"),
            ("Xprinter XP-80", "Xprinter XP-80"),
            ("  XP80  ", "XP80"),
            (r"\\localhost\XP80", "XP80"),
            (r"\\localhost\XP80$", "XP80"),
            (r"\\localhost\XP80\", "XP80"),
            (r"\\*\XP80", "XP80"),
            (r"\\127.0.0.1\XP80", "XP80"),
            (r"\\LOCALHOST\XP80", "XP80"),
            (r"\\localhost\Xprinter XP-80", "Xprinter XP-80"),
        ] {
            assert_eq!(spool_queue_name(configured), queue, "{configured}");
        }
    }

    /// A SHARED or remote printer keeps its server. `OpenPrinterW` takes
    /// `\\SERVER\PrinterName` for exactly this case, and reducing it to
    /// `PrinterName` would ask Windows for a LOCAL queue of that name, which
    /// does not exist, so the reduction must not touch a real server.
    #[test]
    fn a_remote_share_path_keeps_its_server() {
        for (configured, queue) in [
            (r"\\SERVER\Xprinter XP-80", r"\\SERVER\Xprinter XP-80"),
            (r"\\print01\XP80", r"\\print01\XP80"),
            // A print server's nested share form is the printer name too.
            (r"\\SERVER\Share\PrinterName", r"\\SERVER\Share\PrinterName"),
            (r"\\SERVER\XP80\", r"\\SERVER\XP80"),
            // A remote administrative share keeps its `$`: it is part of the
            // name on the server, unlike the local `\\localhost\X$` convention.
            (r"\\SERVER\XP80$", r"\\SERVER\XP80$"),
        ] {
            assert_eq!(spool_queue_name(configured), queue, "{configured}");
        }
    }

    /// The reduction is a name transformation and nothing more: it can never
    /// introduce a drive letter, a device path, or anything a spooler call
    /// would read as a file. What reaches `OpenPrinterW` is a printer name.
    #[test]
    fn the_reduced_queue_is_always_a_printer_name() {
        for configured in [
            r"\\localhost\XP80",
            r"\\localhost\Xprinter\sub\XP80",
            r"\\SERVER\share\printer$",
            r"\\SERVER\Share\PrinterName",
            "\\\\",
            "//localhost/XP80",
        ] {
            let queue = spool_queue_name(configured);
            assert!(!queue.contains(':'), "{configured} reduced to {queue}");
            // A local queue is a single segment; a remote one is exactly the
            // documented `\\SERVER[\Share\Printer]` form, never anything deeper.
            if queue.starts_with("\\\\") {
                assert!(
                    queue[2..].split('\\').count() <= 3,
                    "{configured} reduced to {queue}"
                );
            } else {
                assert!(
                    !queue.contains(['\\', '/']),
                    "{configured} reduced to {queue}"
                );
            }
        }
    }

    /// The RAW datatype and every other string handed to the Windows spooler
    /// must be a NUL-terminated UTF-16 buffer, or `OpenPrinterW` reads past the
    /// end of it. This is the property the `w!` misuse broke: it produced a
    /// pointer into a `'static` array, which can never be the mutable `PWSTR`
    /// `DOC_INFO_1W` needs, so the datatype was not a buffer at all.
    #[cfg(windows)]
    #[test]
    fn the_wide_helper_produces_a_nul_terminated_utf16_buffer() {
        for value in ["RAW", "Station", "Xprinter XP-80", ""] {
            let wide = wide(value);
            assert_eq!(wide.len(), value.encode_utf16().count() + 1, "{value}");
            assert_eq!(*wide.last().unwrap(), 0, "{value} must be NUL-terminated");
            for (i, unit) in value.encode_utf16().enumerate() {
                assert_eq!(wide[i], unit, "{value}");
            }
        }
        // The exact datatype a RAW job is submitted with.
        assert_eq!(wide("RAW"), vec![b'R' as u16, b'A' as u16, b'W' as u16, 0]);
    }

    /// A disabled target keeps its exact existing behaviour: a typed printer
    /// error, never a silent success.
    #[test]
    fn a_disabled_target_still_refuses_to_build_a_backend() {
        for target in ["none", ""] {
            assert!(backend_for(target).is_err());
        }
        assert!(backend_for("share:").is_err());
    }

    /// The transport is chosen per platform, and this is the assertion that says
    /// so: the same configured value must reach a working backend everywhere.
    #[test]
    fn a_configured_queue_reaches_a_backend_on_this_platform() {
        // A share path, which is how the setting is naturally written down next
        // to the machine. Windows needs the printer NAME, so it reduces the
        // path; POSIX keeps handing `lp` the string exactly as configured, which
        // is the pre-existing behaviour and is deliberately untouched.
        let backend = backend_for(r"share:\\localhost\XP80").expect("a configured target builds");
        assert_eq!(
            backend.name(),
            if cfg!(windows) {
                "XP80"
            } else {
                r"\\localhost\XP80"
            }
        );
    }

    /// A diagnostic file target keeps working on every platform, so a manager
    /// can always capture the exact byte stream without a printer attached.
    #[test]
    fn a_file_target_writes_the_exact_bytes() {
        let path = std::env::temp_dir().join(format!(
            "station-backend-test-{}-{}.prn",
            std::process::id(),
            crate::time::now_utc().timestamp()
        ));
        let target = format!("file:{}", path.display());
        let backend = backend_for(&target).unwrap();
        backend.send(&[0x1B, b'@', 0x41]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![0x1B, b'@', 0x41]);
        let _ = std::fs::remove_file(&path);
    }
}
