//! A yamux session over the WebSocket's bytes. yamux's `Connection` only
//! moves while someone polls it, so a task owns it: it keeps reading,
//! hands out the streams the other side opens, and opens streams for
//! whoever asks through an [`Opener`].

use std::future::poll_fn;
use std::io;
use std::task::Poll;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use yamux::{Config, Connection, ConnectionError, Mode};

/// Streams a session may hold at once. Far above what the edge lets an
/// account have in flight (limits.rs, 256): yamux counts a stream until
/// its connection task has handled the drop, which runs behind under load,
/// and ends the whole session when a stream would be one too many, on
/// either side. At yamux's default of 512, a share answering some 15,000
/// requests a second with 200 in flight lost its tunnel every few seconds
/// (tools/load, one-share.mjs).
pub const MAX_STREAMS: usize = 4096;

/// What a session's streams together may be sent beyond the 256 KiB each
/// starts with and yamux never goes below. yamux grows the window of a
/// stream that is read fast, by default up to 1 GiB a session, and keeps it
/// grown: a visitor who read a big answer fast and then slowed down left
/// the edge holding megabytes for that one stream, and a few hundred such
/// visitors took the edge past its 512 MB (tools/load, slow.mjs). It was
/// 16 MiB, and a modified CLI could grow one stream to that and then hold it
/// with a visitor reading a few KB a minute: about 90 tunnels so held took
/// the edge past its memory limit. 2 MiB bounds that to a tunnel's base
/// windows plus 2 MiB, and buys nothing less: the edge sends a share at
/// 5 MiB/s past its burst (pace.rs), which a window of 2.25 MiB keeps up
/// with up to a round trip of some 450 ms.
pub const WINDOW_EXTRA: usize = 2 * 1024 * 1024;

/// A yamux stream with tokio's I/O traits.
pub type MuxStream = Compat<yamux::Stream>;

type OpenReply = oneshot::Sender<Result<yamux::Stream, ConnectionError>>;

/// Opens streams on the session. Cheap to clone.
#[derive(Clone)]
pub struct Opener(mpsc::Sender<OpenReply>);

impl Opener {
    pub async fn open(&self) -> io::Result<MuxStream> {
        let (tx, rx) = oneshot::channel();
        self.0.send(tx).await.map_err(|_| gone())?;
        let stream = rx.await.map_err(|_| gone())?.map_err(io::Error::other)?;
        Ok(stream.compat())
    }

    /// Whether the session has ended.
    pub fn is_closed(&self) -> bool {
        self.0.is_closed()
    }
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the tunnel closed")
}

/// Starts a session. The edge is the [`Mode::Client`] and opens streams;
/// the CLI is the [`Mode::Server`] and receives them. The task ends, and
/// the returned handle with it, when the connection does.
pub fn spawn<T>(
    io: T,
    mode: Mode,
) -> (
    Opener,
    mpsc::Receiver<MuxStream>,
    JoinHandle<Result<(), ConnectionError>>,
)
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut config = Config::default();
    config.set_max_num_streams(MAX_STREAMS);
    // Each stream's 256 KiB, which yamux never goes below, and the extra.
    config.set_max_connection_receive_window(Some(
        MAX_STREAMS * yamux::DEFAULT_CREDIT as usize + WINDOW_EXTRA,
    ));
    let mut connection = Connection::new(io.compat(), config, mode);
    let (open_tx, mut open_rx) = mpsc::channel::<OpenReply>(32);
    // Room for every stream yamux lets the other side open at once, so a
    // burst of visitors is never dropped while the CLI is busy for a moment
    // (a full queue resets the stream: the visitor got "the site closed
    // the connection"). yamux refuses more than that itself.
    let (inbound_tx, inbound_rx) = mpsc::channel::<MuxStream>(MAX_STREAMS);

    let task = tokio::spawn(async move {
        let mut waiting: Option<OpenReply> = None;
        poll_fn(|cx| {
            loop {
                // Open what was asked for, one at a time.
                if waiting.is_none()
                    && let Poll::Ready(Some(reply)) = open_rx.poll_recv(cx)
                {
                    waiting = Some(reply);
                }
                if let Some(reply) = waiting.take() {
                    match connection.poll_new_outbound(cx) {
                        Poll::Ready(result) => {
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                return Poll::Ready(Err(ConnectionError::Closed));
                            }
                            continue;
                        }
                        Poll::Pending => waiting = Some(reply),
                    }
                }
                // Reading drives the whole connection, writes included.
                match connection.poll_next_inbound(cx) {
                    Poll::Ready(Some(Ok(stream))) => {
                        // The edge never expects streams; dropping one resets it.
                        let _ = inbound_tx.try_send(stream.compat());
                        continue;
                    }
                    Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
                    Poll::Ready(None) => return Poll::Ready(Ok(())),
                    Poll::Pending => return Poll::Pending,
                }
            }
        })
        .await
    });

    (Opener(open_tx), inbound_rx, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn a_burst_of_streams_waits_for_a_busy_receiver() {
        let (edge_end, cli_end) = tokio::io::duplex(1 << 20);
        let (opener, _none, _edge) = spawn(edge_end, Mode::Client);
        let (_unused, mut inbound, _cli) = spawn(cli_end, Mode::Server);
        // Visitors arrive faster than the CLI takes their streams: far
        // more than one queue's worth before it looks at any.
        let mut sent = Vec::new();
        for i in 0..200u8 {
            let mut stream = opener.open().await.unwrap();
            stream.write_all(&[i]).await.unwrap();
            stream.flush().await.unwrap();
            sent.push(stream);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut got = Vec::new();
        while let Ok(Some(mut stream)) =
            tokio::time::timeout(Duration::from_millis(500), inbound.recv()).await
        {
            let mut byte = [0u8; 1];
            stream.read_exact(&mut byte).await.unwrap();
            got.push(byte[0]);
        }
        got.sort();
        assert_eq!(got, (0..200u8).collect::<Vec<_>>(), "every stream arrives");
    }

    /// Copies one way, everything `delay` late: a long way, or a CLI that
    /// answers yamux's pings late to make it grow windows.
    fn delayed(
        mut from: tokio::io::ReadHalf<tokio::io::DuplexStream>,
        mut to: tokio::io::WriteHalf<tokio::io::DuplexStream>,
        delay: Duration,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let Ok(n) = from.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                let at = tokio::time::Instant::now() + delay;
                if tx.send((at, buf[..n].to_vec())).is_err() {
                    return;
                }
            }
        });
        tokio::spawn(async move {
            while let Some((at, bytes)) = rx.recv().await {
                tokio::time::sleep_until(at).await;
                if to.write_all(&bytes).await.is_err() {
                    return;
                }
            }
        });
    }

    /// What the edge is left holding for one stream whose reader read fast
    /// for `reading` and then stopped, while the CLI kept writing: what it
    /// wrote and the reader never took, `after` the stop.
    async fn held_after_a_stall(delay: Duration, reading: Duration, after: Duration) -> usize {
        let (edge_io, edge_relay) = tokio::io::duplex(1 << 20);
        let (cli_relay, cli_io) = tokio::io::duplex(1 << 20);
        let (er, ew) = tokio::io::split(edge_relay);
        let (cr, cw) = tokio::io::split(cli_relay);
        delayed(er, cw, delay);
        delayed(cr, ew, delay);
        let (opener, _none, _edge) = spawn(edge_io, Mode::Client);
        let (_unused, mut inbound, _cli) = spawn(cli_io, Mode::Server);
        let mut edge_stream = opener.open().await.unwrap();
        edge_stream
            .write_all(b"GET / HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        edge_stream.flush().await.unwrap();
        let mut cli_stream = inbound.recv().await.unwrap();
        let written = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = written.clone();
        tokio::spawn(async move {
            let chunk = vec![7u8; 16 * 1024];
            while cli_stream.write_all(&chunk).await.is_ok() {
                counted.fetch_add(chunk.len(), std::sync::atomic::Ordering::SeqCst);
            }
        });
        let mut buf = vec![0u8; 64 * 1024];
        let mut read = 0usize;
        let until = tokio::time::Instant::now() + reading;
        while tokio::time::Instant::now() < until {
            match tokio::time::timeout(Duration::from_secs(5), edge_stream.read(&mut buf)).await {
                Ok(Ok(n)) if n > 0 => read += n,
                _ => break,
            }
        }
        tokio::time::sleep(after).await;
        written.load(std::sync::atomic::Ordering::SeqCst) - read
    }

    // Real time: yamux times its round trips with the system clock. About
    // 6 seconds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stalled_stream_holds_at_most_its_window_and_the_extra() {
        // With pongs 300 ms late each way, one stream grew to some 8 MiB at
        // the 16 MiB extra this had, which the edge then held for a visitor
        // reading a few KB a minute.
        let held = held_after_a_stall(
            Duration::from_millis(300),
            Duration::from_secs(4),
            Duration::from_secs(2),
        )
        .await;
        // Its 256 KiB, the extra, and what sits in the pipe on the way.
        let most = yamux::DEFAULT_CREDIT as usize + WINDOW_EXTRA + (1 << 20);
        assert!(held <= most, "{held} > {most}");
    }

    #[tokio::test]
    async fn a_session_holds_more_streams_than_yamux_did_by_default() {
        let (edge_end, cli_end) = tokio::io::duplex(1 << 20);
        let (opener, _none, edge) = spawn(edge_end, Mode::Client);
        let (_unused, mut inbound, cli) = spawn(cli_end, Mode::Server);
        // The CLI answers each stream and keeps it open.
        let held = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Some(mut stream) = inbound.recv().await {
                let mut byte = [0u8; 1];
                stream.read_exact(&mut byte).await.unwrap();
                stream.write_all(&byte).await.unwrap();
                held.push(stream);
            }
            held.len()
        });
        let mut open = Vec::new();
        for _ in 0..600 {
            let mut stream = opener.open().await.unwrap();
            stream.write_all(b"x").await.unwrap();
            let mut byte = [0u8; 1];
            stream.read_exact(&mut byte).await.unwrap();
            open.push(stream);
        }
        assert!(
            !edge.is_finished() && !cli.is_finished(),
            "the session goes on"
        );
        drop(open);
        drop(opener);
        held.abort();
    }
}
