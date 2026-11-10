//! The box's line to visitors, all told, shared fairly between accounts.
//!
//! Pacing (pace.rs) keeps each share or site and each account to a rate of
//! its own, but nothing kept the box to its line: 500 Mbit/s, about 60
//! MiB/s, and seven accounts at their 8 MiB/s fill it. Behind a full line
//! everything waits in the router's queue, the pages of every other share
//! and the web app's too: with nine heavy accounts a light share's page load
//! (1.3 MiB) took 1.4 s instead of 10 ms (a load test with
//! LINE_MIB).
//!
//! So what the edge sends visitors (shares and their WebSockets) also
//! passes one bucket for the whole box ([`Rates`]: 40 MiB/s after 32 MiB
//! by default). While it has room, bytes go at once.
//! When it is empty, the chunks waiting are let go by account, fairly
//! (start-time fair queueing): each account's next chunk starts where its
//! last one ended, so every account busy at once gets the same share of
//! the line however many answers it has waiting, and one that wants less
//! than its share gets all it wants, what it leaves going to the others.
//! An account whose one answer has one chunk waiting at a time keeps its
//! place too, which taking turns (round robin) would not give it.
//!
//! Besides, an account that has been quiet goes first: chunks within its
//! allowance ([`QUIET_BURST`], refilled at [`QUIET_PER_SECOND`]), a page
//! load or two, go before the busy accounts', fairly between the quiet
//! ones in the same way. Every chunk spends from the allowance, so a busy
//! account never has a chunk's worth and never goes first, and a few heavy
//! accounts cannot make a light one's page wait behind them. Heavy
//! accounts that have just begun have their allowance too, so for a
//! moment they and a light one share the line as equals.
//!
//! As with pacing, a chunk waits before it is sent, and the answer is not
//! asked for its next one meanwhile: what waits here is who and how much,
//! never the bytes, which stay in their answer, one chunk each.
//!
//! [`Rates`]: crate::pace::Rates

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, Once, Weak};
use std::time::Duration;

use tokio::sync::{Notify, oneshot};
use tokio::time::Instant;

use crate::held::Account;
use crate::pace::Rate;

const MIB: f64 = 1024.0 * 1024.0;
/// A quiet account's allowance, which it may send before the busy ones:
/// a dev server's cold page load or two (often 2 to 10 MB). Refilled at
/// a quarter of an account's pace: every chunk spends from it, so an
/// account sending faster than this never has a chunk's worth, and never
/// goes first.
const QUIET_BURST: f64 = 8.0 * MIB;
const QUIET_PER_SECOND: f64 = 2.0 * MIB;
/// Accounts remembered before those that make no difference are let go:
/// a full allowance, or a place in the queue no later than the line's.
const KEPT: usize = 10_000;
/// The shortest wait for the line to refill: tokio's timer is no finer.
const TICK: Duration = Duration::from_millis(1);

/// Whether a chunk may go now, or once it is let go.
#[derive(Debug)]
pub enum Turn {
    Go,
    /// Ready when the line lets it go; an error if the line is gone.
    Wait(oneshot::Receiver<()>),
}

/// The line, for every answer the edge sends visitors.
#[derive(Debug)]
pub struct Line {
    rate: Rate,
    /// Each account's quiet allowance.
    quiet: Rate,
    state: Mutex<State>,
    /// Wakes the dispatcher when a chunk starts to wait.
    work: Arc<Notify>,
    dispatching: Once,
}

#[derive(Debug)]
struct State {
    /// Bytes the line may send now; below nothing, its debt, which must
    /// be paid before the next chunk goes.
    tokens: f64,
    at: Instant,
    /// Chunks within their account's quiet allowance, which go first.
    quiet: Fair,
    /// The others.
    busy: Fair,
    allowances: HashMap<Account, Allowance>,
    /// Chunks waiting, all told.
    waiting: usize,
}

/// Chunks waiting, let go fairly between accounts: the one that starts
/// first goes first.
#[derive(Debug, Default)]
struct Fair {
    queue: BinaryHeap<Queued>,
    /// Where each account's next chunk starts, at the earliest: where its
    /// last one ended, in bytes of the queue's own count.
    ends: HashMap<Account, f64>,
    /// Where the chunk let go last started: the queue's own count.
    virtual_at: f64,
    /// Ties go to whoever came first.
    next: u64,
}

impl Fair {
    /// Puts an account's chunk in the queue, starting where its last one
    /// ended, or where the queue is if that is later.
    fn push(&mut self, account: &Account, waiter: Waiter) {
        if self.ends.len() >= KEPT && !self.ends.contains_key(account) {
            let at = self.virtual_at;
            self.ends.retain(|_, end| *end > at);
        }
        let end = self.ends.entry(account.clone()).or_insert(0.0);
        let start = end.max(self.virtual_at);
        *end = start + waiter.bytes;
        self.next += 1;
        self.queue.push(Queued {
            start,
            order: self.next,
            waiter,
        });
    }

    /// The chunk that starts first. One whose answer went away moves the
    /// count on for nobody.
    fn pop(&mut self) -> Option<Waiter> {
        let first = self.queue.pop()?;
        if !first.waiter.go.is_closed() {
            self.virtual_at = first.start;
        }
        Some(first.waiter)
    }

    /// Nothing waits: the count starts again, and with it every account's.
    fn restart(&mut self) {
        self.virtual_at = 0.0;
        self.ends.clear();
    }
}

#[derive(Debug)]
struct Waiter {
    bytes: f64,
    go: oneshot::Sender<()>,
}

#[derive(Debug)]
struct Queued {
    start: f64,
    order: u64,
    waiter: Waiter,
}

impl Queued {
    fn key(&self) -> (f64, u64) {
        (self.start, self.order)
    }
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Queued {}

impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Queued {
    /// The heap keeps the greatest on top: the earliest start is greatest.
    fn cmp(&self, other: &Self) -> Ordering {
        let (start, order) = self.key();
        let (other_start, other_order) = other.key();
        other_start.total_cmp(&start).then(other_order.cmp(&order))
    }
}

#[derive(Debug)]
struct Allowance {
    bytes: f64,
    at: Instant,
}

impl Allowance {
    fn refill(&mut self, quiet: &Rate, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.bytes = (self.bytes + elapsed * quiet.per_second).min(quiet.burst);
        self.at = now;
    }
}

impl State {
    fn refill(&mut self, rate: &Rate, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate.per_second).min(rate.burst);
        self.at = now;
    }

    /// Spends `bytes` of the account's quiet allowance: whether they were
    /// all within it.
    fn spend_allowance(
        &mut self,
        quiet: &Rate,
        account: &Account,
        bytes: f64,
        now: Instant,
    ) -> bool {
        if self.allowances.len() >= KEPT && !self.allowances.contains_key(account) {
            self.allowances.retain(|_, a| {
                a.refill(quiet, now);
                a.bytes < quiet.burst
            });
        }
        let allowance = self.allowances.entry(account.clone()).or_insert(Allowance {
            bytes: quiet.burst,
            at: now,
        });
        allowance.refill(quiet, now);
        let quiet = allowance.bytes >= bytes;
        allowance.bytes = (allowance.bytes - bytes).max(0.0);
        quiet
    }

    /// Lets one chunk go, paying for it unless its answer went away.
    fn let_go(&mut self, waiter: Waiter) {
        self.waiting -= 1;
        if waiter.go.send(()).is_ok() {
            self.tokens -= waiter.bytes;
        }
    }
}

impl Line {
    /// A line with this rate, or none when the rate is off.
    pub fn new(rate: Rate) -> Option<Arc<Self>> {
        Self::with_quiet(
            rate,
            Rate {
                per_second: QUIET_PER_SECOND,
                burst: QUIET_BURST,
            },
        )
    }

    /// The same, with each account's quiet allowance at `quiet`.
    pub(crate) fn with_quiet(rate: Rate, quiet: Rate) -> Option<Arc<Self>> {
        (!rate.is_off()).then(|| {
            Arc::new(Self {
                rate,
                quiet,
                state: Mutex::new(State {
                    tokens: rate.burst,
                    at: Instant::now(),
                    quiet: Fair::default(),
                    busy: Fair::default(),
                    allowances: HashMap::new(),
                    waiting: 0,
                }),
                work: Arc::default(),
                dispatching: Once::new(),
            })
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `bytes` of the account's are ready to go to a visitor: now, or
    /// once the line lets them.
    pub fn take(self: &Arc<Self>, account: &Account, bytes: usize, now: Instant) -> Turn {
        let bytes = bytes as f64;
        let mut state = self.state();
        state.refill(&self.rate, now);
        let quiet = state.spend_allowance(&self.quiet, account, bytes, now);
        // As with pacing, a chunk goes once the line's debt is paid, and
        // takes it into debt if need be.
        if state.waiting == 0 && state.tokens >= 0.0 {
            state.tokens -= bytes;
            return Turn::Go;
        }
        let (go, wait) = oneshot::channel();
        let waiter = Waiter { bytes, go };
        if quiet {
            state.quiet.push(account, waiter);
        } else {
            state.busy.push(account, waiter);
        }
        state.waiting += 1;
        drop(state);
        self.dispatching.call_once(|| {
            tokio::spawn(dispatch(Arc::downgrade(self), self.work.clone()));
        });
        self.work.notify_one();
        Turn::Wait(wait)
    }

    /// Lets waiting chunks go while the line's debt is paid: quiet
    /// accounts' first, then the one that starts first. How long until it
    /// may let the next go, or none when nothing waits.
    fn grant(&self, now: Instant) -> Option<Duration> {
        let mut state = self.state();
        state.refill(&self.rate, now);
        loop {
            if state.waiting == 0 {
                state.quiet.restart();
                state.busy.restart();
                return None;
            }
            if state.tokens < 0.0 {
                let debt = Duration::from_secs_f64(-state.tokens / self.rate.per_second);
                return Some(debt.max(TICK));
            }
            let Some(waiter) = state.quiet.pop().or_else(|| state.busy.pop()) else {
                // Nothing in either queue: the count was off.
                state.waiting = 0;
                continue;
            };
            state.let_go(waiter);
        }
    }
}

/// Lets chunks go as the line refills, for as long as the line is there.
async fn dispatch(line: Weak<Line>, work: Arc<Notify>) {
    loop {
        let next = match line.upgrade() {
            Some(line) => line.grant(Instant::now()),
            None => return,
        };
        match next {
            Some(wait) => tokio::time::sleep(wait).await,
            None => {
                let idle = tokio::time::timeout(Duration::from_secs(60), work.notified()).await;
                if idle.is_err() && line.strong_count() == 0 {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KIB: usize = 1024;

    /// A line, with quiet allowances in proportion as in production: a
    /// twentieth of the line, refilled; a second of the line at most.
    fn line(per_second: usize, burst: usize) -> Arc<Line> {
        Line::with_quiet(
            Rate {
                per_second: per_second as f64,
                burst: burst as f64,
            },
            Rate {
                per_second: per_second as f64 / 20.0,
                burst: per_second as f64,
            },
        )
        .unwrap()
    }

    fn account(id: &str) -> Account {
        Arc::from(id)
    }

    /// Sends chunks of `size` one after another, each when the line lets
    /// it, counting what went, until `until`.
    async fn send(
        line: Arc<Line>,
        account: Account,
        size: usize,
        sent: Arc<AtomicUsize>,
        until: Instant,
    ) {
        while Instant::now() < until {
            if let Turn::Wait(turn) = line.take(&account, size, Instant::now()) {
                turn.await.unwrap();
            }
            sent.fetch_add(size, Ordering::SeqCst);
        }
    }

    /// Spends an account's quiet allowance, so its chunks wait their turn.
    fn busy(line: &Line, account: &Account) {
        line.state()
            .spend_allowance(&line.quiet, account, line.quiet.burst, Instant::now());
    }

    #[tokio::test(start_paused = true)]
    async fn while_the_line_has_room_chunks_go_at_once() {
        let line = line(100 * KIB, 300 * KIB);
        let a = account("a");
        // Its 300 KiB, then one more into debt; the next waits for it.
        for _ in 0..4 {
            assert!(matches!(line.take(&a, 100 * KIB, Instant::now()), Turn::Go));
        }
        assert!(matches!(
            line.take(&a, 100 * KIB, Instant::now()),
            Turn::Wait(_)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_line_lets_bytes_go_at_its_rate() {
        let line = line(100 * KIB, 0);
        let a = account("a");
        busy(&line, &a);
        let sent = Arc::new(AtomicUsize::new(0));
        let started = Instant::now();
        send(
            line,
            a,
            10 * KIB,
            sent.clone(),
            started + Duration::from_secs(5),
        )
        .await;
        let rate = sent.load(Ordering::SeqCst) as f64 / started.elapsed().as_secs_f64();
        assert!((95.0..106.0).contains(&(rate / KIB as f64)), "{rate}");
    }

    #[tokio::test(start_paused = true)]
    async fn busy_accounts_share_the_line_equally_however_many_answers_each_has() {
        let line = line(1000 * KIB, 0);
        let (a, b) = (account("a"), account("b"));
        busy(&line, &a);
        busy(&line, &b);
        let until = Instant::now() + Duration::from_secs(10);
        let (sent_a, sent_b) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let mut all = Vec::new();
        // A has eight answers going at once, B one, a chunk at a time.
        for _ in 0..8 {
            all.push(tokio::spawn(send(
                line.clone(),
                a.clone(),
                16 * KIB,
                sent_a.clone(),
                until,
            )));
        }
        all.push(tokio::spawn(send(
            line.clone(),
            b.clone(),
            16 * KIB,
            sent_b.clone(),
            until,
        )));
        futures::future::join_all(all).await;
        let (a, b) = (sent_a.load(Ordering::SeqCst), sent_b.load(Ordering::SeqCst));
        let total = (a + b) as f64 / 10.0 / KIB as f64;
        assert!(
            (950.0..1060.0).contains(&total),
            "the line is full: {total}"
        );
        let ratio = a as f64 / b as f64;
        assert!((0.9..1.1).contains(&ratio), "half each: {a} and {b}");
    }

    #[tokio::test(start_paused = true)]
    async fn an_account_wanting_less_than_its_share_gets_all_it_wants_and_the_rest_goes_to_others()
    {
        let line = line(1000 * KIB, 0);
        let (heavy, light) = (account("heavy"), account("light"));
        busy(&line, &heavy);
        busy(&line, &light);
        let until = Instant::now() + Duration::from_secs(10);
        let sent_heavy = Arc::new(AtomicUsize::new(0));
        let mut all: Vec<_> = (0..4)
            .map(|_| {
                tokio::spawn(send(
                    line.clone(),
                    heavy.clone(),
                    16 * KIB,
                    sent_heavy.clone(),
                    until,
                ))
            })
            .collect();
        // The light one wants 100 KiB a second, a tenth of the line.
        let light_line = line.clone();
        let sent_light = Arc::new(AtomicUsize::new(0));
        let counting = sent_light.clone();
        all.push(tokio::spawn(async move {
            while Instant::now() < until {
                let at = Instant::now();
                if let Turn::Wait(turn) = light_line.take(&light, 10 * KIB, at) {
                    turn.await.unwrap();
                }
                counting.fetch_add(10 * KIB, Ordering::SeqCst);
                tokio::time::sleep_until(at + Duration::from_millis(100)).await;
            }
        }));
        futures::future::join_all(all).await;
        let light = sent_light.load(Ordering::SeqCst) / 10 / KIB;
        let heavy = sent_heavy.load(Ordering::SeqCst) / 10 / KIB;
        assert!((95..=105).contains(&light), "{light} KiB/s");
        assert!((850..=920).contains(&heavy), "the rest: {heavy} KiB/s");
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_account_goes_before_the_busy_ones() {
        let line = line(1000 * KIB, 0);
        let until = Instant::now() + Duration::from_secs(20);
        let sent = Arc::new(AtomicUsize::new(0));
        let mut busy_ones = Vec::new();
        for id in [
            "one", "two", "three", "four", "five", "six", "seven", "eight",
        ] {
            let id = account(id);
            busy(&line, &id);
            for _ in 0..4 {
                busy_ones.push(tokio::spawn(send(
                    line.clone(),
                    id.clone(),
                    64 * KIB,
                    sent.clone(),
                    until,
                )));
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        // A page load within its allowance: 960 KiB in 64 KiB chunks, all
        // asked at once. At a ninth of the line it would take 9 s; first,
        // about one.
        let quiet = account("quiet");
        let started = Instant::now();
        let page = (0..15).map(|_| {
            let line = line.clone();
            let quiet = quiet.clone();
            tokio::spawn(async move {
                if let Turn::Wait(turn) = line.take(&quiet, 64 * KIB, Instant::now()) {
                    turn.await.unwrap();
                }
            })
        });
        futures::future::join_all(page).await;
        let took = started.elapsed();
        assert!(took < Duration::from_millis(1200), "{took:?}");
        for task in busy_ones {
            task.abort();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_account_has_its_allowance_once_and_then_what_refills() {
        let line = Line::new(Rate::mib(40.0, 4.0)).unwrap();
        let a = account("a");
        let now = Instant::now();
        let mut state = line.state();
        let quiet = line.quiet;
        assert!(state.spend_allowance(&quiet, &a, 4.0 * MIB, now));
        assert!(state.spend_allowance(&quiet, &a, 4.0 * MIB, now));
        assert!(!state.spend_allowance(&quiet, &a, 64.0 * 1024.0, now));
        // Half a second later, 1 MiB more.
        let later = now + Duration::from_millis(500);
        assert!(state.spend_allowance(&quiet, &a, MIB, later));
        assert!(!state.spend_allowance(&quiet, &a, 1.0, later));
        // Sending faster than it refills, it never has a chunk's worth.
        let mut at = later;
        for _ in 0..100 {
            at += Duration::from_millis(10);
            assert!(!state.spend_allowance(&quiet, &a, 64.0 * 1024.0, at));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_that_went_away_while_it_waited_costs_the_line_nothing() {
        let line = line(100 * KIB, 0);
        let (a, b) = (account("a"), account("b"));
        busy(&line, &a);
        busy(&line, &b);
        // A's first chunk goes, a tenth of a second into debt.
        assert!(matches!(line.take(&a, 10 * KIB, Instant::now()), Turn::Go));
        let Turn::Wait(second) = line.take(&a, 100 * KIB, Instant::now()) else {
            panic!("the line is in debt");
        };
        // A's visitor leaves before its turn.
        drop(second);
        let started = Instant::now();
        let Turn::Wait(theirs) = line.take(&b, 10 * KIB, Instant::now()) else {
            panic!("the line is in debt");
        };
        theirs.await.unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "B did not pay for A: {:?}",
            started.elapsed()
        );
        assert_eq!(line.state().waiting, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn once_nothing_waits_the_count_starts_again() {
        let line = line(100 * KIB, 0);
        let a = account("a");
        busy(&line, &a);
        let sent = Arc::new(AtomicUsize::new(0));
        let until = Instant::now() + Duration::from_secs(1);
        send(line.clone(), a, 10 * KIB, sent, until).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        let state = line.state();
        assert_eq!(state.waiting, 0);
        assert!(state.busy.ends.is_empty());
        assert_eq!(state.busy.virtual_at, 0.0);
    }

    #[tokio::test(start_paused = true)]
    async fn quiet_accounts_too_go_fairly_between_them() {
        let line = line(1000 * KIB, 0);
        let (many, one) = (account("many"), account("one"));
        // Both quiet. MANY asks for 600 KiB in a heap of chunks, then ONE
        // for 100 KiB: ONE goes at half the line, not after all of MANY's.
        let mut theirs = Vec::new();
        for _ in 0..60 {
            if let Turn::Wait(turn) = line.take(&many, 10 * KIB, Instant::now()) {
                theirs.push(turn);
            }
        }
        let started = Instant::now();
        let mine: Vec<_> = (0..10)
            .filter_map(|_| match line.take(&one, 10 * KIB, Instant::now()) {
                Turn::Wait(turn) => Some(turn),
                Turn::Go => None,
            })
            .collect();
        futures::future::join_all(mine).await;
        let took = started.elapsed();
        assert!(
            (Duration::from_millis(180)..Duration::from_millis(260)).contains(&took),
            "{took:?}"
        );
        futures::future::join_all(theirs).await;
    }

    #[test]
    fn no_rate_is_no_line() {
        assert!(Line::new(Rate::mib(0.0, 4.0)).is_none());
    }
}
