/**
 * Sending the monthly executive sheet to a printer / a PDF.
 *
 * # What was actually broken
 *
 * The sheet was never the problem. It is produced by the WebView's own print
 * pipeline — `@page { size: A4 }` plus the `printing-monthly` rules in
 * `index.css` — and that pipeline is unchanged. What was broken is the TRIGGER:
 * the panel called `window.print()`, which WKWebView on macOS does not
 * implement, so the click was a silent no-op — no dialog, no PDF, no error.
 *
 * # The two transports, and why both are needed
 *
 * - Desktop (Tauri): `print_monthly_report` (see `commands/ops.rs`). On macOS
 *   wry drives `WKWebView.printOperationWithPrintInfo:` — the native panel,
 *   which is where "Save as PDF" lives; on Windows it evaluates
 *   `window.print()` in WebView2, where that does work.
 * - Browser (the manager's phone on the cafe LAN): there is no Tauri shell at
 *   all, so `window.print()` is correct and is the browser's own dialog.
 *
 * Neither path is a second PDF pipeline: both print the page that is already on
 * screen, through the one `@media print` stylesheet.
 *
 * # Why the body class spans the whole call
 *
 * The `printing-monthly` class is what the print rules key off, so it must
 * still be set when the native panel samples the page. It is therefore removed
 * when the job is observably over — `afterprint` where the engine fires it, the
 * window regaining focus when a modal panel closes — and on unmount. Any of
 * those failing leaves a class that only matters inside `@media print`, so it
 * can never make the application invisible.
 */
import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/services/ipc'

/** Marks the document as the thing being printed; see `index.css`. */
export const PRINTING_CLASS = 'printing-monthly'

/**
 * Print the sheet that is currently on screen.
 *
 * Resolves once the job has been handed over, and rejects only when the dialog
 * genuinely could not be opened — a refusal the caller can show. It never
 * reports success for a PDF that was not produced: no toast claims one here.
 */
export async function printMonthlyReport(): Promise<void> {
  document.body.classList.add(PRINTING_CLASS)
  try {
    if (isDesktop()) {
      await invoke('print_monthly_report')
    } else if (typeof window.print === 'function') {
      window.print()
    } else {
      throw new Error('print unavailable')
    }
  } catch (error) {
    document.body.classList.remove(PRINTING_CLASS)
    throw error
  }
}

/**
 * Clear the print marker once the job is over.
 *
 * `afterprint` is the precise signal where it exists; `focus` covers the macOS
 * panel, which is modal and gives no DOM event at all. A timer is the last
 * resort for an engine that reports neither — the class is inert outside
 * `@media print`, so a late clear costs nothing and a missing one costs less.
 */
export function releaseMonthlyPrint(): void {
  document.body.classList.remove(PRINTING_CLASS)
}

/** Attach the end-of-job listeners; returns their detach function. */
export function watchPrintEnd(): () => void {
  const finish = () => releaseMonthlyPrint()
  const timer = window.setTimeout(finish, PRINT_END_FALLBACK_MS)
  window.addEventListener('afterprint', finish, { once: true })
  window.addEventListener('focus', finish, { once: true })
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener('afterprint', finish)
    window.removeEventListener('focus', finish)
  }
}

/** How long to wait for a signal that never came before clearing anyway. */
const PRINT_END_FALLBACK_MS = 2000
