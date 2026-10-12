//! Errors and log lines to StatOSS.
//!
//! `init` starts the client when `STATOSS_DSN` is set; without it nothing is
//! sent and `layer` is not installed. The client sends from a thread of its
//! own through a bounded queue, so a slow or unreachable StatOSS drops
//! envelopes instead of holding up a request.
//!
//! What a `tracing` event becomes: `error!` an issue and a log line, `warn!`
//! and `info!` a log line. One failure can repeat for every message (the
//! receiver down fails each delivery the same way), so each call site sends at
//! most one issue event a minute and its other errors go as log lines only. A
//! call site's log lines are capped per minute as well; the lines held back
//! are counted in one line a minute. stdout always gets every line.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use statoss::tracing::EventFilter;
use tracing::{Level, Metadata};

/// The name releases and server-side settings use for this program.
const SERVICE: &str = "webhooks-mx";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const WINDOW: Duration = Duration::from_secs(60);
/// Issue events per call site per window.
const EVENTS_PER_WINDOW: u32 = 1;
/// Log lines per call site per window.
const LINES_PER_WINDOW: u32 = 60;

/// Starts the StatOSS client before anything else runs, so the runtime's
/// threads and the panic hook see it. Keep the guard for the life of the
/// process: dropping it sends what is queued (2 seconds at most).
pub fn init() -> statoss::Guard {
    let mut options = statoss::Options::new()
        .environment(environment())
        .logs(true)
        // A request that hangs holds the sending thread, and shutdown waits
        // for it; ingest answers in well under a second.
        .request_timeout(REQUEST_TIMEOUT)
        .in_app_include(&["webhooks_mx"]);
    if let Some(release) = release() {
        options = options.release(release);
    }
    statoss::init(options)
}

/// `STATOSS_ENVIRONMENT`, else production for release builds.
fn environment() -> String {
    std::env::var("STATOSS_ENVIRONMENT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(debug_assertions) {
                "development".into()
            } else {
                "production".into()
            }
        })
}

/// `webhooks-mx@<commit>` from the image's `GIT_SHA`.
fn release() -> Option<String> {
    release_from(std::env::var("GIT_SHA").ok().as_deref())
}

fn release_from(sha: Option<&str>) -> Option<String> {
    let sha = sha?.trim();
    if sha.is_empty() {
        return None;
    }
    Some(format!("{SERVICE}@{}", &sha[..sha.len().min(12)]))
}

/// The tracing layer, with the throttle deciding what each event becomes.
pub fn layer<S>() -> statoss::tracing::SentryLayer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    statoss::tracing::LayerBuilder::new()
        .event_filter(|metadata| THROTTLE.decide(metadata, Instant::now()))
        .build()
}

static THROTTLE: LazyLock<Throttle> = LazyLock::new(Throttle::default);

/// Says once a minute how many log lines the throttle kept from StatOSS,
/// when it kept any.
pub fn spawn_held_back_reporter() {
    tokio::spawn(async {
        let mut interval = tokio::time::interval(WINDOW);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            let held_back = THROTTLE.held_back.swap(0, Ordering::Relaxed);
            if held_back > 0 {
                tracing::info!(held_back, "log lines kept from StatOSS");
            }
        }
    });
}

#[derive(Default)]
struct Throttle {
    /// Keyed by the call site's name (`event src/handlers/webhook.rs:797`),
    /// so the map is bounded by the number of call sites.
    sites: Mutex<HashMap<&'static str, Site>>,
    held_back: AtomicU64,
}

struct Site {
    start: Instant,
    events: u32,
    lines: u32,
}

impl Throttle {
    fn decide(&self, metadata: &Metadata<'_>, now: Instant) -> EventFilter {
        let wanted = match *metadata.level() {
            Level::ERROR => EventFilter::Event | EventFilter::Log,
            Level::WARN | Level::INFO => EventFilter::Breadcrumb | EventFilter::Log,
            _ => return EventFilter::Ignore,
        };
        let mut sites = self.sites.lock().unwrap_or_else(|e| e.into_inner());
        let site = sites.entry(metadata.name()).or_insert(Site {
            start: now,
            events: 0,
            lines: 0,
        });
        if now.duration_since(site.start) >= WINDOW {
            *site = Site {
                start: now,
                events: 0,
                lines: 0,
            };
        }
        let mut out = EventFilter::Ignore;
        if wanted.contains(EventFilter::Event) && site.events < EVENTS_PER_WINDOW {
            site.events += 1;
            out |= EventFilter::Event;
        }
        if site.lines < LINES_PER_WINDOW {
            site.lines += 1;
            out |= wanted.difference(EventFilter::Event);
        } else {
            self.held_back.fetch_add(1, Ordering::Relaxed);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[track_caller]
    fn assert_filter(got: EventFilter, want: EventFilter) {
        assert_eq!(got.bits(), want.bits());
    }

    /// The metadata of the event `emit` makes.
    fn grab(emit: impl FnOnce()) -> &'static Metadata<'static> {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::{Context, SubscriberExt};

        struct Grab(Arc<Mutex<Option<&'static Metadata<'static>>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Grab {
            fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
                *self.0.lock().unwrap() = Some(event.metadata());
            }
        }
        let seen = Arc::new(Mutex::new(None));
        let subscriber = tracing_subscriber::registry().with(Grab(seen.clone()));
        tracing::subscriber::with_default(subscriber, emit);
        seen.lock().unwrap().expect("an event")
    }

    #[test]
    fn an_error_is_an_issue_once_a_minute_and_a_line_otherwise() {
        let throttle = Throttle::default();
        let error = grab(|| tracing::error!("capture failed"));
        let start = Instant::now();
        assert_filter(
            throttle.decide(error, start),
            EventFilter::Event | EventFilter::Log,
        );
        assert_filter(throttle.decide(error, start), EventFilter::Log);
        assert_filter(
            throttle.decide(error, start + Duration::from_secs(59)),
            EventFilter::Log,
        );
        assert_filter(
            throttle.decide(error, start + WINDOW),
            EventFilter::Event | EventFilter::Log,
        );
    }

    #[test]
    fn call_sites_are_throttled_apart() {
        let throttle = Throttle::default();
        let one = grab(|| tracing::error!("one"));
        let other = grab(|| tracing::error!("other"));
        assert_ne!(one.name(), other.name());
        let now = Instant::now();
        assert!(throttle.decide(one, now).contains(EventFilter::Event));
        assert!(throttle.decide(other, now).contains(EventFilter::Event));
    }

    #[test]
    fn lines_past_the_cap_are_held_back_and_counted() {
        let throttle = Throttle::default();
        let warn = grab(|| tracing::warn!("slow"));
        let now = Instant::now();
        for _ in 0..LINES_PER_WINDOW {
            assert_filter(
                throttle.decide(warn, now),
                EventFilter::Breadcrumb | EventFilter::Log,
            );
        }
        assert_filter(throttle.decide(warn, now), EventFilter::Ignore);
        assert_filter(throttle.decide(warn, now), EventFilter::Ignore);
        assert_eq!(throttle.held_back.load(Ordering::Relaxed), 2);
        assert_filter(
            throttle.decide(warn, now + WINDOW),
            EventFilter::Breadcrumb | EventFilter::Log,
        );
    }

    #[test]
    fn debug_is_never_sent() {
        let throttle = Throttle::default();
        let debug = grab(|| tracing::debug!("chatter"));
        assert_filter(throttle.decide(debug, Instant::now()), EventFilter::Ignore);
    }

    #[test]
    fn the_release_names_the_commit() {
        assert_eq!(
            release_from(Some("0123456789abcdef0123")).as_deref(),
            Some("webhooks-mx@0123456789ab")
        );
        assert_eq!(
            release_from(Some("abc")).as_deref(),
            Some("webhooks-mx@abc")
        );
        assert_eq!(release_from(Some(" ")), None);
        assert_eq!(release_from(None), None);
    }
}
