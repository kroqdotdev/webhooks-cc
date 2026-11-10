//! The notice a visitor sees before a share's page (Free, and paid accounts
//! in their first days, as the web app says): what a preview is,
//! and a link to report it. Shown once per browser and name for a week, on
//! page loads only; assets, fetches and WebSockets go straight through.
//!
//! "Continue" posts to [`CONTINUE_PATH`], which only answers a request from
//! the notice page itself (same origin), so a link elsewhere cannot skip
//! it. The cookie it sets is signed with the edge's secret and names the
//! share (its id, so a name drawn again later starts over), so neither the
//! shared site nor another share can forge one. Both are kept from the
//! laptop: stripped from requests, and dropped from responses that try to
//! set them. Responses also may not set cookies for other hosts: until
//! sharehooks.cc is on the Public Suffix List, a `Domain=sharehooks.cc` cookie would
//! reach every other preview.

use hmac::{Hmac, KeyInit, Mac};
use http::{HeaderMap, HeaderValue, header};
use sha2::Sha256;

use crate::header_str;

pub const CONTINUE_PATH: &str = "/__whk/continue";

/// How long a browser that continued is let through.
const SEEN_SECONDS: u64 = 7 * 24 * 60 * 60;

/// `__Host-` keeps the cookie on this one host: browsers refuse it with a
/// Domain, so a sibling share cannot set it for all of sharehooks.cc. It needs
/// HTTPS, so development uses a plain name.
pub fn cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Host-whk-seen"
    } else {
        "whk-seen"
    }
}

/// Every cookie the edge sets: the notice's, and the password's (gate.rs).
const OUR_COOKIES: [&str; 4] = ["__Host-whk-seen", "whk-seen", "__Host-whk-pass", "whk-pass"];

/// Whether a request is a browser loading a page or a frame, the only kind
/// the notice stands in front of. Any method: a form on another site can
/// POST a visitor straight to a page.
pub fn is_page_visit(headers: &HeaderMap, upgrading: bool) -> bool {
    if upgrading {
        return false;
    }
    if header_str(headers, "sec-fetch-mode") == Some("navigate") {
        return true;
    }
    match header_str(headers, "sec-fetch-dest") {
        Some(dest) => matches!(dest, "document" | "iframe" | "frame" | "embed" | "object"),
        None => header_str(headers, "accept").is_some_and(|a| a.contains("text/html")),
    }
}

pub(crate) fn signature(key: &[u8], message: &str) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length");
    mac.update(message.as_bytes());
    mac
}

/// The cookie's value: when it lapses, and a signature over that and the share.
pub fn seen_value(key: &[u8], share: &str, now_secs: u64) -> String {
    let until = now_secs + SEEN_SECONDS;
    let sig = signature(key, &format!("seen|{share}|{until}")).finalize();
    format!("{until}.{}", hex::encode(sig.into_bytes()))
}

fn valid_seen(value: &str, key: &[u8], share: &str, now_secs: u64) -> bool {
    let Some((until, sig)) = value.split_once('.') else {
        return false;
    };
    let (Ok(until_secs), Ok(sig)) = (until.parse::<u64>(), hex::decode(sig)) else {
        return false;
    };
    until_secs > now_secs
        && signature(key, &format!("seen|{share}|{until}"))
            .verify_slice(&sig)
            .is_ok()
}

pub(crate) fn cookies(headers: &HeaderMap) -> impl Iterator<Item = (&str, &str)> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((k.trim(), v.trim()))
        })
}

/// Whether this browser continued past the notice for this share.
pub fn has_seen(headers: &HeaderMap, key: &[u8], share: &str, secure: bool, now_secs: u64) -> bool {
    let wanted = cookie_name(secure);
    cookies(headers).any(|(k, v)| k == wanted && valid_seen(v, key, share, now_secs))
}

fn ours(segment: &str) -> bool {
    let name = segment.split('=').next().unwrap_or("").trim();
    OUR_COOKIES.contains(&name)
}

/// Drops our cookies from a request before it goes to the laptop. Every
/// other cookie stays as it was, values without `=` and odd bytes included.
pub fn strip_request_cookies(headers: &mut HeaderMap) {
    let has_ours = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| v.split(';').any(ours));
    if !has_ours {
        return;
    }
    let values: Vec<HeaderValue> = headers.get_all(header::COOKIE).iter().cloned().collect();
    headers.remove(header::COOKIE);
    for value in values {
        let Ok(text) = value.to_str() else {
            headers.append(header::COOKIE, value);
            continue;
        };
        let kept: Vec<&str> = text
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty() && !ours(s))
            .collect();
        if !kept.is_empty()
            && let Ok(v) = HeaderValue::from_str(&kept.join("; "))
        {
            headers.append(header::COOKIE, v);
        }
    }
}

/// Drops any attempt by the laptop to set our cookies, or a cookie for a
/// host other than this preview's own (`host`, without a port).
pub fn strip_response_cookies(headers: &mut HeaderMap, host: &str) {
    let refused = |v: &HeaderValue| {
        let Ok(s) = v.to_str() else { return false };
        let name = s.split(['=', ';']).next().unwrap_or("").trim();
        let elsewhere = s.split(';').skip(1).any(|attr| {
            let (k, v) = attr.split_once('=').unwrap_or((attr, ""));
            k.trim().eq_ignore_ascii_case("domain")
                && !v.trim().trim_start_matches('.').eq_ignore_ascii_case(host)
        });
        OUR_COOKIES.contains(&name) || elsewhere
    };
    if !headers.get_all(header::SET_COOKIE).iter().any(refused) {
        return;
    }
    let kept: Vec<HeaderValue> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter(|v| !refused(v))
        .cloned()
        .collect();
    headers.remove(header::SET_COOKIE);
    for v in kept {
        headers.append(header::SET_COOKIE, v);
    }
}

/// Whether a Continue post came from the notice page on this same host, as
/// the form's own navigation: a script's fetch is not a click on the button.
pub fn from_notice_page(headers: &HeaderMap, public_origin: &str) -> bool {
    header_str(headers, "origin").is_some_and(|o| o.eq_ignore_ascii_case(public_origin))
        && header_str(headers, "sec-fetch-site").is_none_or(|s| s == "same-origin")
        && header_str(headers, "sec-fetch-mode").is_none_or(|m| m == "navigate")
}

/// Where Continue goes: a path on this host, never another site.
pub fn safe_path(to: &str) -> String {
    let ok = to.starts_with('/')
        && !to.starts_with("//")
        && to.len() <= 2048
        && !to.chars().any(|c| c == '\\' || c.is_control());
    if ok { to.to_string() } else { "/".to_string() }
}

/// The `to` field of a urlencoded Continue form.
pub fn form_target(body: &[u8]) -> String {
    let to = form_urlencoded::parse(body)
        .find(|(k, _)| k == "to")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    safe_path(&to)
}

/// The Set-Cookie header for a browser that continued.
pub fn seen_cookie(key: &[u8], share: &str, secure: bool, now_secs: u64) -> String {
    format!(
        "{}={}; Path=/; Max-Age={SEEN_SECONDS}; HttpOnly; SameSite=Lax{}",
        cookie_name(secure),
        seen_value(key, share, now_secs),
        if secure { "; Secure" } else { "" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"test secret";
    const NOW: u64 = 1_800_000_000;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn only_page_loads_get_the_notice() {
        let page = headers(&[("sec-fetch-dest", "document"), ("accept", "text/html")]);
        assert!(is_page_visit(&page, false));
        let frame = headers(&[("sec-fetch-dest", "iframe")]);
        assert!(is_page_visit(&frame, false));
        let script = headers(&[("sec-fetch-dest", "script"), ("accept", "*/*")]);
        assert!(!is_page_visit(&script, false));
        let fetch = headers(&[("sec-fetch-mode", "cors"), ("sec-fetch-dest", "empty")]);
        assert!(!is_page_visit(&fetch, false));
        let curl = headers(&[("accept", "*/*")]);
        assert!(!is_page_visit(&curl, false));
        let old_browser = headers(&[("accept", "text/html,application/xhtml+xml")]);
        assert!(is_page_visit(&old_browser, false));
        assert!(!is_page_visit(&page, true));
    }

    #[test]
    fn a_form_posted_from_another_site_gets_the_notice() {
        let posted = headers(&[
            ("sec-fetch-mode", "navigate"),
            ("sec-fetch-dest", "document"),
            ("sec-fetch-site", "cross-site"),
        ]);
        assert!(is_page_visit(&posted, false));
    }

    #[test]
    fn a_signed_cookie_lets_the_same_share_through() {
        let cookie = format!("a=1; whk-seen={}; b=2", seen_value(KEY, "calm-otter", NOW));
        let h = headers(&[("cookie", &cookie)]);
        assert!(has_seen(&h, KEY, "calm-otter", false, NOW));
        assert!(
            !has_seen(&h, KEY, "other-name", false, NOW),
            "bound to the share"
        );
        assert!(!has_seen(&h, b"another key", "calm-otter", false, NOW));
        assert!(
            !has_seen(&h, KEY, "calm-otter", true, NOW),
            "the HTTPS name differs"
        );
        assert!(
            !has_seen(&h, KEY, "calm-otter", false, NOW + SEEN_SECONDS + 1),
            "lapses"
        );
    }

    #[test]
    fn a_forged_cookie_does_not() {
        for forged in ["1", "9999999999.00", "9999999999.zz", "", "."] {
            let h = headers(&[("cookie", &format!("whk-seen={forged}"))]);
            assert!(!has_seen(&h, KEY, "calm-otter", false, NOW), "{forged}");
        }
    }

    #[test]
    fn our_cookies_never_reach_the_laptop() {
        let mut h = headers(&[
            ("cookie", "a=1; __Host-whk-seen=x; b=2"),
            ("cookie", "whk-seen=y"),
        ]);
        strip_request_cookies(&mut h);
        assert_eq!(h.get_all(header::COOKIE).iter().count(), 1);
        assert_eq!(h.get(header::COOKIE).unwrap(), "a=1; b=2");

        let mut only = headers(&[("cookie", "whk-seen=y")]);
        strip_request_cookies(&mut only);
        assert!(only.get(header::COOKIE).is_none());

        let mut untouched = headers(&[("cookie", "a=1;b=2")]);
        strip_request_cookies(&mut untouched);
        assert_eq!(untouched.get(header::COOKIE).unwrap(), "a=1;b=2");

        let mut bare = headers(&[("cookie", "flag; whk-seen=y; a=1")]);
        strip_request_cookies(&mut bare);
        assert_eq!(
            bare.get(header::COOKIE).unwrap(),
            "flag; a=1",
            "keeps a value without ="
        );
    }

    #[test]
    fn the_laptop_cannot_set_our_cookies() {
        let mut h = headers(&[
            ("set-cookie", "session=abc; Path=/"),
            ("set-cookie", "__Host-whk-seen=forged; Path=/; Secure"),
            ("set-cookie", "whk-seen=forged"),
        ]);
        strip_response_cookies(&mut h, "calm-otter.sharehooks.cc");
        let left: Vec<_> = h.get_all(header::SET_COOKIE).iter().collect();
        assert_eq!(left, vec!["session=abc; Path=/"]);
    }

    #[test]
    fn a_preview_cannot_set_cookies_for_other_previews() {
        let mut h = headers(&[
            ("set-cookie", "a=1; Domain=sharehooks.cc; Path=/"),
            ("set-cookie", "b=2; Path=/; domain=.SHAREHOOKS.CC"),
            ("set-cookie", "c=3; Domain=calm-otter.sharehooks.cc"),
            (
                "set-cookie",
                "d=4; Domain=.calm-otter.sharehooks.cc; Secure",
            ),
            ("set-cookie", "e=5; Path=/"),
        ]);
        strip_response_cookies(&mut h, "calm-otter.sharehooks.cc");
        let left: Vec<_> = h.get_all(header::SET_COOKIE).iter().collect();
        assert_eq!(
            left,
            vec![
                "c=3; Domain=calm-otter.sharehooks.cc",
                "d=4; Domain=.calm-otter.sharehooks.cc; Secure",
                "e=5; Path=/"
            ]
        );
    }

    #[test]
    fn continue_only_from_the_notice_page() {
        let origin = "https://calm-otter.sharehooks.cc";
        assert!(from_notice_page(
            &headers(&[("origin", origin), ("sec-fetch-site", "same-origin")]),
            origin
        ));
        assert!(from_notice_page(&headers(&[("origin", origin)]), origin));
        assert!(!from_notice_page(
            &headers(&[("origin", "https://evil.example")]),
            origin
        ));
        assert!(!from_notice_page(
            &headers(&[("origin", "https://other.sharehooks.cc")]),
            origin
        ));
        assert!(!from_notice_page(
            &headers(&[("origin", origin), ("sec-fetch-site", "cross-site")]),
            origin
        ));
        assert!(!from_notice_page(&headers(&[]), origin));
        assert!(
            !from_notice_page(
                &headers(&[("origin", origin), ("sec-fetch-mode", "cors")]),
                origin
            ),
            "a script's fetch is not the button"
        );
        assert!(from_notice_page(
            &headers(&[("origin", origin), ("sec-fetch-mode", "navigate")]),
            origin
        ));
    }

    #[test]
    fn continue_stays_on_this_host() {
        assert_eq!(safe_path("/pricing?plan=pro"), "/pricing?plan=pro");
        for bad in [
            "https://evil.example",
            "//evil.example",
            "/\\evil.example",
            "",
            "x",
        ] {
            assert_eq!(safe_path(bad), "/", "{bad}");
        }
        assert_eq!(form_target(b"to=%2Fdocs%3Fa%3D1"), "/docs?a=1");
        assert_eq!(form_target(b"to=https%3A%2F%2Fevil.example"), "/");
        assert_eq!(form_target(b""), "/");
    }

    #[test]
    fn the_password_cookie_is_kept_from_the_laptop_too() {
        let mut h = headers(&[("cookie", "a=1; __Host-whk-pass=x; whk-pass=y")]);
        strip_request_cookies(&mut h);
        assert_eq!(h.get(header::COOKIE).unwrap(), "a=1");
        let mut set = headers(&[
            ("set-cookie", "__Host-whk-pass=forged; Path=/; Secure"),
            ("set-cookie", "app=1"),
        ]);
        strip_response_cookies(&mut set, "a.sharehooks.cc");
        assert_eq!(set.get_all(header::SET_COOKIE).iter().count(), 1);
    }
}
