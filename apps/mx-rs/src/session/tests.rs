use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use rustls_pki_types::pem::PemObject;
use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

use super::*;
use crate::config::Limits;
use crate::tls::test_cert;

const CLIENT_IP: &str = "192.0.2.25";

/// What `authenticate` was asked, minus the message.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SeenAuth {
    ip: IpAddr,
    helo: String,
    mail_from: String,
    reverse_dns: ReverseDns,
}

#[derive(Default)]
struct FakeBackend {
    /// Check answers by lowercased address; anything else is `Ok`.
    statuses: HashMap<String, CheckStatus>,
    outcome: Mutex<Option<DeliverOutcome>>,
    deliveries: Mutex<Vec<Delivery>>,
    auth_requests: Mutex<Vec<SeenAuth>>,
    checks: AtomicUsize,
    /// Set to observe the retry store from inside a delivery.
    store: Mutex<Option<Arc<RetryStore>>>,
    /// Whether each delivery's hash was in the store while it ran.
    in_store_during_deliver: Mutex<Vec<bool>>,
    /// Makes each delivery take this long.
    delay: Option<Duration>,
    /// Makes each recipient check take this long.
    check_delay: Option<Duration>,
}

impl FakeBackend {
    fn with_status(mut self, address: &str, status: CheckStatus) -> Self {
        self.statuses.insert(address.to_ascii_lowercase(), status);
        self
    }

    fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = Some(delay);
        self
    }

    fn with_check_delay(mut self, delay: Duration) -> Self {
        self.check_delay = Some(delay);
        self
    }

    fn set_outcome(&self, outcome: DeliverOutcome) {
        *self.outcome.lock().unwrap() = Some(outcome);
    }

    /// Back to "captured" for every recipient.
    fn reset_outcome(&self) {
        *self.outcome.lock().unwrap() = None;
    }

    fn deliveries(&self) -> Vec<Delivery> {
        self.deliveries.lock().unwrap().clone()
    }
}

fn key_of(raw: &[u8], recipient: &str) -> String {
    retry_store::keys(raw, &[recipient.to_string()]).remove(0)
}

fn unix_now() -> u64 {
    chrono::Utc::now().timestamp() as u64
}

impl Backend for FakeBackend {
    async fn check_recipient(&self, address: &str) -> CheckStatus {
        self.checks.fetch_add(1, Ordering::SeqCst);
        if let Some(delay) = self.check_delay {
            tokio::time::sleep(delay).await;
        }
        self.statuses
            .get(&address.to_ascii_lowercase())
            .copied()
            .unwrap_or(CheckStatus::Ok)
    }

    async fn deliver(&self, delivery: Delivery) -> DeliverOutcome {
        if let Some(store) = self.store.lock().unwrap().clone() {
            let present = retry_store::keys(&delivery.raw, &delivery.recipients)
                .iter()
                .all(|key| store.contains(key, unix_now()));
            self.in_store_during_deliver.lock().unwrap().push(present);
        }
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        let statuses = vec!["captured".to_string(); delivery.recipients.len()];
        self.deliveries.lock().unwrap().push(delivery);
        self.outcome
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(DeliverOutcome::Results(statuses))
    }

    async fn authenticate(&self, request: AuthRequest) -> AuthOutcome {
        self.auth_requests.lock().unwrap().push(SeenAuth {
            ip: request.ip,
            helo: request.helo,
            mail_from: request.mail_from,
            reverse_dns: request.reverse_dns,
        });
        AuthOutcome {
            json: serde_json::json!({ "spf": { "result": "none" } }),
        }
    }
}

fn tls_provider() -> (Arc<TlsProvider>, String) {
    let (cert, key) = test_cert::self_signed();
    let acceptor = crate::tls::acceptor_from_pem(cert.as_bytes(), key.as_bytes()).unwrap();
    (Arc::new(TlsProvider::fixed(acceptor)), cert)
}

fn shared_with(
    backend: FakeBackend,
    limits: Limits,
    timeouts: Timeouts,
    tls: Option<Arc<TlsProvider>>,
) -> Arc<Shared<FakeBackend>> {
    Arc::new(Shared {
        backend,
        hostname: "mx.test".to_string(),
        tls,
        limiter: Limiter::new(limits),
        retry_store: Arc::new(RetryStore::in_memory(Duration::from_secs(3600))),
        data_slots: Arc::new(Semaphore::new(4)),
        timeouts,
    })
}

fn shared(backend: FakeBackend) -> Arc<Shared<FakeBackend>> {
    shared_with(backend, Limits::default(), Timeouts::default(), None)
}

fn limits(change: impl FnOnce(&mut Limits)) -> Limits {
    let mut limits = Limits::default();
    change(&mut limits);
    limits
}

fn timeouts(change: impl FnOnce(&mut Timeouts)) -> Timeouts {
    let mut timeouts = Timeouts::default();
    change(&mut timeouts);
    timeouts
}

fn peer() -> Peer {
    let ip = CLIENT_IP.parse().unwrap();
    Peer {
        ip,
        client: Client::new(ip, false),
        reverse_dns: ReverseDns {
            name: Some("mail.client.test".to_string()),
            confirmed: true,
        },
    }
}

/// The client side of a session.
struct SmtpClient<S> {
    reader: BufReader<ReadHalf<S>>,
    writer: WriteHalf<S>,
}

impl<S: AsyncRead + AsyncWrite> SmtpClient<S> {
    fn new(stream: S) -> Self {
        let (read, write) = tokio::io::split(stream);
        Self {
            reader: BufReader::new(read),
            writer: write,
        }
    }

    async fn send(&mut self, data: &str) {
        self.send_bytes(data.as_bytes()).await;
    }

    async fn send_bytes(&mut self, data: &[u8]) {
        self.writer.write_all(data).await.unwrap();
        self.writer.flush().await.unwrap();
    }

    /// Like `send`, but false once the server has hung up.
    async fn try_send(&mut self, data: &str) -> bool {
        self.writer.write_all(data.as_bytes()).await.is_ok() && self.writer.flush().await.is_ok()
    }

    /// One full reply (all lines); returns the code and the text.
    async fn reply(&mut self) -> (u16, String) {
        let mut text = String::new();
        loop {
            let mut line = String::new();
            let n = tokio::time::timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
                .await
                .expect("reply in time")
                .unwrap();
            assert!(n > 0, "connection closed while waiting for a reply");
            text.push_str(&line);
            if line.as_bytes().get(3) == Some(&b' ') {
                return (line[..3].parse().unwrap(), text);
            }
        }
    }

    async fn expect(&mut self, code: u16) -> String {
        let (got, text) = self.reply().await;
        assert_eq!(got, code, "unexpected reply: {text}");
        text
    }

    async fn closed(&mut self) -> bool {
        let mut line = String::new();
        matches!(
            tokio::time::timeout(Duration::from_secs(5), self.reader.read_line(&mut line)).await,
            Ok(Ok(0))
        )
    }

    /// MAIL, one RCPT and DATA, up to the 354.
    async fn start_message(&mut self, to: &str) {
        self.send(&format!(
            "MAIL FROM:<s@client.test>\r\nRCPT TO:<{to}>\r\nDATA\r\n"
        ))
        .await;
        self.expect(250).await;
        self.expect(250).await;
        self.expect(354).await;
    }
}

type Running = (
    SmtpClient<DuplexStream>,
    tokio::task::JoinHandle<Stats>,
    watch::Sender<bool>,
);

fn start_with(shared: Arc<Shared<FakeBackend>>, peer: Peer) -> Running {
    let (client, server) = tokio::io::duplex(1 << 20);
    let (stop, stopped) = watch::channel(false);
    let handle =
        tokio::spawn(async move { Session::new(&shared, server, peer, stopped).run().await });
    (SmtpClient::new(client), handle, stop)
}

#[tokio::test]
async fn gives_up_on_a_client_that_stops_reading_replies() {
    let shared = shared_with(
        FakeBackend::default(),
        Limits::default(),
        timeouts(|t| t.command = Duration::from_millis(200)),
        None,
    );
    // A small pipe, so the replies fill it once the client stops reading.
    let (client, server) = tokio::io::duplex(256);
    let (_stop, stopped) = watch::channel(false);
    let server_shared = shared.clone();
    let handle = tokio::spawn(async move {
        Session::new(&server_shared, server, peer(), stopped)
            .run()
            .await
    });
    let (mut read, mut write) = tokio::io::split(client);
    let mut banner = [0u8; 16];
    read.read_exact(&mut banner).await.unwrap();
    // Keep the read half alive but never read from it again.
    let _unread = read;
    tokio::spawn(async move {
        let _ = write.write_all("NOOP\r\n".repeat(90).as_bytes()).await;
        // Stay connected without reading.
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    let stats = tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("the session ends although the client never reads")
        .unwrap();
    assert_eq!(stats.closed_by, "write_failed");
}

fn start(shared: Arc<Shared<FakeBackend>>) -> Running {
    start_with(shared, peer())
}

async fn greet(client: &mut SmtpClient<DuplexStream>) {
    client.expect(220).await;
    client.send("EHLO mail.client.test\r\n").await;
    client.expect(250).await;
}

/// A short header, then lines of 1000 bytes and one shorter line, `size`
/// bytes in all.
fn message_of(size: usize) -> Vec<u8> {
    let mut out = b"Subject: size\r\n\r\n".to_vec();
    let line = format!("{}\r\n", "x".repeat(998));
    let body = size - out.len();
    out.extend(line.repeat(body / line.len()).into_bytes());
    let rest = body % line.len();
    if rest > 0 {
        assert!(rest >= 2);
        out.extend(std::iter::repeat_n(b'y', rest - 2));
        out.extend_from_slice(b"\r\n");
    }
    assert_eq!(out.len(), size);
    out
}

#[tokio::test]
async fn captures_a_message_end_to_end() {
    let shared = shared(FakeBackend::default());
    let (mut client, handle, _stop) = start(shared.clone());

    let banner = client.expect(220).await;
    assert!(banner.contains("mx.test ESMTP"));
    client.send("EHLO mail.client.test\r\n").await;
    let ehlo = client.expect(250).await;
    assert!(ehlo.contains("SIZE 10485760"));
    assert!(ehlo.contains("PIPELINING"));
    assert!(!ehlo.contains("STARTTLS"), "no certificate, no STARTTLS");

    client.send("MAIL FROM:<sender@client.test>\r\n").await;
    client.expect(250).await;
    client
        .send("RCPT TO:<Abc123+Signup@mailhooks.cc>\r\n")
        .await;
    client.expect(250).await;
    client.send("DATA\r\n").await;
    client.expect(354).await;
    client.send("Subject: hi\r\n\r\nbody line\r\n.\r\n").await;
    client.expect(250).await;
    client.send("QUIT\r\n").await;
    client.expect(221).await;

    let stats = handle.await.unwrap();
    assert_eq!(stats.messages_accepted, 1);
    assert_eq!(stats.closed_by, "quit");

    let deliveries = shared.backend.deliveries();
    assert_eq!(deliveries.len(), 1);
    let d = &deliveries[0];
    assert_eq!(d.raw.as_slice(), b"Subject: hi\r\n\r\nbody line\r\n");
    assert_eq!(d.recipients, vec!["Abc123+Signup@mailhooks.cc"]);
    assert_eq!(d.envelope_from, "sender@client.test");
    assert_eq!(d.helo.as_deref(), Some("mail.client.test"));
    assert_eq!(d.client_ip, CLIENT_IP);
    assert_eq!(d.client_rdns.as_deref(), Some("mail.client.test"));
    assert_eq!(d.auth, serde_json::json!({ "spf": { "result": "none" } }));
    assert!(!d.retry);
    assert!(d.tls.is_none());

    let auth = shared.backend.auth_requests.lock().unwrap().clone();
    assert_eq!(
        auth,
        vec![SeenAuth {
            ip: CLIENT_IP.parse().unwrap(),
            helo: "mail.client.test".to_string(),
            mail_from: "sender@client.test".to_string(),
            reverse_dns: peer().reverse_dns,
        }]
    );
}

#[tokio::test]
async fn passes_on_only_a_forward_confirmed_reverse_dns_name() {
    let shared = shared(FakeBackend::default());
    let mut unconfirmed = peer();
    unconfirmed.reverse_dns = ReverseDns {
        name: Some("mail.google.com".to_string()),
        confirmed: false,
    };
    let (mut client, _handle, _stop) = start_with(shared.clone(), unconfirmed);
    greet(&mut client).await;
    client.start_message("a@mailhooks.cc").await;
    client.send("x\r\n.\r\n").await;
    client.expect(250).await;
    assert_eq!(shared.backend.deliveries()[0].client_rdns, None);
}

#[tokio::test]
async fn answers_pipelined_commands_in_order() {
    let shared =
        shared(FakeBackend::default().with_status("bad@mailhooks.cc", CheckStatus::Unknown));
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client
        .send("MAIL FROM:<>\r\nRCPT TO:<a@mailhooks.cc>\r\nRCPT TO:<bad@mailhooks.cc>\r\nRCPT TO:<b@mailhooks.cc>\r\nDATA\r\n")
        .await;
    client.expect(250).await;
    client.expect(250).await;
    client.expect(550).await;
    client.expect(250).await;
    client.expect(354).await;
    client.send("x\r\n.\r\nNOOP\r\n").await;
    client.expect(250).await;
    client.expect(250).await;
    let d = &shared.backend.deliveries()[0];
    assert_eq!(d.recipients, vec!["a@mailhooks.cc", "b@mailhooks.cc"]);
    assert_eq!(d.envelope_from, "", "null sender");
}

#[tokio::test]
async fn unstuffs_dots_and_accepts_an_empty_message() {
    let shared = shared(FakeBackend::default());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    for body in [".\r\n", "..leading dot\r\nnext\r\n.\r\n"] {
        client.start_message("a@mailhooks.cc").await;
        client.send(body).await;
        client.expect(250).await;
    }
    let deliveries = shared.backend.deliveries();
    assert_eq!(deliveries[0].raw.as_slice(), b"");
    assert_eq!(deliveries[1].raw.as_slice(), b".leading dot\r\nnext\r\n");
}

#[tokio::test]
async fn refuses_recipients_with_the_receivers_answer() {
    let backend = FakeBackend::default()
        .with_status("guest@mailhooks.cc", CheckStatus::Guest)
        .with_status("full@mailhooks.cc", CheckStatus::OverQuota)
        .with_status("paused@mailhooks.cc", CheckStatus::Paused)
        .with_status("x@example.com", CheckStatus::RelayDenied);
    let (mut client, _handle, _stop) = start(shared(backend));
    greet(&mut client).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(250).await;
    for (address, code) in [
        ("guest@mailhooks.cc", 550),
        ("full@mailhooks.cc", 552),
        ("paused@mailhooks.cc", 451),
        ("x@example.com", 550),
    ] {
        client.send(&format!("RCPT TO:<{address}>\r\n")).await;
        client.expect(code).await;
    }
    client.send("DATA\r\n").await;
    client.expect(554).await;
}

#[tokio::test]
async fn refuses_postmaster_and_the_null_address_without_asking_the_receiver() {
    let shared = shared(FakeBackend::default());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(250).await;
    for rcpt in ["<Postmaster>", "<postmaster>", "<>"] {
        client.send(&format!("RCPT TO:{rcpt}\r\n")).await;
        let (code, text) = client.reply().await;
        assert!((500..600).contains(&code), "{rcpt}: {text}");
    }
    assert_eq!(shared.backend.checks.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn enforces_command_order() {
    let (mut client, _handle, _stop) = start(shared(FakeBackend::default()));
    client.expect(220).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(503).await;
    client.send("EHLO c\r\nRCPT TO:<a@mailhooks.cc>\r\n").await;
    client.expect(250).await;
    client.expect(503).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nMAIL FROM:<t@client.test>\r\n")
        .await;
    client.expect(250).await;
    client.expect(503).await;
    client.send("RSET\r\nRCPT TO:<a@mailhooks.cc>\r\n").await;
    client.expect(250).await;
    client.expect(503).await;
}

#[tokio::test]
async fn a_new_ehlo_resets_the_transaction() {
    let (mut client, _handle, _stop) = start(shared(FakeBackend::default()));
    greet(&mut client).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nEHLO again\r\nRCPT TO:<a@mailhooks.cc>\r\n")
        .await;
    client.expect(250).await;
    client.expect(250).await;
    client.expect(503).await;
}

#[tokio::test]
async fn accepts_exactly_the_advertised_size() {
    let shared = shared(FakeBackend::default());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client
        .send(&format!(
            "MAIL FROM:<s@client.test> SIZE={MAX_MESSAGE_BYTES}\r\nRSET\r\n"
        ))
        .await;
    client.expect(250).await;
    client.expect(250).await;

    client.start_message("a@mailhooks.cc").await;
    client.send_bytes(&message_of(MAX_MESSAGE_BYTES)).await;
    client.send(".\r\n").await;
    client.expect(250).await;
    assert_eq!(shared.backend.deliveries()[0].raw.len(), MAX_MESSAGE_BYTES);

    client.start_message("a@mailhooks.cc").await;
    client.send_bytes(&message_of(MAX_MESSAGE_BYTES + 1)).await;
    client.send(".\r\n").await;
    client.expect(552).await;
    assert_eq!(shared.backend.deliveries().len(), 1);
}

#[tokio::test]
async fn refuses_oversize_messages_releases_the_buffer_and_keeps_the_session() {
    let shared = shared(FakeBackend::default());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;

    client
        .send(&format!(
            "MAIL FROM:<s@client.test> SIZE={}\r\n",
            MAX_MESSAGE_BYTES + 1
        ))
        .await;
    client.expect(552).await;

    client.start_message("a@mailhooks.cc").await;
    assert_eq!(shared.data_slots.available_permits(), 3);
    client
        .send_bytes(&message_of(MAX_MESSAGE_BYTES + 100_000))
        .await;
    // Still inside DATA, but the message is being discarded: its slot is
    // free for others already.
    let freed = async {
        while shared.data_slots.available_permits() != 4 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), freed)
        .await
        .expect("the slot is released while discarding");
    client.send("more\r\n.\r\n").await;
    client.expect(552).await;
    assert!(shared.backend.deliveries().is_empty());

    client.send("NOOP\r\n").await;
    client.expect(250).await;
}

#[tokio::test]
async fn refuses_a_header_section_over_one_mebibyte() {
    let shared = shared(FakeBackend::default());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;

    let header_line = format!("X-Filler: {}\r\n", "h".repeat(988));
    let big_header = format!("{}\r\nbody\r\n", header_line.repeat(1100));
    client.start_message("a@mailhooks.cc").await;
    client.send(&big_header).await;
    client.send(".\r\n").await;
    let text = client.expect(552).await;
    assert!(text.contains("5.3.4"));
    assert!(shared.backend.deliveries().is_empty());

    // A large body under a small header is fine.
    client.start_message("a@mailhooks.cc").await;
    client.send_bytes(&message_of(2 * 1024 * 1024)).await;
    client.send(".\r\n").await;
    client.expect(250).await;
}

#[tokio::test]
async fn caps_recipients_and_ignores_duplicates() {
    let shared = shared(FakeBackend::default());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(250).await;
    client
        .send("RCPT TO:<dup@mailhooks.cc>\r\nRCPT TO:<DUP@mailhooks.cc>\r\n")
        .await;
    client.expect(250).await;
    client.expect(250).await;
    for i in 1..MAX_RECIPIENTS {
        client
            .send(&format!("RCPT TO:<r{i}@mailhooks.cc>\r\n"))
            .await;
        client.expect(250).await;
    }
    client.send("RCPT TO:<one-too-many@mailhooks.cc>\r\n").await;
    client.expect(452).await;
    assert_eq!(
        shared.backend.checks.load(Ordering::SeqCst),
        MAX_RECIPIENTS,
        "the duplicate was not checked again"
    );
}

#[tokio::test]
async fn defers_when_the_receiver_fails_and_flags_the_retry() {
    let shared = shared(FakeBackend::default());
    shared
        .backend
        .set_outcome(DeliverOutcome::Results(vec!["transient".into()]));
    for (attempt, code) in [(0, 451), (1, 250)] {
        if attempt == 1 {
            shared
                .backend
                .set_outcome(DeliverOutcome::Results(vec!["duplicate".into()]));
        }
        let (mut client, _handle, _stop) = start(shared.clone());
        greet(&mut client).await;
        client.start_message("a@mailhooks.cc").await;
        client
            .send("Message-ID: <same@client.test>\r\n\r\nsame bytes\r\n.\r\n")
            .await;
        client.expect(code).await;
    }
    let deliveries = shared.backend.deliveries();
    assert!(!deliveries[0].retry);
    assert!(
        deliveries[1].retry,
        "the second attempt is flagged as a retry"
    );
    // The retry got its definitive answer, so a deliberate re-send of the
    // same bytes later is not mistaken for another retry.
    assert!(
        !shared
            .retry_store
            .contains(&key_of(&deliveries[1].raw, "a@mailhooks.cc"), unix_now())
    );
}

#[tokio::test]
async fn one_endpoints_outcome_does_not_settle_another_endpoints_retry() {
    let shared = shared(FakeBackend::default());
    let raw = "Message-ID: <same@client.test>\r\n\r\nsame bytes\r\n.\r\n";
    for (to, outcome, code) in [
        ("a@mailhooks.cc", "transient", 451),
        ("b@mailhooks.cc", "captured", 250),
        ("a@mailhooks.cc", "duplicate", 250),
    ] {
        shared
            .backend
            .set_outcome(DeliverOutcome::Results(vec![outcome.into()]));
        let (mut client, _handle, _stop) = start(shared.clone());
        greet(&mut client).await;
        client.start_message(to).await;
        client.send(raw).await;
        client.expect(code).await;
    }
    let retries: Vec<bool> = shared
        .backend
        .deliveries()
        .iter()
        .map(|d| d.retry)
        .collect();
    assert_eq!(retries, vec![false, false, true]);
}

#[tokio::test]
async fn a_retry_to_fewer_recipients_is_still_a_retry() {
    let shared = shared(FakeBackend::default());
    let raw = "Message-ID: <subset@client.test>\r\n\r\nsame bytes\r\n.\r\n";
    shared.backend.set_outcome(DeliverOutcome::Results(vec![
        "transient".into(),
        "captured".into(),
    ]));
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nRCPT TO:<a@mailhooks.cc>\r\nRCPT TO:<b@mailhooks.cc>\r\nDATA\r\n")
        .await;
    for code in [250, 250, 250, 354] {
        client.expect(code).await;
    }
    client.send(raw).await;
    client.expect(451).await;

    // The next attempt only reaches b, which already holds a copy.
    shared.backend.reset_outcome();
    client.start_message("b@mailhooks.cc").await;
    client.send(raw).await;
    client.expect(250).await;
    let deliveries = shared.backend.deliveries();
    assert_eq!(deliveries[1].recipients, vec!["b@mailhooks.cc"]);
    assert!(deliveries[1].retry);
}

#[tokio::test]
async fn sends_retried_and_new_recipients_as_separate_deliveries() {
    let shared = shared(FakeBackend::default());
    let raw = "Message-ID: <split@client.test>\r\n\r\nsame bytes\r\n.\r\n";
    shared
        .backend
        .set_outcome(DeliverOutcome::Results(vec!["transient".into()]));
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client.start_message("b@mailhooks.cc").await;
    client.send(raw).await;
    client.expect(451).await;

    // The retry adds a recipient that has never seen the message.
    shared.backend.reset_outcome();
    client
        .send("MAIL FROM:<s@client.test>\r\nRCPT TO:<c@mailhooks.cc>\r\nRCPT TO:<B+tag@mailhooks.cc>\r\nDATA\r\n")
        .await;
    for code in [250, 250, 250, 354] {
        client.expect(code).await;
    }
    client.send(raw).await;
    client.expect(250).await;
    let deliveries = shared.backend.deliveries();
    assert_eq!(deliveries.len(), 3);
    assert_eq!(deliveries[1].recipients, vec!["B+tag@mailhooks.cc"]);
    assert!(deliveries[1].retry, "same endpoint as the deferred attempt");
    assert_eq!(deliveries[2].recipients, vec!["c@mailhooks.cc"]);
    assert!(!deliveries[2].retry);
    assert_eq!(shared.retry_store.len(), 0, "all settled");
}

#[tokio::test]
async fn enforces_the_session_deadline_between_pipelined_commands() {
    let shared = shared_with(
        FakeBackend::default().with_check_delay(Duration::from_millis(100)),
        Limits::default(),
        timeouts(|t| t.session = Duration::from_millis(400)),
        None,
    );
    let (mut client, handle, _stop) = start(shared);
    greet(&mut client).await;
    let mut pipeline = "MAIL FROM:<s@client.test>\r\n".to_string();
    for i in 0..15 {
        pipeline.push_str(&format!("RCPT TO:<r{i}@mailhooks.cc>\r\n"));
    }
    client.send(&pipeline).await;
    let mut answered = 0;
    loop {
        let (code, _) = client.reply().await;
        if code == 421 {
            break;
        }
        answered += 1;
    }
    assert!(answered < 10, "{answered} replies before the deadline hit");
    assert_eq!(handle.await.unwrap().closed_by, "session_timeout");
}

#[tokio::test]
async fn records_the_hash_while_delivering_and_forgets_it_after_a_definitive_answer() {
    let shared = shared(FakeBackend::default());
    *shared.backend.store.lock().unwrap() = Some(shared.retry_store.clone());
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    for _ in 0..2 {
        client.start_message("a@mailhooks.cc").await;
        client
            .send("same bytes, sent on purpose twice\r\n.\r\n")
            .await;
        client.expect(250).await;
    }
    let deliveries = shared.backend.deliveries();
    assert_eq!(
        *shared.backend.in_store_during_deliver.lock().unwrap(),
        vec![true, true],
        "a delivery cut short must leave the hash behind"
    );
    assert!(
        deliveries.iter().all(|d| !d.retry),
        "a deliberate resend is captured again"
    );
    assert_eq!(shared.retry_store.len(), 0);
}

#[tokio::test]
async fn captures_both_of_two_identical_messages_sent_at_the_same_time() {
    let shared = shared(FakeBackend::default().with_delay(Duration::from_millis(200)));
    let send = |shared: Arc<Shared<FakeBackend>>| async move {
        let (mut client, _handle, _stop) = start(shared);
        greet(&mut client).await;
        client.start_message("a@mailhooks.cc").await;
        client.send("identical on purpose\r\n.\r\n").await;
        client.expect(250).await;
    };
    tokio::join!(send(shared.clone()), send(shared.clone()));
    let deliveries = shared.backend.deliveries();
    assert_eq!(deliveries.len(), 2);
    assert!(
        deliveries.iter().all(|d| !d.retry),
        "running at the same time is not a retry"
    );
    assert_eq!(shared.retry_store.len(), 0);
}

#[tokio::test]
async fn keeps_the_hash_when_the_final_reply_cannot_be_written() {
    let shared = shared(FakeBackend::default().with_delay(Duration::from_millis(200)));
    let (mut client, handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client.start_message("a@mailhooks.cc").await;
    client.send("lost reply\r\n.\r\n").await;
    // Hang up while the receiver is still working on it.
    drop(client);
    let stats = handle.await.unwrap();
    assert_eq!(stats.closed_by, "write_failed");
    assert!(
        shared
            .retry_store
            .contains(&key_of(b"lost reply\r\n", "a@mailhooks.cc"), unix_now()),
        "the sender will retry, and that attempt must be flagged"
    );
}

#[tokio::test]
async fn an_answer_missing_recipients_is_a_temporary_failure() {
    let shared = shared(FakeBackend::default());
    shared
        .backend
        .set_outcome(DeliverOutcome::Results(vec!["captured".into()]));
    let (mut client, _handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nRCPT TO:<a@mailhooks.cc>\r\nRCPT TO:<b@mailhooks.cc>\r\nDATA\r\n")
        .await;
    for code in [250, 250, 250, 354] {
        client.expect(code).await;
    }
    client.send("short answer\r\n.\r\n").await;
    client.expect(451).await;
    assert_eq!(shared.retry_store.len(), 2, "both endpoints stay uncertain");
}

#[tokio::test]
async fn refused_messages_are_not_flagged_as_retries() {
    let shared = shared(FakeBackend::default());
    shared
        .backend
        .set_outcome(DeliverOutcome::Results(vec!["over_quota".into()]));
    for code in [552, 552] {
        let (mut client, _handle, _stop) = start(shared.clone());
        greet(&mut client).await;
        client.start_message("a@mailhooks.cc").await;
        client.send("same\r\n.\r\n").await;
        client.expect(code).await;
    }
    assert!(shared.backend.deliveries().iter().all(|d| !d.retry));
}

#[tokio::test]
async fn closes_after_too_many_errors() {
    let (mut client, handle, _stop) = start(shared(FakeBackend::default()));
    client.expect(220).await;
    for _ in 0..MAX_ERRORS {
        client.send("BOGUS\r\n").await;
        client.expect(500).await;
    }
    client.send("BOGUS\r\n").await;
    client.expect(421).await;
    assert!(client.closed().await);
    assert_eq!(handle.await.unwrap().closed_by, "too_many_errors");
}

#[tokio::test]
async fn caps_non_transactional_commands_but_not_messages() {
    let shared = shared(FakeBackend::default());
    let (mut client, handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    // Many messages over one connection are normal for a sending server.
    for _ in 0..40 {
        client.start_message("a@mailhooks.cc").await;
        client.send("x\r\n.\r\n").await;
        client.expect(250).await;
    }
    assert_eq!(shared.backend.deliveries().len(), 40);
    // EHLO above was command 1.
    for _ in 1..MAX_COMMANDS {
        client.send("NOOP\r\n").await;
        client.expect(250).await;
    }
    client.send("NOOP\r\n").await;
    client.expect(421).await;
    assert_eq!(handle.await.unwrap().closed_by, "too_many_commands");
}

#[tokio::test]
async fn closes_the_session_after_too_many_refused_recipients() {
    let mut backend = FakeBackend::default();
    for i in 0..5 {
        backend = backend.with_status(&format!("p{i}@mailhooks.cc"), CheckStatus::Unknown);
    }
    let shared = shared_with(
        backend,
        limits(|l| l.bad_recipients_per_session = 2),
        Timeouts::default(),
        None,
    );
    let (mut client, handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(250).await;
    for i in 0..2 {
        client
            .send(&format!("RCPT TO:<p{i}@mailhooks.cc>\r\n"))
            .await;
        client.expect(550).await;
    }
    client.send("RCPT TO:<p2@mailhooks.cc>\r\n").await;
    client.expect(421).await;
    assert_eq!(handle.await.unwrap().closed_by, "too_many_bad_recipients");

    // Only that session ends: the client is not blocked.
    let (mut client, _handle, _stop) = start(shared);
    greet(&mut client).await;
    client.start_message("a@mailhooks.cc").await;
}

#[tokio::test]
async fn limits_messages_per_client() {
    let shared = shared_with(
        FakeBackend::default(),
        limits(|l| l.messages_per_client_per_hour = 1),
        Timeouts::default(),
        None,
    );
    let (mut client, _handle, _stop) = start(shared);
    greet(&mut client).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nRSET\r\nMAIL FROM:<s@client.test>\r\n")
        .await;
    client.expect(250).await;
    client.expect(250).await;
    client.expect(451).await;
}

#[tokio::test]
async fn limits_messages_per_address_per_client() {
    let shared = shared_with(
        FakeBackend::default(),
        limits(|l| l.messages_per_address_per_minute = 2),
        Timeouts::default(),
        None,
    );
    let (mut client, _handle, _stop) = start(shared);
    greet(&mut client).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(250).await;
    for (rcpt, code) in [
        ("a+one@mailhooks.cc", 250),
        ("a+two@mailhooks.cc", 250),
        ("A+three@mailhooks.cc", 451),
        ("b@mailhooks.cc", 250),
    ] {
        client.send(&format!("RCPT TO:<{rcpt}>\r\n")).await;
        client.expect(code).await;
    }
}

#[tokio::test]
async fn defers_data_when_the_client_or_the_host_has_no_buffer_free() {
    let shared = shared_with(
        FakeBackend::default(),
        limits(|l| l.data_per_client = 0),
        Timeouts::default(),
        None,
    );
    let (mut client, _handle, _stop) = start(shared);
    greet(&mut client).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nRCPT TO:<a@mailhooks.cc>\r\nDATA\r\n")
        .await;
    client.expect(250).await;
    client.expect(250).await;
    let text = client.expect(451).await;
    assert!(text.contains("4.3.1"));

    let shared = Arc::new(Shared {
        data_slots: Arc::new(Semaphore::new(0)),
        ..Arc::into_inner(shared_with(
            FakeBackend::default(),
            Limits::default(),
            timeouts(|t| t.data_slot_wait = Duration::from_millis(50)),
            None,
        ))
        .unwrap()
    });
    let (mut client, _handle, _stop) = start(shared);
    greet(&mut client).await;
    client
        .send("MAIL FROM:<s@client.test>\r\nRCPT TO:<a@mailhooks.cc>\r\nDATA\r\n")
        .await;
    client.expect(250).await;
    client.expect(250).await;
    client.expect(451).await;
    client.send("NOOP\r\n").await;
    client.expect(250).await;
}

#[tokio::test]
async fn times_out_an_idle_client() {
    let shared = shared_with(
        FakeBackend::default(),
        Limits::default(),
        timeouts(|t| t.command = Duration::from_millis(100)),
        None,
    );
    let (mut client, handle, _stop) = start(shared);
    client.expect(220).await;
    client.expect(421).await;
    assert_eq!(handle.await.unwrap().closed_by, "timeout");
}

#[tokio::test]
async fn times_out_a_data_transfer_that_takes_too_long() {
    let shared = shared_with(
        FakeBackend::default(),
        Limits::default(),
        timeouts(|t| t.data = Duration::from_millis(300)),
        None,
    );
    let (mut client, handle, _stop) = start(shared.clone());
    greet(&mut client).await;
    client.start_message("a@mailhooks.cc").await;
    for _ in 0..20 {
        if !client.try_send("still going\r\n").await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    client.expect(421).await;
    assert_eq!(handle.await.unwrap().closed_by, "data_timeout");
    assert!(shared.backend.deliveries().is_empty());
}

#[tokio::test]
async fn closes_a_data_transfer_that_is_too_slow() {
    let shared = shared_with(
        FakeBackend::default(),
        limits(|l| {
            l.min_data_rate = 1_000_000;
            l.min_data_rate_after = Duration::from_millis(100);
        }),
        Timeouts::default(),
        None,
    );
    let (mut client, handle, _stop) = start(shared);
    greet(&mut client).await;
    client.start_message("a@mailhooks.cc").await;
    for _ in 0..10 {
        if !client.try_send("trickle\r\n").await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let text = client.expect(421).await;
    assert!(text.contains("too slow"));
    assert_eq!(handle.await.unwrap().closed_by, "data_too_slow");
}

#[tokio::test]
async fn closes_on_bdat() {
    let (mut client, handle, _stop) = start(shared(FakeBackend::default()));
    greet(&mut client).await;
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(250).await;
    client.send("BDAT 5 LAST\r\nhello").await;
    client.expect(502).await;
    assert!(client.closed().await);
    assert_eq!(handle.await.unwrap().closed_by, "bdat");
}

#[tokio::test]
async fn says_goodbye_on_shutdown_while_idle() {
    let (mut client, handle, stop) = start(shared(FakeBackend::default()));
    greet(&mut client).await;
    stop.send(true).unwrap();
    client.expect(421).await;
    assert_eq!(handle.await.unwrap().closed_by, "shutdown");
}

#[tokio::test]
async fn offers_no_starttls_until_a_certificate_can_be_loaded() {
    let missing = std::path::PathBuf::from("/nonexistent/webhooks-mx-test");
    let tls = Arc::new(TlsProvider::new(
        missing.join("cert.pem"),
        missing.join("key.pem"),
    ));
    let shared = shared_with(
        FakeBackend::default(),
        Limits::default(),
        Timeouts::default(),
        Some(tls),
    );
    let (mut client, _handle, _stop) = start(shared);
    client.expect(220).await;
    client.send("EHLO c\r\n").await;
    assert!(!client.expect(250).await.contains("STARTTLS"));
    client.send("STARTTLS\r\n").await;
    client.expect(454).await;
}

/// Read one full reply byte by byte, so no TLS bytes are buffered.
async fn read_plain_reply(stream: &mut DuplexStream) -> String {
    let mut out = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.unwrap();
        out.push(byte[0]);
        if out.ends_with(b"\r\n") {
            let text = String::from_utf8(out.clone()).unwrap();
            let last = text.trim_end().rsplit("\r\n").next().unwrap().to_string();
            if last.as_bytes().get(3) == Some(&b' ') {
                return text;
            }
        }
    }
}

#[tokio::test]
async fn upgrades_to_tls_discards_injected_plaintext_and_starts_over() {
    use tokio_rustls::TlsConnector;
    use tokio_rustls::rustls::{ClientConfig, RootCertStore, crypto::ring};

    let (tls, cert_pem) = tls_provider();
    let shared = shared_with(
        FakeBackend::default(),
        Limits::default(),
        Timeouts::default(),
        Some(tls),
    );
    let (mut plain, server_stream) = tokio::io::duplex(1 << 20);
    let (_stop, stopped) = watch::channel(false);
    let server_shared = shared.clone();
    let handle = tokio::spawn(async move {
        Session::new(&server_shared, server_stream, peer(), stopped)
            .run()
            .await
    });

    assert!(read_plain_reply(&mut plain).await.starts_with("220"));
    plain.write_all(b"EHLO c\r\n").await.unwrap();
    assert!(read_plain_reply(&mut plain).await.contains("STARTTLS"));
    plain
        .write_all(b"MAIL FROM:<before@client.test>\r\n")
        .await
        .unwrap();
    assert!(read_plain_reply(&mut plain).await.starts_with("250"));
    // A man in the middle appends a command to the plaintext STARTTLS; it
    // must not run inside the encrypted session.
    plain
        .write_all(b"STARTTLS\r\nRCPT TO:<injected@mailhooks.cc>\r\n")
        .await
        .unwrap();
    assert!(read_plain_reply(&mut plain).await.starts_with("220"));

    let mut roots = RootCertStore::empty();
    for cert in rustls_pki_types::CertificateDer::pem_slice_iter(cert_pem.as_bytes()) {
        roots.add(cert.unwrap()).unwrap();
    }
    let config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tls = TlsConnector::from(Arc::new(config))
        .connect("mx.test".try_into().unwrap(), plain)
        .await
        .unwrap();
    let mut client = SmtpClient::new(tls);

    client.send("NOOP\r\n").await;
    client.expect(250).await; // not the injected RCPT's reply
    client.send("MAIL FROM:<s@client.test>\r\n").await;
    client.expect(503).await; // EHLO again after STARTTLS
    client.send("EHLO c\r\n").await;
    let ehlo = client.expect(250).await;
    assert!(!ehlo.contains("STARTTLS"), "no second STARTTLS");
    client.send("RCPT TO:<a@mailhooks.cc>\r\n").await;
    client.expect(503).await; // the plaintext MAIL is gone too
    client.start_message("a@mailhooks.cc").await;
    client.send("secret\r\n.\r\nQUIT\r\n").await;
    client.expect(250).await;
    client.expect(221).await;

    let stats = handle.await.unwrap();
    assert!(stats.tls);
    assert_eq!(shared.backend.checks.load(Ordering::SeqCst), 1);
    let d = &shared.backend.deliveries()[0];
    let tls_info = d.tls.as_ref().expect("TLS details recorded");
    assert!(tls_info["version"].as_str().unwrap().starts_with("TLSv1_"));
    assert_eq!(d.envelope_from, "s@client.test");
    assert_eq!(d.raw.as_slice(), b"secret\r\n");
}
