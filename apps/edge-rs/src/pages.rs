//! The pages a visitor sees when there is nothing to show, in the style of
//! the site. Plain HTML, no scripts, nothing loaded from elsewhere. Each
//! page of a preview links to the report form for that address.

use bytes::Bytes;
use http::{Response, StatusCode, header};
use http_body_util::{BodyExt, Full};

use crate::Body;
use crate::meter::own_page;

const STYLE: &str = r#"
:root { color-scheme: light dark; --bg: #f6f7f5; --surface: #ffffff; --sunken: #eef0ec; --ink: #16181a; --muted: #5a5f63; --rule: #d9ddd8; --edge: #a3a8a4; --fail: #b3261e; --brand: #1f5f4a; --fill: #1f5f4a; --fill-hover: #26735a; --fill-ink: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #121413; --surface: #1a1d1b; --sunken: #0d0f0e; --ink: #e9ece9; --muted: #a2a8a4; --rule: #2e3330; --edge: #5b625e; --fail: #ff8f80; --brand: #7cc7a8; --fill: #2f7a5f; --fill-hover: #379070; --fill-ink: #ffffff; } }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 17px/1.6 "IBM Plex Sans", system-ui, sans-serif; }
main { width: 100%; max-width: 34rem; box-sizing: border-box; margin: 1rem; padding: 2rem 1.75rem; background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; }
.brand { margin: 0 0 2rem; color: var(--ink); font: 600 1rem/1 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: -0.01em; }
.brand span { color: var(--brand); }
h1 { margin: 0 0 0.75rem; font-size: 1.75rem; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em; }
p { margin: 0 0 1rem; color: var(--muted); }
code { font: 15px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.address { margin: 1.25rem 0 1.5rem; padding: 0.8rem 1rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--sunken); color: var(--ink); font: 16px/1.45 "IBM Plex Mono", ui-monospace, monospace; overflow-wrap: anywhere; }
a { color: var(--brand); text-underline-offset: 4px; }
.actions { margin: 1.75rem 0 1.25rem; }
.quiet { font-size: 15px; }
form { margin: 0; }
button { font: inherit; font-weight: 600; color: var(--fill-ink); background: var(--fill); border: 0; border-radius: 4px; padding: 0.7rem 1.15rem; cursor: pointer; }
button:hover { background: var(--fill-hover); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
label { display: block; margin: 0 0 0.4rem; color: var(--ink); font-size: 15px; font-weight: 600; }
input[type="password"] { box-sizing: border-box; width: 100%; margin: 0 0 1rem; padding: 0.65rem 0.8rem; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--edge); border-radius: 4px; }
.error { color: var(--fail); }
"#;

/// The site the pages link to (APP_URL), set once at start.
static APP_URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn set_app_url(url: &str) {
    let _ = APP_URL.set(url.trim_end_matches('/').to_string());
}

fn app_url() -> &'static str {
    APP_URL.get().map_or("https://webhooks.cc", String::as_str)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A page with a heading and paragraphs. Paragraphs are HTML already;
/// `report` is the report form's address for this page.
///
/// When the shared site is unreachable the status is 503, never 502 or
/// 504: Cloudflare swaps an origin's 502 and 504 for its own "Bad gateway"
/// page, and the visitor would never see these words.
fn page(status: StatusCode, title: &str, paragraphs: &[String], report: &str) -> Response<Body> {
    let paras = paragraphs
        .iter()
        .map(|p| format!("<p>{p}</p>"))
        .collect::<String>();
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store");
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response = response.header(header::RETRY_AFTER, "5");
    }
    response
        .body(full(document(title, &paras, Some(report))))
        .unwrap()
}

/// The whole document around a heading and some HTML, with the report link
/// when the page has none of its own.
fn document(title: &str, inner: &str, report: Option<&str>) -> String {
    let report = report
        .map(|r| {
            format!(
                "<p class=\"quiet\">Something wrong with this preview? <a href=\"{}\">Report it</a>.</p>",
                escape(r)
            )
        })
        .unwrap_or_default();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>{title}</title><style>{STYLE}</style></head><body><main><p class=\"brand\">sharehooks<span>.</span> by webhooks.cc</p><h1>{title}</h1>{inner}{report}<p class=\"quiet\"><a href=\"{about}\">What is this?</a></p></main></body></html>",
        title = escape(title),
        about = escape(&format!("{}/docs/share", app_url())),
    )
}

pub fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

pub fn nothing_shared(host: &str, report: &str) -> Response<Body> {
    page(
        StatusCode::NOT_FOUND,
        "Nothing is shared here",
        &[
            format!(
                "<code>{}</code> isn't showing anything right now. The share may have ended, or the link may have a typo.",
                escape(host)
            ),
            "If someone sent you this link, ask them to share it again.".into(),
        ],
        report,
    )
}

/// Reloads the same address, without a script: an empty link is this page.
const TRY_AGAIN: &str = "<a href=\"\">Try again</a>";

fn laptop_gone_page(report: &str) -> Response<Body> {
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        "The computer sharing this isn't answering",
        &[
            "The share is open, but the connection to it dropped for a moment.".into(),
            TRY_AGAIN.into(),
        ],
        report,
    )
}

fn nothing_running_page(port: u16, report: &str) -> Response<Body> {
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        "The site isn't running yet",
        &[
            format!(
                "The share is open, but nothing is running on port <code>{port}</code> on the computer sharing it. If it's yours, start your dev server. If someone sent you this link, tell them."
            ),
            TRY_AGAIN.into(),
        ],
        report,
    )
}

fn no_answer_page(port: u16, report: &str) -> Response<Body> {
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        "The site closed the connection",
        &[
            format!(
                "The site on port <code>{port}</code> ended this request without an answer. If the site is yours, its terminal may say why."
            ),
            TRY_AGAIN.into(),
        ],
        report,
    )
}

/// What a visitor sees before a share's page when the notice applies (notice.rs): where they
/// are going, on its own line, and one way on. Not framed by other sites,
/// so the button cannot be clicked from under one.
fn visitor_notice_page(host: &str, to: &str, report_url: &str) -> Response<Body> {
    notice_page(host, to, report_url, crate::notice::CONTINUE_PATH)
}

/// The notice as visitors see it, for a sample address, at
/// `/__edge/notice` off the preview hosts (the ops center can link to it). Its
/// button only shows the sample again.
pub fn notice_sample(preview_domain: &str, app_url: &str) -> Response<Body> {
    let host = format!("calm-otter-4821.{preview_domain}");
    let report = format!(
        "{app_url}/report?url={}",
        form_urlencoded::byte_serialize(format!("https://{host}/").as_bytes()).collect::<String>()
    );
    notice_page(&host, "/", &report, SAMPLE_PATH)
}

pub const SAMPLE_PATH: &str = "/__edge/notice";

fn notice_page(host: &str, to: &str, report_url: &str, action: &str) -> Response<Body> {
    // The host only: it is what to check, and a path could say anything.
    let inner = format!(
        "<p class=\"address\">{host}</p>\
         <p>A preview is a site still being worked on. It's running on someone's computer right now and reaches you through webhooks.cc, which doesn't check what's on it.</p>\
         <p>Open it if you know who sent you the link. Don't type passwords, card numbers or other private details into it unless you trust the person who sent it.</p>\
         <div class=\"actions\"><form method=\"post\" action=\"{action}\"><input type=\"hidden\" name=\"to\" value=\"{to}\"><button type=\"submit\">Open the preview</button></form></div>\
         <p class=\"quiet\">Not expecting this? <a href=\"{report}\">Report this preview</a>.</p>",
        host = escape(host),
        action = escape(action),
        to = escape(to),
        report = escape(report_url),
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-frame-options", "DENY")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        )
        .body(full(document("You're about to open a preview", &inner, None)))
        .unwrap()
}

/// What a visitor sees before a share behind a password (gate.rs): where
/// they are, and one field. `error` says why the last try failed. Not
/// framed by other sites, like the notice.
fn password_page_page(
    status: StatusCode,
    host: &str,
    to: &str,
    report_url: &str,
    error: Option<&str>,
) -> Response<Body> {
    let error = error
        .map(|e| format!("<p class=\"error\" role=\"alert\">{}</p>", escape(e)))
        .unwrap_or_default();
    let inner = format!(
        "<p class=\"address\">{host}</p>\
         <p>The person who shared it set a password. If you don't have it, ask them for it.</p>\
         {error}\
         <div class=\"actions\"><form method=\"post\" action=\"{action}\"><input type=\"hidden\" name=\"to\" value=\"{to}\"><label for=\"password\">Password</label><input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required autofocus><button type=\"submit\">Open the preview</button></form></div>",
        host = escape(host),
        action = crate::gate::UNLOCK_PATH,
        to = escape(to),
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-frame-options", "DENY")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        )
        .body(full(document(
            "This preview needs a password",
            &inner,
            Some(report_url),
        )))
        .unwrap()
}

/// Anything but a page load, on a share behind a password, without the
/// cookie: a script or a fetch has no use for the password page.
fn locked_page() -> Response<Body> {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(full("This preview needs a password.\n"))
        .unwrap()
}

/// Back to the page after Continue, with the cookie that lets it through.
fn continue_to_page(to: &str, cookie: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, to)
        .header(header::SET_COOKIE, cookie)
        .header(header::CACHE_CONTROL, "no-store")
        .body(full(""))
        .unwrap()
}

/// In place of a video, a download or another file that is not part of a
/// web page (content.rs). 403, which Cloudflare passes on as it is.
fn not_served_page(refusal: &crate::content::Refusal, report: &str) -> Response<Body> {
    let why = match refusal {
        crate::content::Refusal::TooLarge => format!(
            "This file is larger than a preview passes on ({} MB).",
            crate::content::MAX_RESPONSE / (1024 * 1024)
        ),
        crate::content::Refusal::Encoding(_) => "This page came compressed in a way a preview doesn't pass on. Previews pass on pages sent plain or compressed with gzip, deflate or Brotli.".to_string(),
        _ => "Previews show web pages: their HTML, styles, scripts, images and fonts. Videos, audio and files to download, like this one, aren't passed on.".to_string(),
    };
    page(
        StatusCode::FORBIDDEN,
        "This isn't shared through a preview",
        &[why],
        report,
    )
}

/// In place of Werkzeug's debugger console (debugger.rs): what it is, and
/// how its owner can share safely. 403, like a file kept back.
fn debugger_refused_page(report: &str) -> Response<Body> {
    page(
        StatusCode::FORBIDDEN,
        "A debugger console isn't shared through a link",
        &[
            "This is the console of the debugger that comes with Flask and Werkzeug (<code>--debug</code>). It runs code on the computer sharing this preview, so it isn't passed to anyone with the link.".into(),
            "If the preview is yours, share it without <code>--debug</code>, so an error shows a plain page. Or keep the debugger and share behind a password (<code>whk share --password</code>): its error pages, with your code, still show to whoever opens the link.".into(),
        ],
        report,
    )
}

fn too_many_page(report: &str) -> Response<Body> {
    let mut response = page(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many requests",
        &[
            "This preview is getting more requests than it can take right now. Wait a few seconds."
                .into(),
            TRY_AGAIN.into(),
        ],
        report,
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, http::HeaderValue::from_static("5"));
    response
}

/// The account behind the preview has used its plan's data for the month
/// (meter.rs). The visitor hears that it is paused, not why in detail.
fn visitor_spent_page(report: &str) -> Response<Body> {
    let mut response = page(
        StatusCode::TOO_MANY_REQUESTS,
        "That's a lot for one day",
        &[
            "You've opened a great deal of this preview today, more than one visitor may in a day. It opens for you again tomorrow.".into(),
        ],
        report,
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, http::HeaderValue::from_static("3600"));
    response
}

fn over_allowance_page(report: &str) -> Response<Body> {
    let mut response = page(
        StatusCode::TOO_MANY_REQUESTS,
        "This preview is paused",
        &[
            "The person who shared it has used this month's sharing data on their webhooks.cc plan. It opens again when the month turns, or sooner if they change plans.".into(),
            "If you're waiting to see it, let them know.".into(),
        ],
        report,
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, http::HeaderValue::from_static("3600"));
    response
}

pub fn unknown_host() -> Response<Body> {
    Response::builder()
        .status(StatusCode::MISDIRECTED_REQUEST)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(full("Unknown host\n"))
        .unwrap()
}

/// A refused tunnel connection, as JSON the CLI shows.
pub fn refused(status: u16, error: &str) -> Response<Body> {
    let body = serde_json::to_string(&whk_tunnel::ErrorBody {
        error: error.to_string(),
    })
    .unwrap();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST))
        .header(header::CONTENT_TYPE, "application/json")
        .body(full(body))
        .unwrap()
}

// The edge's own pages on a preview, marked so the owner's log shows them
// for what they are and the month's data never counts them (meter.rs).

pub fn laptop_gone(report: &str) -> Response<Body> {
    own_page(laptop_gone_page(report), "no answer")
}

pub fn nothing_running(port: u16, report: &str) -> Response<Body> {
    own_page(nothing_running_page(port, report), "no answer")
}

pub fn no_answer(port: u16, report: &str) -> Response<Body> {
    own_page(no_answer_page(port, report), "no answer")
}

pub fn visitor_notice(host: &str, to: &str, report_url: &str) -> Response<Body> {
    own_page(visitor_notice_page(host, to, report_url), "notice")
}

pub fn password_page(
    status: StatusCode,
    host: &str,
    to: &str,
    report_url: &str,
    error: Option<&str>,
) -> Response<Body> {
    own_page(
        password_page_page(status, host, to, report_url, error),
        "password",
    )
}

pub fn locked() -> Response<Body> {
    own_page(locked_page(), "password")
}

pub fn continue_to(to: &str, cookie: &str) -> Response<Body> {
    own_page(continue_to_page(to, cookie), "let in")
}

pub fn not_served(refusal: &crate::content::Refusal, report: &str) -> Response<Body> {
    own_page(not_served_page(refusal, report), "not served")
}

pub fn debugger_refused(report: &str) -> Response<Body> {
    own_page(debugger_refused_page(report), "debugger")
}

pub fn too_many(report: &str) -> Response<Body> {
    own_page(too_many_page(report), "too many requests")
}

pub fn over_allowance(report: &str) -> Response<Body> {
    own_page(over_allowance_page(report), "paused")
}

/// One visitor took their day's share of a preview (meter.rs, VISITOR_DAILY).
pub fn visitor_spent(report: &str) -> Response<Body> {
    own_page(visitor_spent_page(report), "visitor's day used")
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = "https://webhooks.cc/report?url=https%3A%2F%2Fa.sharehooks.cc%2F";

    #[test]
    fn unreachable_sites_answer_503_so_cloudflare_shows_our_page() {
        for response in [
            laptop_gone(REPORT),
            nothing_running(3000, REPORT),
            no_answer(3000, REPORT),
        ] {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()[header::RETRY_AFTER], "5");
        }
    }

    #[tokio::test]
    async fn the_debugger_page_says_what_it_is_and_how_to_share_safely() {
        let response = debugger_refused(REPORT);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let html = response.into_body().collect().await.unwrap().to_bytes();
        let html = String::from_utf8(html.to_vec()).unwrap();
        assert!(html.contains("<h1>A debugger console isn't shared through a link</h1>"));
        assert!(html.contains("without <code>--debug</code>"));
        assert!(html.contains("<code>whk share --password</code>"));
    }

    #[tokio::test]
    async fn preview_pages_link_to_the_report_form() {
        let response = nothing_shared(
            "a.sharehooks.cc",
            "https://webhooks.cc/report?url=x&y=\"z\"",
        );
        let html = response.into_body().collect().await.unwrap().to_bytes();
        let html = String::from_utf8(html.to_vec()).unwrap();
        assert!(html.contains(
            "<a href=\"https://webhooks.cc/report?url=x&amp;y=&quot;z&quot;\">Report it</a>"
        ));
    }
}
