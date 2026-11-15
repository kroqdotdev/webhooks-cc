//! Helpers shared by unit tests across modules.

use std::sync::{Mutex, MutexGuard};

/// Held by every test that changes how this process handles SIGINT or sends
/// SIGINT to it. The disposition is one per process and tests run on
/// parallel threads, so a test that puts the default action back while
/// another test's SIGINT is still on its way would end the whole test
/// binary.
static SIGNAL_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Takes [`SIGNAL_TEST_LOCK`], also after a test that held it panicked.
pub(crate) fn signal_test_lock() -> MutexGuard<'static, ()> {
    SIGNAL_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
