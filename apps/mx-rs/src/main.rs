//! webhooks-mx: the receive-only SMTP host for email capture.
//!
//! Accepts mail for `{slug}[+tag]@mailhooks.cc`, asks the receiver whether
//! each recipient can take it, and hands accepted messages to the receiver's
//! private mail API over the private network. It never sends mail and never
//! stores messages itself.

mod auth_check;
mod config;
mod expiring;
mod ingest;
mod limits;
mod reply;
mod retry_store;
mod session;
mod tls;

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

use auth_check::{AuthChecker, AuthOutcome, AuthRequest, ReverseDns};
use config::Config;
use expiring::Expiring;
use ingest::{Delivery, Ingest};
use limits::{Client, ClientKey, Limiter, is_trusted_name};
use reply::{CheckStatus, DeliverOutcome, Reply};
use retry_store::RetryStore;
use session::{Backend, Peer, Session, Shared};
use tls::TlsProvider;

/// How long running sessions get to finish after SIGTERM.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);
/// Refused connections are logged at most this often per client.
const REFUSAL_LOG_EVERY: Duration = Duration::from_secs(60);
/// How long a reverse-DNS answer is reused for later connections.
const REVERSE_DNS_CACHE_FOR: Duration = Duration::from_secs(600);
/// Most entries kept in each of the per-client caches.
const CACHE_CAP: usize = 50_000;

struct LiveBackend {
    ingest: Ingest,
    auth: AuthChecker,
}

impl Backend for LiveBackend {
    async fn check_recipient(&self, address: &str) -> CheckStatus {
        self.ingest.check(address).await
    }

    async fn deliver(&self, delivery: Delivery) -> DeliverOutcome {
        self.ingest.deliver(delivery).await
    }

    async fn authenticate(&self, request: AuthRequest) -> AuthOutcome {
        self.auth.check(request).await
    }
}

/// Everything the accept loops share.
struct Server {
    shared: Shared<LiveBackend>,
    auth: AuthChecker,
    trusted_rdns: Vec<String>,
    sessions: Arc<Semaphore>,
    refusals: Mutex<Expiring<ClientKey, Instant>>,
    /// Recent reverse-DNS answers: a sending server usually opens several
    /// connections in a row.
    reverse_dns: Mutex<Expiring<IpAddr, (ReverseDns, Instant)>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "webhooks_mx=info".into()),
        )
        .with_target(false)
        .init();

    let config = Config::from_env();
    tracing::info!(?config, "starting");

    // Without a certificate, plaintext delivery still works for most senders;
    // refusing all mail over a certificate problem would be worse. A missing
    // or broken certificate is retried, so a renewal fixes it without a
    // restart.
    let tls = match (&config.tls_cert, &config.tls_key) {
        (Some(cert), Some(key)) => Some(Arc::new(TlsProvider::new(cert.clone(), key.clone()))),
        _ => {
            tracing::warn!("no TLS certificate configured; STARTTLS is off");
            None
        }
    };

    let now = chrono::Utc::now().timestamp() as u64;
    let retry_store =
        match RetryStore::open(config.state_dir.join("retry-hashes"), retry_store::TTL, now) {
            Ok(store) => {
                tracing::info!(entries = store.len(), "retry store loaded");
                store
            }
            Err(e) => {
                tracing::error!(error = %e, "could not open the retry store; keeping it in memory");
                RetryStore::in_memory(retry_store::TTL)
            }
        };

    // One authentication check per buffered message; a check whose message
    // already got its reply keeps its slot until it has really stopped.
    let auth = AuthChecker::new(
        &config.hostname,
        config.timeouts.auth_checks,
        config.data_slots,
    );
    let server = Arc::new(Server {
        shared: Shared {
            backend: LiveBackend {
                ingest: Ingest::new(
                    &config.ingest_url,
                    &config.shared_secret,
                    config.timeouts.check_call,
                    config.timeouts.deliver_call,
                ),
                auth: auth.clone(),
            },
            hostname: config.hostname.clone(),
            tls,
            limiter: Limiter::new(config.limits.clone()),
            retry_store: Arc::new(retry_store),
            data_slots: Arc::new(Semaphore::new(config.data_slots)),
            timeouts: config.timeouts.clone(),
        },
        auth,
        trusted_rdns: config.trusted_rdns.clone(),
        sessions: Arc::new(Semaphore::new(config.max_sessions)),
        refusals: Mutex::new(Expiring::capped(CACHE_CAP)),
        reverse_dns: Mutex::new(Expiring::capped(CACHE_CAP)),
    });
    let (stop, stopped) = watch::channel(false);

    let mut accept_loops = Vec::new();
    for addr in &config.listen {
        let listener = TcpListener::bind(addr)
            .await
            .unwrap_or_else(|e| panic!("could not listen on {addr}: {e}"));
        tracing::info!(addr, "listening for SMTP");
        accept_loops.push(tokio::spawn(accept_loop(
            listener,
            server.clone(),
            stopped.clone(),
        )));
    }
    if let Some(addr) = &config.health_addr {
        let listener = TcpListener::bind(addr)
            .await
            .unwrap_or_else(|e| panic!("could not listen on {addr}: {e}"));
        tokio::spawn(health(listener));
    }

    shutdown_signal().await;
    tracing::info!("shutting down");
    let _ = stop.send(true);
    for handle in accept_loops {
        let _ = handle.await;
    }
    // Every session holds a permit; getting all of them back means all ended.
    let all = u32::try_from(config.max_sessions).unwrap_or(u32::MAX);
    if tokio::time::timeout(SHUTDOWN_GRACE, server.sessions.acquire_many(all))
        .await
        .is_err()
    {
        tracing::warn!("sessions still running after the grace period; exiting anyway");
    }
}

async fn accept_loop(
    listener: TcpListener,
    server: Arc<Server>,
    mut stopped: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = stopped.wait_for(|stop| *stop) => return,
        };
        let (stream, peer) = match accepted {
            Ok(accepted) => accepted,
            Err(e) => {
                tracing::warn!(error = %e, "accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let ip = peer.ip().to_canonical();

        let Ok(permit) = server.sessions.clone().try_acquire_owned() else {
            server.refuse(stream, Client::new(ip, false), &reply::TOO_BUSY);
            continue;
        };
        let server = server.clone();
        let stopped = stopped.clone();
        tokio::spawn(async move {
            let _permit = permit;
            // Reverse DNS decides whether the client is a known provider,
            // which sets its limits, so it is looked up before anything else,
            // under a per-client cap of its own.
            let reverse_dns = match server.cached_reverse_dns(ip) {
                Some(found) => found,
                None => {
                    let Some(_lookup) = server.shared.limiter.start_lookup(ip) else {
                        server.refuse(stream, Client::new(ip, false), &reply::TOO_BUSY);
                        return;
                    };
                    let budget = server.shared.timeouts.reverse_dns;
                    let found = server.auth.reverse_dns(ip, budget).await;
                    server.remember_reverse_dns(ip, &found);
                    found
                }
            };
            let trusted = reverse_dns.confirmed
                && reverse_dns
                    .name
                    .as_deref()
                    .is_some_and(|name| is_trusted_name(name, &server.trusted_rdns));
            let client = Client::new(ip, trusted);
            let Some(_slot) = server.shared.limiter.open_session(client) else {
                server.refuse(stream, client, &reply::TOO_BUSY);
                return;
            };
            let peer = Peer {
                ip,
                client,
                reverse_dns,
            };
            let stats = Session::new(&server.shared, stream, peer, stopped)
                .run()
                .await;
            tracing::info!(
                %ip,
                trusted,
                tls = stats.tls,
                accepted = stats.messages_accepted,
                refused = stats.messages_refused,
                deferred = stats.messages_deferred,
                recipients_refused = stats.recipients_refused,
                closed_by = stats.closed_by,
                "session"
            );
        });
    }
}

impl Server {
    fn cached_reverse_dns(&self, ip: IpAddr) -> Option<ReverseDns> {
        let cache = self.reverse_dns.lock().unwrap_or_else(|e| e.into_inner());
        cache
            .get(&ip)
            .filter(|(_, at)| at.elapsed() < REVERSE_DNS_CACHE_FOR)
            .map(|(found, _)| found.clone())
    }

    fn remember_reverse_dns(&self, ip: IpAddr, found: &ReverseDns) {
        let now = Instant::now();
        let mut cache = self.reverse_dns.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(ip, (found.clone(), now), |_, (_, at)| {
            now.duration_since(*at) < REVERSE_DNS_CACHE_FOR
        });
    }

    /// Send one 421 and close, without holding a session slot. Logged at most
    /// once a minute per client, so a flood does not flood the log too.
    fn refuse(&self, mut stream: TcpStream, client: Client, reply: &Reply) {
        let now = Instant::now();
        let log = {
            let mut refusals = self.refusals.lock().unwrap_or_else(|e| e.into_inner());
            match refusals.get(&client.key) {
                Some(at) if now.duration_since(*at) < REFUSAL_LOG_EVERY => false,
                _ => {
                    refusals.insert(client.key, now, |_, at| {
                        now.duration_since(*at) < REFUSAL_LOG_EVERY
                    });
                    true
                }
            }
        };
        if log {
            let ip = stream.peer_addr().map(|a| a.ip().to_canonical()).ok();
            tracing::info!(ip = ?ip, code = reply.code, "connection refused");
        }
        let bytes = reply.to_bytes();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                let _ = stream.write_all(&bytes).await;
                let _ = stream.shutdown().await;
            })
            .await;
        });
    }
}

/// A plain-HTTP liveness answer for container health checks.
async fn health(listener: TcpListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        tokio::spawn(async move {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await;
            let _ = stream.shutdown().await;
        });
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
