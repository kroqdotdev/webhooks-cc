//! What each capture was answered with, stored on its request row
//! (`requests.response_status` and `response_rule`, migration 00090).
//!
//! The answer depends on the endpoint's response rules and mock response,
//! which `capture_webhook()` returns in the same call that inserts the row.
//! So that a capture stays one write, the answer is worked out before the
//! call from the rules the previous capture of the same slug returned, kept
//! here, and passed to the insert; a slug with nothing kept is predicted to
//! get the plain 200, which is what an endpoint without rules or a mock
//! gets. After the call the fresh rules decide the response as before, and
//! the row is corrected with an UPDATE only when what was sent differs from
//! the prediction (a cold cache for an endpoint with rules or a mock, edited
//! rules, a response that could not be built). Rules are pure functions of
//! the request, so in the steady state the prediction is right.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::rules::{self, RequestContext, ResponseRule};
use super::values::LazyBody;
use super::webhook::{MockResponse, mock_status};

/// How long a slug's rules are used for predictions. A stale entry costs one
/// corrective UPDATE, never a wrong record.
const TTL: Duration = Duration::from_secs(3600);
/// Bounds on the cache: entries, and the approximate bytes their rules take.
/// Past either, stale entries go, then the large ones, then everything.
const MAX_SLUGS: usize = 50_000;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// Rule sets larger than this are not kept (their endpoints are predicted the
/// plain 200 and corrected when they answer otherwise): validation allows
/// rule sets of megabytes, which would make the cache's size up to senders.
const MAX_ENTRY_BYTES: usize = 128 * 1024;
/// Entries above this go first when the cache is full.
const LARGE_ENTRY_BYTES: usize = 16 * 1024;

/// The status sent and the rule that chose it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Answer {
    pub(crate) status: u16,
    /// The rule's name, or "Rule N" for an unnamed one; None when the
    /// endpoint's own mock response or the plain 200 answered.
    pub(crate) rule: Option<String>,
}

impl Answer {
    /// The plain 200 an endpoint without rules or a mock response sends.
    pub(crate) fn plain_ok() -> Self {
        Self {
            status: 200,
            rule: None,
        }
    }
}

/// The status a response goes out with: what `build_mock_response` sends the
/// mock with (the plain 200 for an invalid status or header), and 200 when
/// there is no mock at all.
pub(crate) fn response_status(mock: Option<&MockResponse>) -> u16 {
    mock.map_or(200, |m| mock_status(m).as_u16())
}

/// A rule as the dashboard names it: its own name, or its place in the
/// stored list ("Rule 2"), counting rules that are switched off or could not
/// be read.
fn rule_label(rule: &ResponseRule) -> String {
    match rule.name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => format!("Rule {}", rule.position + 1),
    }
}

/// The answer for a request: the first matching rule's, else the default.
/// Also returns the matching rule's index, so the caller can send its response.
pub(crate) fn decide(
    rules: &[ResponseRule],
    default: Option<&MockResponse>,
    ctx: &RequestContext<'_>,
    body: &LazyBody<'_>,
) -> (Answer, Option<usize>) {
    match rules::matching_rule(rules, ctx, body) {
        Some(index) => {
            let rule = &rules[index];
            (
                Answer {
                    status: response_status(Some(&rule.response)),
                    rule: Some(rule_label(rule)),
                },
                Some(index),
            )
        }
        None => (
            Answer {
                status: response_status(default),
                rule: None,
            },
            None,
        ),
    }
}

/// What deciding needs from one capture result: the rules without their
/// response bodies and headers, and the default status.
pub(crate) struct Known {
    rules: Vec<ResponseRule>,
    default: Option<MockResponse>,
    /// Roughly what the rules take in memory, for the cache's byte bound.
    bytes: usize,
}

impl Known {
    pub(crate) fn decide(&self, ctx: &RequestContext<'_>, body: &LazyBody<'_>) -> Answer {
        decide(&self.rules, self.default.as_ref(), ctx, body).0
    }
}

/// A response reduced to the status it goes out with: deciding never reads
/// the rest, and the headers that could make it fall back to 200 are judged
/// here, before they are dropped.
fn status_only(mock: &MockResponse) -> MockResponse {
    MockResponse {
        status: i64::from(response_status(Some(mock))),
        body: String::new(),
        headers: HashMap::new(),
        delay: None,
    }
}

/// An estimate of the heap a rule keeps here: its strings, plus overhead.
fn rule_bytes(rule: &ResponseRule) -> usize {
    let text = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    let conditions: usize = rule
        .conditions
        .iter()
        .map(|c| c.field.len() + c.op.len() + text(&c.value) + text(&c.name) + text(&c.path) + 128)
        .sum();
    256 + text(&rule.id) + text(&rule.name) + rule.logic.len() + conditions
}

#[derive(Default)]
struct Entries {
    slugs: HashMap<String, (Arc<Known>, Instant)>,
    bytes: usize,
}

impl Entries {
    fn remove(&mut self, slug: &str) {
        if let Some((known, _)) = self.slugs.remove(slug) {
            self.bytes -= known.bytes;
        }
    }

    fn full(&self, bytes: usize) -> bool {
        self.slugs.len() >= MAX_SLUGS || self.bytes + bytes > MAX_TOTAL_BYTES
    }

    /// Drops stale entries, then large ones, then everything, until `bytes`
    /// more fit.
    fn make_room(&mut self, bytes: usize) {
        if !self.full(bytes) {
            return;
        }
        self.slugs.retain(|_, (_, seen)| seen.elapsed() < TTL);
        self.bytes = self.slugs.values().map(|(known, _)| known.bytes).sum();
        if self.full(bytes) {
            self.slugs
                .retain(|_, (known, _)| known.bytes <= LARGE_ENTRY_BYTES);
            self.bytes = self.slugs.values().map(|(known, _)| known.bytes).sum();
        }
        if self.full(bytes) {
            self.slugs.clear();
            self.bytes = 0;
        }
    }
}

#[derive(Default)]
pub struct AnswerCache {
    entries: Mutex<Entries>,
}

impl AnswerCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The answer the rules last seen for `slug` would give, or the plain
    /// 200 when none are kept.
    pub(crate) fn predict(
        &self,
        slug: &str,
        ctx: &RequestContext<'_>,
        body: &LazyBody<'_>,
    ) -> Answer {
        let known = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            match entries.slugs.get(slug) {
                Some((known, seen)) if seen.elapsed() < TTL => Some(known.clone()),
                _ => None,
            }
        };
        known.map_or_else(Answer::plain_ok, |known| known.decide(ctx, body))
    }

    /// Keeps what a capture of `slug` returned, for the next capture's prediction.
    pub(crate) fn remember(
        &self,
        slug: &str,
        rules: Option<&[ResponseRule]>,
        default: Option<&MockResponse>,
    ) {
        let rules = rules.unwrap_or_default();
        let bytes = 512 + slug.len() + rules.iter().map(rule_bytes).sum::<usize>();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.remove(slug);
        // Most endpoints have no rules and answer the plain 200, which is what
        // a slug with nothing kept is predicted anyway.
        let plain = rules.is_empty() && response_status(default) == 200;
        if plain || bytes > MAX_ENTRY_BYTES {
            return;
        }
        let known = Arc::new(Known {
            rules: rules
                .iter()
                .map(|rule| ResponseRule {
                    response: status_only(&rule.response),
                    ..rule.clone()
                })
                .collect(),
            default: default.map(status_only),
            bytes,
        });
        entries.make_room(bytes);
        entries.bytes += bytes;
        entries
            .slugs
            .insert(slug.to_string(), (known, Instant::now()));
    }

    /// Forgets `slug`: it no longer names an endpoint, and a new one may take it.
    pub(crate) fn forget(&self, slug: &str) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(slug);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock(status: i64) -> MockResponse {
        MockResponse {
            status,
            body: "big body".to_string(),
            headers: HashMap::from([("x-a".to_string(), "b".to_string())]),
            delay: Some(10),
        }
    }

    /// Rules as the capture handler reads them, each at its stored position.
    fn rules(specs: &[(Option<&str>, &str, i64, bool)]) -> Vec<ResponseRule> {
        specs
            .iter()
            .enumerate()
            .map(|(position, (name, method, status, enabled))| {
                let mut rule: ResponseRule = serde_json::from_value(serde_json::json!({
                    "name": name,
                    "enabled": enabled,
                    "conditions": [{ "field": "method", "op": "eq", "value": method }],
                    "response": { "status": status, "body": "x", "headers": {} },
                }))
                .unwrap();
                rule.position = position;
                rule
            })
            .collect()
    }

    fn ctx<'a>(method: &'a str, headers: &'a HashMap<String, String>) -> RequestContext<'a> {
        RequestContext {
            method,
            path: "/",
            headers,
            body: "",
            query: headers,
            content_type: None,
            size: Some(0),
        }
    }

    #[test]
    fn a_matching_rule_answers_with_its_name_or_its_place() {
        let none = HashMap::new();
        let body = LazyBody::new("", None);
        let rules = rules(&[
            (Some("Off"), "POST", 500, false),
            (Some("  Payment failed "), "POST", 402, true),
            (None, "PUT", 409, true),
        ]);
        assert_eq!(
            decide(&rules, None, &ctx("POST", &none), &body),
            (
                Answer {
                    status: 402,
                    rule: Some("Payment failed".to_string())
                },
                Some(1)
            )
        );
        assert_eq!(
            decide(&rules, None, &ctx("PUT", &none), &body).0,
            Answer {
                status: 409,
                rule: Some("Rule 3".to_string())
            }
        );
    }

    #[test]
    fn an_unnamed_rule_keeps_its_stored_place_when_an_earlier_one_was_skipped() {
        let none = HashMap::new();
        let body = LazyBody::new("", None);
        // The rule at stored position 0 could not be read and was dropped.
        let mut rules = rules(&[(None, "PUT", 409, true)]);
        rules[0].position = 1;
        assert_eq!(
            decide(&rules, None, &ctx("PUT", &none), &body).0.rule,
            Some("Rule 2".to_string())
        );
    }

    #[test]
    fn without_a_match_the_default_answers() {
        let none = HashMap::new();
        let body = LazyBody::new("", None);
        let rules = rules(&[(Some("Puts"), "PUT", 409, true)]);
        let answer =
            |default: Option<&MockResponse>| decide(&rules, default, &ctx("GET", &none), &body);
        assert_eq!(answer(None), (Answer::plain_ok(), None));
        assert_eq!(answer(Some(&mock(201))).0.status, 201);
        // build_mock_response sends 200 for a status HTTP has no code for.
        assert_eq!(answer(Some(&mock(42))).0.status, 200);
    }

    #[test]
    fn the_cache_predicts_what_the_rules_it_saw_would_answer() {
        let cache = AnswerCache::new();
        let none = HashMap::new();
        let body = LazyBody::new("", None);
        // Nothing kept: the plain 200.
        assert_eq!(
            cache.predict("acme", &ctx("POST", &none), &body),
            Answer::plain_ok()
        );
        let rules = rules(&[(Some("Payment failed"), "POST", 402, true)]);
        cache.remember("acme", Some(&rules), Some(&mock(204)));
        assert_eq!(
            cache.predict("acme", &ctx("POST", &none), &body).status,
            402
        );
        assert_eq!(cache.predict("acme", &ctx("GET", &none), &body).status, 204);
        {
            let entries = cache.entries.lock().unwrap();
            let (known, _) = &entries.slugs["acme"];
            // Only the statuses are kept.
            assert!(known.rules[0].response.body.is_empty());
            assert!(known.default.as_ref().unwrap().headers.is_empty());
            assert_eq!(entries.bytes, known.bytes);
        }

        cache.remember("acme", None, None);
        assert_eq!(
            cache.predict("acme", &ctx("POST", &none), &body),
            Answer::plain_ok()
        );

        cache.remember("acme", Some(&rules), None);
        cache.forget("acme");
        assert_eq!(
            cache.predict("acme", &ctx("POST", &none), &body),
            Answer::plain_ok()
        );
        assert_eq!(cache.entries.lock().unwrap().bytes, 0);
    }

    #[test]
    fn a_mock_that_goes_out_as_200_is_predicted_as_200() {
        let cache = AnswerCache::new();
        let none = HashMap::new();
        let body = LazyBody::new("", None);
        let mut broken = mock(402);
        broken.headers = HashMap::from([("Content Type".to_string(), "x".to_string())]);
        cache.remember("acme", None, Some(&broken));
        // Nothing to keep: it answers the plain 200 like an endpoint without a mock.
        assert_eq!(cache.entries.lock().unwrap().bytes, 0);
        assert_eq!(
            cache.predict("acme", &ctx("GET", &none), &body),
            Answer::plain_ok()
        );
        // A rule whose response cannot be built is recorded as the 200 it is sent as.
        let mut rules = rules(&[(Some("Broken"), "GET", 402, true)]);
        rules[0].response = broken;
        cache.remember("acme", Some(&rules), None);
        assert_eq!(
            cache.predict("acme", &ctx("GET", &none), &body),
            Answer {
                status: 200,
                rule: Some("Broken".to_string())
            }
        );
    }

    #[test]
    fn endpoints_without_rules_or_a_mock_are_not_kept() {
        let cache = AnswerCache::new();
        cache.remember("plain", None, None);
        cache.remember("plain-200", None, Some(&mock(200)));
        assert!(cache.entries.lock().unwrap().slugs.is_empty());
        cache.remember("teapot", None, Some(&mock(418)));
        assert_eq!(cache.entries.lock().unwrap().slugs.len(), 1);
    }

    #[test]
    fn a_full_cache_drops_large_entries_before_small_ones() {
        let cache = AnswerCache::new();
        let mut big = rules(&[(Some("Big"), "POST", 402, true)]);
        big[0].conditions[0].value = Some("x".repeat(LARGE_ENTRY_BYTES * 2));
        cache.remember("big", Some(&big), None);
        cache.remember("small", Some(&rules(&[(None, "PUT", 409, true)])), None);
        let mut entries = cache.entries.lock().unwrap();
        let small = entries.slugs["small"].0.bytes;
        assert_eq!(entries.bytes, small + entries.slugs["big"].0.bytes);
        entries.make_room(MAX_TOTAL_BYTES - small);
        assert!(!entries.slugs.contains_key("big"));
        assert!(entries.slugs.contains_key("small"));
        assert_eq!(entries.bytes, small);
        entries.make_room(MAX_TOTAL_BYTES);
        assert!(entries.slugs.is_empty());
        assert_eq!(entries.bytes, 0);
    }

    #[test]
    fn a_large_rule_set_is_not_kept() {
        let cache = AnswerCache::new();
        let none = HashMap::new();
        let body = LazyBody::new("", None);
        let mut big = rules(&[(Some("Big"), "POST", 402, true)]);
        big[0].conditions[0].value = Some("x".repeat(MAX_ENTRY_BYTES));
        // Kept small first, then replaced by a large set: the old entry goes too.
        cache.remember("acme", Some(&rules(&[(None, "POST", 418, true)])), None);
        cache.remember("acme", Some(&big), None);
        assert_eq!(
            cache.predict("acme", &ctx("POST", &none), &body),
            Answer::plain_ok()
        );
        assert_eq!(cache.entries.lock().unwrap().bytes, 0);
    }
}
