//! What visitors take from each share, for the owner's dashboard and the
//! plan's monthly allowance of data.
//!
//! Every answer from the laptop is counted: one request and the bytes sent
//! to the visitor, a WebSocket's as they go. The edge's own
//! pages (the notice, a password page, "too many requests", "paused") are
//! shown in the owner's log but never counted, so hammering a preview costs
//! its owner nothing. The counts go to the web app in numbered batches with
//! every sync (control.rs); it applies each batch once, adds them to the
//! account's month and answers with the accounts past their plan's
//! allowance, whose previews show a page saying so until the month turns or
//! the plan changes (main.rs, front_door). A batch the web app did not
//! confirm is sent again as it was.
//!
//! One visitor can take [`VISITOR_DAILY`] a day from one share, so no
//! single visitor can use up an account's month.
//!
//! Each share also keeps its last [`RECENT`] requests for the
//! dashboard: what was asked, the answer, its size and time, the country and
//! kind of device, and a number for each visitor (1 for the first seen).
//! Visitors are told apart by a keyed hash of their address that changes
//! with every start of the edge; the address itself is not kept. All of it
//! lives in memory only and goes when the edge restarts. The logs of all
//! shares, ended ones included, hold [`LOGS_BYTES`] at most: past it, the
//! longest unused go.
//!
//! `whk tunnel --live` traffic (relay.rs) is not counted here: those
//! requests are captures, which count against the request quota instead.

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::BuildHasher;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::task::{Context, Poll};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http::{HeaderMap, Request, Response, header};
use hyper::body::{Body as HttpBody, Frame, SizeHint};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::Body;
use crate::door::Kind;

/// Requests kept for each share and site.
pub const RECENT: usize = 50;
/// Bytes one visitor may take from one share or site in a UTC day.
pub const VISITOR_DAILY: u64 = 250 * 1024 * 1024;
/// Shares and sites whose requests are kept before the longest unused go.
const LOGS_KEPT: usize = 5_000;
/// What their logs may hold in memory together, by [`Log::size`] (within
/// a few percent of what the process grows by). A share seen by a few
/// visitors keeps about 12 KiB, one seen by 2,000 (an IPv6 /48 is 65,536
/// visitor networks) about 270 KiB, so by count alone 5,000 could hold
/// 1.3 GiB. This keeps some 2,700 light ones or 120 of the heaviest, the
/// ones in use among them.
const LOGS_BYTES: usize = 32 * 1024 * 1024;
/// What one allocation costs beyond its bytes, give or take.
const ALLOCATION: usize = 16;
/// Visitors remembered for one share or site; past it the longest unseen go.
const VISITORS_KEPT: usize = 2_000;
const PATH_KEPT: usize = 300;
/// Batches kept for a web app that does not answer: two hours of syncs.
const UNSENT_KEPT: usize = 240;
/// WebSocket bytes are counted in steps of this, and when it closes.
const WEBSOCKET_STEP: u64 = 64 * 1024;
const DAY_MS: u64 = 86_400_000;

/// Whose a counted answer is: the share or site, and its account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub kind: Kind,
    pub id: String,
    pub user_id: String,
}

/// Counts for one share or site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub id: String,
    pub kind: &'static str,
    pub user_id: String,
    pub bytes: u64,
    pub requests: u64,
}

/// Counts handed to the web app under an id it applies once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Batch {
    pub id: String,
    pub usage: Vec<Usage>,
}

/// Marks an answer as the edge's own page rather than the laptop's: shown
/// in the owner's log under this word, never counted. [`INTERNAL`] answers
/// (the report button's script) are left out of the log too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnPage(pub &'static str);

pub const INTERNAL: &str = "internal";

/// Marks a response as one of the edge's own pages.
pub fn own_page(mut response: Response<Body>, what: &'static str) -> Response<Body> {
    response.extensions_mut().insert(OwnPage(what));
    response
}

/// One request as the owner sees it on the dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Seen {
    /// When it came in, in milliseconds since 1970.
    pub at: u64,
    pub method: String,
    pub path: String,
    pub status: u16,
    /// Until the answer started.
    pub ms: u64,
    pub bytes: u64,
    pub country: Option<String>,
    pub device: &'static str,
    /// 1 for the first visitor seen here, 2 for the next.
    pub visitor: u32,
    /// Which of the edge's own pages answered, if one did ("notice").
    pub edge: Option<&'static str>,
}

/// What is known of a request before it is answered.
pub struct Asked {
    at: u64,
    started: Instant,
    method: String,
    path: String,
    country: Option<String>,
    device: &'static str,
    /// The keyed hash of the visitor's address (main.rs, visitor_key).
    visitor: u64,
}

impl Asked {
    pub fn of<B>(meter: &Meter, req: &Request<B>, visitor_key: &str) -> Self {
        let headers = req.headers();
        Self {
            at: unix_ms(),
            started: Instant::now(),
            method: req.method().to_string(),
            path: req
                .uri()
                .path_and_query()
                .map(|p| p.as_str())
                .unwrap_or("/")
                .chars()
                .take(PATH_KEPT)
                .collect(),
            country: crate::header_str(headers, "cf-ipcountry")
                .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()))
                .map(str::to_ascii_uppercase),
            device: device_of(headers),
            visitor: meter.visitor_hash(visitor_key),
        }
    }
}

struct Visitor {
    number: u32,
    seen: Instant,
    /// The UTC day of `bytes_today`.
    day: u64,
    bytes_today: u64,
}

struct Log {
    seen: VecDeque<Seen>,
    /// The bytes the words in `seen` hold beyond the entries themselves.
    words: usize,
    visitors: HashMap<u64, Visitor>,
    /// Visitors numbered so far, the forgotten ones included.
    numbered: u32,
    /// Requests and bytes since the edge started, as the dashboard shows.
    requests: u64,
    bytes: u64,
    used: Instant,
}

/// The bytes a request's words hold on the heap.
fn words_of(seen: &Seen) -> usize {
    let word = |capacity: usize| {
        if capacity == 0 {
            0
        } else {
            capacity + ALLOCATION
        }
    };
    word(seen.method.capacity())
        + word(seen.path.capacity())
        + seen.country.as_ref().map_or(0, |c| word(c.capacity()))
}

impl Log {
    fn new() -> Self {
        Self {
            seen: VecDeque::with_capacity(RECENT),
            words: 0,
            visitors: HashMap::new(),
            numbered: 0,
            requests: 0,
            bytes: 0,
            used: Instant::now(),
        }
    }

    /// About what it holds in memory: itself, its requests and their
    /// words, and its table of visitors (a hash table keeps an eighth of
    /// its slots free and a byte beside each).
    fn size(&self) -> usize {
        let slots = if self.visitors.capacity() == 0 {
            0
        } else {
            (self.visitors.capacity() * 8 / 7).next_power_of_two()
        };
        std::mem::size_of::<Self>()
            + self.seen.capacity() * std::mem::size_of::<Seen>()
            + ALLOCATION
            + self.words
            + slots * (std::mem::size_of::<(u64, Visitor)>() + 1)
            + ALLOCATION
    }

    /// The visitor's entry, numbering a new one and forgetting the longest
    /// unseen when full.
    fn visitor(&mut self, key: u64) -> &mut Visitor {
        if !self.visitors.contains_key(&key) {
            if self.visitors.len() >= VISITORS_KEPT {
                let oldest = self
                    .visitors
                    .iter()
                    .min_by_key(|(_, v)| v.seen)
                    .map(|(k, _)| *k);
                if let Some(k) = oldest {
                    self.visitors.remove(&k);
                }
            }
            self.numbered += 1;
            self.visitors.insert(
                key,
                Visitor {
                    number: self.numbered,
                    seen: Instant::now(),
                    day: today(),
                    bytes_today: 0,
                },
            );
        }
        let visitor = self.visitors.get_mut(&key).unwrap();
        visitor.seen = Instant::now();
        if visitor.day != today() {
            visitor.day = today();
            visitor.bytes_today = 0;
        }
        visitor
    }
}

/// Every share's and site's log, and what they hold together.
#[derive(Default)]
struct Logs {
    map: HashMap<String, Log>,
    bytes: usize,
}

impl Logs {
    /// What a log and its key hold.
    fn size_of(id: &str, log: &Log) -> usize {
        log.size() + id.len() + ALLOCATION
    }

    /// Changes one log, keeping the count of what all hold: its new size
    /// less its old.
    fn change<T>(&mut self, id: &str, change: impl FnOnce(&mut Log) -> T) -> Option<T> {
        let log = self.map.get_mut(id)?;
        let before = log.size();
        let out = change(log);
        let after = log.size();
        self.bytes = (self.bytes + after).saturating_sub(before);
        Some(out)
    }

    /// The log of `id`, made if new, past the most kept the longest unused
    /// going first.
    fn open(&mut self, id: &str) {
        if self.map.contains_key(id) {
            return;
        }
        if self.map.len() >= LOGS_KEPT {
            let oldest = self
                .map
                .iter()
                .min_by_key(|(_, log)| log.used)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                self.remove(&id);
            }
        }
        let log = Log::new();
        self.bytes += Self::size_of(id, &log);
        self.map.insert(id.to_string(), log);
    }

    fn remove(&mut self, id: &str) {
        if let Some(log) = self.map.remove(id) {
            self.bytes = self.bytes.saturating_sub(Self::size_of(id, &log));
        }
    }

    /// Past `most` bytes, the longest unused logs go until they hold a
    /// tenth less, so this is seldom needed; `keep`'s stays.
    fn trim(&mut self, most: usize, keep: &str) {
        if self.bytes <= most {
            return;
        }
        let mut by_use: Vec<(Instant, String)> = self
            .map
            .iter()
            .filter(|(id, _)| id.as_str() != keep)
            .map(|(id, log)| (log.used, id.clone()))
            .collect();
        by_use.sort();
        for (_, id) in by_use {
            if self.bytes <= most / 10 * 9 {
                break;
            }
            self.remove(&id);
        }
    }
}

/// What the dashboard shows of a share or site: its last requests, its
/// visitors and what they took since the edge started.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Activity {
    pub requests: Vec<Seen>,
    pub visitors: u32,
    pub total: Totals,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Totals {
    pub requests: u64,
    pub bytes: u64,
}

pub struct Meter {
    pending: Mutex<HashMap<(Kind, String), Usage>>,
    unsent: Mutex<VecDeque<Batch>>,
    /// This start of the edge, for batch ids.
    boot: String,
    batches: AtomicU64,
    over: RwLock<HashSet<String>>,
    logs: Mutex<Logs>,
    /// What the logs may hold together: [`LOGS_BYTES`].
    logs_bytes: usize,
    /// Keyed afresh at every start, so a visitor's hash means nothing
    /// outside this process.
    hasher: RandomState,
}

impl Default for Meter {
    fn default() -> Self {
        let hasher = RandomState::new();
        Self {
            pending: Mutex::default(),
            unsent: Mutex::default(),
            boot: format!("{:016x}", hasher.hash_one(SystemTime::now())),
            batches: AtomicU64::new(0),
            over: RwLock::default(),
            logs: Mutex::default(),
            logs_bytes: LOGS_BYTES,
            hasher,
        }
    }
}

/// A lock that a panic elsewhere does not poison for every later visitor.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Meter {
    pub fn visitor_hash(&self, key: &str) -> u64 {
        self.hasher.hash_one(key)
    }

    /// Bytes sent outside an answer's body: a WebSocket's.
    pub fn add_bytes(&self, owner: &Owner, visitor: u64, bytes: u64) {
        if bytes == 0 {
            return;
        }
        self.tally(owner, bytes, 0);
        let mut logs = lock(&self.logs);
        logs.change(&owner.id, |log| {
            log.bytes += bytes;
            log.visitor(visitor).bytes_today += bytes;
        });
        logs.trim(self.logs_bytes, &owner.id);
    }

    /// Whether this visitor took their day's share from this share or site.
    pub fn visitor_spent(&self, id: &str, visitor_key: &str) -> bool {
        let key = self.visitor_hash(visitor_key);
        lock(&self.logs)
            .map
            .get(id)
            .and_then(|log| log.visitors.get(&key))
            .is_some_and(|v| v.day == today() && v.bytes_today >= VISITOR_DAILY)
    }

    /// One answered request: kept for the dashboard, and counted unless
    /// the edge's own page answered it.
    pub fn record(&self, owner: &Owner, asked: Asked, answer: Answer, bytes: u64) {
        if answer.edge.is_none() {
            self.tally(owner, bytes, 1);
        }
        let mut logs = lock(&self.logs);
        logs.open(&owner.id);
        let counted = if answer.edge.is_none() { bytes } else { 0 };
        let recorded = logs.change(&owner.id, |log| {
            log.used = Instant::now();
            let visitor = log.visitor(asked.visitor);
            visitor.bytes_today += counted;
            let number = visitor.number;
            if answer.edge.is_none() {
                log.requests += 1;
                log.bytes += bytes;
            }
            if log.seen.len() == RECENT
                && let Some(gone) = log.seen.pop_back()
            {
                log.words -= words_of(&gone);
            }
            number
        });
        let Some(number) = recorded else {
            return;
        };
        let seen = Seen {
            at: asked.at,
            method: asked.method,
            path: asked.path,
            status: answer.status,
            ms: answer.ms,
            bytes: counted,
            country: asked.country,
            device: asked.device,
            visitor: number,
            edge: answer.edge,
        };
        logs.change(&owner.id, |log| {
            log.words += words_of(&seen);
            log.seen.push_front(seen);
        });
        logs.trim(self.logs_bytes, &owner.id);
    }

    fn tally(&self, owner: &Owner, bytes: u64, requests: u64) {
        let mut pending = lock(&self.pending);
        let usage = pending
            .entry((owner.kind, owner.id.clone()))
            .or_insert_with(|| Usage {
                id: owner.id.clone(),
                kind: kind_name(owner.kind),
                user_id: owner.user_id.clone(),
                bytes: 0,
                requests: 0,
            });
        usage.bytes += bytes;
        usage.requests += requests;
    }

    /// Every batch the web app has not confirmed, oldest first, with the
    /// counts since the last sync as a new one.
    pub fn batches(&self) -> Vec<Batch> {
        let fresh: Vec<Usage> = lock(&self.pending).drain().map(|(_, u)| u).collect();
        let mut unsent = lock(&self.unsent);
        if !fresh.is_empty() {
            let n = self.batches.fetch_add(1, Ordering::Relaxed);
            unsent.push_back(Batch {
                id: format!("{}:{n}", self.boot),
                usage: fresh,
            });
        }
        while unsent.len() > UNSENT_KEPT {
            if let Some(dropped) = unsent.pop_front() {
                tracing::warn!(batch = %dropped.id, "counts dropped: the web app has not answered for hours");
            }
        }
        unsent.iter().cloned().collect()
    }

    /// The web app applied these batches; they are not sent again.
    pub fn confirmed(&self, ids: &[String]) {
        lock(&self.unsent).retain(|b| !ids.contains(&b.id));
    }

    /// The accounts past their allowance, as the web app last said.
    pub fn set_over(&self, user_ids: Vec<String>) {
        let next: HashSet<String> = user_ids.into_iter().collect();
        let mut over = self.over.write().unwrap_or_else(|e| e.into_inner());
        if *over != next {
            tracing::info!(accounts = next.len(), "accounts past their data allowance");
        }
        *over = next;
    }

    pub fn is_over(&self, user_id: &str) -> bool {
        self.over
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains(user_id)
    }

    /// A share's or site's last requests (newest first), its visitors and
    /// what they took, since the edge started.
    pub fn activity(&self, id: &str) -> Activity {
        lock(&self.logs)
            .map
            .get(id)
            .map(|log| Activity {
                requests: log.seen.iter().cloned().collect(),
                visitors: log.numbered,
                total: Totals {
                    requests: log.requests,
                    bytes: log.bytes,
                },
            })
            .unwrap_or_default()
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Share => "share",
    }
}

/// A rough kind of device from the User-Agent: enough to tell a client
/// opened the link on a phone, nothing more.
fn device_of(headers: &HeaderMap) -> &'static str {
    let Some(agent) = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .filter(|a| !a.trim().is_empty())
    else {
        return "unknown";
    };
    let has = |s: &str| agent.contains(s);
    if [
        "bot", "crawl", "spider", "curl/", "wget", "python", "headless", "preview",
    ]
    .iter()
    .any(|s| has(s))
    {
        "bot"
    } else if has("ipad") || has("tablet") || (has("android") && !has("mobile")) {
        "tablet"
    } else if has("mobi") || has("iphone") || has("android") {
        "phone"
    } else {
        "computer"
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn today() -> u64 {
    unix_ms() / DAY_MS
}

/// How a request was answered, known when the answer starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub ms: u64,
    pub edge: Option<&'static str>,
}

/// An answer's body, counted as it goes and recorded once it ends or the
/// visitor leaves.
pub struct Metered {
    inner: Body,
    meter: Arc<Meter>,
    owner: Owner,
    asked: Option<Asked>,
    answer: Answer,
    bytes: u64,
}

impl Metered {
    /// Counts and records the answer, unless it is the edge's internal one.
    pub fn wrap(
        meter: Arc<Meter>,
        owner: Owner,
        asked: Asked,
        response: Response<Body>,
    ) -> Response<Body> {
        let edge = response.extensions().get::<OwnPage>().map(|p| p.0);
        if edge == Some(INTERNAL) {
            return response;
        }
        let answer = Answer {
            status: response.status().as_u16(),
            ms: asked.started.elapsed().as_millis() as u64,
            edge,
        };
        response.map(|inner| {
            Body::new(Self {
                inner,
                meter,
                owner,
                asked: Some(asked),
                answer,
                bytes: 0,
            })
        })
    }
}

impl HttpBody for Metered {
    type Data = Bytes;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &polled
            && let Some(data) = frame.data_ref()
        {
            self.bytes += data.len() as u64;
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Metered {
    fn drop(&mut self) {
        if let Some(asked) = self.asked.take() {
            self.meter
                .record(&self.owner, asked, self.answer, self.bytes);
        }
    }
}

/// The visitor's side of a WebSocket, counting what it is sent as it goes,
/// so an open socket counts before it closes and one that ends in an error
/// counts all the same.
pub struct CountedSocket<T> {
    inner: T,
    meter: Arc<Meter>,
    owner: Owner,
    visitor: u64,
    unsent: u64,
}

impl<T> CountedSocket<T> {
    pub fn new(inner: T, meter: Arc<Meter>, owner: Owner, visitor: u64) -> Self {
        Self {
            inner,
            meter,
            owner,
            visitor,
            unsent: 0,
        }
    }

    fn count(&mut self) {
        let bytes = std::mem::take(&mut self.unsent);
        self.meter.add_bytes(&self.owner, self.visitor, bytes);
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for CountedSocket<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for CountedSocket<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = written {
            self.unsent += n as u64;
            if self.unsent >= WEBSOCKET_STEP {
                self.count();
            }
        }
        written
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl<T> Drop for CountedSocket<T> {
    fn drop(&mut self) {
        self.count();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tokio::io::AsyncWriteExt;

    fn owner(id: &str) -> Owner {
        Owner {
            kind: Kind::Share,
            id: id.into(),
            user_id: "user-1".into(),
        }
    }

    fn asked(meter: &Meter, path: &str, visitor: &str, agent: &str) -> Asked {
        let req = Request::get(path)
            .header(header::USER_AGENT, agent)
            .header("cf-ipcountry", "dk")
            .body(())
            .unwrap();
        Asked::of(meter, &req, visitor)
    }

    fn answered(status: u16) -> Answer {
        Answer {
            status,
            ms: 5,
            edge: None,
        }
    }

    const PHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148";
    const LAPTOP: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15";

    fn usage_of(batches: &[Batch]) -> Vec<Usage> {
        batches.iter().flat_map(|b| b.usage.clone()).collect()
    }

    #[test]
    fn requests_are_counted_and_handed_over_in_a_batch() {
        let m = Meter::default();
        m.record(
            &owner("s1"),
            asked(&m, "/", "203.0.113.7", LAPTOP),
            answered(200),
            1200,
        );
        m.record(
            &owner("s1"),
            asked(&m, "/a.css", "203.0.113.7", LAPTOP),
            answered(200),
            300,
        );
        m.add_bytes(&owner("s1"), m.visitor_hash("203.0.113.7"), 50);
        let batches = m.batches();
        assert_eq!(batches.len(), 1);
        assert_eq!(
            batches[0].usage,
            vec![Usage {
                id: "s1".into(),
                kind: "share",
                user_id: "user-1".into(),
                bytes: 1550,
                requests: 2,
            }]
        );
    }

    #[test]
    fn a_batch_is_sent_again_as_it_was_until_the_web_app_confirms_it() {
        let m = Meter::default();
        m.record(
            &owner("s1"),
            asked(&m, "/", "v", LAPTOP),
            answered(200),
            100,
        );
        let first = m.batches();
        // No answer: the same batch, the same id, and the new counts apart.
        m.record(&owner("s1"), asked(&m, "/", "v", LAPTOP), answered(200), 10);
        let again = m.batches();
        assert_eq!(again.len(), 2);
        assert_eq!(again[0], first[0]);
        assert_eq!(again[1].usage[0].bytes, 10);
        assert_ne!(again[0].id, again[1].id);
        m.confirmed(&[again[0].id.clone(), again[1].id.clone()]);
        assert!(m.batches().is_empty());
    }

    #[test]
    fn the_edges_own_pages_are_shown_but_never_counted() {
        let m = Meter::default();
        let notice = Answer {
            status: 200,
            ms: 1,
            edge: Some("notice"),
        };
        m.record(&owner("s1"), asked(&m, "/", "v", PHONE), notice, 3000);
        assert!(m.batches().is_empty());
        let activity = m.activity("s1");
        assert_eq!(activity.total, Totals::default());
        assert_eq!(activity.visitors, 1);
        assert_eq!(activity.requests[0].edge, Some("notice"));
        assert_eq!(activity.requests[0].bytes, 0);
    }

    #[test]
    fn the_report_buttons_script_is_left_out_of_the_log() {
        let m = Arc::new(Meter::default());
        let response = own_page(Response::new(crate::pages::full("js")), INTERNAL);
        let wrapped = Metered::wrap(
            m.clone(),
            owner("s1"),
            asked(&m, "/__whk/badge.js", "v", LAPTOP),
            response,
        );
        drop(wrapped);
        assert_eq!(m.activity("s1"), Activity::default());
    }

    #[test]
    fn the_dashboard_sees_the_newest_requests_with_numbered_visitors() {
        let m = Meter::default();
        m.record(
            &owner("s1"),
            asked(&m, "/", "203.0.113.7", PHONE),
            answered(200),
            10,
        );
        m.record(
            &owner("s1"),
            asked(&m, "/about", "198.51.100.2", LAPTOP),
            answered(404),
            20,
        );
        m.record(
            &owner("s1"),
            asked(&m, "/?q=1", "203.0.113.7", PHONE),
            answered(200),
            30,
        );
        let activity = m.activity("s1");
        let seen = &activity.requests;
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0].path, "/?q=1");
        assert_eq!(seen[0].visitor, 1);
        assert_eq!(seen[0].device, "phone");
        assert_eq!(seen[0].country.as_deref(), Some("DK"));
        assert_eq!(seen[1].visitor, 2);
        assert_eq!(seen[1].device, "computer");
        assert_eq!(seen[1].status, 404);
        assert_eq!(activity.visitors, 2);
        assert_eq!(
            activity.total,
            Totals {
                requests: 3,
                bytes: 60
            }
        );
        assert_eq!(m.activity("someone-else"), Activity::default());
    }

    #[test]
    fn visitors_are_kept_by_a_hash_that_differs_from_one_start_to_the_next() {
        let a = Meter::default();
        let b = Meter::default();
        assert_eq!(a.visitor_hash("203.0.113.7"), a.visitor_hash("203.0.113.7"));
        assert_ne!(a.visitor_hash("203.0.113.7"), b.visitor_hash("203.0.113.7"));
    }

    #[test]
    fn many_visitors_keep_getting_numbers_as_the_longest_unseen_are_forgotten() {
        let m = Meter::default();
        for i in 0..VISITORS_KEPT + 5 {
            m.record(
                &owner("s1"),
                asked(&m, "/", &format!("v{i}"), LAPTOP),
                answered(200),
                1,
            );
        }
        let activity = m.activity("s1");
        assert_eq!(activity.visitors as usize, VISITORS_KEPT + 5);
        assert_eq!(activity.requests[0].visitor as usize, VISITORS_KEPT + 5);
        assert!(lock(&m.logs).map["s1"].visitors.len() <= VISITORS_KEPT);
    }

    /// What the logs hold, counted afresh.
    fn held_by_logs(m: &Meter) -> usize {
        let logs = lock(&m.logs);
        logs.map
            .iter()
            .map(|(id, log)| Logs::size_of(id, log))
            .sum()
    }

    #[test]
    fn the_logs_count_what_they_hold_as_it_changes() {
        let m = Meter::default();
        for share in 0..5 {
            for i in 0..RECENT * 2 {
                m.record(
                    &owner(&format!("s{share}")),
                    asked(&m, &format!("/a/{i}?x=y"), &format!("v{i}"), LAPTOP),
                    answered(200),
                    10,
                );
            }
            m.add_bytes(&owner(&format!("s{share}")), m.visitor_hash("new"), 5);
        }
        let bytes = lock(&m.logs).bytes;
        assert_eq!(bytes, held_by_logs(&m));
        // A light share's log is some kilobytes, a heavy one's far more.
        let light = lock(&m.logs).bytes / 5;
        assert!((8_000..40_000).contains(&light), "{light}");
    }

    #[test]
    fn past_their_bytes_the_logs_longest_unused_go_first() {
        let m = Meter {
            logs_bytes: 256 * 1024,
            ..Meter::default()
        };
        // Shares seen by many visitors, one after the other.
        for share in 0..40 {
            for i in 0..200 {
                m.record(
                    &owner(&format!("s{share}")),
                    asked(&m, "/", &format!("{share}-{i}"), LAPTOP),
                    answered(200),
                    10,
                );
            }
        }
        let bytes = lock(&m.logs).bytes;
        assert!(bytes <= 256 * 1024, "{bytes}");
        assert_eq!(bytes, held_by_logs(&m));
        assert_eq!(m.activity("s0"), Activity::default(), "the oldest went");
        assert_eq!(m.activity("s39").total.requests, 200, "the newest stays");
        // Using the oldest left again keeps it over the next oldest.
        let oldest = (0..40)
            .find(|share| m.activity(&format!("s{share}")) != Activity::default())
            .unwrap();
        assert!(oldest > 20, "some 9 of these fit: {oldest}");
        let used = format!("s{oldest}");
        m.record(&owner(&used), asked(&m, "/", "x", LAPTOP), answered(200), 1);
        let next = format!("s{}", oldest + 1);
        for share in 40..50 {
            if m.activity(&next) == Activity::default() {
                break;
            }
            for i in 0..200 {
                m.record(
                    &owner(&format!("s{share}")),
                    asked(&m, "/", &format!("{share}-{i}"), LAPTOP),
                    answered(200),
                    10,
                );
            }
        }
        assert_eq!(m.activity(&next), Activity::default());
        assert_eq!(m.activity(&used).total.requests, 201);
    }

    #[test]
    fn one_visitor_cannot_take_more_than_a_days_share() {
        let m = Meter::default();
        assert!(!m.visitor_spent("s1", "203.0.113.7"));
        m.record(
            &owner("s1"),
            asked(&m, "/big.jpg", "203.0.113.7", LAPTOP),
            answered(200),
            VISITOR_DAILY - 1,
        );
        assert!(!m.visitor_spent("s1", "203.0.113.7"));
        m.record(
            &owner("s1"),
            asked(&m, "/big.jpg", "203.0.113.7", LAPTOP),
            answered(200),
            1,
        );
        assert!(m.visitor_spent("s1", "203.0.113.7"));
        assert!(
            !m.visitor_spent("s1", "198.51.100.2"),
            "others still get in"
        );
        assert!(!m.visitor_spent("s2", "203.0.113.7"), "and elsewhere too");
    }

    #[test]
    fn only_the_last_requests_are_kept() {
        let m = Meter::default();
        for i in 0..RECENT + 10 {
            m.record(
                &owner("s1"),
                asked(&m, &format!("/{i}"), "v", LAPTOP),
                answered(200),
                1,
            );
        }
        let activity = m.activity("s1");
        assert_eq!(activity.requests.len(), RECENT);
        assert_eq!(activity.total.requests, RECENT as u64 + 10);
        assert_eq!(activity.requests[0].path, format!("/{}", RECENT + 9));
    }

    #[tokio::test]
    async fn a_websocket_counts_as_it_goes_and_what_is_left_when_it_ends() {
        let m = Arc::new(Meter::default());
        m.record(
            &owner("s1"),
            asked(&m, "/ws", "v", LAPTOP),
            answered(101),
            0,
        );
        let (a, _b) = tokio::io::duplex(1 << 20);
        let mut socket = CountedSocket::new(a, m.clone(), owner("s1"), m.visitor_hash("v"));
        socket
            .write_all(&vec![0u8; WEBSOCKET_STEP as usize])
            .await
            .unwrap();
        assert_eq!(
            m.activity("s1").total.bytes,
            WEBSOCKET_STEP,
            "counted before it closes"
        );
        socket.write_all(&[0u8; 10]).await.unwrap();
        drop(socket);
        assert_eq!(m.activity("s1").total.bytes, WEBSOCKET_STEP + 10);
        assert_eq!(usage_of(&m.batches())[0].bytes, WEBSOCKET_STEP + 10);
    }

    #[test]
    fn devices_are_told_apart_roughly() {
        let of = |agent: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::USER_AGENT, agent.parse().unwrap());
            device_of(&headers)
        };
        assert_eq!(of(PHONE), "phone");
        assert_eq!(of(LAPTOP), "computer");
        assert_eq!(
            of("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"),
            "tablet"
        );
        assert_eq!(of("Mozilla/5.0 (Linux; Android 14; SM-X710)"), "tablet");
        assert_eq!(
            of("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile"),
            "phone"
        );
        assert_eq!(of("curl/8.5.0"), "bot");
        assert_eq!(of("Slackbot-LinkExpanding 1.0"), "bot");
        assert_eq!(device_of(&HeaderMap::new()), "unknown");
    }

    #[test]
    fn accounts_past_their_allowance_are_known_until_the_web_app_says_otherwise() {
        let m = Meter::default();
        m.set_over(vec!["user-1".into()]);
        assert!(m.is_over("user-1"));
        assert!(!m.is_over("user-2"));
        m.set_over(vec![]);
        assert!(!m.is_over("user-1"));
    }

    #[tokio::test]
    async fn a_body_is_counted_as_sent_and_recorded_when_it_ends() {
        let m = Arc::new(Meter::default());
        let response = Response::builder()
            .status(200)
            .body(crate::pages::full("hello, visitor"))
            .unwrap();
        let wrapped = Metered::wrap(
            m.clone(),
            owner("s1"),
            asked(&m, "/", "v", LAPTOP),
            response,
        );
        let body = wrapped.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"hello, visitor");
        assert_eq!(m.activity("s1").requests[0].bytes, 14);
        assert_eq!(usage_of(&m.batches())[0].bytes, 14);
    }

    #[tokio::test]
    async fn a_visitor_who_leaves_early_is_counted_for_what_was_sent() {
        let m = Arc::new(Meter::default());
        let response = Response::new(crate::pages::full("never read"));
        let wrapped = Metered::wrap(
            m.clone(),
            owner("s1"),
            asked(&m, "/", "v", LAPTOP),
            response,
        );
        drop(wrapped);
        assert_eq!(m.activity("s1").requests[0].bytes, 0);
        assert_eq!(usage_of(&m.batches())[0].requests, 1);
    }
}
