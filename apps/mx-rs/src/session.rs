//! One SMTP session, from banner to QUIT.
//!
//! The session speaks to the network through `Conn` (plain or TLS after
//! STARTTLS) and to the rest of the system through `Backend`, so tests can
//! drive it over an in-memory stream with a fake backend.

use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use smtp_proto::request::receiver::{DataReceiver, DummyDataReceiver, RequestReceiver};
use smtp_proto::{Error as SmtpError, Request};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

use crate::auth_check::{AuthOutcome, AuthRequest, ReverseDns, header_section_end};
use crate::config::{MAX_MESSAGE_BYTES, MAX_RECIPIENTS, Timeouts};
use crate::ingest::Delivery;
use crate::limits::{Client, Limiter, SlotGuard, address_key};
use crate::reply::{self, CheckStatus, DeliverOutcome, Reply};
use crate::retry_store::{self, Attempt, RetryStore};
use crate::tls::TlsProvider;

/// Errors tolerated before the connection is closed.
const MAX_ERRORS: u32 = 5;
/// Non-transactional commands (EHLO, NOOP, RSET, ...) per session before the
/// connection is closed. MAIL, RCPT and DATA are bounded by the message and
/// recipient limits instead, so a sender may reuse one connection for many
/// messages.
const MAX_COMMANDS: u32 = 100;
/// Header sections longer than this are refused: no legitimate message comes
/// close, and the receiver would cut them anyway.
const MAX_HEADER_SECTION: usize = 1024 * 1024;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const READ_CHUNK: usize = 16 * 1024;

/// What a session needs from the rest of the system.
pub trait Backend: Send + Sync + 'static {
    fn check_recipient(&self, address: &str) -> impl Future<Output = CheckStatus> + Send;
    fn deliver(&self, delivery: Delivery) -> impl Future<Output = DeliverOutcome> + Send;
    fn authenticate(&self, request: AuthRequest) -> impl Future<Output = AuthOutcome> + Send;
}

/// State shared by all sessions.
pub struct Shared<B: Backend> {
    pub backend: B,
    pub hostname: String,
    pub tls: Option<Arc<TlsProvider>>,
    pub limiter: Arc<Limiter>,
    pub retry_store: Arc<RetryStore>,
    /// Bounds how many messages are buffered at once.
    pub data_slots: Arc<Semaphore>,
    pub timeouts: Timeouts,
}

/// What is known about the client before the session starts.
#[derive(Debug, Clone)]
pub struct Peer {
    pub ip: IpAddr,
    pub client: Client,
    pub reverse_dns: ReverseDns,
}

/// Plain TCP, or TLS after STARTTLS.
enum Conn<S> {
    Plain(S),
    Tls(Box<tokio_rustls::server::TlsStream<S>>),
    /// Only while the handshake owns the stream.
    Gone,
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::NotConnected, "connection handed to TLS")
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Conn<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            Conn::Gone => Poll::Ready(Err(gone())),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Conn<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            Conn::Gone => Poll::Ready(Err(gone())),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_flush(cx),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            Conn::Gone => Poll::Ready(Err(gone())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            Conn::Gone => Poll::Ready(Ok(())),
        }
    }
}

/// Counts for the one log line a session writes when it ends. No addresses
/// and no content, by design.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Stats {
    pub messages_accepted: u32,
    pub messages_refused: u32,
    pub messages_deferred: u32,
    pub recipients_refused: u32,
    pub tls: bool,
    pub closed_by: &'static str,
}

#[derive(Default)]
struct Transaction {
    /// Envelope sender; `Some("")` for a null sender.
    mail_from: Option<String>,
    recipients: Vec<String>,
}

enum Flow {
    Continue,
    Close(&'static str),
}

/// The slots a DATA transfer holds while its message is in memory.
struct DataSlots {
    _client: SlotGuard,
    _global: OwnedSemaphorePermit,
}

pub struct Session<'a, B: Backend, S> {
    shared: &'a Shared<B>,
    conn: Conn<S>,
    peer: Peer,
    shutdown: watch::Receiver<bool>,
    deadline: Instant,
    /// Bytes read but not yet handled.
    pending: Vec<u8>,
    receiver: RequestReceiver,
    helo: Option<String>,
    tls_info: Option<serde_json::Value>,
    tx: Transaction,
    errors: u32,
    commands: u32,
    bad_recipients: u32,
    stats: Stats,
}

impl<'a, B: Backend, S: AsyncRead + AsyncWrite + Unpin + Send> Session<'a, B, S> {
    pub fn new(
        shared: &'a Shared<B>,
        stream: S,
        peer: Peer,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        Self {
            deadline: Instant::now() + shared.timeouts.session,
            shared,
            conn: Conn::Plain(stream),
            peer: Peer {
                ip: peer.ip.to_canonical(),
                ..peer
            },
            shutdown,
            pending: Vec::new(),
            receiver: RequestReceiver::default(),
            helo: None,
            tls_info: None,
            tx: Transaction::default(),
            errors: 0,
            commands: 0,
            bad_recipients: 0,
            stats: Stats::default(),
        }
    }

    pub async fn run(mut self) -> Stats {
        // RFC 5321 greetings carry no enhanced status code; write it plainly.
        let banner = format!("220 {} ESMTP webhooks.cc\r\n", self.shared.hostname);
        if self.write_raw(banner.as_bytes()).await.is_err() {
            self.stats.closed_by = "write_failed";
            return self.stats;
        }
        let reason = self.command_loop().await;
        self.stats.closed_by = reason;
        let _ = self.conn.shutdown().await;
        self.stats
    }

    async fn write_raw(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.conn.write_all(bytes).await?;
        self.conn.flush().await
    }

    async fn reply(&mut self, reply: &Reply) -> io::Result<()> {
        self.write_raw(&reply.to_bytes()).await
    }

    /// Read more bytes into `pending`; returns how many. `Err(reason)` ends
    /// the session.
    async fn read_more(
        &mut self,
        timeout: Duration,
        interruptible: bool,
    ) -> Result<usize, &'static str> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = self.reply(&reply::TIMEOUT).await;
            return Err("session_timeout");
        }
        let wait = timeout.min(remaining);
        let start = self.pending.len();
        self.pending.resize(start + READ_CHUNK, 0);
        let mut shutdown = self.shutdown.clone();
        let read = tokio::select! {
            read = tokio::time::timeout(wait, self.conn.read(&mut self.pending[start..])) => read,
            // The guard `wait_for` returns is dropped inside this block, so it
            // is never held across the reply below.
            () = async { let _ = shutdown.wait_for(|stop| *stop).await; }, if interruptible => {
                self.pending.truncate(start);
                let _ = self.reply(&reply::SHUTTING_DOWN).await;
                return Err("shutdown");
            }
        };
        match read {
            Ok(Ok(0)) => {
                self.pending.truncate(start);
                Err("client_closed")
            }
            Ok(Ok(n)) => {
                self.pending.truncate(start + n);
                Ok(n)
            }
            Ok(Err(_)) => {
                self.pending.truncate(start);
                Err("read_failed")
            }
            Err(_) => {
                self.pending.truncate(start);
                let _ = self.reply(&reply::TIMEOUT).await;
                Err("timeout")
            }
        }
    }

    async fn command_loop(&mut self) -> &'static str {
        loop {
            if self.pending.is_empty()
                && let Err(reason) = self.read_more(self.shared.timeouts.command, true).await
            {
                return reason;
            }
            let bytes = std::mem::take(&mut self.pending);
            let mut iter = bytes.iter();
            loop {
                let parsed = self.receiver.ingest(&mut iter).map(Request::into_owned);
                match parsed {
                    Ok(request) => {
                        let transactional = matches!(
                            request,
                            Request::Mail { .. } | Request::Rcpt { .. } | Request::Data
                        );
                        if !transactional {
                            self.commands += 1;
                            if self.commands > MAX_COMMANDS {
                                let _ = self.reply(&reply::TOO_MANY_COMMANDS).await;
                                return "too_many_commands";
                            }
                        }
                        // DATA and STARTTLS consume what follows the command
                        // themselves, so hand the rest over before running it.
                        self.pending = iter.as_slice().to_vec();
                        match self.handle(request).await {
                            Ok(Flow::Continue) => {}
                            Ok(Flow::Close(reason)) => return reason,
                            Err(_) if self.errors > MAX_ERRORS => return "too_many_errors",
                            Err(_) => return "write_failed",
                        }
                        break;
                    }
                    Err(SmtpError::NeedsMoreData { .. }) => break,
                    Err(e) => {
                        let reply = match e {
                            SmtpError::UnknownCommand => reply::UNKNOWN_COMMAND,
                            SmtpError::InvalidSenderAddress => reply::BAD_SENDER,
                            SmtpError::InvalidRecipientAddress => {
                                reply::rcpt_reply(CheckStatus::Invalid)
                            }
                            SmtpError::ResponseTooLong => reply::LINE_TOO_LONG,
                            SmtpError::UnsupportedParameter { .. } => {
                                Reply::new(555, 5, 5, 4, "Unsupported parameter")
                            }
                            _ => reply::BAD_SYNTAX,
                        };
                        if self.error(&reply).await.is_err() {
                            return if self.errors > MAX_ERRORS {
                                "too_many_errors"
                            } else {
                                "write_failed"
                            };
                        }
                    }
                }
            }
        }
    }

    /// Reply with an error and count it; `Err` once the limit is reached and
    /// the connection is being closed.
    async fn error(&mut self, reply: &Reply) -> Result<(), ()> {
        self.errors += 1;
        if self.errors > MAX_ERRORS {
            let _ = self.reply(&reply::TOO_MANY_ERRORS).await;
            return Err(());
        }
        self.reply(reply).await.map_err(|_| ())
    }

    /// Like `error`, but as an `io::Result` for use inside `handle`.
    async fn count_error(&mut self, reply: &Reply) -> io::Result<()> {
        self.error(reply)
            .await
            .map_err(|()| io::Error::other("too many errors"))
    }

    async fn handle(&mut self, request: Request<String>) -> io::Result<Flow> {
        match request {
            Request::Ehlo { host } => {
                self.helo = Some(host);
                self.tx = Transaction::default();
                let offer_tls = self.tls_info.is_none()
                    && self
                        .shared
                        .tls
                        .as_ref()
                        .is_some_and(|tls| tls.acceptor().is_some());
                let ehlo = reply::ehlo(&self.shared.hostname, MAX_MESSAGE_BYTES, offer_tls);
                self.write_raw(&ehlo).await?;
            }
            Request::Helo { host } => {
                self.helo = Some(host);
                self.tx = Transaction::default();
                let line = format!("250 {}\r\n", self.shared.hostname);
                self.write_raw(line.as_bytes()).await?;
            }
            Request::StartTls => return self.start_tls().await,
            Request::Mail { from } => {
                if self.helo.is_none() {
                    self.count_error(&reply::NEED_HELO).await?;
                } else if self.tx.mail_from.is_some() {
                    self.count_error(&reply::NESTED_MAIL).await?;
                } else if from.size > MAX_MESSAGE_BYTES {
                    self.reply(&reply::MESSAGE_TOO_BIG).await?;
                } else if !self
                    .shared
                    .limiter
                    .allow_message(self.peer.client, Instant::now())
                {
                    self.reply(&reply::RATE_LIMITED).await?;
                } else {
                    self.tx.mail_from = Some(from.address);
                    self.reply(&reply::SENDER_OK).await?;
                }
            }
            Request::Rcpt { to } => return self.rcpt(to.address).await,
            Request::Data => return self.data().await,
            Request::Rset => {
                self.tx = Transaction::default();
                self.reply(&reply::OK).await?;
            }
            Request::Noop { .. } => self.reply(&reply::OK).await?,
            Request::Quit => {
                self.reply(&reply::BYE).await?;
                return Ok(Flow::Close("quit"));
            }
            Request::Vrfy { .. } => self.reply(&reply::VRFY_UNSUPPORTED).await?,
            Request::Help { .. } => self.reply(&reply::HELP).await?,
            // BDAT is followed by raw chunk bytes that would otherwise be read
            // as commands; CHUNKING is not advertised, so close instead.
            Request::Bdat { .. } => {
                self.reply(&reply::NOT_IMPLEMENTED).await?;
                return Ok(Flow::Close("bdat"));
            }
            Request::Lhlo { .. }
            | Request::Expn { .. }
            | Request::Auth { .. }
            | Request::Etrn { .. }
            | Request::Atrn { .. }
            | Request::Burl { .. } => self.count_error(&reply::NOT_IMPLEMENTED).await?,
        }
        Ok(Flow::Continue)
    }

    async fn start_tls(&mut self) -> io::Result<Flow> {
        let acceptor = self.shared.tls.as_ref().and_then(|tls| tls.acceptor());
        let Some(acceptor) = acceptor else {
            self.count_error(&reply::TLS_UNAVAILABLE).await?;
            return Ok(Flow::Continue);
        };
        if self.tls_info.is_some() {
            self.count_error(&reply::ALREADY_TLS).await?;
            return Ok(Flow::Continue);
        }
        self.reply(&reply::READY_FOR_TLS).await?;
        // Anything the client sent after STARTTLS in plaintext is discarded
        // (RFC 3207), so it cannot be injected into the encrypted session.
        self.pending.clear();
        self.receiver = RequestReceiver::default();
        let Conn::Plain(stream) = std::mem::replace(&mut self.conn, Conn::Gone) else {
            return Ok(Flow::Close("tls_state"));
        };
        let handshake = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await;
        match handshake {
            Ok(Ok(tls)) => {
                let (_, connection) = tls.get_ref();
                self.tls_info = Some(serde_json::json!({
                    "version": connection.protocol_version().map(|v| format!("{v:?}")),
                    "cipher": connection.negotiated_cipher_suite().map(|c| format!("{:?}", c.suite())),
                }));
                self.conn = Conn::Tls(Box::new(tls));
                self.stats.tls = true;
                // RFC 3207: forget everything learned before the handshake.
                self.helo = None;
                self.tx = Transaction::default();
                Ok(Flow::Continue)
            }
            Ok(Err(_)) => Ok(Flow::Close("tls_failed")),
            Err(_) => Ok(Flow::Close("tls_timeout")),
        }
    }

    async fn rcpt(&mut self, address: String) -> io::Result<Flow> {
        if self.tx.mail_from.is_none() {
            self.count_error(&reply::NEED_MAIL).await?;
            return Ok(Flow::Continue);
        }
        // `<>` and a bare `<Postmaster>`: there is no such mailbox here, and
        // asking the receiver about them would only count against the sender.
        if address.is_empty() || address.eq_ignore_ascii_case("postmaster") {
            self.stats.recipients_refused += 1;
            self.reply(&reply::rcpt_reply(CheckStatus::Unknown)).await?;
            return Ok(Flow::Continue);
        }
        if self
            .tx
            .recipients
            .iter()
            .any(|accepted| accepted.eq_ignore_ascii_case(&address))
        {
            self.reply(&reply::RECIPIENT_OK).await?;
            return Ok(Flow::Continue);
        }
        if self.tx.recipients.len() >= MAX_RECIPIENTS {
            self.reply(&reply::TOO_MANY_RECIPIENTS).await?;
            return Ok(Flow::Continue);
        }
        let status = self.shared.backend.check_recipient(&address).await;
        if status != CheckStatus::Ok {
            self.stats.recipients_refused += 1;
        }
        if status.is_bad_recipient() {
            self.bad_recipients += 1;
            if self.bad_recipients > self.shared.limiter.limits().bad_recipients_per_session {
                self.reply(&reply::BLOCKED).await?;
                return Ok(Flow::Close("too_many_bad_recipients"));
            }
        }
        if status == CheckStatus::Ok {
            if !self.shared.limiter.allow_address(
                self.peer.client,
                &address_key(&address),
                Instant::now(),
            ) {
                self.reply(&reply::RATE_LIMITED).await?;
                return Ok(Flow::Continue);
            }
            self.tx.recipients.push(address);
        }
        self.reply(&reply::rcpt_reply(status)).await?;
        Ok(Flow::Continue)
    }

    async fn data(&mut self) -> io::Result<Flow> {
        if self.tx.mail_from.is_none() {
            self.count_error(&reply::NEED_MAIL).await?;
            return Ok(Flow::Continue);
        }
        if self.tx.recipients.is_empty() {
            self.reply(&reply::NO_VALID_RECIPIENTS).await?;
            return Ok(Flow::Continue);
        }
        // One client may not hold every buffer: its own cap first, then a
        // global slot.
        let Some(client_slot) = self.shared.limiter.start_data(self.peer.client) else {
            self.reply(&reply::NO_DATA_SLOT).await?;
            return Ok(Flow::Continue);
        };
        let global = tokio::time::timeout(
            self.shared.timeouts.data_slot_wait,
            self.shared.data_slots.clone().acquire_owned(),
        )
        .await;
        let Ok(Ok(global_slot)) = global else {
            self.reply(&reply::NO_DATA_SLOT).await?;
            return Ok(Flow::Continue);
        };
        self.write_raw(reply::START_DATA).await?;

        let slots = DataSlots {
            _client: client_slot,
            _global: global_slot,
        };
        let (message, slots) = match self.read_message(slots).await {
            Ok(Some(read)) => read,
            Ok(None) => {
                self.stats.messages_refused += 1;
                self.tx = Transaction::default();
                self.reply(&reply::MESSAGE_TOO_BIG).await?;
                return Ok(Flow::Continue);
            }
            Err(reason) => return Ok(Flow::Close(reason)),
        };

        // Only the start needs looking at: a header section that has not
        // ended by then is too large either way.
        let head = &message[..message.len().min(MAX_HEADER_SECTION + 4)];
        let header_end = header_section_end(head).unwrap_or(message.len());
        let (verdict, attempt) = if header_end > MAX_HEADER_SECTION {
            (Reply::new(552, 5, 3, 4, "Message header too large"), None)
        } else {
            self.deliver(message).await
        };
        drop(slots);
        if verdict.is_success() {
            self.stats.messages_accepted += 1;
        } else if verdict.is_transient() {
            self.stats.messages_deferred += 1;
        } else {
            self.stats.messages_refused += 1;
        }
        self.tx = Transaction::default();
        let written = self.reply(&verdict).await;
        // Settled only once a definitive answer has actually been written:
        // had the write failed, the sender would try again, and that attempt
        // must count as a retry.
        if let Some((attempt, definitive)) = attempt {
            self.shared.retry_store.finish(
                attempt,
                definitive && written.is_ok(),
                chrono::Utc::now().timestamp() as u64,
            );
        }
        written?;
        Ok(Flow::Continue)
    }

    /// The message after DATA, dot-unstuffed, without the final ".", and the
    /// slots it holds. `Ok(None)` when it was larger than the limit: it is
    /// read to the end and discarded, and its slots are released as soon as
    /// it goes over. `Err` ends the session (timeout, too slow, gone).
    async fn read_message(
        &mut self,
        slots: DataSlots,
    ) -> Result<Option<(Vec<u8>, DataSlots)>, &'static str> {
        let mut receiver = DataReceiver::new();
        let mut message = Vec::new();
        // The receiver only recognises "." as the end after a line break, so
        // start it as if one had just been seen; that also makes an empty
        // message (".") work.
        receiver.ingest(&mut b"\r\n".iter(), &mut message);
        message.clear();

        let limits = self.shared.limiter.limits().clone();
        let mut slots = Some(slots);
        let mut discard: Option<DummyDataReceiver> = None;
        let started = Instant::now();
        let data_deadline = started + self.shared.timeouts.data;
        let mut received: u64 = self.pending.len() as u64;
        loop {
            if self.pending.is_empty() {
                let now = Instant::now();
                let remaining = data_deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    let _ = self.reply(&reply::TIMEOUT).await;
                    return Err("data_timeout");
                }
                let elapsed = now.duration_since(started);
                let expected = u64::try_from(elapsed.as_millis())
                    .unwrap_or(u64::MAX)
                    .saturating_mul(limits.min_data_rate)
                    / 1000;
                if elapsed > limits.min_data_rate_after && received < expected {
                    let _ = self
                        .reply(&Reply::new(421, 4, 4, 2, "Data transfer too slow"))
                        .await;
                    return Err("data_too_slow");
                }
                let n = self
                    .read_more(self.shared.timeouts.command.min(remaining), false)
                    .await
                    .map_err(|reason| match reason {
                        "timeout" => "data_timeout",
                        other => other,
                    })?;
                received += n as u64;
            }
            let bytes = std::mem::take(&mut self.pending);
            let mut iter = bytes.iter();
            let done = match discard.as_mut() {
                Some(dummy) => dummy.ingest(&mut iter),
                None => receiver.ingest(&mut iter, &mut message),
            };
            if discard.is_none() && message.len() > MAX_MESSAGE_BYTES {
                discard = Some(DummyDataReceiver::new_data(&receiver));
                message = Vec::new();
                slots = None;
            }
            if done {
                self.pending = iter.as_slice().to_vec();
                return Ok(match (discard, slots) {
                    (None, Some(slots)) => Some((message, slots)),
                    _ => None,
                });
            }
        }
    }

    /// Hand the message to the receiver. Returns the reply, and the retry
    /// store's attempt with whether the reply is definitive, to be finished
    /// once the reply has been written.
    async fn deliver(&mut self, raw: Vec<u8>) -> (Reply, Option<(Attempt, bool)>) {
        let raw = Arc::new(raw);
        let helo = self.helo.clone().unwrap_or_default();
        let mail_from = self.tx.mail_from.clone().unwrap_or_default();
        let auth = self
            .shared
            .backend
            .authenticate(AuthRequest {
                ip: self.peer.ip,
                helo,
                mail_from: mail_from.clone(),
                raw: raw.clone(),
                reverse_dns: self.peer.reverse_dns.clone(),
            })
            .await;
        let (hashed, recipients) = (raw.clone(), self.tx.recipients.clone());
        let hash = tokio::task::spawn_blocking(move || retry_store::key(&hashed, &recipients))
            .await
            .ok();

        // Record the attempt before handing the message over: if the delivery
        // dies half way (crash, restart), the receiver may have stored it, and
        // the sender's next attempt must be flagged as a retry.
        let now = chrono::Utc::now();
        let attempt = hash.map(|hash| self.shared.retry_store.begin(&hash, now.timestamp() as u64));
        let retry = attempt.as_ref().is_some_and(|attempt| attempt.retry);

        let size = raw.len();
        let recipients = self.tx.recipients.len();
        let reverse_dns = &self.peer.reverse_dns;
        let outcome = self
            .shared
            .backend
            .deliver(Delivery {
                recipients: self.tx.recipients.clone(),
                envelope_from: mail_from,
                client_ip: self.peer.ip.to_string(),
                // Only a forward-confirmed name: an unconfirmed PTR is
                // whatever the sender's network operator chose to publish.
                client_rdns: reverse_dns
                    .confirmed
                    .then(|| reverse_dns.name.clone())
                    .flatten(),
                helo: self.helo.clone(),
                tls: self.tls_info.clone(),
                auth: auth.json,
                received_at: now,
                retry,
                raw,
            })
            .await;
        let verdict = reply::data_reply(&outcome);
        tracing::info!(
            ip = %self.peer.ip,
            trusted = self.peer.client.trusted,
            recipients,
            size,
            retry,
            code = verdict.reply.code,
            "message"
        );
        let definitive = !verdict.remember_for_retry;
        (verdict.reply, attempt.map(|attempt| (attempt, definitive)))
    }
}

#[cfg(test)]
mod tests;
