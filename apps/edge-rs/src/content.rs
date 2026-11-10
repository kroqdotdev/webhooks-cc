//! What a preview may send visitors: the stuff web pages are made of, and
//! nothing else. Videos, audio, documents, archives, installers and any
//! file sent as a download are kept from visitors, so a preview cannot be used
//! to hand out files or stream media from someone's laptop.
//!
//! A response sent as a download (`Content-Disposition: attachment`) is
//! refused too, except to an `<img>`: Next.js sends every optimized image
//! that way (`images.contentDispositionType`), and a browser only draws an
//! image it loads for a page. Opened on its own, it would be saved as a
//! file, so it is still refused then.
//!
//! It is an allowlist by media type, since a list of forbidden types would
//! always miss the next one; a response with no type at all is refused too,
//! as browsers may save it as a file. Bodies are capped at
//! [`MAX_RESPONSE`], up front when the length is stated and while streaming
//! when it is not.
//!
//! An error with no type is the one exception: SvelteKit, for one, answers
//! a form from another site with a 403 and no `Content-Type`, and the
//! developer needs to read it. A 4xx or 5xx up to [`MAX_UNTYPED_ERROR`]
//! goes on as plain text, which the browser is told not to take for
//! anything else ([`Pass::AsText`]). An untyped 2xx is still refused, so a
//! preview cannot hand out files that way.

use std::pin::Pin;
use std::task::{Context, Poll, ready};

use bytes::Bytes;
use http::{HeaderMap, HeaderValue, StatusCode, header};
use hyper::body::{Body as HttpBody, Frame, SizeHint};

use crate::header_str;

/// The largest response passed on. A dev server's biggest script bundle is
/// a few megabytes; anything near this is a file, not a page.
pub const MAX_RESPONSE: usize = 50 * 1024 * 1024;

/// The largest untyped error passed on, as plain text. A framework's error
/// message is a line (SvelteKit's 403 is 46 bytes), and a plain-text stack
/// trace a few kilobytes, so 64 KB holds any of them whole. A file sent
/// this way would be cut at 64 KB and shown as text, never played, run or
/// saved, so an error status is no way round [`Refusal::Untyped`].
pub const MAX_UNTYPED_ERROR: usize = 64 * 1024;

/// How a response goes on to the visitor, once [`check`] lets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    /// As the laptop sent it.
    AsSent,
    /// An error with no `Content-Type`: as plain text ([`as_text`]), its
    /// body cut at [`MAX_UNTYPED_ERROR`] ([`Capped`]).
    AsText,
}

/// Why a response was kept from the visitor, in words for the developer.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A media type outside the allowlist: "video/mp4".
    Kind(String),
    /// `Content-Disposition: attachment`.
    Download,
    /// No `Content-Type` on a response with a body.
    Untyped,
    TooLarge,
}

impl Refusal {
    /// "a video (video/mp4)", for the CLI's line.
    pub fn describe(&self) -> String {
        match self {
            Refusal::Kind(kind) => {
                let what = match kind.split('/').next().unwrap_or("") {
                    "video" => "a video",
                    "audio" => "audio",
                    _ => "a file",
                };
                format!("{what} ({kind})")
            }
            Refusal::Download => "a download".into(),
            Refusal::Untyped => "a file with no content type".into(),
            Refusal::TooLarge => format!("a file over {} MB", MAX_RESPONSE / (1024 * 1024)),
        }
    }
}

/// Media types a web page is made of.
fn allowed(kind: &str) -> bool {
    const EXACT: &[&str] = &[
        "application/javascript",
        "application/x-javascript",
        "application/ecmascript",
        "application/json",
        "application/x-ndjson",
        "application/xml",
        "application/wasm",
        "application/x-www-form-urlencoded",
        "application/font-woff",
        "application/font-woff2",
        "application/x-font-woff",
        "application/x-font-ttf",
        "application/x-font-otf",
        "application/vnd.ms-fontobject",
    ];
    kind.starts_with("text/")
        || kind.starts_with("image/")
        || kind.starts_with("font/")
        || kind.ends_with("+json")
        || kind.ends_with("+xml")
        || EXACT.contains(&kind)
}

/// Whether a response from the laptop may go on to the visitor, and how.
/// `dest` is what the browser asked for it as (`Sec-Fetch-Dest`): "image"
/// for an `<img>`.
pub fn check(status: StatusCode, headers: &HeaderMap, dest: Option<&str>) -> Result<Pass, Refusal> {
    // Nothing to show: informational, no content, not modified, redirects.
    if status.is_informational() || status.is_redirection() || status == StatusCode::NO_CONTENT {
        return Ok(Pass::AsSent);
    }
    if dest != Some("image")
        && header_str(headers, "content-disposition").is_some_and(|d| {
            d.trim_start()
                .to_ascii_lowercase()
                .starts_with("attachment")
        })
    {
        return Err(Refusal::Download);
    }
    let length = header_str(headers, "content-length").and_then(|l| l.parse::<u64>().ok());
    if length.is_some_and(|l| l > MAX_RESPONSE as u64) {
        return Err(Refusal::TooLarge);
    }
    let Some(kind) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|v| !v.is_empty())
    else {
        let error = status.is_client_error() || status.is_server_error();
        return if length == Some(0) {
            Ok(Pass::AsSent)
        } else if error && length.is_none_or(|l| l <= MAX_UNTYPED_ERROR as u64) {
            // With no length stated, it is cut while it streams.
            Ok(Pass::AsText)
        } else {
            Err(Refusal::Untyped)
        };
    };
    if allowed(&kind) {
        Ok(Pass::AsSent)
    } else {
        Err(Refusal::Kind(kind))
    }
}

/// Marks an untyped error as plain text, and tells the browser to read it
/// as nothing else: not a page, a script or a style, whatever it holds.
pub fn as_text(headers: &mut HeaderMap) {
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

/// A body that ends after `cap` bytes, cleanly: what comes past it is
/// dropped, and the visitor gets the start as a whole answer, not one cut
/// off with an error. A stated length over the cap is refused up front
/// ([`check`]), so it only ever ends an answer whose length was not
/// stated, and ending early breaks no promise.
pub struct Capped<B> {
    inner: B,
    left: usize,
}

impl<B> Capped<B> {
    pub fn new(inner: B, cap: usize) -> Self {
        Self { inner, left: cap }
    }
}

impl<B> HttpBody for Capped<B>
where
    B: HttpBody<Data = Bytes> + Unpin,
{
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if self.left == 0 {
            return Poll::Ready(None);
        }
        let frame = match ready!(Pin::new(&mut self.inner).poll_frame(cx)) {
            Some(Ok(frame)) => frame,
            other => return Poll::Ready(other),
        };
        Poll::Ready(Some(Ok(match frame.into_data() {
            Ok(mut data) => {
                data.truncate(self.left);
                self.left -= data.len();
                Frame::data(data)
            }
            Err(trailers) => trailers,
        })))
    }

    fn is_end_stream(&self) -> bool {
        self.left == 0 || self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        let inner = self.inner.size_hint();
        let left = self.left as u64;
        let mut hint = SizeHint::new();
        hint.set_lower(inner.lower().min(left));
        hint.set_upper(inner.upper().map_or(left, |u| u.min(left)));
        hint
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn response(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn ok(pairs: &[(&'static str, &str)]) -> bool {
        check(StatusCode::OK, &response(pairs), None).is_ok()
    }

    #[test]
    fn web_pages_pass() {
        for kind in [
            "text/html; charset=utf-8",
            "text/css",
            "application/javascript",
            "text/javascript",
            "application/json",
            "text/x-component",
            "text/event-stream",
            "image/svg+xml",
            "image/webp",
            "font/woff2",
            "application/manifest+json",
            "application/wasm",
            "TEXT/HTML",
        ] {
            assert!(ok(&[("content-type", kind)]), "{kind}");
        }
    }

    #[test]
    fn media_documents_and_binaries_do_not() {
        for kind in [
            "video/mp4",
            "audio/mpeg",
            "application/pdf",
            "application/zip",
            "application/octet-stream",
            "application/x-msdownload",
            "application/vnd.android.package-archive",
            "application/x-apple-diskimage",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ] {
            assert_eq!(
                check(StatusCode::OK, &response(&[("content-type", kind)]), None),
                Err(Refusal::Kind(kind.to_string())),
                "{kind}"
            );
        }
    }

    #[test]
    fn downloads_untyped_and_large_responses_do_not() {
        assert_eq!(
            check(
                StatusCode::OK,
                &response(&[
                    ("content-type", "text/plain"),
                    ("content-disposition", "attachment; filename=setup.exe")
                ]),
                None
            ),
            Err(Refusal::Download)
        );
        assert_eq!(
            check(StatusCode::OK, &response(&[]), None),
            Err(Refusal::Untyped)
        );
        assert_eq!(
            check(
                StatusCode::OK,
                &response(&[
                    ("content-type", "image/png"),
                    ("content-length", "52428801")
                ]),
                None
            ),
            Err(Refusal::TooLarge)
        );
        assert!(ok(&[
            ("content-disposition", "inline"),
            ("content-type", "text/html")
        ]));
    }

    #[test]
    fn an_image_sent_as_a_download_shows_in_a_page_but_is_not_handed_out() {
        // As Next.js's /_next/image sends every image.
        let next_image = response(&[
            ("content-type", "image/webp"),
            (
                "content-disposition",
                "attachment; filename=\"tiif1922.webp\"",
            ),
        ]);
        assert!(check(StatusCode::OK, &next_image, Some("image")).is_ok());
        // Opened on its own, it would be saved as a file.
        assert_eq!(
            check(StatusCode::OK, &next_image, Some("document")),
            Err(Refusal::Download)
        );
        assert_eq!(
            check(StatusCode::OK, &next_image, None),
            Err(Refusal::Download)
        );
        // Only images: anything else asked for as one is still refused.
        let zip = response(&[
            ("content-type", "application/zip"),
            ("content-disposition", "attachment; filename=files.zip"),
        ]);
        assert_eq!(
            check(StatusCode::OK, &zip, Some("image")),
            Err(Refusal::Kind("application/zip".into()))
        );
    }

    #[test]
    fn untyped_errors_pass_as_plain_text_up_to_the_cap() {
        let error = |status: u16, pairs: &[(&'static str, &str)]| {
            check(
                StatusCode::from_u16(status).unwrap(),
                &response(pairs),
                None,
            )
        };
        // SvelteKit's 403 for a form from another site, with its length.
        assert_eq!(error(403, &[("content-length", "46")]), Ok(Pass::AsText));
        // Chunked: no length up front, so it is cut while it streams.
        assert_eq!(error(403, &[]), Ok(Pass::AsText));
        assert_eq!(
            error(500, &[("transfer-encoding", "chunked")]),
            Ok(Pass::AsText)
        );
        assert_eq!(error(404, &[("content-length", "65536")]), Ok(Pass::AsText));
        assert_eq!(
            error(502, &[("content-length", "65537")]),
            Err(Refusal::Untyped)
        );
        assert_eq!(error(403, &[("content-length", "0")]), Ok(Pass::AsSent));
        // A typed error goes as it was sent.
        assert_eq!(
            error(403, &[("content-type", "text/html")]),
            Ok(Pass::AsSent)
        );
    }

    #[test]
    fn untyped_successes_are_still_refused_so_previews_hand_out_no_files() {
        for status in [
            StatusCode::OK,
            StatusCode::CREATED,
            StatusCode::PARTIAL_CONTENT,
        ] {
            assert_eq!(
                check(status, &response(&[("content-length", "46")]), None),
                Err(Refusal::Untyped),
                "{status}"
            );
            assert_eq!(
                check(status, &response(&[]), None),
                Err(Refusal::Untyped),
                "{status}"
            );
        }
        // An error sent as a download is still a download.
        assert_eq!(
            check(
                StatusCode::FORBIDDEN,
                &response(&[("content-disposition", "attachment; filename=a.bin")]),
                None
            ),
            Err(Refusal::Download)
        );
    }

    #[test]
    fn an_untyped_error_reads_as_plain_text_and_nothing_else() {
        let mut headers = response(&[("content-length", "46")]);
        as_text(&mut headers);
        assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CONTENT_LENGTH], "46");
    }

    fn chunks(
        sizes: Vec<usize>,
    ) -> impl HttpBody<Data = Bytes, Error = std::convert::Infallible> + Unpin {
        http_body_util::StreamBody::new(futures::stream::iter(
            sizes.into_iter().map(|n| {
                Ok::<_, std::convert::Infallible>(Frame::data(Bytes::from(vec![b'x'; n])))
            }),
        ))
    }

    async fn read(body: impl HttpBody<Data = Bytes, Error = std::convert::Infallible>) -> usize {
        use http_body_util::BodyExt;
        body.collect().await.unwrap().to_bytes().len()
    }

    #[tokio::test]
    async fn a_streamed_error_ends_cleanly_at_the_cap() {
        // Whole, when it fits.
        assert_eq!(
            read(Capped::new(chunks(vec![46]), MAX_UNTYPED_ERROR)).await,
            46
        );
        assert_eq!(
            read(Capped::new(chunks(vec![32 * 1024; 2]), MAX_UNTYPED_ERROR)).await,
            MAX_UNTYPED_ERROR
        );
        // Cut inside a chunk, and the body still ends without an error.
        assert_eq!(
            read(Capped::new(chunks(vec![40 * 1024; 3]), MAX_UNTYPED_ERROR)).await,
            MAX_UNTYPED_ERROR
        );
        // One that never ends is cut too.
        let endless = http_body_util::StreamBody::new(futures::stream::repeat_with(|| {
            Ok::<_, std::convert::Infallible>(Frame::data(Bytes::from_static(&[b'x'; 1000])))
        }));
        let capped = Capped::new(endless, MAX_UNTYPED_ERROR);
        assert_eq!(read(capped).await, MAX_UNTYPED_ERROR);
    }

    #[test]
    fn a_capped_body_says_it_is_no_longer_than_the_cap() {
        let capped = Capped::new(http_body_util::Full::new(Bytes::from(vec![0; 100])), 10);
        assert_eq!(capped.size_hint().upper(), Some(10));
        assert_eq!(capped.size_hint().lower(), 10);
        let short = Capped::new(http_body_util::Full::new(Bytes::from(vec![0; 4])), 10);
        assert_eq!(short.size_hint().exact(), Some(4));
    }

    #[test]
    fn empty_answers_pass() {
        assert!(check(StatusCode::NOT_MODIFIED, &response(&[]), None).is_ok());
        assert!(check(StatusCode::NO_CONTENT, &response(&[]), None).is_ok());
        assert!(check(StatusCode::FOUND, &response(&[("location", "/x")]), None).is_ok());
        assert!(ok(&[("content-length", "0")]));
    }

    #[test]
    fn refusals_read_plainly() {
        assert_eq!(
            Refusal::Kind("video/mp4".into()).describe(),
            "a video (video/mp4)"
        );
        assert_eq!(Refusal::TooLarge.describe(), "a file over 50 MB");
    }
}
