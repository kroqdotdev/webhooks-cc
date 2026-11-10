//! What stands between a visitor and a preview (a tunnel to someone's
//! computer): the request limits, the notice, a password, and whether the
//! pages were flagged as phishing already. Kept apart from the session so
//! uploaded sites can stand behind the same door later.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use crate::limits::{ShareLimits, Streams};
use crate::pace::Paces;
use crate::registry::Account;

/// What a door belongs to, for the web app's records. Only shares for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Share,
}

pub struct Door {
    /// The share's id.
    pub id: String,
    pub kind: Kind,
    pub user_id: String,
    pub name: String,
    /// Whether visitors see the notice first (Free, and new paid accounts).
    pub notice: bool,
    /// The version of the password visitors need, if any (gate.rs); the
    /// web app may change it while the door is open.
    gate: RwLock<Option<String>>,
    pub limits: ShareLimits,
    /// The account's streams, shared by all its shares.
    pub streams: Arc<Streams>,
    /// This share's own, so one share cannot take all the account's
    /// (limits.rs, SHARE_STREAMS).
    pub share_streams: Arc<Streams>,
    /// The account's live requests in flight, a pool apart from its
    /// visitors' (relay.rs, LIVE_STREAMS).
    pub live_streams: Arc<Streams>,
    /// How fast it may send visitors: its own bucket and its account's
    /// (pace.rs).
    pub paces: Paces,
    /// Whether its pages were flagged as phishing already (inject.rs).
    flagged: AtomicBool,
    /// The CLI's run, the same across its reconnects (`x-whk-instance`).
    run: String,
}

impl Door {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: String,
        kind: Kind,
        user_id: String,
        name: String,
        notice: bool,
        gate: Option<String>,
        run: String,
        account: Account,
    ) -> Self {
        Self {
            id,
            kind,
            user_id,
            name,
            notice,
            gate: RwLock::new(gate),
            limits: ShareLimits::new(Instant::now()),
            streams: account.streams,
            share_streams: Arc::default(),
            live_streams: account.live_streams,
            paces: account.paces,
            flagged: AtomicBool::new(false),
            run,
        }
    }

    /// What a visitor's notice cookie is signed over (notice.rs): the
    /// account, the name and the CLI's run. Not the share id, which is new
    /// on every reconnect, so a dropped tunnel does not show visitors the
    /// notice again; a later run (or a name drawn again for someone else)
    /// starts over.
    pub fn notice_key(&self) -> String {
        format!("{}|{}|{}", self.user_id, self.name, self.run)
    }

    pub fn gate(&self) -> Option<String> {
        self.gate.read().unwrap().clone()
    }

    pub fn set_gate(&self, gate: Option<String>) {
        let mut current = self.gate.write().unwrap();
        if *current != gate {
            tracing::info!(name = %self.name, gated = gate.is_some(), "gate changed");
        }
        *current = gate;
    }

    pub fn was_flagged(&self) -> bool {
        self.flagged.load(Ordering::Relaxed)
    }

    /// True the first time only: a share is flagged once.
    pub fn flag_once(&self) -> bool {
        !self.flagged.swap(true, Ordering::SeqCst)
    }

    /// How the web app names it: `{"shareId": ...}`.
    pub fn id_field(&self) -> &'static str {
        match self.kind {
            Kind::Share => "shareId",
        }
    }
}
