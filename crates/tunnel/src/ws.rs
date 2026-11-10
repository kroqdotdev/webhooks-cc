//! A WebSocket as a byte stream, for yamux. Binary messages are the
//! bytes; text messages travel beside them as JSON ([`crate::EdgeMessage`]).
//! A ping goes out every [`PING_EVERY`] so that Cloudflare, which drops
//! WebSockets idle for 100 seconds, keeps the tunnel open.

use std::io;
use std::pin::Pin;
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
                _ = ping.tick() => Message::Ping(Bytes::new()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
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
