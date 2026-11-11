//! The shares open on this edge, by name, the live sessions
//! (`whk tunnel --live`, relay.rs) by endpoint, and each account's streams
//! in flight across the shares.

use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use whk_tunnel::EdgeMessage;
use whk_tunnel::mux::Opener;
use whk_tunnel::ws::TextSender;

use crate::door::{Door, Kind};
use crate::held::Held;
use crate::limits::Streams;
use crate::line::Line;
use crate::pace::{Pace, Paces, Rates};

pub struct Session {
    /// Its limits, notice, password and flags (door.rs).
    pub door: Arc<Door>,
    /// The port on the laptop, for `Host: localhost:<port>`.
    pub port: u16,
    /// For a live session: the endpoint whose captures come down this
    /// tunnel (relay.rs). None for a share.
    pub endpoint_id: Option<String>,
    pub opener: Opener,
    notices: TextSender,
    /// Set when the edge ends the share: replaced, time is up, or the web
    /// app stopped it.
    closing: watch::Sender<Option<String>>,
}

/// A share is used through its door: `session.name`, `session.limits`.
impl Deref for Session {
    type Target = Door;
    fn deref(&self) -> &Door {
        &self.door
    }
}

/// What the web app said about a share when it opened.
pub struct Opening {
    pub share_id: String,
    pub user_id: String,
    pub name: String,
    pub port: u16,
    pub endpoint_id: Option<String>,
    pub notice: bool,
    pub gate: Option<String>,
    /// The CLI's run (`x-whk-instance`), the same across its reconnects.
    pub run: String,
}

impl Session {
    pub fn new(opening: Opening, opener: Opener, notices: TextSender, account: Account) -> Self {
        Self {
            door: Arc::new(Door::new(
                opening.share_id,
                Kind::Share,
                opening.user_id,
                opening.name,
                opening.notice,
                opening.gate,
                opening.run,
                account,
            )),
            port: opening.port,
            endpoint_id: opening.endpoint_id,
            opener,
            notices,
            closing: watch::channel(None).0,
        }
    }

    /// Tells the CLI something, without waiting.
    pub fn notify(&self, message: &EdgeMessage) {
        if let Ok(text) = serde_json::to_string(message) {
            self.notices.try_send(text);
        }
    }

    /// Tells the CLI something a full queue must not lose (the line for a
    /// relayed capture): when there is no room now, a task of its own waits
    /// up to [`NOTIFY_WAIT`] for some, so the caller never waits.
    pub fn notify_soon(&self, message: &EdgeMessage) {
        let Ok(text) = serde_json::to_string(message) else {
            return;
        };
        if self.notices.try_send(text.clone()) {
            return;
        }
        let notices = self.notices.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(NOTIFY_WAIT, notices.send(text)).await;
        });
    }

    /// Ends the share. Its session task tells the CLI why (main.rs,
    /// run_session), waiting for room on the tunnel rather than dropping it.
    pub fn close(&self, reason: &str) {
        self.closing.send_replace(Some(reason.to_string()));
    }

    pub fn closing(&self) -> watch::Receiver<Option<String>> {
        self.closing.subscribe()
    }
}

/// How long a line that must not be lost waits for room on the tunnel.
const NOTIFY_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
pub struct Registry {
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    /// Live sessions, by the endpoint id the receiver relays for.
    live: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    accounts: Arc<Mutex<HashMap<String, Shared>>>,
    rates: Rates,
    /// The box's line, which every share sends
    /// through (line.rs).
    line: Option<Arc<Line>>,
    /// Where answers waiting for their pace count as held up.
    held: Arc<Held>,
    /// Shares the web app closed before they were registered here (a stop
    /// that raced the tunnel opening), with why and when: such a share is
    /// closed as soon as it would register, instead of serving until the
    /// next sync. Kept [`EARLY_CLOSE_FOR`]. Locked before the session maps,
    /// by both sides, so a close cannot fall between the check and the
    /// insert.
    closed_early: Arc<Mutex<HashMap<String, (String, Instant)>>>,
}

/// How long a close for a share not open here is remembered.
const EARLY_CLOSE_FOR: Duration = Duration::from_secs(120);

/// How long an account's part is kept once nothing of it is open here:
/// at least this, and as long as its bucket takes to fill again. A
/// reconnect within it finds the same counts and the same bucket, so
/// dropping a tunnel and opening it again starts nothing afresh.
const ACCOUNT_KEPT_FOR: Duration = Duration::from_secs(60);

/// What an account's shares have in common.
#[derive(Clone)]
struct Shared {
    streams: Arc<Streams>,
    live_streams: Arc<Streams>,
    pace: Option<Arc<Pace>>,
    /// When a door last took it, or its last session here closed.
    touched: Instant,
}

/// What a new share's or site's door gets from its account: the streams
/// in flight it counts against, and how fast it may send (pace.rs), its
/// own bucket and the account's.
pub struct Account {
    pub streams: Arc<Streams>,
    pub live_streams: Arc<Streams>,
    pub paces: Paces,
}

impl Registry {
    pub fn new(rates: Rates, held: Arc<Held>) -> Self {
        Self {
            rates,
            line: Line::new(rates.line),
            held,
            ..Self::default()
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<Session>> {
        self.sessions.read().unwrap().get(name).cloned()
    }

    /// The live session relaying this endpoint's captures, if one is open.
    pub fn get_live(&self, endpoint_id: &str) -> Option<Arc<Session>> {
        self.live.read().unwrap().get(endpoint_id).cloned()
    }

    /// The map a session belongs in, and its key there.
    fn place(&self, session: &Session) -> (&RwLock<HashMap<String, Arc<Session>>>, String) {
        match &session.endpoint_id {
            Some(endpoint) => (&self.live, endpoint.clone()),
            None => (&self.sessions, session.name.clone()),
        }
    }

    /// Adds a session, returning the one it replaces under the same name
    /// (or, for a live session, the same endpoint).
    pub fn insert(&self, session: Arc<Session>) -> Option<Arc<Session>> {
        let (map, key) = self.place(&session);
        map.write().unwrap().insert(key, session)
    }

    /// Adds a session unless the web app already closed it while it was
    /// opening: then nothing is added, and the reason is returned.
    pub fn insert_unless_closed(
        &self,
        session: Arc<Session>,
    ) -> Result<Option<Arc<Session>>, String> {
        let mut early = self.closed_early.lock().unwrap();
        prune(&mut early, Instant::now());
        if let Some((reason, _)) = early.remove(&session.id) {
            return Err(reason);
        }
        Ok(self.insert(session))
    }

    /// Removes the session, unless a newer one has taken its place. An
    /// account left with no session here is forgotten once its streams are
    /// done and [`Self::kept_for`] has passed, so the map does not keep
    /// everyone who ever shared, while a reconnect cannot be used to start
    /// its counts and its bucket afresh.
    pub fn remove(&self, session: &Arc<Session>) {
        self.remove_at(session, Instant::now());
    }

    fn remove_at(&self, session: &Arc<Session>, now: Instant) {
        let (map, key) = self.place(session);
        {
            let mut sessions = map.write().unwrap();
            if sessions.get(&key).is_some_and(|s| Arc::ptr_eq(s, session)) {
                sessions.remove(&key);
            }
        }
        let mut accounts = self.accounts.lock().unwrap();
        if let Some(shared) = accounts.get_mut(&session.user_id) {
            shared.touched = now;
        }
        self.forget_idle(&mut accounts, now);
    }

    /// How long an account with nothing open is kept ([`ACCOUNT_KEPT_FOR`]).
    fn kept_for(&self) -> Duration {
        let rate = self.rates.account;
        let refill = if rate.is_off() {
            Duration::ZERO
        } else {
            Duration::from_secs_f64((rate.burst / rate.per_second).min(86_400.0))
        };
        ACCOUNT_KEPT_FOR.max(refill)
    }

    /// Forgets accounts with no session open here, no stream in flight, and
    /// nothing done for [`Self::kept_for`].
    fn forget_idle(&self, accounts: &mut HashMap<String, Shared>, now: Instant) {
        let open: HashSet<String> = self.all().into_iter().map(|s| s.user_id.clone()).collect();
        let kept_for = self.kept_for();
        accounts.retain(|user, shared| {
            open.contains(user)
                || shared.streams.count() > 0
                || shared.live_streams.count() > 0
                || now.saturating_duration_since(shared.touched) < kept_for
        });
    }

    /// Accounts with their part kept here.
    #[cfg(test)]
    pub fn accounts_kept(&self) -> usize {
        self.accounts.lock().unwrap().len()
    }

    /// Shares and live sessions open here.
    pub fn len(&self) -> usize {
        self.sessions.read().unwrap().len() + self.live.read().unwrap().len()
    }

    /// Every session open here, shares and live ones.
    fn all(&self) -> Vec<Arc<Session>> {
        let mut all: Vec<Arc<Session>> = self.sessions.read().unwrap().values().cloned().collect();
        all.extend(self.live.read().unwrap().values().cloned());
        all
    }

    /// What a new door of this account counts against and is paced by;
    /// the account's part is made on first use.
    pub fn account(&self, user_id: &str) -> Account {
        let now = Instant::now();
        let shared = {
            let mut accounts = self.accounts.lock().unwrap();
            let shared = accounts
                .entry(user_id.to_string())
                .or_insert_with(|| Shared {
                    streams: Arc::default(),
                    live_streams: Arc::default(),
                    pace: Pace::new(self.rates.account),
                    touched: now,
                });
            shared.touched = now;
            shared.clone()
        };
        Account {
            streams: shared.streams,
            live_streams: shared.live_streams,
            paces: Paces::new(Pace::new(self.rates.door), shared.pace)
                .line(self.line.clone())
                .held(self.held.clone())
                .of(Arc::from(user_id)),
        }
    }

    /// The web app's ids of the shares and live sessions open here.
    pub fn share_ids(&self) -> Vec<String> {
        self.all().iter().map(|s| s.id.clone()).collect()
    }

    /// Puts a share behind another password, or none. False when it is
    /// not open here.
    pub fn set_gate(&self, share_id: &str, gate: Option<String>) -> bool {
        let found = self.all().into_iter().find(|s| s.id == share_id);
        match found {
            Some(session) => {
                session.set_gate(gate);
                true
            }
            None => false,
        }
    }

    /// Closes the share with this id, if it is open here. One that is not
    /// is remembered for a while, in case it is still opening.
    pub fn close_share(&self, share_id: &str, reason: &str) -> bool {
        self.close_share_at(share_id, reason, Instant::now())
    }

    fn close_share_at(&self, share_id: &str, reason: &str, now: Instant) -> bool {
        let mut early = self.closed_early.lock().unwrap();
        let found = self.all().into_iter().find(|s| s.id == share_id);
        match found {
            Some(session) => {
                session.close(reason);
                true
            }
            None => {
                prune(&mut early, now);
                early.insert(share_id.to_string(), (reason.to_string(), now));
                false
            }
        }
    }
}

/// Forgets closes older than [`EARLY_CLOSE_FOR`].
fn prune(early: &mut HashMap<String, (String, Instant)>, now: Instant) {
    early.retain(|_, (_, at)| now.saturating_duration_since(*at) < EARLY_CLOSE_FOR);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use whk_tunnel::{mux, ws};

    async fn session(registry: &Registry, id: &str, name: &str) -> Arc<Session> {
        let (edge_io, _cli_io) = tokio::io::duplex(1 << 16);
        std::mem::forget(_cli_io);
        let (opener, inbound, _task) = mux::spawn(edge_io, yamux::Mode::Client);
        drop(inbound);
        let (text_io, _other) = tokio::io::duplex(1 << 16);
        std::mem::forget(_other);
        let socket = WebSocketStream::from_raw_socket(text_io, Role::Server, None).await;
        let (_bytes, text) = ws::split(socket);
        std::mem::forget(_bytes);
        let session = Arc::new(Session::new(
            Opening {
                share_id: id.into(),
                user_id: "user-1".into(),
                name: name.into(),
                port: 3000,
                endpoint_id: None,
                notice: false,
                gate: None,
                run: "run-1".into(),
            },
            opener,
            text.sender(),
            registry.account("user-1"),
        ));
        std::mem::forget(text);
        session
    }

    #[tokio::test]
    async fn an_account_with_nothing_open_is_forgotten_after_a_while() {
        let registry = Registry::default();
        let one = session(&registry, "share-1", "calm-otter").await;
        let two = session(&registry, "share-2", "brisk-heron").await;
        registry.insert(one.clone());
        registry.insert(two.clone());
        assert_eq!(registry.accounts_kept(), 1);
        let now = Instant::now();
        registry.remove_at(&one, now);
        assert_eq!(registry.accounts_kept(), 1, "its other share is still open");
        registry.remove_at(&two, now);
        assert_eq!(registry.accounts_kept(), 1, "kept for a reconnect");
        let later = now + registry.kept_for();
        registry.forget_idle(&mut registry.accounts.lock().unwrap(), later);
        assert_eq!(registry.accounts_kept(), 0);
    }

    #[tokio::test]
    async fn a_reconnect_does_not_start_the_accounts_counts_afresh() {
        let registry = Registry::default();
        let before = session(&registry, "share-1", "acme").await;
        registry.insert(before.clone());
        // A visitor's request is in flight when the tunnel drops.
        let in_flight = before.door.streams.enter(10).unwrap();
        let now = Instant::now();
        registry.remove_at(&before, now);
        // The same account comes back: the request still counts.
        let after = session(&registry, "share-2", "acme").await;
        assert_eq!(after.door.streams.count(), 1);
        registry.insert(after.clone());
        registry.remove_at(&after, now);
        // Long past the while, a stream still in flight keeps it.
        let later = now + registry.kept_for() * 2;
        registry.forget_idle(&mut registry.accounts.lock().unwrap(), later);
        assert_eq!(registry.accounts_kept(), 1);
        drop(in_flight);
        registry.forget_idle(&mut registry.accounts.lock().unwrap(), later);
        assert_eq!(registry.accounts_kept(), 0);
    }

    #[tokio::test]
    async fn a_close_that_beats_the_opening_still_lands() {
        let registry = Registry::default();
        // The web app stops the share before its tunnel registered.
        assert!(!registry.close_share("share-1", "you stopped it"));
        let early = session(&registry, "share-1", "acme").await;
        assert_eq!(
            registry.insert_unless_closed(early).err().as_deref(),
            Some("you stopped it")
        );
        assert!(registry.get("acme").is_none());
        // Remembered once: the next run of that id opens.
        let again = session(&registry, "share-1", "acme").await;
        assert!(registry.insert_unless_closed(again).is_ok());
        // Another share is untouched.
        let other = session(&registry, "share-2", "other").await;
        assert!(registry.insert_unless_closed(other).is_ok());
        assert!(registry.get("other").is_some());
        // An open share is closed directly, not remembered.
        assert!(registry.close_share("share-2", "stopped"));
        assert!(registry.closed_early.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_early_close_is_forgotten_after_a_while() {
        let registry = Registry::default();
        let long_ago = Instant::now()
            .checked_sub(EARLY_CLOSE_FOR + Duration::from_secs(1))
            .unwrap();
        registry.close_share_at("share-1", "stopped", long_ago);
        let later = session(&registry, "share-1", "acme").await;
        assert!(registry.insert_unless_closed(later).is_ok());
    }

    #[tokio::test]
    async fn a_relayed_captures_line_waits_for_room_instead_of_being_dropped() {
        use futures::StreamExt;
        let registry = Registry::default();
        let (edge_io, _cli_io) = tokio::io::duplex(1 << 16);
        std::mem::forget(_cli_io);
        let (opener, inbound, _task) = mux::spawn(edge_io, yamux::Mode::Client);
        drop(inbound);
        let (text_io, cli_text) = tokio::io::duplex(1 << 16);
        let socket = WebSocketStream::from_raw_socket(text_io, Role::Server, None).await;
        let (_bytes, text) = ws::split(socket);
        std::mem::forget(_bytes);
        let session = Session::new(
            Opening {
                share_id: "share-1".into(),
                user_id: "user-1".into(),
                name: "acme".into(),
                port: 3000,
                endpoint_id: Some("ep1".into()),
                notice: false,
                gate: None,
                run: "run-1".into(),
            },
            opener,
            text.sender(),
            registry.account("user-1"),
        );
        std::mem::forget(text);
        // The CLI is not reading: the socket and the queue fill, and what
        // is only tried is dropped.
        let filler = EdgeMessage::Notice {
            text: "x".repeat(4096),
        };
        for _ in 0..2000 {
            session.notify(&filler);
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let line = |id: &str| EdgeMessage::Request {
            method: "POST".into(),
            path: "/hooks".into(),
            status: 200,
            ms: 1,
            request_id: Some(id.into()),
        };
        session.notify(&line("dropped"));
        session.notify_soon(&line("kept"));
        // Then it reads everything.
        let mut cli = WebSocketStream::from_raw_socket(cli_text, Role::Client, None).await;
        let mut seen = Vec::new();
        while let Ok(Some(Ok(message))) =
            tokio::time::timeout(Duration::from_millis(500), cli.next()).await
        {
            if let Ok(text) = message.into_text()
                && text.contains("requestId")
            {
                seen.push(text.to_string());
            }
        }
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].contains("\"kept\""));
    }

    #[tokio::test]
    async fn a_reconnect_keeps_the_notice_cookie_good() {
        let registry = Registry::default();
        // The same run under the same name, before and after a reconnect:
        // a new share id, the same notice key.
        let before = session(&registry, "share-1", "acme").await;
        let after = session(&registry, "share-2", "acme").await;
        assert_eq!(before.notice_key(), after.notice_key());
        // Another name is another key.
        let other = session(&registry, "share-3", "other").await;
        assert_ne!(before.notice_key(), other.notice_key());
    }
}
