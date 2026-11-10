//! How fast the edge sends visitors what shares answer, so one heavy share
//! cannot take the box's line (500 Mbit/s, about 60 MiB/s) from everyone
//! else. A plan's monthly data
//! bounds the total, not the rate: at its 50 requests a second, a share
//! serving 1 MB scripts sent 50 MB/s (a load test).
//!
//! Each share has a bucket of bytes, and each account one more that all
//! its shares draw on. A bucket starts
//! full, so a page load (a dev server's is often 2 to 10 MB) goes out at
//! once; past it, bytes go at the bucket's rate. Last, every chunk passes
//! the line, one bucket for the whole box, shared fairly between accounts
//! when it is full (line.rs). See [`Rates::default`] for the numbers.
//!
//! Pacing holds bytes back, it never buffers more: a chunk is paid for
//! before it is sent, and until then the answer is not asked for its next
//! one, so the tunnel's window fills and the laptop waits (or the next
//! chunk of a file is not read). Answers waiting their turn at a share's
//! or account's bucket are served in the order they asked: each takes its
//! bytes from the bucket at once, into debt if need be, and waits until
//! that debt is paid; then it waits for the line to let it go.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use hyper::body::{Body as HttpBody, Frame, SizeHint};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::Body;
use crate::held::{Account, Behind, Conn, Held, cut_off};
use crate::line::{Line, Turn};

const MIB: f64 = 1024.0 * 1024.0;

/// A bucket's rate and depth, in bytes. A rate of nothing is no limit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    pub per_second: f64,
    pub burst: f64,
}

impl Rate {
    /// From MiB a second and MiB at once.
    pub fn mib(per_second: f64, burst: f64) -> Self {
        Self {
            per_second: per_second * MIB,
            burst: burst.max(0.0) * MIB,
        }
    }

    pub fn is_off(&self) -> bool {
        self.per_second <= 0.0
    }
}

/// The rates for each share or site, for each account, and for the line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rates {
    pub door: Rate,
    pub account: Rate,
    pub line: Rate,
}

impl Default for Rates {
    /// 5 MiB/s a share or site (42 Mbit/s, a twelfth of the line) after
    /// 32 MiB at once, about six cold page loads of a dev server; 8 MiB/s
    /// an account (67 Mbit/s) after 64 MiB. Four accounts at full tilt
    /// take about half the line and leave the rest to everyone else, and
    /// a page load after the bucket is spent still takes a second or so.
    ///
    /// 40 MiB/s for the whole line (about 335 Mbit/s, two thirds of the
    /// 500). The third left is for webhooks.cc and the web app, request
    /// bodies on their way up to laptops, TCP's and TLS's own bytes (some
    /// 4% more on the wire), and slack, so that the router's queue stays
    /// empty and everyone's pages come at once: once a line is full, all
    /// on it wait behind its queue. Five accounts at full tilt reach it;
    /// past that they share it (line.rs). After 32 MiB at once, a share's
    /// burst: a crowd opening a page together gets it at once, as before,
    /// rather than each answer waiting its turn and taking a place among
    /// those held up (held.rs); the router's queue holds such a moment
    /// for half a second at most.
    fn default() -> Self {
        Self {
            door: Rate::mib(5.0, 32.0),
            account: Rate::mib(8.0, 64.0),
            line: Rate::mib(40.0, 32.0),
        }
    }
}

#[derive(Debug)]
struct Level {
    /// Bytes that may go now; below nothing, the debt still to pay.
    tokens: f64,
    at: Instant,
}

/// One bucket, shared by every answer it paces.
#[derive(Debug)]
pub struct Pace {
    rate: Rate,
    level: Mutex<Level>,
}

impl Pace {
    /// A full bucket, or none when the rate is off.
    pub fn new(rate: Rate) -> Option<Arc<Self>> {
        (!rate.is_off()).then(|| {
            Arc::new(Self {
                rate,
                level: Mutex::new(Level {
                    tokens: rate.burst,
                    at: Instant::now(),
                }),
            })
        })
    }

    fn refilled<'a>(&self, level: &'a mut Level, now: Instant) -> &'a mut Level {
        let elapsed = now.saturating_duration_since(level.at).as_secs_f64();
        level.tokens = (level.tokens + elapsed * self.rate.per_second).min(self.rate.burst);
        level.at = now;
        level
    }

    /// Takes `bytes`, into debt if need be: how long until they are paid
    /// for and may go.
    pub fn take(&self, bytes: usize, now: Instant) -> Duration {
        let mut level = self.level.lock().unwrap_or_else(|e| e.into_inner());
        let level = self.refilled(&mut level, now);
        level.tokens -= bytes as f64;
        if level.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-level.tokens / self.rate.per_second)
        }
    }

    /// Gives back bytes taken but never sent (the visitor left).
    pub fn give_back(&self, bytes: usize) {
        let mut level = self.level.lock().unwrap_or_else(|e| e.into_inner());
        level.tokens = (level.tokens + bytes as f64).min(self.rate.burst);
    }
}

/// What an answer is paced by: its share's or site's bucket, its
/// account's, and the line; and where answers waiting for them count as
/// held up (held.rs), as the account's.
#[derive(Debug, Clone, Default)]
pub struct Paces {
    door: Option<Arc<Pace>>,
    account: Option<Arc<Pace>>,
    line: Option<Arc<Line>>,
    held: Option<Arc<Held>>,
    /// Whose answers these are: their turns on the line and their places
    /// among those held up are this account's.
    owner: Account,
    /// The visitor's connection, reset when an answer on it is cut off.
    conn: Option<Arc<Conn>>,
}

impl Paces {
    pub fn new(door: Option<Arc<Pace>>, account: Option<Arc<Pace>>) -> Self {
        Self {
            door,
            account,
            line: None,
            held: None,
            owner: Account::default(),
            conn: None,
        }
    }

    /// The answers go through this line too.
    pub fn line(mut self, line: Option<Arc<Line>>) -> Self {
        self.line = line;
        self
    }

    /// Answers waiting for these paces count among those held up.
    pub fn held(mut self, held: Arc<Held>) -> Self {
        self.held = Some(held);
        self
    }

    /// The answers are this account's.
    pub fn of(mut self, owner: Account) -> Self {
        self.owner = owner;
        self
    }

    pub fn owner(&self) -> &Account {
        &self.owner
    }

    /// For an answer on this connection.
    pub fn on(mut self, conn: Arc<Conn>) -> Self {
        self.conn = Some(conn);
        self
    }

    fn cut(&self) -> std::io::Error {
        if let Some(conn) = &self.conn {
            conn.cut();
        }
        cut_off()
    }

    /// Whether an answer may wait now, taking a place among those held up
    /// if it has none: false when none is left, and it is cut off.
    fn waits(&self, behind: &mut Behind, now: Instant) -> bool {
        match &self.held {
            Some(held) => behind.waits(held, &self.owner, now),
            None => true,
        }
    }

    pub fn is_off(&self) -> bool {
        self.door.is_none() && self.account.is_none() && self.line.is_none()
    }

    /// `bytes` paid at the share's and account's pace may go once the
    /// line lets them.
    fn turn(&self, bytes: usize, now: Instant) -> Turn {
        match &self.line {
            Some(line) => line.take(&self.owner, bytes, now),
            None => Turn::Go,
        }
    }

    /// Takes `bytes` from both: how long until both are paid.
    fn take(&self, bytes: usize, now: Instant) -> Duration {
        let door = self
            .door
            .as_ref()
            .map_or(Duration::ZERO, |p| p.take(bytes, now));
        let account = self
            .account
            .as_ref()
            .map_or(Duration::ZERO, |p| p.take(bytes, now));
        door.max(account)
    }

    fn give_back(&self, bytes: usize) {
        for pace in [&self.door, &self.account].into_iter().flatten() {
            pace.give_back(bytes);
        }
    }
}

/// Waits shorter than this are not slept: tokio's timer is no finer, and
/// the debt carries over to the next chunk anyway.
const NO_WAIT: Duration = Duration::from_millis(1);

/// An answer's body, each chunk sent once it is paid for and the line
/// lets it go.
pub struct Paced {
    inner: Body,
    paces: Paces,
    /// A chunk on its way, with its size: waiting at its pace, or for the
    /// line.
    held: Option<(Frame<Bytes>, usize)>,
    wait: Option<Pin<Box<tokio::time::Sleep>>>,
    turn: Option<oneshot::Receiver<()>>,
    behind: Behind,
}

impl Paced {
    /// The body as it is when nothing paces it.
    pub fn wrap(inner: Body, paces: Paces) -> Body {
        if paces.is_off() {
            return inner;
        }
        Body::new(Self {
            inner,
            paces,
            held: None,
            wait: None,
            turn: None,
            behind: Behind::default(),
        })
    }

    /// Cut off, its chunk unsent: what it took at its pace goes back.
    fn cut(&mut self) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if let Some((_, bytes)) = self.held.take() {
            self.paces.give_back(bytes);
        }
        self.wait = None;
        self.turn = None;
        Poll::Ready(Some(Err(self.paces.cut().into())))
    }
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

impl HttpBody for Paced {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = &mut *self;
        this.behind.watch(cx.waker());
        loop {
            // Its place among those held up went to another account's
            // answer.
            if this.behind.is_cut() {
                return this.cut();
            }
            if let Some(wait) = this.wait.as_mut() {
                if wait.as_mut().poll(cx).is_pending() {
                    return Poll::Pending;
                }
                this.wait = None;
                // Paid at its pace: now its turn on the line.
                let now = Instant::now();
                let bytes = this.held.as_ref().map_or(0, |(_, bytes)| *bytes);
                if let Turn::Wait(turn) = this.paces.turn(bytes, now) {
                    if !this.paces.waits(&mut this.behind, now) {
                        return this.cut();
                    }
                    this.turn = Some(turn);
                }
                continue;
            }
            if let Some(turn) = this.turn.as_mut() {
                // An error is the line gone, as the edge stops: it goes.
                if Pin::new(turn).poll(cx).is_pending() {
                    return Poll::Pending;
                }
                this.turn = None;
            }
            if let Some((frame, _)) = this.held.take() {
                return Poll::Ready(Some(Ok(frame)));
            }
            let frame = match ready!(Pin::new(&mut this.inner).poll_frame(cx)) {
                Some(Ok(frame)) => frame,
                other => return Poll::Ready(other),
            };
            let bytes = frame.data_ref().map_or(0, Bytes::len);
            if bytes == 0 {
                return Poll::Ready(Some(Ok(frame)));
            }
            let now = Instant::now();
            let wait = this.paces.take(bytes, now);
            this.held = Some((frame, bytes));
            if wait >= NO_WAIT {
                if !this.paces.waits(&mut this.behind, now) {
                    return this.cut();
                }
                this.wait = Some(Box::pin(tokio::time::sleep(wait)));
                continue;
            }
            match this.paces.turn(bytes, now) {
                Turn::Go => this.behind.keeps_up(now),
                Turn::Wait(turn) => {
                    if !this.paces.waits(&mut this.behind, now) {
                        return this.cut();
                    }
                    this.turn = Some(turn);
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.held.is_none() && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        let mut hint = self.inner.size_hint();
        if let Some((_, bytes)) = &self.held {
            let bytes = *bytes as u64;
            hint.set_lower(hint.lower() + bytes);
            if let Some(upper) = hint.upper() {
                hint.set_upper(upper + bytes);
            }
        }
        hint
    }
}

impl Drop for Paced {
    /// A chunk paid for but never sent is given back.
    fn drop(&mut self) {
        if let Some((_, bytes)) = self.held.take() {
            self.paces.give_back(bytes);
        }
    }
}

/// The visitor's side of a WebSocket, paced: what was written is paid for,
/// and let go by the line, before the next write goes. Writes are a copy's
/// few kilobytes, so the first one going unpaid is nothing.
pub struct PacedSocket<T> {
    inner: T,
    paces: Paces,
    wait: Option<Pin<Box<tokio::time::Sleep>>>,
    /// Bytes written and waiting at their pace, for the line after.
    owed: usize,
    turn: Option<oneshot::Receiver<()>>,
    behind: Behind,
}

impl<T> PacedSocket<T> {
    pub fn new(inner: T, paces: Paces) -> Self {
        Self {
            inner,
            paces,
            wait: None,
            owed: 0,
            turn: None,
            behind: Behind::default(),
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for PacedSocket<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for PacedSocket<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = &mut *self;
        this.behind.watch(cx.waker());
        loop {
            if this.behind.is_cut() {
                return Poll::Ready(Err(this.paces.cut()));
            }
            if let Some(wait) = this.wait.as_mut() {
                if wait.as_mut().poll(cx).is_pending() {
                    return Poll::Pending;
                }
                this.wait = None;
                let now = Instant::now();
                let owed = std::mem::take(&mut this.owed);
                if let Turn::Wait(turn) = this.paces.turn(owed, now) {
                    if !this.paces.waits(&mut this.behind, now) {
                        return Poll::Ready(Err(this.paces.cut()));
                    }
                    this.turn = Some(turn);
                }
                continue;
            }
            if let Some(turn) = this.turn.as_mut() {
                if Pin::new(turn).poll(cx).is_pending() {
                    return Poll::Pending;
                }
                this.turn = None;
            }
            break;
        }
        let n = ready!(Pin::new(&mut this.inner).poll_write(cx, buf))?;
        if n > 0 {
            let now = Instant::now();
            let wait = this.paces.take(n, now);
            if wait >= NO_WAIT {
                if !this.paces.waits(&mut this.behind, now) {
                    return Poll::Ready(Err(this.paces.cut()));
                }
                this.wait = Some(Box::pin(tokio::time::sleep(wait)));
                this.owed = n;
            } else {
                match this.paces.turn(n, now) {
                    Turn::Go => this.behind.keeps_up(now),
                    Turn::Wait(turn) => {
                        if !this.paces.waits(&mut this.behind, now) {
                            return Poll::Ready(Err(this.paces.cut()));
                        }
                        this.turn = Some(turn);
                    }
                }
            }
        }
        Poll::Ready(Ok(n))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{BodyExt, StreamBody};
    use tokio::io::AsyncWriteExt;

    const KIB: usize = 1024;

    fn rate(per_second: usize, burst: usize) -> Rate {
        Rate {
            per_second: per_second as f64,
            burst: burst as f64,
        }
    }

    #[test]
    fn a_full_bucket_lets_its_burst_through_then_charges_for_the_rest() {
        let now = Instant::now();
        let pace = Pace::new(rate(100 * KIB, 300 * KIB)).unwrap();
        assert_eq!(pace.take(300 * KIB, now), Duration::ZERO);
        // 50 KiB more is half a second of debt at 100 KiB/s.
        let wait = pace.take(50 * KIB, now);
        assert!((wait.as_secs_f64() - 0.5).abs() < 0.001, "{wait:?}");
        // The next in line waits behind it.
        let wait = pace.take(50 * KIB, now);
        assert!((wait.as_secs_f64() - 1.0).abs() < 0.001, "{wait:?}");
        // A second on, half a second of debt is left.
        let wait = pace.take(0, now + Duration::from_secs(1));
        assert!((wait.as_secs_f64() - 0.0).abs() < 0.001, "{wait:?}");
    }

    #[test]
    fn a_bucket_refills_no_further_than_its_burst() {
        let now = Instant::now();
        let pace = Pace::new(rate(100 * KIB, 200 * KIB)).unwrap();
        pace.take(200 * KIB, now);
        let later = now + Duration::from_secs(60);
        assert_eq!(pace.take(200 * KIB, later), Duration::ZERO);
        assert!(pace.take(KIB, later) > Duration::ZERO);
    }

    #[test]
    fn what_was_never_sent_is_given_back() {
        let now = Instant::now();
        let pace = Pace::new(rate(100 * KIB, 100 * KIB)).unwrap();
        assert!(pace.take(200 * KIB, now) > Duration::ZERO);
        pace.give_back(100 * KIB);
        assert_eq!(pace.take(0, now), Duration::ZERO);
    }

    #[test]
    fn the_slower_of_share_and_account_decides() {
        let now = Instant::now();
        let account = Pace::new(rate(100 * KIB, 0));
        let one = Paces::new(Pace::new(rate(1000 * KIB, 0)), account.clone());
        let other = Paces::new(Pace::new(rate(1000 * KIB, 0)), account);
        let first = one.take(100 * KIB, now);
        assert!((first.as_secs_f64() - 1.0).abs() < 0.001, "{first:?}");
        // Another share of the same account waits behind the first.
        let second = other.take(100 * KIB, now);
        assert!((second.as_secs_f64() - 2.0).abs() < 0.001, "{second:?}");
        assert!(Paces::new(None, None).is_off());
        assert!(Pace::new(Rate::mib(0.0, 32.0)).is_none());
    }

    fn chunks(n: usize, size: usize) -> Body {
        let frames: Vec<Result<Frame<Bytes>, Box<dyn std::error::Error + Send + Sync>>> = (0..n)
            .map(|_| Ok(Frame::data(Bytes::from(vec![7u8; size]))))
            .collect();
        StreamBody::new(futures::stream::iter(frames)).boxed()
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_goes_at_the_rate_once_its_burst_is_spent() {
        let paces = Paces::new(Pace::new(rate(100 * KIB, 100 * KIB)), None);
        let started = tokio::time::Instant::now();
        let body = Paced::wrap(chunks(10, 50 * KIB), paces)
            .collect()
            .await
            .unwrap();
        assert_eq!(body.to_bytes().len(), 500 * KIB);
        // 100 KiB at once, then 400 KiB at 100 KiB/s.
        let took = started.elapsed().as_secs_f64();
        assert!((3.9..4.2).contains(&took), "{took}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_within_its_burst_is_not_held_up() {
        let paces = Paces::new(Pace::new(rate(KIB, 1024 * KIB)), None);
        let started = tokio::time::Instant::now();
        Paced::wrap(chunks(10, 50 * KIB), paces)
            .collect()
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(1));
    }

    #[tokio::test(start_paused = true)]
    async fn the_next_chunk_is_not_asked_for_while_one_waits() {
        use futures::StreamExt;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let asked = Arc::new(AtomicUsize::new(0));
        let counting = asked.clone();
        let frames = futures::stream::iter(0..10).map(move |_| {
            counting.fetch_add(1, Ordering::SeqCst);
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Frame::data(Bytes::from(
                vec![0u8; 100 * KIB],
            )))
        });
        let paces = Paces::new(Pace::new(rate(100 * KIB, 0)), None);
        let mut body = Paced::wrap(BodyExt::boxed(StreamBody::new(frames)), paces);
        let waiting = tokio::time::timeout(Duration::from_millis(500), body.frame()).await;
        assert!(waiting.is_err(), "the first chunk waits a second");
        assert_eq!(asked.load(Ordering::SeqCst), 1, "and nothing more is read");
    }

    #[tokio::test(start_paused = true)]
    async fn a_chunk_never_sent_gives_its_bytes_back() {
        let pace = Pace::new(rate(100 * KIB, 0));
        let paces = Paces::new(pace.clone(), None);
        let mut body = Paced::wrap(chunks(1, 100 * KIB), paces);
        let _ = tokio::time::timeout(Duration::from_millis(10), body.frame()).await;
        drop(body);
        assert!(pace.unwrap().take(0, Instant::now()) < Duration::from_millis(1));
    }

    #[tokio::test(start_paused = true)]
    async fn answers_waiting_for_their_pace_count_as_held_up_and_past_the_most_are_cut_off() {
        let held = Held::new(1);
        let account = Pace::new(rate(100 * KIB, 0));
        let paces = Paces::new(None, account).held(held.clone());
        let mut first = Paced::wrap(chunks(3, 50 * KIB), paces.clone());
        let waiting = tokio::time::timeout(Duration::from_millis(100), first.frame()).await;
        assert!(waiting.is_err(), "it waits for its pace");
        assert_eq!(held.count(), 1, "and is held up meanwhile");
        // Another answer of the account would wait too, with no place left.
        let mut second = Paced::wrap(chunks(1, 50 * KIB), paces);
        let cut = second.frame().await.unwrap();
        assert!(cut.is_err());
        drop(second);
        // The first goes on, and lets its place go once it ends.
        let rest = first.collect().await.unwrap().to_bytes();
        assert_eq!(
            rest.len(),
            150 * KIB,
            "every chunk, the one that waited too"
        );
        assert_eq!(held.count(), 0);
        assert_eq!(held.taken_stats().cut, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_heavy_account_waiting_at_its_pace_makes_room_for_another_accounts_slow_visitor() {
        let held = Held::new(2);
        let heavy = Paces::new(None, Pace::new(rate(100 * KIB, 0)))
            .held(held.clone())
            .of(Account::from("heavy"));
        let mut first = Paced::wrap(chunks(3, 50 * KIB), heavy.clone());
        let mut second = Paced::wrap(chunks(3, 50 * KIB), heavy);
        for body in [&mut first, &mut second] {
            let waiting = tokio::time::timeout(Duration::from_millis(10), body.frame()).await;
            assert!(waiting.is_err(), "it waits for its pace");
        }
        assert_eq!(held.count(), 2, "both places are the heavy account's");
        // A slow visitor of another account falls behind: the heavy
        // account's newest answer lets its place go, and is cut off.
        let _theirs = held
            .take(&Account::from("studio"))
            .expect("a place for the studio");
        let cut = second.frame().await.unwrap();
        assert!(cut.is_err());
        drop(second);
        assert_eq!(held.count(), 2);
        // The older one goes on.
        let rest = first.collect().await.unwrap().to_bytes();
        assert_eq!(rest.len(), 150 * KIB);
    }

    /// A line of `per_second`, with quiet allowances too small to matter.
    fn full_line(per_second: usize) -> Option<Arc<Line>> {
        Line::with_quiet(
            rate(per_second, 0),
            Rate {
                per_second: 1.0,
                burst: 0.0,
            },
        )
    }

    #[tokio::test(start_paused = true)]
    async fn accounts_share_a_full_line_however_many_answers_each_has() {
        let line = full_line(100 * KIB);
        let of = |id: &str| {
            Paces::new(None, None)
                .line(line.clone())
                .of(Account::from(id))
        };
        let started = tokio::time::Instant::now();
        let mut many: Vec<_> = (0..4)
            .map(|_| {
                let body = Paced::wrap(chunks(5, 50 * KIB), of("many"));
                tokio::spawn(async move { body.collect().await.unwrap().to_bytes().len() })
            })
            .collect();
        let one = Paced::wrap(chunks(5, 50 * KIB), of("one"));
        let one = tokio::spawn(async move {
            let len = one.collect().await.unwrap().to_bytes().len();
            (len, started.elapsed().as_secs_f64())
        });
        // Half the line each: the one answer's 250 KiB in about 5 s, not
        // in the 12.5 s a fifth of the line would take.
        let (len, took) = one.await.unwrap();
        assert_eq!(len, 250 * KIB);
        assert!((4.0..6.5).contains(&took), "{took}");
        for body in many.drain(..) {
            assert_eq!(body.await.unwrap(), 250 * KIB);
        }
        let all = started.elapsed().as_secs_f64();
        assert!((12.0..13.5).contains(&all), "the line stays full: {all}");
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_waiting_for_the_line_counts_as_held_up() {
        let held = Held::new(4);
        let paces = Paces::new(None, None)
            .line(full_line(100 * KIB))
            .held(held.clone())
            .of(Account::from("studio"));
        let mut body = Paced::wrap(chunks(3, 50 * KIB), paces);
        body.frame().await.unwrap().unwrap();
        let waiting = tokio::time::timeout(Duration::from_millis(100), body.frame()).await;
        assert!(waiting.is_err(), "the second chunk waits for the line");
        assert_eq!(held.count(), 1);
        assert_eq!(held.most(), Some(("studio".to_string(), 1)));
        drop(body);
        assert_eq!(held.count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_websocket_waits_for_the_line_too() {
        let (socket, mut far) = tokio::io::duplex(1 << 20);
        let paces = Paces::new(None, None).line(full_line(100 * KIB));
        let mut socket = PacedSocket::new(socket, paces);
        let started = tokio::time::Instant::now();
        for _ in 0..4 {
            socket.write_all(&[0u8; 50 * KIB]).await.unwrap();
        }
        let took = started.elapsed().as_secs_f64();
        assert!((0.9..1.6).contains(&took), "{took}");
        drop(socket);
        let mut all = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut far, &mut all)
            .await
            .unwrap();
        assert_eq!(all.len(), 200 * KIB);
    }

    #[tokio::test(start_paused = true)]
    async fn a_websocket_is_paced_as_it_writes() {
        let (socket, mut far) = tokio::io::duplex(1 << 20);
        let paces = Paces::new(Pace::new(rate(100 * KIB, 0)), None);
        let mut socket = PacedSocket::new(socket, paces);
        let started = tokio::time::Instant::now();
        for _ in 0..4 {
            socket.write_all(&[0u8; 50 * KIB]).await.unwrap();
        }
        // Each write is paid before the next goes: three are waited for.
        let took = started.elapsed().as_secs_f64();
        assert!((1.4..1.6).contains(&took), "{took}");
        drop(socket);
        let mut all = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut far, &mut all)
            .await
            .unwrap();
        assert_eq!(all.len(), 200 * KIB);
    }
}
