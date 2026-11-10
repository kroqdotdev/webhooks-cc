//! The shares open on this edge, by name, the live sessions
//! (`whk tunnel --live`, relay.rs) by endpoint, and each account's streams
//! in flight across the shares.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::{Arc, Mutex, RwLock};

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

    /// Ends the share. Its session task tells the CLI why (main.rs,
    /// run_session), waiting for room on the tunnel rather than dropping it.
    pub fn close(&self, reason: &str) {
        self.closing.send_replace(Some(reason.to_string()));
    }

    pub fn closing(&self) -> watch::Receiver<Option<String>> {
        self.closing.subscribe()
    }
}

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
}

/// What an account's shares have in common.
#[derive(Clone)]
struct Shared {
    streams: Arc<Streams>,
    pace: Option<Arc<Pace>>,
}

/// What a new share's or site's door gets from its account: the streams
/// in flight it counts against, and how fast it may send (pace.rs), its
/// own bucket and the account's.
pub struct Account {
    pub streams: Arc<Streams>,
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

    /// Removes the session, unless a newer one has taken its place.
    pub fn remove(&self, session: &Arc<Session>) {
        let (map, key) = self.place(session);
        let mut sessions = map.write().unwrap();
        if sessions.get(&key).is_some_and(|s| Arc::ptr_eq(s, session)) {
            sessions.remove(&key);
        }
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
        let shared = self
            .accounts
            .lock()
            .unwrap()
            .entry(user_id.to_string())
            .or_insert_with(|| Shared {
                streams: Arc::default(),
                pace: Pace::new(self.rates.account),
            })
            .clone();
        Account {
            streams: shared.streams,
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

    /// Closes the share with this id, if it is open here.
    pub fn close_share(&self, share_id: &str, reason: &str) -> bool {
        let found = self.all().into_iter().find(|s| s.id == share_id);
        match found {
            Some(session) => {
                session.close(reason);
                true
            }
            None => false,
        }
    }
}
