//! What the edge adds to the HTML pages it passes on: one script tag, for
//! the report button (badge.js), right after `<head>`. The page is streamed
//! through; only its start is held until the tag is placed, and a page
//! without a `<head>` in its first [`SEARCH_LIMIT`] bytes goes on untouched.
//!
//! The same pass keeps a copy of the page's start, up to [`SCAN_LIMIT`],
//! and looks for what phishing pages have: a password or card field on a
//! page whose title names a bank or a big brand. A page built in the
//! browser has no such field in what is sent, so badge.js looks again once
//! the page has run and reports what it saw to [`FLAG_PATH`]. Either only
//! flags the share for staff to look at (the ops center's reports); it
//! blocks nothing. The words come from a private file (words.rs).

use std::pin::Pin;
use std::task::{Context, Poll, ready};

use bytes::{Bytes, BytesMut};
use hyper::body::{Body as HttpBody, Frame};
use tokio::sync::oneshot;

pub const BADGE_PATH: &str = "/__whk/badge.js";
pub const FLAG_PATH: &str = "/__whk/flag";
const TAG: &[u8] = b"<script src=\"/__whk/badge.js\" async></script>";

const SEARCH_LIMIT: usize = 64 * 1024;
/// Frames looked at for `<head` before giving up: a page whose start comes
/// in tiny pieces passes untouched rather than costing a poll per byte.
const SEARCH_FRAMES: usize = 4096;
const SCAN_LIMIT: usize = 256 * 1024;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The badge script, with the address reports go to and the brand words.
pub fn badge_script(app_url: &str) -> String {
    include_str!("badge.js")
        .replace("__REPORT_URL__", &format!("{app_url}/report"))
        .replace("__BRANDS__", &serde_json::to_string(brands()).unwrap())
}

/// Where the tag goes: just after the `<head ...>` opening tag.
#[cfg(test)]
fn insert_at(html: &[u8]) -> Option<usize> {
    HeadFinder::default().advance(html)
}

/// Finds the end of the `<head ...>` opening tag in a buffer that only
/// grows, looking at each byte once: [`HeadFinder::advance`] takes the
/// whole buffer every time and goes on where the last call stopped, so a
/// page sent one byte at a time costs no more than one sent at once.
#[derive(Default)]
struct HeadFinder {
    /// Where to look for the next `<head`; everything before it is settled.
    from: usize,
    /// Where `<head` starts, once the byte after it showed it is the tag
    /// (not `<header>`); then only its closing `>` is looked for.
    head: Option<usize>,
}

impl HeadFinder {
    /// The index just after the tag's `>`, once the buffer holds it.
    fn advance(&mut self, buf: &[u8]) -> Option<usize> {
        if self.head.is_none() {
            loop {
                let Some(rel) = buf
                    .get(self.from..)
                    .and_then(|b| b.iter().position(|&c| c == b'<'))
                else {
                    self.from = buf.len();
                    return None;
                };
                let start = self.from + rel;
                // `<head` and the byte after it decide; wait for them.
                let Some(next) = buf.get(start + 5) else {
                    let seen = &buf[start + 1..];
                    if b"head"[..seen.len()].eq_ignore_ascii_case(seen) {
                        self.from = start;
                        return None;
                    }
                    self.from = start + 1;
                    continue;
                };
                if !buf[start + 1..start + 5].eq_ignore_ascii_case(b"head") {
                    self.from = start + 1;
                    continue;
                }
                // `<header>` is not `<head>`.
                if matches!(next, b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/') {
                    self.head = Some(start);
                    self.from = start + 5;
                    break;
                }
                self.from = start + 5;
            }
        }
        match buf[self.from..].iter().position(|&c| c == b'>') {
            Some(i) => Some(self.from + i + 1),
            None => {
                self.from = buf.len();
                None
            }
        }
    }
}

/// Brand and lure words a phishing page puts in its title (words.rs).
fn brands() -> &'static [String] {
    crate::words::all()
}

/// Why a page looks like phishing, in words, or nothing.
pub fn phishing_signals(html: &[u8]) -> Vec<String> {
    let lower = String::from_utf8_lossy(html).to_ascii_lowercase();
    let squeezed: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    let password = ["type=\"password\"", "type='password'", "type=password"]
        .iter()
        .any(|p| squeezed.contains(p));
    let card = squeezed.contains("cc-number") || squeezed.contains("name=\"cardnumber\"");
    if !password && !card {
        return Vec::new();
    }
    let title = lower
        .find("<title")
        .and_then(|i| lower[i..].find('>').map(|j| i + j + 1))
        .and_then(|start| {
            lower[start..]
                .find("</title")
                .map(|end| &lower[start..start + end])
        })
        .unwrap_or("");
    let brands: Vec<&str> = brands()
        .iter()
        .map(String::as_str)
        .filter(|b| title.contains(b))
        .collect();
    describe(password, card, &brands)
}

/// "a password field", "\"paypal\" in the title"; nothing unless a field
/// and a brand are both there.
fn describe(password: bool, card: bool, brands: &[&str]) -> Vec<String> {
    if !(password || card) || brands.is_empty() {
        return Vec::new();
    }
    let mut why = Vec::new();
    if password {
        why.push("a password field".to_string());
    }
    if card {
        why.push("a card number field".to_string());
    }
    why.push(format!("\"{}\" in the title", brands.join("\", \"")));
    why
}

/// What badge.js saw in a page after it ran: which fields, which brand
/// words of [`brands`] in the title, and the page's address.
#[derive(serde::Deserialize)]
struct Seen {
    #[serde(default)]
    password: bool,
    #[serde(default)]
    card: bool,
    #[serde(default)]
    brands: Vec<String>,
    #[serde(default)]
    url: Option<String>,
}

/// A browser's report, as the same words [`phishing_signals`] uses, and the
/// page it came from, or nothing. Anyone can send one, so only facts from
/// a fixed list are taken: brand words outside [`brands`] are dropped, and
/// the words are the edge's own.
pub fn browser_signals(body: &[u8]) -> Option<(Vec<String>, Option<String>)> {
    let seen: Seen = serde_json::from_slice(body).ok()?;
    let brands: Vec<&str> = brands()
        .iter()
        .map(String::as_str)
        .filter(|b| seen.brands.iter().any(|s| s == b))
        .collect();
    let why = describe(seen.password, seen.card, &brands);
    (!why.is_empty()).then_some((why, seen.url))
}

/// An HTML body with the tag added, and a copy of its start sent to `scan`
/// when it is complete (or the page ends sooner).
pub struct Inject<B> {
    inner: B,
    /// The inner body has ended: it is not asked again, since some bodies
    /// (a stream) must not be.
    ended: bool,
    searching: bool,
    held: BytesMut,
    finder: HeadFinder,
    frames: usize,
    ready: Option<Bytes>,
    copy: BytesMut,
    scan: Option<oneshot::Sender<Bytes>>,
    tag: Vec<u8>,
}

impl<B> Inject<B> {
    pub fn new(inner: B, scan: oneshot::Sender<Bytes>) -> Self {
        Self {
            inner,
            ended: false,
            searching: true,
            held: BytesMut::new(),
            finder: HeadFinder::default(),
            frames: 0,
            ready: None,
            copy: BytesMut::new(),
            scan: Some(scan),
            tag: TAG.to_vec(),
        }
    }

    fn keep(&mut self, data: &[u8]) {
        if self.scan.is_none() {
            return;
        }
        let room = SCAN_LIMIT - self.copy.len();
        self.copy.extend_from_slice(&data[..data.len().min(room)]);
        if self.copy.len() >= SCAN_LIMIT {
            self.send_scan();
        }
    }

    fn send_scan(&mut self) {
        if let Some(scan) = self.scan.take() {
            let _ = scan.send(std::mem::take(&mut self.copy).freeze());
        }
    }

    /// Takes in a chunk while the tag is not placed yet.
    fn search(&mut self, data: Bytes) {
        self.held.extend_from_slice(&data);
        self.frames += 1;
        if let Some(at) = self.finder.advance(&self.held) {
            let mut out = BytesMut::with_capacity(self.held.len() + self.tag.len());
            out.extend_from_slice(&self.held[..at]);
            out.extend_from_slice(&self.tag);
            out.extend_from_slice(&self.held[at..]);
            self.held.clear();
            self.ready = Some(out.freeze());
            self.searching = false;
        } else if self.held.len() > SEARCH_LIMIT || self.frames >= SEARCH_FRAMES {
            self.ready = Some(self.held.split().freeze());
            self.searching = false;
        }
    }
}

impl<B> HttpBody for Inject<B>
where
    B: HttpBody<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        loop {
            if let Some(out) = self.ready.take() {
                return Poll::Ready(Some(Ok(Frame::data(out))));
            }
            if self.ended {
                return Poll::Ready(None);
            }
            match ready!(Pin::new(&mut self.inner).poll_frame(cx)) {
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(data) => {
                        self.keep(&data);
                        if self.searching {
                            self.search(data);
                            continue;
                        }
                        return Poll::Ready(Some(Ok(Frame::data(data))));
                    }
                    Err(other) => return Poll::Ready(Some(Ok(other))),
                },
                Some(Err(e)) => return Poll::Ready(Some(Err(e.into()))),
                None => {
                    self.ended = true;
                    self.send_scan();
                    if self.searching {
                        self.searching = false;
                        if !self.held.is_empty() {
                            self.ready = Some(self.held.split().freeze());
                            continue;
                        }
                    }
                    return Poll::Ready(None);
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        !self.searching && self.ready.is_none() && (self.ended || self.inner.is_end_stream())
    }
}

// hyper stops reading once a body says it has ended, without asking for
// the end itself, so the copy goes out when the body is let go.
impl<B> Drop for Inject<B> {
    fn drop(&mut self) {
        self.send_scan();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{BodyExt, Full, StreamBody};

    #[test]
    fn the_tag_goes_after_head() {
        assert_eq!(insert_at(b"<!doctype html><html><head><title>x"), Some(27));
        assert_eq!(insert_at(b"<html><HEAD lang=en><meta>"), Some(20));
        assert_eq!(insert_at(b"<html><header>nav</header><head>"), Some(32));
        assert_eq!(insert_at(b"<p>no head at all</p>"), None);
    }

    async fn run(chunks: Vec<&'static str>) -> (String, Bytes) {
        let stream = futures::stream::iter(
            chunks
                .into_iter()
                .map(|c| Ok::<_, std::convert::Infallible>(Frame::data(Bytes::from(c)))),
        );
        let (tx, rx) = oneshot::channel();
        let body = Inject::new(StreamBody::new(stream), tx);
        let out = body.collect().await.unwrap().to_bytes();
        (String::from_utf8(out.to_vec()).unwrap(), rx.await.unwrap())
    }

    #[tokio::test]
    async fn pages_get_the_tag_once_even_when_head_is_split() {
        let (out, copy) = run(vec![
            "<!doctype html><html><he",
            "ad><title>Hi</title></head>",
            "<body>x</body>",
        ])
        .await;
        assert_eq!(
            out,
            "<!doctype html><html><head><script src=\"/__whk/badge.js\" async></script><title>Hi</title></head><body>x</body>"
        );
        assert!(copy.starts_with(b"<!doctype html>"));
    }

    #[tokio::test]
    async fn a_body_that_ended_is_not_asked_again() {
        // A stream panics when polled after its end; a page without <head>
        // is held to its end and then let out.
        let stream = futures::stream::unfold(Some("<p>plain</p>"), |left| async move {
            left.map(|text| {
                (
                    Ok::<_, std::convert::Infallible>(Frame::data(Bytes::from(text))),
                    None,
                )
            })
        });
        let (tx, _rx) = oneshot::channel();
        let out = Inject::new(StreamBody::new(Box::pin(stream)), tx)
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&out[..], b"<p>plain</p>");
    }

    #[test]
    fn the_finder_takes_a_page_in_any_pieces() {
        let page = b"<!doctype html><HeAder>x</header><head lang=en><title>t</title>";
        let whole = insert_at(page).unwrap();
        for step in 1..8 {
            let mut finder = HeadFinder::default();
            let mut found = None;
            let mut end = 0;
            while found.is_none() && end < page.len() {
                end = (end + step).min(page.len());
                found = finder.advance(&page[..end]);
            }
            assert_eq!(found, Some(whole), "step {step}");
        }
        // A `<hea` at the very end waits; `<heap` does not match.
        let mut finder = HeadFinder::default();
        assert_eq!(finder.advance(b"<p><hea"), None);
        assert_eq!(finder.advance(b"<p><head>"), Some(9));
        assert_eq!(insert_at(b"<heap><head>"), Some(12));
    }

    #[tokio::test]
    async fn a_page_sent_a_byte_at_a_time_is_cheap() {
        // 64 KiB with no <head>, one byte per frame: the search gives up
        // after SEARCH_FRAMES frames and lets the page through unchanged,
        // looking at each byte once on the way.
        let page = vec![b'a'; SEARCH_LIMIT];
        let stream = futures::stream::iter(
            page.clone()
                .into_iter()
                .map(|c| Ok::<_, std::convert::Infallible>(Frame::data(Bytes::from(vec![c])))),
        );
        let (tx, _rx) = oneshot::channel();
        let started = std::time::Instant::now();
        let out = Inject::new(StreamBody::new(stream), tx)
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&out[..], &page[..]);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[tokio::test]
    async fn the_tag_is_found_across_tiny_frames() {
        let (out, _) = run(vec!["<", "h", "E", "a", "d", " ", "x", ">", "<title>t"]).await;
        assert_eq!(
            out,
            "<hEad x><script src=\"/__whk/badge.js\" async></script><title>t"
        );
    }

    #[tokio::test]
    async fn pages_without_head_pass_untouched() {
        let (out, _) = run(vec!["<p>plain</p>"]).await;
        assert_eq!(out, "<p>plain</p>");
    }

    #[tokio::test]
    async fn a_full_body_works_too() {
        let (tx, _rx) = oneshot::channel();
        let body = Inject::new(Full::new(Bytes::from("<html><head></head></html>")), tx);
        let out = body.collect().await.unwrap().to_bytes();
        assert!(out.starts_with(b"<html><head><script"));
    }

    #[tokio::test]
    async fn the_copy_arrives_when_reading_stops_at_the_stated_end() {
        // As hyper does: read until the body says it is done, then drop it.
        let (tx, rx) = oneshot::channel();
        let mut body = Inject::new(Full::new(Bytes::from("<html><head></head></html>")), tx);
        while !body.is_end_stream() {
            body.frame().await.unwrap().unwrap();
        }
        drop(body);
        assert_eq!(&rx.await.unwrap()[..], b"<html><head></head></html>");
    }

    #[test]
    fn browser_reports_keep_only_known_facts() {
        let (why, url) = browser_signals(
            br#"{"password":true,"brands":["paypal","<b>evil</b>"],"url":"https://a.sharehooks.cc/x"}"#,
        )
        .unwrap();
        assert_eq!(why, vec!["a password field", "\"paypal\" in the title"]);
        assert_eq!(url.as_deref(), Some("https://a.sharehooks.cc/x"));
        // A field but no known brand, a brand but no field, and junk.
        assert!(browser_signals(br#"{"password":true,"brands":["acme"]}"#).is_none());
        assert!(browser_signals(br#"{"brands":["paypal"]}"#).is_none());
        assert!(browser_signals(b"not json").is_none());
    }

    #[test]
    fn the_script_gets_the_brand_words() {
        let script = badge_script("https://webhooks.cc");
        assert!(script.contains("\"https://webhooks.cc/report\""));
        assert!(script.contains("[\"paypal\",\"apple id\""));
        assert!(script.contains("\"seed phrase\""));
        assert!(!script.contains("__BRANDS__"));
    }

    #[test]
    fn phishing_pages_are_spotted_and_ordinary_logins_are_not() {
        let phish = b"<html><head><title>PayPal - Log in</title></head><body><form><input type=\"password\"></form>";
        assert_eq!(
            phishing_signals(phish),
            vec!["a password field", "\"paypal\" in the title"]
        );
        let login = b"<title>Acme dashboard</title><input type=\"password\">";
        assert!(phishing_signals(login).is_empty());
        let shop = b"<title>Mastercard offers</title><p>no fields</p>";
        assert!(phishing_signals(shop).is_empty());
        let card = b"<title>Bank verification</title><input autocomplete=\"cc-number\">";
        assert_eq!(
            phishing_signals(card),
            vec!["a card number field", "\"bank\" in the title"]
        );
        let lure = b"<title>Restore wallet: enter your seed phrase</title><input type=password>";
        assert_eq!(
            phishing_signals(lure),
            vec![
                "a password field",
                "\"wallet\", \"seed phrase\" in the title"
            ]
        );
    }
}
