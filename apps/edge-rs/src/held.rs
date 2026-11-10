//! What the edge holds for visitors who fall behind, all told, and how it
//! is shared between accounts.
//!
//! An answer from a laptop the visitor is not taking as fast as it comes
//! piles up in the edge: the tunnel stream's window (256 KiB, which yamux
//! never goes below), hyper's buffers on both sides and the socket's,
//! about 0.65 MiB with the allocator's share (a load test). The
//! same goes for an answer waiting for its share's pace or for the line
//! (pace.rs, line.rs). Each account may have 256 streams in flight
//! (limits.rs), but four accounts' slow readers together took the edge
//! past its 512 MB.
//!
//! So the edge counts the answers held up, wherever they are from, and
//! keeps them to [`HELD_UP_MAX`] (or `HELD_UP_MAX` in the environment). An
//! answer is held up once its visitor's socket has taken nothing for
//! [`GRACE`] (a fast visitor's socket fills for moments only) or its pace
//! makes it wait; it stays counted while it keeps falling behind, and lets
//! its place go once it has kept up for [`KEEP`]. Answers that keep up
//! are never counted, so the cap bounds the slow ones and nothing else.
//!
//! The places are shared between accounts. While there is room, any
//! answer takes one. Once all are taken, an answer of an account holding
//! fewer than its share (the places divided among the accounts holding
//! any) still gets one: the account holding the most lets its newest go,
//! and that answer is cut off at once. An answer of an account at its
//! share or past it is cut off itself. So two accounts whose visitors (or
//! attackers) read slowly no longer take every place and get the slow
//! visitors of every other share cut off. Answers waiting at their pace
//! or for the line count against their own account's share like its slow
//! visitors: they hold the same memory, and it is that account's own
//! traffic that makes them wait.
//!
//! Besides, a visitor's connection that takes no byte for [`STALL`] is
//! closed: it holds its share's stream, the counts and buffers for
//! nothing. Tunnels are never counted or closed here.
//!
//! A connection cut off for either is reset rather than closed: closed,
//! the kernel would keep sending what its buffer holds (up to 128 KiB) for
//! as long as the slow visitor takes to read it, and the container's
//! memory counts that too.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use futures::task::AtomicWaker;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, Sleep};

/// Answers held up at once, by default: at about 0.65 MiB each, some
/// 250 MiB of the edge's 512, beside what shares and the dashboard's logs
/// take. More than one account's 256 streams,
/// so one account alone never meets it.
pub const HELD_UP_MAX: usize = 384;
/// How long a visitor's socket may take nothing before the answer counts
/// as held up.
pub const GRACE: Duration = Duration::from_millis(250);
/// How long an answer must keep up before it lets its place go.
pub const KEEP: Duration = Duration::from_secs(2);
/// How long a visitor's connection may take nothing before it is closed.
pub const STALL: Duration = Duration::from_secs(60);
/// Places told to go and not gone yet, at most; past it a newcomer is cut
/// off itself. Each goes within moments (it is woken), so this only
/// bounds how far past the cap a burst of newcomers takes the count.
const CUTTING_MAX: usize = 32;

/// Whose an answer is, for sharing the places: its account's id, or
/// nothing for the edge's own pages.
pub type Account = Arc<str>;

/// The account the edge's own pages count to.
pub fn edge_own() -> Account {
    static EDGE_OWN: OnceLock<Account> = OnceLock::new();
    EDGE_OWN.get_or_init(|| Arc::from("")).clone()
}

/// The answers held up, and what was cut off for it.
#[derive(Debug)]
pub struct Held {
    max: usize,
    places: Mutex<Places>,
    cut: AtomicU64,
    made_room: AtomicU64,
    stalled: AtomicU64,
}

#[derive(Debug, Default)]
struct Places {
    /// Places taken, those told to go included.
    count: usize,
    /// Places told to go, not gone yet.
    cutting: usize,
    next: u64,
    accounts: HashMap<Account, Holding>,
}

/// One account's places, by when they were taken.
#[derive(Debug, Default)]
struct Holding {
    places: BTreeMap<u64, Arc<Mark>>,
    cutting: usize,
}

impl Holding {
    /// The places it keeps: all but those told to go.
    fn kept(&self) -> usize {
        self.places.len() - self.cutting
    }
}

/// What the one holding a place watches: whether it was told to go.
#[derive(Debug, Default)]
struct Mark {
    cut: AtomicBool,
    waker: AtomicWaker,
}

impl Mark {
    fn cut(&self) {
        self.cut.store(true, Ordering::SeqCst);
        self.waker.wake();
    }

    fn is_cut(&self) -> bool {
        self.cut.load(Ordering::SeqCst)
    }
}

/// One answer's place among those held up, given back when dropped.
#[derive(Debug)]
pub struct Slot {
    held: Arc<Held>,
    account: Account,
    id: u64,
    mark: Arc<Mark>,
}

impl Slot {
    /// Whether it was told to go, to make room for another account's
    /// answer: the answer holding it is then cut off.
    pub fn is_cut(&self) -> bool {
        self.mark.is_cut()
    }

    /// Wakes `waker` when the place is told to go.
    pub fn watch(&self, waker: &Waker) {
        self.mark.waker.register(waker);
    }
}

/// What was cut off since last asked.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Taken {
    /// Answers cut off: no place left for them, or theirs given to
    /// another account's.
    pub cut: u64,
    /// Of them, those whose place went to another account's answer.
    pub made_room: u64,
    /// Connections closed for taking nothing for [`STALL`].
    pub stalled: u64,
}

impl Held {
    pub fn new(max: usize) -> Arc<Self> {
        Arc::new(Self::with_most(max))
    }

    fn with_most(max: usize) -> Self {
        Self {
            max,
            places: Mutex::default(),
            cut: AtomicU64::new(0),
            made_room: AtomicU64::new(0),
            stalled: AtomicU64::new(0),
        }
    }

    fn places(&self) -> std::sync::MutexGuard<'_, Places> {
        self.places.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A place for one more answer of `account` held up: while there is
    /// room, or when the account holds fewer than its share. None when it
    /// must be cut off.
    pub fn take(self: &Arc<Self>, account: &Account) -> Option<Slot> {
        let mut places = self.places();
        if places.count - places.cutting >= self.max && !self.make_room(&mut places, account) {
            self.cut.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        places.count += 1;
        places.next += 1;
        let id = places.next;
        let mark = Arc::new(Mark::default());
        places
            .accounts
            .entry(account.clone())
            .or_default()
            .places
            .insert(id, mark.clone());
        Some(Slot {
            held: self.clone(),
            account: account.clone(),
            id,
            mark,
        })
    }

    /// Every place is kept: whether `account` holds fewer than its share,
    /// and the account holding the most was told to let its newest go.
    fn make_room(&self, places: &mut Places, account: &Account) -> bool {
        if places.cutting >= CUTTING_MAX {
            return false;
        }
        let mine = places.accounts.get(account).map_or(0, Holding::kept);
        let holders = places.accounts.len() + usize::from(!places.accounts.contains_key(account));
        let share = (self.max / holders.max(1)).max(1);
        if mine >= share {
            return false;
        }
        let Some(most) = places
            .accounts
            .iter_mut()
            .filter(|(a, _)| *a != account)
            .map(|(_, holding)| holding)
            .max_by_key(|holding| holding.kept())
        else {
            return false;
        };
        if most.kept() <= mine + 1 {
            return false;
        }
        let Some(newest) = most.places.values().rev().find(|m| !m.is_cut()).cloned() else {
            return false;
        };
        newest.cut();
        most.cutting += 1;
        places.cutting += 1;
        self.cut.fetch_add(1, Ordering::Relaxed);
        self.made_room.fetch_add(1, Ordering::Relaxed);
        true
    }

    pub fn count(&self) -> usize {
        self.places().count
    }

    /// The account holding the most places, and how many, for the log.
    pub fn most(&self) -> Option<(String, usize)> {
        self.places()
            .accounts
            .iter()
            .map(|(account, holding)| (account.to_string(), holding.places.len()))
            .max_by_key(|(_, n)| *n)
    }

    /// What was cut off since last asked: said once a sync (control.rs),
    /// not once each.
    pub fn taken_stats(&self) -> Taken {
        Taken {
            cut: self.cut.swap(0, Ordering::Relaxed),
            made_room: self.made_room.swap(0, Ordering::Relaxed),
            stalled: self.stalled.swap(0, Ordering::Relaxed),
        }
    }
}

impl Default for Held {
    fn default() -> Self {
        Self::with_most(HELD_UP_MAX)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut places = self.held.places();
        let cut = self.mark.is_cut();
        places.count -= 1;
        if cut {
            places.cutting -= 1;
        }
        if let Some(holding) = places.accounts.get_mut(&self.account) {
            holding.places.remove(&self.id);
            if cut {
                holding.cutting -= 1;
            }
            if holding.places.is_empty() {
                places.accounts.remove(&self.account);
            }
        }
    }
}

pub fn cut_off() -> io::Error {
    io::Error::other("too many answers held up for visitors who fell behind")
}

/// Whether an answer waiting for its pace or the line is held up
/// (pace.rs).
#[derive(Debug, Default)]
pub struct Behind {
    slot: Option<Slot>,
    /// When it last waited.
    waited: Option<Instant>,
}

impl Behind {
    /// The answer waits: it takes a place for its account if it has none.
    /// False when there is none to take, and it must be cut off.
    pub fn waits(&mut self, held: &Arc<Held>, account: &Account, now: Instant) -> bool {
        self.waited = Some(now);
        if self.slot.is_none() {
            self.slot = held.take(account);
        }
        self.slot.is_some()
    }

    /// It went on without waiting; after [`KEEP`] of that, its place goes.
    pub fn keeps_up(&mut self, now: Instant) {
        if self
            .waited
            .is_some_and(|at| now.saturating_duration_since(at) >= KEEP)
        {
            self.slot = None;
        }
    }

    /// Whether its place went to another account's answer: it is to be
    /// cut off.
    pub fn is_cut(&self) -> bool {
        self.slot.as_ref().is_some_and(Slot::is_cut)
    }

    /// Wakes `waker` if its place is told to go while it waits.
    pub fn watch(&self, waker: &Waker) {
        if let Some(slot) = &self.slot {
            slot.watch(waker);
        }
    }

    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.slot.is_some()
    }
}

/// One accepted connection, as its requests show it: one that has served
/// a visitor is watched; a tunnel never is.
#[derive(Debug, Default)]
pub struct Conn {
    visitor: AtomicBool,
    cut: AtomicBool,
    /// The account whose answer it is sending (main.rs, front_door): its
    /// place, if it falls behind, counts to that account.
    account: Mutex<Option<Account>>,
}

impl Conn {
    /// It serves a visitor's request, the edge's own page until the front
    /// door says whose (`serves`).
    pub fn serves_visitors(&self) {
        self.visitor.store(true, Ordering::Relaxed);
        *self.account.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The request is answered by this account's share or site.
    pub fn serves(&self, account: &Account) {
        *self.account.lock().unwrap_or_else(|e| e.into_inner()) = Some(account.clone());
    }

    fn account(&self) -> Account {
        self.account
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(edge_own)
    }

    fn is_visitor(&self) -> bool {
        self.visitor.load(Ordering::Relaxed)
    }

    /// An answer on it was cut off: it is reset when it closes.
    pub fn cut(&self) {
        self.cut.store(true, Ordering::Relaxed);
    }

    fn is_cut(&self) -> bool {
        self.cut.load(Ordering::Relaxed)
    }
}

/// A connection that can be reset: closed at once, dropping what it has
/// not sent.
pub trait Reset {
    fn reset(&self);
}

impl Reset for tokio::net::TcpStream {
    fn reset(&self) {
        if let Err(e) = self.set_zero_linger() {
            tracing::debug!(error = %e, "connection not reset");
        }
    }
}

/// A visitor's connection, watched for falling behind: counted among the
/// answers held up once its socket has taken nothing for [`GRACE`], cut off
/// when there is no place for it or its place goes to another account's
/// answer, closed after [`STALL`] of nothing.
pub struct Watched<T: Reset> {
    inner: T,
    conn: Arc<Conn>,
    held: Arc<Held>,
    /// Since when the socket has taken nothing, while it has not.
    stalled: Option<Instant>,
    slot: Option<Slot>,
    /// When it last let a place go: falling behind again soon after takes
    /// one at once, so a slow reader's every pause is not a fresh grace.
    let_go: Option<Instant>,
    timer: Option<Pin<Box<Sleep>>>,
}

impl<T: Reset> Watched<T> {
    pub fn new(inner: T, conn: Arc<Conn>, held: Arc<Held>) -> Self {
        Self {
            inner,
            conn,
            held,
            stalled: None,
            slot: None,
            let_go: None,
            timer: None,
        }
    }

    /// The socket took something.
    fn wrote(&mut self) {
        self.stalled = None;
        self.timer = None;
        if self.slot.take().is_some() {
            self.let_go = Some(Instant::now());
        }
    }

    /// Its place went to another account's answer: it is cut off.
    fn was_cut(&self) -> Option<io::Error> {
        self.slot.as_ref().is_some_and(Slot::is_cut).then(|| {
            self.conn.cut();
            cut_off()
        })
    }

    /// The socket took nothing: still waiting, or an error that closes the
    /// connection.
    fn waits(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        if !self.conn.is_visitor() {
            return Poll::Pending;
        }
        loop {
            let now = Instant::now();
            let since = *self.stalled.get_or_insert(now);
            let waited = now.saturating_duration_since(since);
            if waited >= STALL {
                self.held.stalled.fetch_add(1, Ordering::Relaxed);
                self.conn.cut();
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the visitor took nothing for a minute",
                )));
            }
            let again = self
                .let_go
                .is_some_and(|at| now.saturating_duration_since(at) < KEEP);
            if self.slot.is_none() && (again || waited >= GRACE) {
                match self.held.take(&self.conn.account()) {
                    Some(slot) => self.slot = Some(slot),
                    None => {
                        self.conn.cut();
                        return Poll::Ready(Err(cut_off()));
                    }
                }
            }
            if let Some(slot) = &self.slot {
                slot.watch(cx.waker());
                if let Some(cut) = self.was_cut() {
                    return Poll::Ready(Err(cut));
                }
            }
            let next = if self.slot.is_none() {
                since + GRACE
            } else {
                since + STALL
            };
            let timer = self
                .timer
                .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(next)));
            if timer.deadline() != next {
                timer.as_mut().reset(next);
            }
            if timer.as_mut().poll(cx).is_pending() {
                return Poll::Pending;
            }
        }
    }
}

impl<T: Reset> Drop for Watched<T> {
    fn drop(&mut self) {
        if self.conn.is_cut() {
            self.inner.reset();
        }
    }
}

impl<T: AsyncRead + Reset + Unpin> AsyncRead for Watched<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Reset + Unpin> AsyncWrite for Watched<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(cut) = self.was_cut() {
            return Poll::Ready(Err(cut));
        }
        match Pin::new(&mut self.inner).poll_write(cx, buf) {
            Poll::Ready(Ok(n)) => {
                self.wrote();
                Poll::Ready(Ok(n))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => self.waits(cx),
        }
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        if let Some(cut) = self.was_cut() {
            return Poll::Ready(Err(cut));
        }
        match Pin::new(&mut self.inner).poll_write_vectored(cx, bufs) {
            Poll::Ready(Ok(n)) => {
                self.wrote();
                Poll::Ready(Ok(n))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => self.waits(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    impl Reset for tokio::io::DuplexStream {
        fn reset(&self) {}
    }

    pub fn account(id: &str) -> Account {
        Arc::from(id)
    }

    #[test]
    fn places_run_out_and_come_back() {
        let held = Held::new(2);
        let a = account("a");
        let first = held.take(&a).unwrap();
        let _second = held.take(&a).unwrap();
        assert!(held.take(&a).is_none());
        assert_eq!(
            held.taken_stats(),
            Taken {
                cut: 1,
                ..Taken::default()
            },
            "the refused one is counted"
        );
        drop(first);
        assert!(held.take(&a).is_some());
        assert_eq!(held.taken_stats(), Taken::default(), "and said once");
    }

    #[test]
    fn when_all_are_taken_an_account_below_its_share_gets_one_from_the_one_holding_most() {
        let held = Held::new(4);
        let (a, b) = (account("a"), account("b"));
        let mut theirs: Vec<Slot> = (0..4).map(|_| held.take(&a).unwrap()).collect();
        // B holds nothing, its share is 2: A's newest place goes.
        let mine = held.take(&b).expect("a place for B");
        assert!(theirs[3].is_cut(), "A's newest is told to go");
        assert!(theirs[..3].iter().all(|s| !s.is_cut()));
        assert_eq!(held.count(), 5, "until it is gone");
        theirs.pop();
        assert_eq!(held.count(), 4);
        // Once more: A keeps 3, B 1, below its share of 2.
        let _also = held.take(&b).expect("a second place for B");
        assert!(theirs[2].is_cut());
        theirs.pop();
        // B is at its share now: it is cut off itself, A keeps its two.
        assert!(held.take(&b).is_none());
        assert!(theirs.iter().all(|s| !s.is_cut()));
        let taken = held.taken_stats();
        assert_eq!((taken.cut, taken.made_room), (3, 2));
        drop(mine);
        assert_eq!(held.most(), Some(("a".to_string(), 2)));
    }

    #[test]
    fn a_share_is_the_places_divided_among_those_holding_any() {
        let held = Held::new(6);
        let (a, b, c) = (account("a"), account("b"), account("c"));
        let _a: Vec<Slot> = (0..3).map(|_| held.take(&a).unwrap()).collect();
        let _b: Vec<Slot> = (0..3).map(|_| held.take(&b).unwrap()).collect();
        // Three accounts: two places each. C gets two, from A and B in turn.
        let _c: Vec<Slot> = (0..2).map(|_| held.take(&c).unwrap()).collect();
        assert!(held.take(&c).is_none(), "C is at its share");
        // A and B have a place each told to go; they keep two each.
        let places = held.places();
        assert_eq!(places.accounts[&a].kept(), 2);
        assert_eq!(places.accounts[&b].kept(), 2);
    }

    #[test]
    fn an_account_alone_may_take_every_place() {
        let held = Held::new(3);
        let a = account("a");
        let _all: Vec<Slot> = (0..3).map(|_| held.take(&a).unwrap()).collect();
        assert!(held.take(&a).is_none());
        assert_eq!(held.taken_stats().made_room, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiting_answer_keeps_its_place_until_it_has_kept_up_a_while() {
        let held = Held::new(1);
        let a = account("a");
        let mut behind = Behind::default();
        let now = Instant::now();
        assert!(behind.waits(&held, &a, now));
        assert_eq!(held.count(), 1);
        behind.keeps_up(now + KEEP / 2);
        assert!(behind.is_held(), "a moment without waiting changes nothing");
        assert!(
            !Behind::default().waits(&held, &a, now),
            "no place left for the same account"
        );
        behind.keeps_up(now + KEEP);
        assert!(!behind.is_held());
        assert_eq!(held.count(), 0);
    }

    #[test]
    fn one_place_is_not_passed_back_and_forth() {
        let held = Held::new(1);
        let _theirs = held.take(&account("a")).unwrap();
        assert!(held.take(&account("b")).is_none());
        assert_eq!(held.taken_stats().made_room, 0);
    }

    #[test]
    fn a_waiting_answer_learns_its_place_went_to_another_account() {
        let held = Held::new(2);
        let a = account("a");
        let _older = held.take(&a).unwrap();
        let mut behind = Behind::default();
        assert!(behind.waits(&held, &a, Instant::now()));
        let woken = Arc::new(Woken::default());
        behind.watch(&Waker::from(woken.clone()));
        let _theirs = held.take(&account("b")).unwrap();
        assert!(behind.is_cut());
        assert!(woken.0.load(Ordering::SeqCst), "and is woken to stop");
    }

    #[derive(Default)]
    struct Woken(AtomicBool);

    impl std::task::Wake for Woken {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// A connection that served a visitor of `owner`, its far end, and the
    /// count.
    fn visitor_of(
        owner: &str,
        buffer: usize,
        held: &Arc<Held>,
    ) -> (Watched<tokio::io::DuplexStream>, tokio::io::DuplexStream) {
        let (near, far) = duplex(buffer);
        let conn = Arc::new(Conn::default());
        conn.serves_visitors();
        conn.serves(&account(owner));
        (Watched::new(near, conn, held.clone()), far)
    }

    fn visitor(
        buffer: usize,
        max: usize,
    ) -> (
        Watched<tokio::io::DuplexStream>,
        tokio::io::DuplexStream,
        Arc<Held>,
    ) {
        let held = Held::new(max);
        let (socket, far) = visitor_of("a", buffer, &held);
        (socket, far, held)
    }

    #[tokio::test(start_paused = true)]
    async fn a_visitor_who_reads_keeps_up_and_is_never_counted() {
        let (mut socket, mut far, held) = visitor(1024, 1);
        let reader = tokio::spawn(async move {
            let mut all = Vec::new();
            far.read_to_end(&mut all).await.unwrap();
            all.len()
        });
        for _ in 0..100 {
            socket.write_all(&[1u8; 4096]).await.unwrap();
            assert_eq!(held.count(), 0);
        }
        drop(socket);
        assert_eq!(reader.await.unwrap(), 409_600);
    }

    #[tokio::test(start_paused = true)]
    async fn a_visitor_who_stops_reading_is_counted_after_the_grace() {
        let (mut socket, _far, held) = visitor(1024, 4);
        socket.write_all(&[0u8; 1024]).await.unwrap();
        let writing = tokio::spawn(async move {
            let result = socket.write_all(&[0u8; 1024]).await;
            (socket, result)
        });
        tokio::time::sleep(GRACE / 2).await;
        assert_eq!(held.count(), 0, "a moment's wait is not falling behind");
        tokio::time::sleep(GRACE).await;
        assert_eq!(held.count(), 1);
        assert_eq!(held.most(), Some(("a".to_string(), 1)), "counted to A");
        writing.abort();
        let _ = writing.await;
        assert_eq!(held.count(), 0, "a closed connection lets its place go");
    }

    #[tokio::test(start_paused = true)]
    async fn past_the_most_held_up_the_next_one_is_cut_off() {
        let (mut first, _far1, held) = visitor(16, 1);
        let (mut second, _far2) = visitor_of("a", 16, &held);
        first.write_all(&[0u8; 16]).await.unwrap();
        second.write_all(&[0u8; 16]).await.unwrap();
        let one = tokio::spawn(async move { first.write_all(&[0u8; 16]).await });
        tokio::time::sleep(GRACE * 2).await;
        assert_eq!(held.count(), 1);
        let error = second.write_all(&[0u8; 16]).await.unwrap_err();
        assert_eq!(error.to_string(), cut_off().to_string());
        assert_eq!(held.taken_stats().cut, 1);
        one.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_visitor_of_another_account_takes_the_place_of_one_holding_too_many() {
        let held = Held::new(2);
        let _older = held.take(&account("attacker")).unwrap();
        let (mut theirs, _far1) = visitor_of("attacker", 16, &held);
        let (mut mine, _far2) = visitor_of("studio", 16, &held);
        theirs.write_all(&[0u8; 16]).await.unwrap();
        mine.write_all(&[0u8; 16]).await.unwrap();
        let attacker = tokio::spawn(async move { theirs.write_all(&[0u8; 16]).await });
        tokio::time::sleep(GRACE * 2).await;
        assert_eq!(held.most(), Some(("attacker".to_string(), 2)));
        let studio = tokio::spawn(async move { mine.write_all(&[0u8; 16]).await });
        tokio::time::sleep(GRACE * 2).await;
        // The attacker's newest answer is cut off at once, woken to stop.
        let cut = attacker.await.unwrap().unwrap_err();
        assert_eq!(cut.to_string(), cut_off().to_string());
        assert!(!studio.is_finished(), "the studio's visitor still reads");
        assert_eq!(held.count(), 2);
        assert_eq!(held.places().accounts[&account("studio")].kept(), 1);
        assert_eq!(held.taken_stats().made_room, 1);
        studio.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_that_takes_nothing_for_a_minute_is_closed() {
        let (mut socket, _far, held) = visitor(16, 4);
        socket.write_all(&[0u8; 16]).await.unwrap();
        let started = Instant::now();
        let error = socket.write_all(&[0u8; 16]).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= STALL);
        assert!(started.elapsed() < STALL + Duration::from_secs(1));
        assert_eq!(
            held.taken_stats(),
            Taken {
                stalled: 1,
                ..Taken::default()
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_reader_does_not_get_a_fresh_grace_at_every_pause() {
        let (mut socket, mut far, held) = visitor(16, 4);
        socket.write_all(&[0u8; 16]).await.unwrap();
        let writer = tokio::spawn(async move {
            for _ in 0..10 {
                if socket.write_all(&[0u8; 16]).await.is_err() {
                    break;
                }
            }
        });
        tokio::time::sleep(GRACE * 2).await;
        assert_eq!(held.count(), 1);
        // It reads a little now and then; between, it is counted at once.
        for _ in 0..3 {
            let mut some = [0u8; 16];
            far.read_exact(&mut some).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert_eq!(held.count(), 1);
        }
        writer.abort();
    }

    #[tokio::test]
    async fn a_connection_cut_off_is_reset_not_closed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let ended = |cut: bool| {
            let listener = &listener;
            async move {
                let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
                let (accepted, _) = listener.accept().await.unwrap();
                let conn = Arc::new(Conn::default());
                conn.serves_visitors();
                let mut socket = Watched::new(accepted, conn.clone(), Held::new(4));
                socket.write_all(b"partial answer").await.unwrap();
                if cut {
                    conn.cut();
                }
                drop(socket);
                let mut rest = Vec::new();
                client.read_to_end(&mut rest).await.map_err(|e| e.kind())
            }
        };
        assert!(ended(false).await.is_ok(), "closed: what was sent arrives");
        assert_eq!(
            ended(true).await.unwrap_err(),
            io::ErrorKind::ConnectionReset
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_tunnel_is_never_counted_or_closed() {
        let (near, _far) = duplex(16);
        let held = Held::new(0);
        let mut socket = Watched::new(near, Arc::new(Conn::default()), held.clone());
        socket.write_all(&[0u8; 16]).await.unwrap();
        let waited = tokio::time::timeout(STALL * 2, socket.write_all(&[0u8; 16])).await;
        assert!(waited.is_err(), "still waiting, not cut off");
        assert_eq!(held.taken_stats(), Taken::default());
    }

    #[test]
    fn a_connection_counts_to_the_account_it_serves_until_the_next_request() {
        let conn = Conn::default();
        conn.serves_visitors();
        assert_eq!(&*conn.account(), "", "the edge's own page");
        conn.serves(&account("user-1"));
        assert_eq!(&*conn.account(), "user-1");
        conn.serves_visitors();
        assert_eq!(&*conn.account(), "");
    }
}
