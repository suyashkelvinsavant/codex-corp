use parking_lot::{Condvar, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct ProcessLimiter {
    active: Mutex<usize>,
    changed: Condvar,
    limit: AtomicUsize,
    next_ticket: AtomicU64,
    serving_ticket: AtomicU64,
}

impl ProcessLimiter {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            active: Mutex::new(0),
            changed: Condvar::new(),
            limit: AtomicUsize::new(limit),
            next_ticket: AtomicU64::new(0),
            serving_ticket: AtomicU64::new(0),
        }
    }

    pub(super) fn set_limit(&self, limit: usize) {
        self.limit.store(limit.clamp(1, 16), Ordering::SeqCst);
        self.changed.notify_all();
    }

    pub(super) fn acquire(
        self: &Arc<Self>,
        stop: &AtomicBool,
    ) -> Result<ProcessPermit, String> {
        let ticket = self.next_ticket.fetch_add(1, Ordering::SeqCst);
        let mut active = self.active.lock();
        while ticket != self.serving_ticket.load(Ordering::SeqCst)
            || *active >= self.limit.load(Ordering::SeqCst)
        {
            if stop.load(Ordering::SeqCst) {
                self.serving_ticket.fetch_add(1, Ordering::SeqCst);
                self.changed.notify_all();
                return Err("run interrupted while queued for a Codex process".into());
            }
            let _ = self
                .changed
                .wait_for(&mut active, Duration::from_millis(250));
        }
        self.serving_ticket.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_all();
        if stop.load(Ordering::SeqCst) {
            return Err("run interrupted while queued for a Codex process".into());
        }
        *active += 1;
        Ok(ProcessPermit(self.clone()))
    }
}

#[derive(Debug)]
pub(crate) struct ProcessPermit(pub(crate) Arc<ProcessLimiter>);

impl Drop for ProcessPermit {
    fn drop(&mut self) {
        let mut active = self.0.active.lock();
        *active = active.saturating_sub(1);
        self.0.changed.notify_all();
    }
}
