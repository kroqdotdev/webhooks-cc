//! What the sender's DNS says about its setup, recorded beside the
//! authentication results: its SPF record (how many there are, the `all`
//! term, how many DNS lookups it takes), the DMARC record's policy and
//! reports, the type and size of each DKIM key, a BIMI record, and whether
//! the HELO name fits the sending server.
//!
//! Only facts are recorded here. The web app decides what counts as a
//! problem (apps/web/lib/deliverability.ts), so changing a threshold never
//! needs this host redeployed. Like the other checks, these never decide
//! whether mail is accepted.
//!
//! The SPF, DKIM and DMARC checks have just looked up most of these names,
//! so the resolver's cache answers them. The SPF walk is bounded anyway,
//! because a record can include any number of other domains.

use std::net::IpAddr;

use base64::Engine;
use mail_auth::MessageAuthenticator;
use mail_auth::common::crypto::Algorithm;
use mail_auth::dmarc::{Alignment, Dmarc, Policy};
use mail_auth::hickory_resolver::net::{DnsError, NetError};
use mail_auth::hickory_resolver::proto::rr::{Name, RData};
use serde_json::{Value, json};

use crate::auth_check::{ReverseDns, resolves_to};

/// SPF records fetched while counting lookups, the first one included. The
/// count stops there and is reported as capped: past RFC 7208's limit of 10
/// lookups the record fails anyway.
const MAX_SPF_FETCHES: usize = 20;
/// How deep includes and redirects are followed.
const MAX_SPF_DEPTH: usize = 10;
/// Longest record text kept.
const MAX_RECORD_CHARS: usize = 512;
/// DKIM keys looked up; more signatures than this are not looked at.
const MAX_DKIM_KEYS: usize = 10;
/// DMARC report addresses kept, and their length.
const MAX_REPORT_URIS: usize = 3;
const MAX_URI_CHARS: usize = 200;

/// A TXT lookup's outcome, one string per record.
pub(crate) enum TxtAnswer {
    Records(Vec<String>),
    /// The name has no TXT records (or does not exist).
    Missing,
    /// The lookup failed: a timeout, a server failure, a bad name.
    Failed,
}

/// The DNS this module needs, so tests can answer without a network.
pub(crate) trait Dns {
    async fn txt(&self, name: &str) -> TxtAnswer;
    async fn resolves_to(&self, name: &str, ip: IpAddr) -> bool;
}

/// The system resolver, through mail-auth's.
pub(crate) struct LiveDns<'a>(pub &'a MessageAuthenticator);

impl Dns for LiveDns<'_> {
    async fn txt(&self, name: &str) -> TxtAnswer {
        let fqdn = if name.ends_with('.') {
            name.to_string()
        } else {
            format!("{name}.")
        };
        let Ok(name) = Name::from_str_relaxed(fqdn.as_str()) else {
            return TxtAnswer::Failed;
        };
        match self.0.0.txt_lookup(name).await {
            Ok(lookup) => {
                let records: Vec<String> = lookup
                    .answers()
                    .iter()
                    .filter_map(|record| match &record.data {
                        // A record split into several strings is one record.
                        RData::TXT(txt) => Some(
                            String::from_utf8_lossy(
                                &txt.txt_data.iter().flatten().copied().collect::<Vec<u8>>(),
                            )
                            .into_owned(),
                        ),
                        _ => None,
                    })
                    .collect();
                if records.is_empty() {
                    TxtAnswer::Missing
                } else {
                    TxtAnswer::Records(records)
                }
            }
            Err(NetError::Dns(DnsError::NoRecordsFound(_))) => TxtAnswer::Missing,
            Err(_) => TxtAnswer::Failed,
        }
    }

    async fn resolves_to(&self, name: &str, ip: IpAddr) -> bool {
        resolves_to(self.0, name.to_string(), ip).await
    }
}

/// What the checks found out about the message, for this module to build on.
pub struct SetupInput<'a> {
    pub ip: IpAddr,
    pub helo: &'a str,
    pub reverse_dns: &'a ReverseDns,
    /// The domain SPF checked: the envelope sender's, or the HELO name's.
    pub spf_domain: &'a str,
    /// The From header's domain, when there is exactly one.
    pub from_domain: Option<&'a str>,
    /// Each DKIM signature's domain, selector and algorithm.
    pub dkim: Vec<(String, String, Algorithm)>,
    /// The DMARC record that applied, if one was found.
    pub dmarc: Option<&'a Dmarc>,
}

pub(crate) async fn sender_setup(dns: &impl Dns, input: &SetupInput<'_>) -> Value {
    // Independent lookups, side by side: each DATA reply waits for them.
    let (spf, helo, dkim, bimi) = tokio::join!(
        spf(dns, input.spf_domain),
        helo(dns, input),
        dkim_keys(dns, &input.dkim),
        async {
            match input.from_domain {
                Some(domain) => Some(bimi(dns, domain).await),
                None => None,
            }
        },
    );
    let mut setup = json!({ "spf": spf, "helo": helo, "dkim": dkim });
    if let Some(record) = input.dmarc {
        setup["dmarc"] = dmarc(record);
    }
    if let Some(bimi) = bimi {
        setup["bimi"] = bimi;
    }
    setup
}

/// At most `max` characters of text from DNS or a header, without control
/// characters. (The whole document is cleaned of NUL once more before it
/// leaves, see `auth_check::fit`.)
fn cut(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

// ---------------------------------------------------------------- SPF

fn is_spf_record(text: &str) -> bool {
    // Bytes, not characters: records come from the sender's DNS, and slicing
    // a string inside a character would panic.
    let text = text.trim_start().as_bytes();
    text.len() >= 6
        && text[..6].eq_ignore_ascii_case(b"v=spf1")
        && text.get(6).is_none_or(|&c| c == b' ')
}

async fn spf_records(dns: &impl Dns, domain: &str) -> Result<Vec<String>, ()> {
    match dns.txt(domain).await {
        TxtAnswer::Records(records) => {
            Ok(records.into_iter().filter(|r| is_spf_record(r)).collect())
        }
        TxtAnswer::Missing => Ok(Vec::new()),
        TxtAnswer::Failed => Err(()),
    }
}

/// A term's mechanism or modifier, without its qualifier, and the qualifier.
fn split_qualifier(term: &str) -> (char, &str) {
    match term.chars().next() {
        Some(q @ ('+' | '-' | '~' | '?')) => (q, &term[1..]),
        _ => ('+', term),
    }
}

/// What one record's terms take: the DNS lookups it costs itself, the
/// domains it includes or redirects to, its `all` and whether it uses `ptr`.
#[derive(Debug, Default, PartialEq)]
struct SpfTerms {
    lookups: u32,
    includes: Vec<String>,
    redirect: Option<String>,
    all: Option<char>,
    ptr: bool,
}

fn spf_terms(record: &str) -> SpfTerms {
    let mut terms = SpfTerms::default();
    for term in record.split_ascii_whitespace().skip(1) {
        let (qualifier, rest) = split_qualifier(term);
        let lower = rest.to_ascii_lowercase();
        let name = lower.split([':', '/', '=']).next().unwrap_or("");
        let target = rest
            .split_once([':', '='])
            .map(|(_, target)| target.to_string());
        match name {
            "include" => {
                terms.lookups += 1;
                if let Some(target) = target {
                    terms.includes.push(target);
                }
            }
            "redirect" if lower.starts_with("redirect=") => {
                terms.lookups += 1;
                terms.redirect = target;
            }
            "a" | "mx" | "exists" => terms.lookups += 1,
            "ptr" => {
                terms.lookups += 1;
                terms.ptr = true;
            }
            "all" if lower == "all" => terms.all = Some(qualifier),
            _ => {}
        }
    }
    // RFC 7208 section 6.1: a redirect is ignored when the record has `all`.
    if terms.all.is_some() && terms.redirect.take().is_some() {
        terms.lookups -= 1;
    }
    terms
}

/// A target with a macro (`%{d}`) depends on the message; it is counted
/// but not followed.
fn followable(domain: &str) -> bool {
    !domain.contains('%') && domain.contains('.')
}

async fn spf(dns: &impl Dns, domain: &str) -> Value {
    if domain.is_empty() {
        return json!({ "domain": null, "records": 0 });
    }
    let Ok(records) = spf_records(dns, domain).await else {
        return json!({ "domain": cut(domain, MAX_URI_CHARS), "error": "lookup failed" });
    };
    let Some(first) = records.first() else {
        return json!({ "domain": cut(domain, MAX_URI_CHARS), "records": 0 });
    };

    let top = spf_terms(first);
    let mut all = top.all;
    let mut ptr = top.ptr;
    let mut lookups = top.lookups;
    let mut fetches = 1;
    let mut capped = false;
    // Included domains without an SPF record: RFC 7208 makes that a
    // permerror whenever the include is reached.
    let mut missing: Vec<String> = Vec::new();
    // Included or redirected domains with more than one SPF record: also a
    // permerror when reached.
    let mut duplicated: Vec<String> = Vec::new();
    // A nested lookup failed, so the count is short by what it would add.
    let mut incomplete = false;
    // (domain, depth, reached only through redirects from the top record:
    // such a record's `all` is the one that applies).
    let mut pending: Vec<(String, usize, bool)> = top
        .includes
        .iter()
        .map(|d| (d.clone(), 1, false))
        .chain(top.redirect.iter().map(|d| (d.clone(), 1, true)))
        .collect();
    while let Some((target, depth, via_redirect)) = pending.pop() {
        if !followable(&target) || depth > MAX_SPF_DEPTH {
            continue;
        }
        if fetches >= MAX_SPF_FETCHES {
            capped = true;
            break;
        }
        fetches += 1;
        let Ok(found) = spf_records(dns, &target).await else {
            incomplete = true;
            continue;
        };
        if found.len() > 1 && duplicated.len() < MAX_REPORT_URIS {
            duplicated.push(cut(&target, MAX_URI_CHARS));
        }
        let Some(record) = found.first() else {
            if !via_redirect && missing.len() < MAX_REPORT_URIS {
                missing.push(cut(&target, MAX_URI_CHARS));
            }
            continue;
        };
        let terms = spf_terms(record);
        lookups += terms.lookups;
        ptr |= terms.ptr;
        if via_redirect && all.is_none() {
            all = terms.all;
        }
        pending.extend(terms.includes.into_iter().map(|d| (d, depth + 1, false)));
        pending.extend(terms.redirect.map(|d| (d, depth + 1, via_redirect)));
    }

    json!({
        "domain": cut(domain, MAX_URI_CHARS),
        "records": records.len(),
        "record": cut(first.trim(), MAX_RECORD_CHARS),
        "all": all.map(|q| format!("{q}all")),
        "redirect": top.redirect.is_some(),
        "lookups": lookups,
        "lookups_capped": capped,
        "missing_includes": missing,
        "duplicate_includes": duplicated,
        "lookups_incomplete": incomplete,
        "ptr": ptr,
    })
}

// ---------------------------------------------------------------- DMARC

fn policy(policy: &Policy) -> Option<&'static str> {
    match policy {
        Policy::None => Some("none"),
        Policy::Quarantine => Some("quarantine"),
        Policy::Reject => Some("reject"),
        Policy::Unspecified => None,
    }
}

fn alignment(alignment: &Alignment) -> &'static str {
    match alignment {
        Alignment::Relaxed => "relaxed",
        Alignment::Strict => "strict",
    }
}

fn dmarc(record: &Dmarc) -> Value {
    json!({
        "p": policy(&record.p),
        "sp": policy(&record.sp),
        "adkim": alignment(&record.adkim),
        "aspf": alignment(&record.aspf),
        "rua": record
            .rua
            .iter()
            .take(MAX_REPORT_URIS)
            .map(|uri| cut(uri.uri(), MAX_URI_CHARS))
            .collect::<Vec<_>>(),
        "ruf": record.ruf.len(),
        "testing": record.t,
    })
}

// ---------------------------------------------------------------- DKIM

fn algorithm(algorithm: Algorithm) -> &'static str {
    match algorithm {
        Algorithm::RsaSha1 => "rsa-sha1",
        Algorithm::RsaSha256 => "rsa-sha256",
        Algorithm::Ed25519Sha256 => "ed25519-sha256",
    }
}

/// A DKIM key record's tags, lowercase names, values without whitespace.
fn tags(record: &str) -> Vec<(String, String)> {
    record
        .split(';')
        .filter_map(|tag| {
            let (name, value) = tag.split_once('=')?;
            Some((
                name.trim().to_ascii_lowercase(),
                value.chars().filter(|c| !c.is_ascii_whitespace()).collect(),
            ))
        })
        .collect()
}

/// The key's type and size in bits, from a key record; `None` for the size
/// when the key cannot be read. An empty `p=` is a revoked key.
fn key_facts(record: &str) -> Value {
    let tags = tags(record);
    let tag = |name: &str| {
        tags.iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    let kind = tag("k").unwrap_or("rsa").to_ascii_lowercase();
    let Some(key) = tag("p") else {
        return json!({ "key": kind, "bits": null });
    };
    if key.is_empty() {
        return json!({ "key": kind, "bits": null, "revoked": true });
    }
    let bits = base64::engine::general_purpose::STANDARD
        .decode(key)
        .ok()
        .and_then(|der| match kind.as_str() {
            "rsa" => rsa_bits(&der),
            "ed25519" if der.len() == 32 => Some(256),
            _ => None,
        });
    json!({ "key": kind, "bits": bits })
}

async fn dkim_keys(dns: &impl Dns, signatures: &[(String, String, Algorithm)]) -> Value {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    let mut keys = Vec::new();
    for (domain, selector, signed_with) in signatures {
        if seen.len() >= MAX_DKIM_KEYS || seen.contains(&(domain.as_str(), selector.as_str())) {
            continue;
        }
        seen.push((domain, selector));
        let mut entry = json!({
            "domain": cut(domain, MAX_URI_CHARS),
            "selector": cut(selector, MAX_URI_CHARS),
            "algorithm": algorithm(*signed_with),
        });
        let found = match dns.txt(&format!("{selector}._domainkey.{domain}")).await {
            TxtAnswer::Records(records) => Ok(records
                .into_iter()
                .find(|record| tags(record).iter().any(|(name, _)| name == "p"))),
            TxtAnswer::Missing => Ok(None),
            // Not the same as no key: the key may well be there.
            TxtAnswer::Failed => Err(()),
        };
        match found {
            Ok(Some(record)) => {
                if let (Value::Object(entry), Value::Object(facts)) =
                    (&mut entry, key_facts(&record))
                {
                    entry.extend(facts);
                }
            }
            Ok(None) => entry["key"] = Value::Null,
            Err(()) => {
                entry["key"] = Value::Null;
                entry["error"] = json!("lookup failed");
            }
        }
        keys.push(entry);
    }
    Value::Array(keys)
}

/// One DER element: its tag, its contents and what follows it.
fn tlv(data: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = data.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (first as usize, rest)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let len = rest[..count]
            .iter()
            .fold(0usize, |len, &b| (len << 8) | b as usize);
        (len, &rest[count..])
    };
    (rest.len() >= len).then(|| (tag, &rest[..len], &rest[len..]))
}

/// The size of a DER INTEGER's value, in bits.
fn integer_bits(integer: &[u8]) -> Option<u32> {
    let start = integer.iter().position(|&b| b != 0)?;
    let digits = &integer[start..];
    Some((digits.len() as u32 - 1) * 8 + (8 - digits[0].leading_zeros()))
}

const SEQUENCE: u8 = 0x30;
const INTEGER: u8 = 0x02;
const BIT_STRING: u8 = 0x03;

/// The modulus size of an RSA key, published as a SubjectPublicKeyInfo (the
/// usual form) or as a bare RSAPublicKey (which some signers publish).
fn rsa_bits(der: &[u8]) -> Option<u32> {
    let (tag, body, _) = tlv(der)?;
    if tag != SEQUENCE {
        return None;
    }
    let (tag, first, rest) = tlv(body)?;
    match tag {
        INTEGER => integer_bits(first),
        SEQUENCE => {
            let (tag, bits, _) = tlv(rest)?;
            // The first byte of a BIT STRING counts its unused bits.
            if tag != BIT_STRING || bits.is_empty() {
                return None;
            }
            let (tag, key, _) = tlv(&bits[1..])?;
            if tag != SEQUENCE {
                return None;
            }
            let (tag, modulus, _) = tlv(key)?;
            (tag == INTEGER).then(|| integer_bits(modulus)).flatten()
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- BIMI

fn bimi_record(record: &str) -> Option<(bool, bool)> {
    let tags = tags(record);
    let version = tags.iter().find(|(name, _)| name == "v")?;
    if !version.1.eq_ignore_ascii_case("bimi1") {
        return None;
    }
    let present = |name: &str| tags.iter().any(|(n, v)| n == name && !v.is_empty());
    Some((present("l"), present("a")))
}

/// Second-level labels under which country domains register names
/// (example.co.uk, example.com.au): a partial public suffix list.
const SECOND_LEVEL_SUFFIXES: [&str; 8] = ["co", "com", "org", "net", "ac", "gov", "edu", "ne"];

/// The organizational domain, roughly: the last two labels, or three under
/// a country's second-level suffix such as co.uk. Where to look next for a
/// BIMI record, never used to decide anything.
fn parent_domain(domain: &str) -> Option<&str> {
    let labels: Vec<&str> = domain.split('.').collect();
    let n = labels.len();
    let country_suffix =
        n >= 2 && labels[n - 1].len() == 2 && SECOND_LEVEL_SUFFIXES.contains(&labels[n - 2]);
    let keep_labels = if country_suffix { 3 } else { 2 };
    (n > keep_labels).then(|| {
        let keep = labels[n - keep_labels..].join(".").len();
        &domain[domain.len() - keep..]
    })
}

async fn bimi(dns: &impl Dns, domain: &str) -> Value {
    let domain = domain.to_ascii_lowercase();
    for candidate in std::iter::once(domain.as_str()).chain(parent_domain(&domain)) {
        match dns.txt(&format!("default._bimi.{candidate}")).await {
            TxtAnswer::Records(records) => {
                if let Some((logo, authority)) = records.iter().find_map(|r| bimi_record(r)) {
                    return json!({
                        "found": true,
                        "domain": candidate,
                        "logo": logo,
                        "authority": authority,
                    });
                }
            }
            TxtAnswer::Missing => {}
            TxtAnswer::Failed => return json!({ "found": false, "error": "lookup failed" }),
        }
    }
    json!({ "found": false })
}

// ---------------------------------------------------------------- HELO

async fn helo(dns: &impl Dns, input: &SetupInput<'_>) -> Value {
    let name = input.helo.trim().trim_end_matches('.').to_ascii_lowercase();
    let literal = name.starts_with('[') || name.parse::<IpAddr>().is_ok();
    let fqdn = !literal && name.contains('.');
    let resolves = fqdn && dns.resolves_to(&name, input.ip).await;
    let matches_ptr = input.reverse_dns.confirmed
        && input
            .reverse_dns
            .name
            .as_deref()
            .is_some_and(|ptr| ptr.eq_ignore_ascii_case(&name));
    json!({
        "name": cut(&name, MAX_URI_CHARS),
        "ip_literal": literal,
        "fqdn": fqdn,
        "resolves": resolves,
        "matches_ptr": matches_ptr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct StubDns {
        txt: HashMap<String, Vec<String>>,
        failing: Vec<String>,
        addresses: HashMap<String, IpAddr>,
        asked: Mutex<Vec<String>>,
    }

    impl StubDns {
        fn with(mut self, name: &str, records: &[&str]) -> Self {
            self.txt.insert(
                name.to_string(),
                records.iter().map(|r| r.to_string()).collect(),
            );
            self
        }
    }

    impl Dns for StubDns {
        async fn txt(&self, name: &str) -> TxtAnswer {
            self.asked.lock().unwrap().push(name.to_string());
            if self.failing.iter().any(|n| n == name) {
                return TxtAnswer::Failed;
            }
            match self.txt.get(name) {
                Some(records) => TxtAnswer::Records(records.clone()),
                None => TxtAnswer::Missing,
            }
        }

        async fn resolves_to(&self, name: &str, ip: IpAddr) -> bool {
            self.addresses.get(name) == Some(&ip)
        }
    }

    fn ip() -> IpAddr {
        "192.0.2.1".parse().unwrap()
    }

    #[test]
    fn reads_the_terms_of_a_record() {
        let terms = spf_terms(
            "v=spf1 a mx:mail.example.com ip4:192.0.2.0/24 include:_spf.example.net -all",
        );
        assert_eq!(
            terms,
            SpfTerms {
                lookups: 3,
                includes: vec!["_spf.example.net".into()],
                redirect: None,
                all: Some('-'),
                ptr: false,
            }
        );
        let terms = spf_terms("v=spf1 ptr ?exists:%{i}.x.example redirect=_spf.example.org");
        assert_eq!(terms.lookups, 3);
        assert_eq!(terms.redirect.as_deref(), Some("_spf.example.org"));
        assert!(terms.ptr);
        assert_eq!(terms.all, None);
        // With `all`, the redirect does not apply and costs nothing.
        let terms = spf_terms("v=spf1 ~all redirect=_spf.example.org");
        assert_eq!(
            (terms.lookups, terms.redirect, terms.all),
            (0, None, Some('~'))
        );
        assert!(is_spf_record("V=SPF1 -all"));
        assert!(is_spf_record("v=spf1"));
        assert!(!is_spf_record("v=spf10 -all"));
        assert!(!is_spf_record("google-site-verification=abc"));
        // A sender's DNS may hold anything; slicing inside a character panicked.
        assert!(!is_spf_record("v=\u{20ac}\u{20ac} hello"));
        assert!(!is_spf_record("\u{20ac}"));
        assert!(!is_spf_record("v=spf1\u{20ac}"));
        assert!(is_spf_record("v=spf1 \u{20ac}"));
    }

    #[tokio::test]
    async fn counts_lookups_through_includes_and_redirects() {
        let dns = StubDns::default()
            .with(
                "example.com",
                &[
                    "google-site-verification=x",
                    "v=spf1 include:a.example include:b.example redirect=r.example",
                ],
            )
            .with("a.example", &["v=spf1 include:c.example a ~all"])
            .with("b.example", &["v=spf1 ip4:192.0.2.0/24 -all"])
            .with("c.example", &["v=spf1 mx mx ptr -all"])
            .with("r.example", &["v=spf1 -all"]);
        let found = spf(&dns, "example.com").await;
        assert_eq!(found["records"], json!(1));
        // 2 includes + redirect, 1 include + a, 2 mx + ptr.
        assert_eq!(found["lookups"], json!(8));
        assert_eq!(found["all"], json!("-all"));
        assert_eq!(found["redirect"], json!(true));
        assert_eq!(found["ptr"], json!(true));
        assert_eq!(found["lookups_capped"], json!(false));
    }

    #[tokio::test]
    async fn names_includes_without_a_record() {
        let dns = StubDns::default()
            .with(
                "example.com",
                &["v=spf1 include:gone.example include:ok.example -all"],
            )
            .with("ok.example", &["v=spf1 -all"]);
        let found = spf(&dns, "example.com").await;
        assert_eq!(found["missing_includes"], json!(["gone.example"]));
        assert_eq!(found["lookups"], json!(2));
        assert_eq!(found["lookups_incomplete"], json!(false));
    }

    #[tokio::test]
    async fn notices_includes_with_two_records_and_failed_lookups() {
        let dns = StubDns {
            failing: vec!["down.example".into()],
            ..StubDns::default()
        }
        .with(
            "example.com",
            &["v=spf1 include:two.example include:down.example -all"],
        )
        .with("two.example", &["v=spf1 -all", "v=spf1 ~all"]);
        let found = spf(&dns, "example.com").await;
        assert_eq!(found["duplicate_includes"], json!(["two.example"]));
        assert_eq!(found["lookups_incomplete"], json!(true));
        assert_eq!(found["missing_includes"], json!([]));
    }

    #[tokio::test]
    async fn notices_two_records_none_and_a_failed_lookup() {
        let dns = StubDns::default().with("two.example", &["v=spf1 -all", "v=spf1 ~all"]);
        assert_eq!(spf(&dns, "two.example").await["records"], json!(2));
        assert_eq!(
            spf(&dns, "none.example").await,
            json!({ "domain": "none.example", "records": 0 })
        );
        let dns = StubDns {
            failing: vec!["down.example".into()],
            ..StubDns::default()
        };
        assert_eq!(
            spf(&dns, "down.example").await["error"],
            json!("lookup failed")
        );
    }

    #[tokio::test]
    async fn stops_walking_includes_that_never_end() {
        // Every domain includes two more: without a bound this never ends.
        let mut dns = StubDns::default();
        for i in 0..200 {
            dns = dns.with(
                &format!("d{i}.example"),
                &[&format!(
                    "v=spf1 include:d{}.example include:d{}.example -all",
                    2 * i + 1,
                    2 * i + 2
                )],
            );
        }
        let found = spf(&dns, "d0.example").await;
        assert_eq!(found["lookups_capped"], json!(true));
        assert!(found["lookups"].as_u64().unwrap() > 10);
        assert!(dns.asked.lock().unwrap().len() <= MAX_SPF_FETCHES);
    }

    #[tokio::test]
    async fn follows_the_redirect_for_all_and_never_a_macro() {
        let dns = StubDns::default()
            .with(
                "example.com",
                &["v=spf1 include:%{d}.example redirect=r.example"],
            )
            .with("r.example", &["v=spf1 ?all"]);
        let found = spf(&dns, "example.com").await;
        assert_eq!(found["all"], json!("?all"));
        assert_eq!(found["lookups"], json!(2));
        assert!(!dns.asked.lock().unwrap().iter().any(|n| n.contains('%')));
    }

    /// A DER element with a short or long length.
    fn der(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        match body.len() {
            len @ 0..0x80 => out.push(len as u8),
            len @ 0x80..0x100 => out.extend([0x81, len as u8]),
            len => out.extend([0x82, (len >> 8) as u8, len as u8]),
        }
        out.extend_from_slice(body);
        out
    }

    fn rsa_public_key(modulus_bytes: usize) -> Vec<u8> {
        // A leading zero keeps the INTEGER positive, as real keys do.
        let mut modulus = vec![0x00, 0xc5];
        modulus.resize(modulus_bytes + 1, 0x11);
        der(
            SEQUENCE,
            &[der(INTEGER, &modulus), der(INTEGER, &[1, 0, 1])].concat(),
        )
    }

    fn spki(modulus_bytes: usize) -> Vec<u8> {
        let algorithm = der(
            SEQUENCE,
            &[
                0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
            ],
        );
        let bits = der(
            BIT_STRING,
            &[&[0u8][..], &rsa_public_key(modulus_bytes)].concat(),
        );
        der(SEQUENCE, &[algorithm, bits].concat())
    }

    #[test]
    fn measures_rsa_keys_in_both_forms() {
        assert_eq!(rsa_bits(&spki(256)), Some(2048));
        assert_eq!(rsa_bits(&spki(128)), Some(1024));
        assert_eq!(rsa_bits(&rsa_public_key(64)), Some(512));
        assert_eq!(rsa_bits(&[0x30, 0x82, 0xff]), None);
        assert_eq!(rsa_bits(b""), None);
        assert_eq!(integer_bits(&[0x00, 0x01, 0x00]), Some(9));
    }

    #[tokio::test]
    async fn reads_each_dkim_key_once() {
        let b64 = |der: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(der);
        let dns = StubDns::default()
            .with(
                "s1._domainkey.example.com",
                &[&format!("v=DKIM1; k=rsa; p={}", b64(spki(128)))],
            )
            .with(
                "ed._domainkey.example.com",
                &[&format!("v=DKIM1; k=ed25519; p={}", b64(vec![7; 32]))],
            )
            .with("old._domainkey.example.com", &["v=DKIM1; p="]);
        let dns = StubDns {
            failing: vec!["down._domainkey.example.com".into()],
            ..dns
        };
        let signatures = vec![
            (
                "example.com".to_string(),
                "s1".to_string(),
                Algorithm::RsaSha1,
            ),
            (
                "example.com".to_string(),
                "s1".to_string(),
                Algorithm::RsaSha1,
            ),
            (
                "example.com".to_string(),
                "ed".to_string(),
                Algorithm::Ed25519Sha256,
            ),
            (
                "example.com".to_string(),
                "old".to_string(),
                Algorithm::RsaSha256,
            ),
            (
                "example.com".to_string(),
                "gone".to_string(),
                Algorithm::RsaSha256,
            ),
            (
                "example.com".to_string(),
                "down".to_string(),
                Algorithm::RsaSha256,
            ),
        ];
        let keys = dkim_keys(&dns, &signatures).await;
        assert_eq!(
            keys,
            json!([
                { "domain": "example.com", "selector": "s1", "algorithm": "rsa-sha1", "key": "rsa", "bits": 1024 },
                { "domain": "example.com", "selector": "ed", "algorithm": "ed25519-sha256", "key": "ed25519", "bits": 256 },
                { "domain": "example.com", "selector": "old", "algorithm": "rsa-sha256", "key": "rsa", "bits": null, "revoked": true },
                { "domain": "example.com", "selector": "gone", "algorithm": "rsa-sha256", "key": null },
                { "domain": "example.com", "selector": "down", "algorithm": "rsa-sha256", "key": null, "error": "lookup failed" },
            ])
        );
    }

    #[tokio::test]
    async fn finds_bimi_at_the_domain_or_its_parent() {
        let dns = StubDns::default().with(
            "default._bimi.example.com",
            &["v=BIMI1; l=https://example.com/logo.svg; a="],
        );
        assert_eq!(
            bimi(&dns, "News.Example.com").await,
            json!({ "found": true, "domain": "example.com", "logo": true, "authority": false })
        );
        assert_eq!(bimi(&dns, "example.org").await, json!({ "found": false }));
        assert_eq!(parent_domain("a.b.example.com"), Some("example.com"));
        assert_eq!(parent_domain("example.com"), None);
        assert_eq!(parent_domain("news.example.co.uk"), Some("example.co.uk"));
        assert_eq!(parent_domain("example.co.uk"), None);
        assert_eq!(parent_domain("a.b.example.com.au"), Some("example.com.au"));
    }

    #[tokio::test]
    async fn judges_nothing_about_helo_only_records_it() {
        let mut dns = StubDns::default();
        dns.addresses.insert("mail.example.com".into(), ip());
        let confirmed = ReverseDns {
            name: Some("mail.example.com".into()),
            confirmed: true,
        };
        let input = |helo: &'static str, reverse_dns: &'static ReverseDns| SetupInput {
            ip: ip(),
            helo,
            reverse_dns,
            spf_domain: "example.com",
            from_domain: None,
            dkim: Vec::new(),
            dmarc: None,
        };
        let confirmed: &'static ReverseDns = Box::leak(Box::new(confirmed));
        let none: &'static ReverseDns = Box::leak(Box::new(ReverseDns::default()));
        assert_eq!(
            helo(&dns, &input("Mail.Example.com.", confirmed)).await,
            json!({ "name": "mail.example.com", "ip_literal": false, "fqdn": true, "resolves": true, "matches_ptr": true })
        );
        assert_eq!(
            helo(&dns, &input("[192.0.2.1]", none)).await,
            json!({ "name": "[192.0.2.1]", "ip_literal": true, "fqdn": false, "resolves": false, "matches_ptr": false })
        );
        assert_eq!(
            helo(&dns, &input("localhost", none)).await["fqdn"],
            json!(false)
        );
    }
}
