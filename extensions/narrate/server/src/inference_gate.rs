use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub(crate) struct InferenceGate {
    inner: Arc<GateInner>,
}

struct GateInner {
    available: Mutex<usize>,
    changed: Condvar,
    capacity: usize,
}

pub(crate) struct InferencePermit {
    gate: InferenceGate,
}

impl InferenceGate {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(capacity > 0);
        Self {
            inner: Arc::new(GateInner {
                available: Mutex::new(capacity),
                changed: Condvar::new(),
                capacity,
            }),
        }
    }

    pub(crate) fn acquire(
        &self,
        cancelled: &dyn Fn() -> bool,
        deadline_exceeded: &dyn Fn() -> bool,
    ) -> Result<InferencePermit, String> {
        let mut available = self
            .inner
            .available
            .lock()
            .map_err(|_| "narration inference gate poisoned".to_string())?;
        loop {
            if cancelled() {
                return Err("narration cancelled".to_string());
            }
            if deadline_exceeded() {
                return Err("narration job deadline exceeded".to_string());
            }
            if *available > 0 {
                *available -= 1;
                return Ok(InferencePermit { gate: self.clone() });
            }
            let waited = self
                .inner
                .changed
                .wait_timeout(available, Duration::from_millis(100))
                .map_err(|_| "narration inference gate poisoned".to_string())?;
            available = waited.0;
        }
    }
}

impl Drop for InferencePermit {
    fn drop(&mut self) {
        if let Ok(mut available) = self.gate.inner.available.lock() {
            *available = (*available + 1).min(self.gate.inner.capacity);
            self.gate.inner.changed.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permit_is_returned_on_drop() {
        let gate = InferenceGate::new(1);
        let permit = gate.acquire(&|| false, &|| false).unwrap();
        drop(permit);
        gate.acquire(&|| false, &|| false).unwrap();
    }
}
