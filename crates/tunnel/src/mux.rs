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
/// visitors took the edge past its 512 MB (tools/load, slow.mjs). This
/// still lets a big download over a long way grow to full speed.
pub const WINDOW_EXTRA: usize = 16 * 1024 * 1024;

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
