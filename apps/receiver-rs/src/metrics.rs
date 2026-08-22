//! Capture-path metrics.
//!
//! Instruments are created lazily from the global meter provider on first use
//! and cached in a `OnceLock`. When no provider has been installed (no
//! `APPSIGNAL_COLLECTOR_URL`), the global provider is the OpenTelemetry no-op
//! provider and every call here is a cheap no-op.
//!
//! Ordering matters: `main.rs` installs the provider via
//! `opentelemetry::global::set_meter_provider` before the server starts
//! serving, so the first call from a handler always binds to the real provider.

use std::sync::OnceLock;

use opentelemetry::KeyValue;
use opentelemetry::global;
use opentelemetry::metrics::Counter;

/// Instrumentation scope name for all receiver metrics.
const METER_NAME: &str = "webhooks-receiver";

/// `webhooks_capture_total{status}`: one increment per capture_webhook call
/// that returned a result (ok, not_found, expired, quota_exceeded, unknown).
const CAPTURE_TOTAL: &str = "webhooks_capture_total";

/// `webhooks_capture_failed_total{kind}`: one increment per capture that
/// could not be completed (transient, permanent, parse, unknown_status).
const CAPTURE_FAILED_TOTAL: &str = "webhooks_capture_failed_total";

struct CaptureInstruments {
    total: Counter<u64>,
    failed: Counter<u64>,
}

fn instruments() -> &'static CaptureInstruments {
    static INSTRUMENTS: OnceLock<CaptureInstruments> = OnceLock::new();
    INSTRUMENTS.get_or_init(|| {
        let meter = global::meter(METER_NAME);
        CaptureInstruments {
            total: meter
                .u64_counter(CAPTURE_TOTAL)
                .with_description("Number of capture_webhook calls by result status")
                .build(),
            failed: meter
                .u64_counter(CAPTURE_FAILED_TOTAL)
                .with_description("Number of capture_webhook calls that failed, by failure kind")
                .build(),
        }
    })
}

/// Record the status returned by `capture_webhook()`.
///
/// Takes a `&'static str` on purpose: the label must be one of a small fixed
/// set (never a value read from the database or the request) to keep metric
/// cardinality bounded.
pub fn capture_result(status: &'static str) {
    instruments()
        .total
        .add(1, &[KeyValue::new("status", status)]);
}

/// Record a capture that did not complete. `kind` is one of
/// `transient`, `permanent`, `parse`, `unknown_status`.
pub fn capture_failed(kind: &'static str) {
    instruments().failed.add(1, &[KeyValue::new("kind", kind)]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_without_a_provider_is_a_noop() {
        // No global meter provider is installed in unit tests; the calls must
        // not panic and must be safe to repeat.
        capture_result("ok");
        capture_result("not_found");
        capture_failed("transient");
        capture_failed("permanent");
    }
}
