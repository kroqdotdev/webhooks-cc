//! Maps that drop expired entries without rescanning on every insertion.
//!
//! A client that keeps presenting new keys (rotating IPv6 addresses, random
//! address tags) must not turn each insertion into a scan of everything still
//! live. Expired entries are dropped only once the map has doubled since the
//! last scan, so scanning costs a constant amount per insertion. A capped map
//! is a cache: when a scan leaves it more than half full of live entries, it
//! starts over empty instead of being scanned again and again, and it never
//! holds more than its cap.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;

/// No scans below this many entries.
const PRUNE_FLOOR: usize = 10_000;

pub struct Expiring<K, V> {
    map: HashMap<K, V>,
    next_prune: usize,
    cap: Option<usize>,
}

impl<K: Hash + Eq, V> Default for Expiring<K, V> {
    fn default() -> Self {
        Self::uncapped()
    }
}

impl<K: Hash + Eq, V> Expiring<K, V> {
    /// For state that must not be dropped while live (rate-limit windows).
    pub fn uncapped() -> Self {
        Self {
            map: HashMap::new(),
            next_prune: PRUNE_FLOOR,
            cap: None,
        }
    }

    /// For caches, where a lost entry only costs a lookup.
    pub fn capped(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            next_prune: PRUNE_FLOOR.min(cap),
            cap: Some(cap.max(1)),
        }
    }

    pub fn get<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.map.get(key)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Insert or replace; `live` says which entries are still live should a
    /// scan be due.
    pub fn insert(&mut self, key: K, value: V, live: impl FnMut(&K, &mut V) -> bool) {
        if !self.map.contains_key(&key) {
            self.make_room(live);
        }
        self.map.insert(key, value);
    }

    /// The entry for `key`, created with `make` if missing.
    pub fn get_or_insert_with(
        &mut self,
        key: K,
        make: impl FnOnce() -> V,
        live: impl FnMut(&K, &mut V) -> bool,
    ) -> &mut V {
        if !self.map.contains_key(&key) {
            self.make_room(live);
        }
        self.map.entry(key).or_insert_with(make)
    }

    fn make_room(&mut self, live: impl FnMut(&K, &mut V) -> bool) {
        if self.map.len() < self.next_prune {
            return;
        }
        self.map.retain(live);
        let mut next = (self.map.len() * 2).max(PRUNE_FLOOR);
        if let Some(cap) = self.cap {
            if self.map.len() * 2 > cap {
                self.map.clear();
                next = PRUNE_FLOOR;
            }
            next = next.min(cap);
        }
        self.next_prune = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn drops_expired_entries_once_the_floor_is_reached() {
        let mut map = Expiring::uncapped();
        for i in 0..PRUNE_FLOOR {
            map.insert(i, i % 2 == 0, |_, _| true);
        }
        // The next new key triggers a scan; odd values count as expired.
        map.insert(usize::MAX, true, |_, live| *live);
        assert_eq!(map.len(), PRUNE_FLOOR / 2 + 1);
        assert!(map.get(&1).is_none());
        assert_eq!(map.get(&2), Some(&true));
    }

    #[test]
    fn scans_cost_a_constant_amount_per_insertion_however_many_stay_live() {
        let mut map = Expiring::uncapped();
        let visited = Cell::new(0usize);
        let n = 20 * PRUNE_FLOOR;
        for i in 0..n {
            map.insert(i, (), |_, _| {
                visited.set(visited.get() + 1);
                true
            });
        }
        assert_eq!(map.len(), n, "live entries are never dropped");
        assert!(
            visited.get() < 2 * n,
            "{} visits for {n} inserts",
            visited.get()
        );
    }

    #[test]
    fn a_capped_cache_never_exceeds_its_cap_and_starts_over_when_full() {
        let cap = 3 * PRUNE_FLOOR;
        let mut map = Expiring::capped(cap);
        let visited = Cell::new(0usize);
        let n = 20 * cap;
        for i in 0..n {
            map.insert(i, (), |_, _| {
                visited.set(visited.get() + 1);
                true
            });
            assert!(map.len() <= cap);
        }
        assert!(
            visited.get() < 2 * n,
            "{} visits for {n} inserts",
            visited.get()
        );
    }

    #[test]
    fn replacing_an_existing_key_never_scans() {
        let mut map = Expiring::capped(PRUNE_FLOOR);
        for i in 0..PRUNE_FLOOR {
            map.insert(i, 0, |_, _| true);
        }
        map.insert(5, 1, |_, _| {
            panic!("no scan for a key that is already there")
        });
        assert_eq!(map.get(&5), Some(&1));
    }
}
