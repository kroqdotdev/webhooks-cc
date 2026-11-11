//! A WebSocket as a byte stream, for yamux. Binary messages are the
//! bytes; text messages travel beside them as JSON ([`crate::EdgeMessage`]).
//! A ping goes out every [`PING_EVERY`] so that Cloudflare, which drops
//! WebSockets idle for 100 seconds, keeps the tunnel open. Both ends ping,
//! so each hears from the other at least that often: after [`SILENT_AFTER`]
//! with nothing at all from the peer (a laptop that slept, a Wi-Fi change,
//! a NAT mapping that lapsed, none of which sends a FIN), the WebSocket is
//! taken as gone and both halves end, instead of waiting the kernel's
//! quarter of an hour for TCP to give up.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_util::sync::PollSender;

pub const PING_EVERY: Duration = Duration::from_secs(20);
/// How long a peer may send nothing at all (not even its ping or a pong)
/// before the WebSocket is taken as dead: three pings missed.
pub const SILENT_AFTER: Duration = Duration::from_secs(PING_EVERY.as_secs() * 3);
/// How long closing a WebSocket may take before it is just dropped: a dead
/// peer never acknowledges the close.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

/// Limits for both ends. yamux frames are at most 16 KiB and a header, and
/// the JSON beside them is small, so a megabyte is a peer misbehaving, not
/// one to buffer (tungstenite would take 64 MiB).
pub fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(1 << 20))
        .max_frame_size(Some(1 << 20))
}

enum Outgoing {
    Binary(Bytes),
    Text(String),
}

/// The byte half: yamux reads and writes this.
pub struct WsBytes {
    incoming: mpsc::Receiver<Bytes>,
    pending: Bytes,
    outgoing: PollSender<Outgoing>,
}

/// The text half: send and receive JSON messages beside the bytes.
pub struct WsText {
    pub incoming: mpsc::Receiver<String>,
    outgoing: mpsc::Sender<Outgoing>,
}

impl WsText {
    /// Queues a text message. False once the WebSocket is gone.
    pub async fn send(&self, text: String) -> bool {
        self.outgoing.send(Outgoing::Text(text)).await.is_ok()
    }

    /// A sender that can be cloned and kept elsewhere.
    pub fn sender(&self) -> TextSender {
        TextSender(self.outgoing.clone())
    }
}

#[derive(Clone)]
pub struct TextSender(mpsc::Sender<Outgoing>);

impl TextSender {
    /// Sends without waiting; a full queue drops the message.
    pub fn try_send(&self, text: String) -> bool {
        self.0.try_send(Outgoing::Text(text)).is_ok()
    }
}

/// Splits a WebSocket into its byte and text halves. Two tasks run until
/// the WebSocket closes or both halves are dropped.
pub fn split<S>(ws: WebSocketStream<S>) -> (WsBytes, WsText)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (bytes_tx, bytes_rx) = mpsc::channel::<Bytes>(64);
    let (text_tx, text_rx) = mpsc::channel::<String>(64);
    let (out_tx, mut out_rx) = mpsc::channel::<Outgoing>(64);
    // When the peer was last heard from, frame of any kind.
    let heard = Arc::new(Mutex::new(tokio::time::Instant::now()));
    // Tells the reader to stop when the writer has given the peer up.
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);

    let last = heard.clone();
    tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            let message = tokio::select! {
                next = out_rx.recv() => match next {
                    Some(Outgoing::Binary(b)) => Message::Binary(b),
                    Some(Outgoing::Text(t)) => Message::text(t),
                    None => break,
                },
                _ = ping.tick() => {
                    if silent_for(&last) >= SILENT_AFTER {
                        break;
                    }
                    Message::Ping(Bytes::new())
                }
            };
            if !send_unless_silent(&mut sink, message, &last).await {
                break;
            }
        }
        let _ = stop_tx.send(true);
        let _ = tokio::time::timeout(CLOSE_WAIT, sink.close()).await;
    });

    tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                next = stream.next() => match next {
                    Some(Ok(message)) => message,
                    _ => break,
                },
                _ = stop_rx.changed() => break,
            };
            *heard.lock().unwrap_or_else(|e| e.into_inner()) = tokio::time::Instant::now();
            match message {
                Message::Binary(b) => {
                    if bytes_tx.send(b).await.is_err() {
                        break;
                    }
                }
                Message::Text(t) => {
                    // Waits for room, so a Closing behind a burst of request
                    // lines still arrives. Nobody listening for text is not
                    // a reason to stop.
                    let _ = text_tx.send(t.to_string()).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    (
        WsBytes {
            incoming: bytes_rx,
            pending: Bytes::new(),
            outgoing: PollSender::new(out_tx.clone()),
        },
        WsText {
            incoming: text_rx,
            outgoing: out_tx,
        },
    )
}

impl AsyncRead for WsBytes {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.pending.is_empty() {
            match ready!(self.incoming.poll_recv(cx)) {
                Some(bytes) => self.pending = bytes,
                // The WebSocket is gone: end of stream.
                None => return Poll::Ready(Ok(())),
            }
        }
        let n = self.pending.len().min(buf.remaining());
        buf.put_slice(&self.pending.split_to(n));
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for WsBytes {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        ready!(self.outgoing.poll_reserve(cx)).map_err(|_| closed())?;
        self.outgoing
            .send_item(Outgoing::Binary(Bytes::copy_from_slice(buf)))
            .map_err(|_| closed())?;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.outgoing.close();
        Poll::Ready(Ok(()))
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the tunnel closed")
}

/// Sends one message, unless the peer goes silent for [`SILENT_AFTER`]
/// first: a send waits while the socket is full, and the ping tick that
/// checks for silence is not reached meanwhile, so a path that died in the
/// middle of an upload would otherwise wait the kernel's quarter of an hour.
/// The peer may still be heard while the send waits (its pings, its own
/// bytes), which moves the deadline on. False when the send failed or the
/// peer is taken as gone.
async fn send_unless_silent<S>(
    sink: &mut S,
    message: Message,
    heard: &Mutex<tokio::time::Instant>,
) -> bool
where
    S: futures::Sink<Message> + Unpin,
{
    let send = sink.send(message);
    tokio::pin!(send);
    loop {
        let deadline = *heard.lock().unwrap_or_else(|e| e.into_inner()) + SILENT_AFTER;
        tokio::select! {
            sent = &mut send => return sent.is_ok(),
            () = tokio::time::sleep_until(deadline) => {
                if silent_for(heard) >= SILENT_AFTER {
                    return false;
                }
            }
        }
    }
}

/// How long since the peer last sent anything.
fn silent_for(heard: &Mutex<tokio::time::Instant>) -> Duration {
    heard.lock().unwrap_or_else(|e| e.into_inner()).elapsed()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio_tungstenite::tungstenite::protocol::Role;

    use super::*;

    /// Copies one way until `silent` is set, then swallows what comes: a
    /// network path that stops delivering without closing anything.
    fn relay(
        mut from: tokio::io::ReadHalf<DuplexStream>,
        mut to: tokio::io::WriteHalf<DuplexStream>,
        silent: Arc<AtomicBool>,
    ) {
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                let Ok(n) = from.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                if !silent.load(Ordering::Relaxed) && to.write_all(&buf[..n]).await.is_err() {
                    return;
                }
            }
        });
    }

    /// Copies one way until `dead` is set, then neither delivers nor reads:
    /// a path whose packets vanish, so the sender's socket fills.
    fn dying_relay(
        mut from: tokio::io::ReadHalf<DuplexStream>,
        mut to: tokio::io::WriteHalf<DuplexStream>,
        dead: Arc<AtomicBool>,
    ) {
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                if dead.load(Ordering::Relaxed) {
                    // Both halves stay open, moving nothing.
                    std::future::pending::<()>().await;
                }
                let Ok(n) = from.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                if dead.load(Ordering::Relaxed) {
                    continue;
                }
                if to.write_all(&buf[..n]).await.is_err() {
                    return;
                }
            }
        });
    }

    #[tokio::test(start_paused = true)]
    async fn a_peer_that_goes_silent_mid_upload_ends_the_tunnel_too() {
        let dead = Arc::new(AtomicBool::new(false));
        let (a, a_relay) = tokio::io::duplex(64 * 1024);
        let (b_relay, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a_relay);
        let (br, bw) = tokio::io::split(b_relay);
        dying_relay(ar, bw, dead.clone());
        dying_relay(br, aw, dead.clone());
        let a = WebSocketStream::from_raw_socket(a, Role::Client, Some(config())).await;
        let b = WebSocketStream::from_raw_socket(b, Role::Server, Some(config())).await;
        let (a_bytes, _a_text) = split(a);
        let (mut b_bytes, _b_text) = split(b);
        let (mut a_read, mut a_write) = tokio::io::split(a_bytes);
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            while let Ok(n) = b_bytes.read(&mut buf).await {
                if n == 0 {
                    break;
                }
            }
        });
        a_write.write_all(b"hello").await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        // The path dies while A is sending an answer larger than any buffer
        // on the way: its send waits on a full socket from then on.
        dead.store(true, Ordering::Relaxed);
        tokio::spawn(async move {
            let chunk = vec![1u8; 16 * 1024];
            while a_write.write_all(&chunk).await.is_ok() {}
        });
        let started = tokio::time::Instant::now();
        let mut rest = Vec::new();
        let ended =
            tokio::time::timeout(Duration::from_secs(900), a_read.read_to_end(&mut rest)).await;
        assert!(matches!(ended, Ok(Ok(_))), "still open: {ended:?}");
        let took = started.elapsed();
        assert!(took <= SILENT_AFTER + PING_EVERY * 2, "{took:?}");
    }

    /// Two ends joined through a relay that can go silent.
    async fn joined(silent: Arc<AtomicBool>) -> ((WsBytes, WsText), (WsBytes, WsText)) {
        let (a, a_relay) = tokio::io::duplex(64 * 1024);
        let (b_relay, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a_relay);
        let (br, bw) = tokio::io::split(b_relay);
        relay(ar, bw, silent.clone());
        relay(br, aw, silent);
        let a = WebSocketStream::from_raw_socket(a, Role::Client, Some(config())).await;
        let b = WebSocketStream::from_raw_socket(b, Role::Server, Some(config())).await;
        (split(a), split(b))
    }

    #[tokio::test(start_paused = true)]
    async fn a_peer_that_goes_silent_ends_the_tunnel_on_both_sides() {
        let silent = Arc::new(AtomicBool::new(false));
        let ((mut a, _a_text), (mut b, _b_text)) = joined(silent.clone()).await;
        // Bytes go through while the path works.
        a.write_all(b"hello").await.unwrap();
        let mut got = [0u8; 5];
        b.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello");
        // A quiet but healthy tunnel stays open: pings keep both alive.
        tokio::time::sleep(SILENT_AFTER * 3).await;
        a.write_all(b"still").await.unwrap();
        let mut got = [0u8; 5];
        b.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"still");
        // Then the path goes silent, with nothing closed.
        silent.store(true, Ordering::Relaxed);
        let started = tokio::time::Instant::now();
        let mut rest = Vec::new();
        let a_end = tokio::time::timeout(Duration::from_secs(300), a.read_to_end(&mut rest)).await;
        let b_end = tokio::time::timeout(Duration::from_secs(300), b.read_to_end(&mut rest)).await;
        assert!(matches!(a_end, Ok(Ok(0))), "{a_end:?}");
        assert!(matches!(b_end, Ok(Ok(0))), "{b_end:?}");
        let took = started.elapsed();
        assert!(took >= SILENT_AFTER, "{took:?}");
        assert!(took <= SILENT_AFTER + PING_EVERY * 2, "{took:?}");
    }
}
