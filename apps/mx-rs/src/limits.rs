//! Limits applied before mail is accepted, all in memory.
//!
//! Counted per client. An untrusted client is an IPv4 address or the /64 an
//! IPv6 address sits in (one host usually owns a whole /64, so per-address
//! limits would be easy to sidestep). A trusted client, one whose reverse DNS
//! is forward-confirmed inside a known mail provider, is counted per exact
//! address with higher allowances: providers such as Gmail send for millions
//! of users from a handful of addresses, and one abuser must not use up an
//! allowance everyone else shares.
//!
//! There is deliberately no cross-session blocking: slugs are random enough
//! that probing for addresses gains nothing, and a block keyed on a shared
//! provider address would stop that provider's mail for everyone. Refused
//! recipients only end the session they occur in.
//!
//! Windows are fixed, which allows short bursts at a boundary; that is fine
//! for abuse control.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::config::Limits;

const HOUR: Duration = Duration::from_secs(3600);
const MINUTE: Duration = Duration::from_secs(60);
/// Maps are pruned once they hold this many keys.
const PRUNE_AT: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClientKey {
    V4(u32),
    V6(u128),
    V6Prefix(u64),
}

impl ClientKey {
    pub fn of(ip: IpAddr, trusted: bool) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(v4) => Self::V4(u32::from(v4)),
            IpAddr::V6(v6) if trusted => Self::V6(u128::from(v6)),
            IpAddr::V6(v6) => Self::V6Prefix((u128::from(v6) >> 64) as u64),
        }
    }
}

/// Who is on the other end, as far as the limits are concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Client {
    pub key: ClientKey,
    pub trusted: bool,
}

impl Client {
    pub fn new(ip: IpAddr, trusted: bool) -> Self {
        Self {
            key: ClientKey::of(ip, trusted),
            trusted,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Window {
    started: Instant,
    count: u32,
}

impl Window {
    fn new(now: Instant) -> Self {
        Self {
            started: now,
            count: 0,
        }
    }

    /// Count one event; true while the window's count stays within `max`.
    fn hit(&mut self, now: Instant, period: Duration, max: u32) -> bool {
        if now.duration_since(self.started) >= period {
            self.started = now;
            self.count = 0;
        }
        self.count = self.count.saturating_add(1);
        self.count <= max
    }
}

pub struct Limiter {
    limits: Limits,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    lookups: HashMap<ClientKey, usize>,
    sessions: HashMap<ClientKey, usize>,
    data: HashMap<ClientKey, usize>,
    messages: HashMap<ClientKey, Window>,
    per_address: HashMap<(ClientKey, String), Window>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// A reverse-DNS lookup for a new connection, before trust is known.
    Lookup,
    Session,
    Data,
}

impl State {
    fn slots(&mut self, slot: Slot) -> &mut HashMap<ClientKey, usize> {
        match slot {
            Slot::Lookup => &mut self.lookups,
            Slot::Session => &mut self.sessions,
            Slot::Data => &mut self.data,
        }
    }
}

/// Holds one of a client's counted slots until dropped.
pub struct SlotGuard {
    limiter: Arc<Limiter>,
    key: ClientKey,
    slot: Slot,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let mut state = self.limiter.lock();
        let map = state.slots(self.slot);
        if let Some(count) = map.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.key);
            }
        }
    }
}

impl Limiter {
    pub fn new(limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            limits,
            state: Mutex::new(State::default()),
        })
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn take_slot(self: &Arc<Self>, client: Client, slot: Slot) -> Option<SlotGuard> {
        let max = match (slot, client.trusted) {
            // Trust is not known yet while the lookup runs.
            (Slot::Lookup, _) | (Slot::Session, false) => self.limits.sessions_per_client,
            (Slot::Session, true) => self.limits.trusted_sessions_per_client,
            (Slot::Data, false) => self.limits.data_per_client,
            (Slot::Data, true) => self.limits.trusted_data_per_client,
        };
        let mut state = self.lock();
        let count = state.slots(slot).entry(client.key).or_insert(0);
        if *count >= max {
            return None;
        }
        *count += 1;
        Some(SlotGuard {
            limiter: Arc::clone(self),
            key: client.key,
            slot,
        })
    }

    /// A slot for the reverse-DNS lookup of a new connection, counted as an
    /// untrusted client because trust is what the lookup decides. Without it
    /// one network could hold every connection slot while its lookups run.
    pub fn start_lookup(self: &Arc<Self>, ip: IpAddr) -> Option<SlotGuard> {
        self.take_slot(Client::new(ip, false), Slot::Lookup)
    }

    /// A session slot, unless the client has too many open.
    pub fn open_session(self: &Arc<Self>, client: Client) -> Option<SlotGuard> {
        self.take_slot(client, Slot::Session)
    }

    /// A DATA slot, unless the client already has too many transfers running.
    pub fn start_data(self: &Arc<Self>, client: Client) -> Option<SlotGuard> {
        self.take_slot(client, Slot::Data)
    }

    /// Count one message from this client; false once it is over its hourly
    /// allowance.
    pub fn allow_message(&self, client: Client, now: Instant) -> bool {
        let max = if client.trusted {
            self.limits.trusted_messages_per_client_per_hour
        } else {
            self.limits.messages_per_client_per_hour
        };
        let mut state = self.lock();
        prune(&mut state.messages, now, HOUR);
        state
            .messages
            .entry(client.key)
            .or_insert_with(|| Window::new(now))
            .hit(now, HOUR, max)
    }

    /// Count one accepted recipient for this address from this client; false
    /// once that pair is over its per-minute allowance. Keyed per client, so
    /// nobody can use up someone else's address.
    pub fn allow_address(&self, client: Client, address_key: &str, now: Instant) -> bool {
        let max = self.limits.messages_per_address_per_minute;
        let mut state = self.lock();
        prune(&mut state.per_address, now, MINUTE);
        state
            .per_address
            .entry((client.key, address_key.to_string()))
            .or_insert_with(|| Window::new(now))
            .hit(now, MINUTE, max)
    }
}

fn prune<K: std::hash::Hash + Eq>(map: &mut HashMap<K, Window>, now: Instant, period: Duration) {
    if map.len() >= PRUNE_AT {
        map.retain(|_, w| now.duration_since(w.started) < period);
    }
}

/// The key the per-address limit and the recipient cache use: the slug part
/// of the local part (before any `+tag`) and the domain, lowercased, without
/// a trailing dot. Different tags of one address share it.
pub fn address_key(address: &str) -> String {
    let address = address.trim().trim_start_matches('<').trim_end_matches('>');
    let (local, domain) = address.rsplit_once('@').unwrap_or((address, ""));
    let slug = local.split('+').next().unwrap_or(local);
    format!(
        "{}@{}",
        slug.to_ascii_lowercase(),
        domain.trim_end_matches('.').to_ascii_lowercase()
    )
}

/// True when `name` (a forward-confirmed PTR name) is the provider domain or
/// sits under one of `suffixes`.
pub fn is_trusted_name(name: &str, suffixes: &[String]) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    suffixes.iter().any(|suffix| {
        name == *suffix
            || name
                .strip_suffix(suffix.as_str())
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            sessions_per_client: 2,
            trusted_sessions_per_client: 3,
            data_per_client: 1,
            trusted_data_per_client: 2,
            messages_per_client_per_hour: 3,
            trusted_messages_per_client_per_hour: 5,
            bad_recipients_per_session: 2,
            messages_per_address_per_minute: 2,
            ..Limits::default()
        }
    }

    fn client(ip: &str, trusted: bool) -> Client {
        Client::new(ip.parse().unwrap(), trusted)
    }

    #[test]
    fn groups_untrusted_ipv6_by_64_and_trusted_by_address() {
        assert_eq!(
            client("2001:db8:1:2::1", false).key,
            client("2001:db8:1:2:ffff::9", false).key
        );
        assert_ne!(
            client("2001:db8:1:2::1", true).key,
            client("2001:db8:1:2:ffff::9", true).key
        );
        assert_eq!(
            client("::ffff:192.0.2.1", false).key,
            client("192.0.2.1", false).key
        );
    }

    #[test]
    fn caps_sessions_per_client_and_releases_on_drop() {
        let limiter = Limiter::new(limits());
        let a = limiter.open_session(client("192.0.2.1", false)).unwrap();
        let _b = limiter.open_session(client("192.0.2.1", false)).unwrap();
        assert!(limiter.open_session(client("192.0.2.1", false)).is_none());
        assert!(limiter.open_session(client("192.0.2.2", false)).is_some());
        drop(a);
        assert!(limiter.open_session(client("192.0.2.1", false)).is_some());
    }

    #[test]
    fn trusted_clients_get_more_sessions() {
        let limiter = Limiter::new(limits());
        let held: Vec<_> = (0..3)
            .map(|_| limiter.open_session(client("192.0.2.9", true)).unwrap())
            .collect();
        assert!(limiter.open_session(client("192.0.2.9", true)).is_none());
        drop(held);
    }

    #[test]
    fn caps_data_transfers_per_client() {
        let limiter = Limiter::new(limits());
        let first = limiter.start_data(client("192.0.2.1", false)).unwrap();
        assert!(limiter.start_data(client("192.0.2.1", false)).is_none());
        assert!(
            limiter.open_session(client("192.0.2.1", false)).is_some(),
            "DATA slots and sessions are counted apart"
        );
        drop(first);
        assert!(limiter.start_data(client("192.0.2.1", false)).is_some());
    }

    #[test]
    fn caps_lookups_as_untrusted_and_apart_from_sessions() {
        let limiter = Limiter::new(limits());
        let ip = "2001:db8:1:2::1".parse().unwrap();
        let a = limiter.start_lookup(ip).unwrap();
        let _b = limiter
            .start_lookup("2001:db8:1:2::ffff".parse().unwrap())
            .unwrap();
        assert!(limiter.start_lookup(ip).is_none(), "same /64, cap of 2");
        assert!(
            limiter
                .open_session(client("2001:db8:1:2::1", false))
                .is_some()
        );
        drop(a);
        assert!(limiter.start_lookup(ip).is_some());
    }

    #[test]
    fn limits_messages_per_client_per_hour() {
        let limiter = Limiter::new(limits());
        let now = Instant::now();
        for _ in 0..3 {
            assert!(limiter.allow_message(client("192.0.2.1", false), now));
        }
        assert!(!limiter.allow_message(client("192.0.2.1", false), now));
        assert!(limiter.allow_message(client("192.0.2.1", false), now + HOUR));
        for _ in 0..5 {
            assert!(limiter.allow_message(client("192.0.2.7", true), now));
        }
        assert!(!limiter.allow_message(client("192.0.2.7", true), now));
    }

    #[test]
    fn limits_each_address_per_client_per_minute_across_tags() {
        let limiter = Limiter::new(limits());
        let now = Instant::now();
        let key = address_key("<Abc+one@MailHooks.cc>");
        assert_eq!(key, address_key("abc+two@mailhooks.cc"));
        assert_eq!(key, address_key("abc@mailhooks.cc."));
        let attacker = client("192.0.2.1", false);
        assert!(limiter.allow_address(attacker, &key, now));
        assert!(limiter.allow_address(attacker, &key, now));
        assert!(!limiter.allow_address(attacker, &key, now));
        assert!(
            limiter.allow_address(client("198.51.100.1", false), &key, now),
            "another client still reaches the address"
        );
        assert!(limiter.allow_address(attacker, &key, now + MINUTE));
    }

    #[test]
    fn matches_trusted_names_on_label_boundaries() {
        let suffixes = vec!["google.com".to_string(), "amazonses.com".to_string()];
        assert!(is_trusted_name("mail-sor-f41.google.com.", &suffixes));
        assert!(is_trusted_name("a48-93.smtp-out.amazonses.com", &suffixes));
        assert!(is_trusted_name("google.com", &suffixes));
        assert!(!is_trusted_name("evilgoogle.com", &suffixes));
        assert!(!is_trusted_name("google.com.evil.net", &suffixes));
    }
}
