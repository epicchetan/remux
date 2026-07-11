//! Worker hang watchdog: converts a wedged tokio runtime into a crash, which
//! L1 already heals. This is the pass-2 answer to the one remaining
//! "SSH required" failure mode — a worker that is alive but unreachable.
//!
//! A tokio interval task stamps a monotonic heartbeat every second; a plain
//! OS thread checks it every 5s. When the heartbeat is older than the
//! configured staleness the thread journals `fatal:watchdog-stale` and calls
//! `std::process::abort()` — abort rather than `exit(75)` because no
//! atexit/unwind code runs (nothing to deadlock on) and the SIGABRT death
//! takes L1's *backoff* path, so a deterministic wedge-on-boot cannot
//! hot-loop at exit-75 speed. systemd's `WatchdogSec` was rejected: the
//! unit's main process is the supervisor, which is trivially alive even when
//! the worker wedges, and it would do nothing for ad-hoc dev runs.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::logs::{Journal, JournalEvent};

pub const STAMP_INTERVAL_MS: u64 = 1_000;
pub const CHECK_INTERVAL_MS: u64 = 5_000;
/// How long the abort path waits for the journal writer thread to drain.
pub const JOURNAL_DRAIN_MS: u64 = 200;

/// Returns the stale age in ms when the heartbeat is older than
/// `stale_after_ms`, else `None`. Pure so the checker logic unit-tests with
/// a fake clock.
pub fn stale_age_ms(heartbeat: &AtomicU64, now_ms: u64, stale_after_ms: u64) -> Option<u64> {
    let age = now_ms.saturating_sub(heartbeat.load(Ordering::Relaxed));
    (age > stale_after_ms).then_some(age)
}

/// Spawns the heartbeat stamper (on the current tokio runtime — that is the
/// thing being monitored) and the checker thread. `stale_seconds == 0`
/// disables the watchdog entirely.
pub fn start(
    stale_seconds: u32,
    journal: Arc<Journal>,
    is_shutting_down: impl Fn() -> bool + Send + 'static,
) {
    if stale_seconds == 0 {
        return;
    }
    let stale_after_ms = u64::from(stale_seconds) * 1_000;
    let epoch = Instant::now();
    let heartbeat = Arc::new(AtomicU64::new(0));

    let stamper_heartbeat = heartbeat.clone();
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(STAMP_INTERVAL_MS));
        loop {
            interval.tick().await;
            stamper_heartbeat.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
        }
    });

    let _ = std::thread::Builder::new()
        .name("remux-watchdog".to_string())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(CHECK_INTERVAL_MS));
            if is_shutting_down() {
                // Slow graceful shutdowns are not hangs; the 5s shutdown hard
                // deadline already bounds this path.
                continue;
            }
            let now_ms = epoch.elapsed().as_millis() as u64;
            if let Some(age) = stale_age_ms(&heartbeat, now_ms, stale_after_ms) {
                on_stale(&journal, age, stale_after_ms);
            }
        });
}

fn on_stale(journal: &Journal, age_ms: u64, stale_after_ms: u64) -> ! {
    // Best-effort journal: the writer is its own thread, so this usually
    // succeeds even when tokio is wedged; give it a bounded drain window.
    journal.event(JournalEvent {
        detail: Some(serde_json::json!({
            "staleAgeMs": age_ms,
            "staleAfterMs": stale_after_ms,
        })),
        label: Some("fatal:watchdog-stale".to_string()),
        level: "error",
        message: Some(format!(
            "worker event loop stale for {age_ms}ms; aborting for L1 restart"
        )),
        ..Default::default()
    });
    std::thread::sleep(std::time::Duration::from_millis(JOURNAL_DRAIN_MS));
    eprintln!("remux: watchdog detected a wedged worker ({age_ms}ms stale); aborting");
    std::process::abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_detection_with_fake_clock() {
        let heartbeat = AtomicU64::new(10_000);

        // Fresh heartbeat: not stale, even exactly at the boundary.
        assert_eq!(stale_age_ms(&heartbeat, 10_500, 30_000), None);
        assert_eq!(stale_age_ms(&heartbeat, 40_000, 30_000), None);

        // Past the boundary: stale with the right age.
        assert_eq!(stale_age_ms(&heartbeat, 40_001, 30_000), Some(30_001));
        assert_eq!(stale_age_ms(&heartbeat, 99_000, 30_000), Some(89_000));

        // A re-stamp recovers.
        heartbeat.store(98_000, Ordering::Relaxed);
        assert_eq!(stale_age_ms(&heartbeat, 99_000, 30_000), None);

        // Clock skew (heartbeat ahead of now) never underflows.
        assert_eq!(stale_age_ms(&heartbeat, 0, 30_000), None);
    }

    #[test]
    fn checker_invokes_injected_on_stale_only_when_stale() {
        // The production loop body, with clock + on_stale injected.
        let heartbeat = AtomicU64::new(0);
        let check = |now_ms: u64, stale_after_ms: u64, on_stale: &mut dyn FnMut(u64)| {
            if let Some(age) = stale_age_ms(&heartbeat, now_ms, stale_after_ms) {
                on_stale(age);
            }
        };

        let mut fired: Vec<u64> = Vec::new();
        check(5_000, 30_000, &mut |age| fired.push(age));
        assert!(fired.is_empty());
        check(31_000, 30_000, &mut |age| fired.push(age));
        assert_eq!(fired, vec![31_000]);
    }
}
