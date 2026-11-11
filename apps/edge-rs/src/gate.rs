//! Passwords on links (Pro and Business). A share behind one shows visitors
//! a password page (pages.rs) on page loads and refuses its other requests
//! (assets, fetches, WebSockets) until the visitor has the cookie set here.
//! The web app checks what they type (/api/edge/unlock) and keeps only a
//! hash. The cookie is signed with the edge's secret and names the preview
//! and the password's version, so it opens that name while that password
//! holds: a new password, or another account's share under the name later,
//! asks again, while a laptop reconnecting does not. It is kept from the
//! laptop both ways, like the notice's (notice.rs).

use hmac::Mac;
use http::HeaderMap;

use crate::notice::{cookies, safe_path, signature};

pub const UNLOCK_PATH: &str = "/__whk/unlock";

/// How long a browser that typed the password is let in.
const PASS_SECONDS: u64 = 7 * 24 * 60 * 60;

/// `__Host-`, as the notice's, so no sibling preview can set it.
pub fn cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Host-whk-pass"
    } else {
        "whk-pass"
    }
}

/// What the cookie's signature covers.
fn message(name: &str, version: &str, until: u64) -> String {
    format!("pass|{name}|{version}|{until}")
}

/// `until.signature`.
fn value(key: &[u8], name: &str, version: &str, now_secs: u64) -> String {
    let until = now_secs + PASS_SECONDS;
    let sig = hex::encode(
        signature(key, &message(name, version, until))
            .finalize()
            .into_bytes(),
    );
    format!("{until}.{sig}")
}

fn valid(value: &str, key: &[u8], name: &str, version: &str, now_secs: u64) -> bool {
    let Some((until, sig)) = value.split_once('.') else {
        return false;
    };
    let (Ok(until_secs), Ok(sig)) = (until.parse::<u64>(), hex::decode(sig)) else {
        return false;
    };
    until_secs > now_secs
        && signature(key, &message(name, version, until_secs))
            .verify_slice(&sig)
            .is_ok()
}

/// Whether this browser has typed the password for this name and version.
pub fn has_pass(
    headers: &HeaderMap,
    key: &[u8],
    name: &str,
    version: &str,
    secure: bool,
    now_secs: u64,
) -> bool {
    let wanted = cookie_name(secure);
    cookies(headers)
        .filter(|(k, _)| *k == wanted)
        .any(|(_, v)| valid(v, key, name, version, now_secs))
}

/// The Set-Cookie header for a browser that typed the right password.
pub fn pass_cookie(key: &[u8], name: &str, version: &str, secure: bool, now_secs: u64) -> String {
    format!(
        "{}={}; Path=/; Max-Age={PASS_SECONDS}; HttpOnly; SameSite=Lax{}",
        cookie_name(secure),
        value(key, name, version, now_secs),
        if secure { "; Secure" } else { "" },
    )
}

/// The password and where to go after, from a urlencoded password form.
pub fn form(body: &[u8]) -> (String, String) {
    let mut password = String::new();
    let mut to = String::new();
    for (k, v) in form_urlencoded::parse(body) {
        match k.as_ref() {
            "password" => password = v.into_owned(),
            "to" => to = v.into_owned(),
            _ => {}
        }
    }
    (password, safe_path(&to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    const KEY: &[u8] = b"test secret";
    const NOW: u64 = 1_800_000_000;

    fn with_cookie(cookie: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("cookie", HeaderValue::from_str(cookie).unwrap());
        h
    }

    #[test]
    fn the_cookie_opens_one_name_and_password() {
        let h = with_cookie(&format!(
            "a=1; whk-pass={}",
            value(KEY, "studio", "v1", NOW)
        ));
        assert!(has_pass(&h, KEY, "studio", "v1", false, NOW));
        assert!(
            !has_pass(&h, KEY, "studio", "v2", false, NOW),
            "a new password asks again"
        );
        assert!(
            !has_pass(&h, KEY, "other", "v1", false, NOW),
            "another name"
        );
        assert!(
            !has_pass(&h, b"other key", "studio", "v1", false, NOW),
            "forged"
        );
        assert!(
            !has_pass(&h, KEY, "studio", "v1", true, NOW),
            "the HTTPS name differs"
        );
        assert!(
            !has_pass(&h, KEY, "studio", "v1", false, NOW + PASS_SECONDS + 1),
            "lapses"
        );
        for forged in ["", "1", "9999999999.00", "x.y", "1.2.3"] {
            let h = with_cookie(&format!("whk-pass={forged}"));
            assert!(!has_pass(&h, KEY, "studio", "v1", false, NOW), "{forged}");
        }
    }

    #[test]
    fn the_form_keeps_unicode_and_safe_paths() {
        let (password, to) = form(b"password=r%C3%B8dgr%C3%B8d+med&to=%2Fdocs%3Fa%3D1");
        assert_eq!(password, "r\u{f8}dgr\u{f8}d med");
        assert_eq!(to, "/docs?a=1");
        let (_, elsewhere) = form(b"password=x&to=https%3A%2F%2Fevil.example");
        assert_eq!(elsewhere, "/");
    }
}
