//! A page the laptop compressed, read back for the report button and the
//! phishing look (inject.rs). The edge asks for pages uncompressed (it drops
//! `Accept-Encoding` on page loads), but a server may compress anyway, and
//! a browser decodes what it gets: a page that came compressed would skip
//! both. So a page is decoded on its way through and goes on uncompressed
//! (Cloudflare compresses it again for the visitor). Gzip, deflate and
//! Brotli are what browsers and servers use; a page in any other encoding
//! is refused (content.rs).
//!
//! It streams: nothing is held whole, and what comes out is capped like
//! any answer (`content::MAX_RESPONSE`, in main.rs), so a small body that
//! inflates to gigabytes is cut off there.
//!
//! What a decoder holds is its window: 32 KiB for gzip and deflate, up to
//! 16 MiB for Brotli, reserved on the first read whatever the body's size.
//! So a Brotli stream may ask for 4 MiB at most ([`MAX_BROTLI_WINDOW_BITS`],
//! what servers use by default; larger windows are refused), and pages
//! decoded at once are capped per account and for the edge ([`Decodes`]):
//! 64 at most, 256 MiB all told, which held.rs counts on top of its own
//! budget. A page holds its slot for [`DECODE_FOR`] at most: a laptop that
//! sends a compressed page a byte now and then would otherwise keep one for
//! as long as it liked, and 64 such pages turn every other compressed page
//! away.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
use bytes::Bytes;
use futures::TryStreamExt;
use http::HeaderMap;
use http_body_util::{BodyExt, BodyStream, StreamBody};
use hyper::body::{Body as HttpBody, Frame};
use tokio_util::io::{ReaderStream, StreamReader};

use crate::Body;

/// The largest Brotli window a page may ask for: 2^22 bytes (4 MiB), the
/// default of Brotli encoders. A larger one (up to 16 MiB, or the
/// non-standard large window) would hold that much of the edge's memory
/// for each page being decoded, from a body of a few bytes.
pub const MAX_BROTLI_WINDOW_BITS: u8 = 22;

/// Pages one account may have decoded at once.
pub const DECODES_PER_ACCOUNT: usize = 8;

/// Pages the edge decodes at once, all accounts together.
pub const DECODES_TOTAL: usize = 64;

/// How long a page may take to decode before it is broken off and its
/// slot given back. A page of the most the edge passes (50 MB) goes in
/// some 10 seconds at a share's pace; one still coming after this is
/// stalled or dripping.
pub const DECODE_FOR: Duration = Duration::from_secs(120);

/// Frames read before giving up on a Brotli body that has not yet sent a
/// byte (empty frames from a laptop that stalls the look).
const FIRST_BYTE_FRAMES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Gzip,
    Deflate,
    Brotli,
}

/// What a `Content-Encoding` value asks for: `Ok(None)` for none (or
/// identity), `Ok(Some)` for one the edge reads, `Err` for anything else,
/// a list of encodings included.
pub fn codec(value: Option<&str>) -> Result<Option<Codec>, String> {
    let Some(value) = value.map(|v| v.trim().to_ascii_lowercase()) else {
        return Ok(None);
    };
    match value.as_str() {
        "" | "identity" => Ok(None),
        "gzip" | "x-gzip" => Ok(Some(Codec::Gzip)),
        "deflate" => Ok(Some(Codec::Deflate)),
        "br" => Ok(Some(Codec::Brotli)),
        _ => Err(value),
    }
}

/// What an answer's `Content-Encoding` headers ask for, all of them:
/// every header and every comma-separated part. None (or `identity`) is
/// `Ok(None)`, exactly one coding the edge reads is `Ok(Some)`, and anything
/// else is `Err`: two codings, an unknown one, an empty part (`""` before
/// `gzip` is no encoding to one reader and gzip to another), or a value
/// that is not text.
pub fn codec_of(headers: &HeaderMap) -> Result<Option<Codec>, String> {
    let mut parts = Vec::new();
    for value in headers.get_all(http::header::CONTENT_ENCODING) {
        let Ok(text) = value.to_str() else {
            return Err("an encoding that is not text".to_string());
        };
        parts.extend(text.split(',').map(|p| p.trim().to_ascii_lowercase()));
    }
    match parts.as_slice() {
        [] => Ok(None),
        [one] if one.is_empty() => Err("an empty encoding".to_string()),
        [one] => codec(Some(one)),
        _ => Err(parts.join(", ")),
    }
}

/// The window a Brotli stream asks for, in bits, from its first byte
/// (RFC 7932, 9.1: WBITS, read from the lowest bit up). `None` for the
/// large-window extension, which standard decoders refuse anyway.
pub fn brotli_window_bits(first: u8) -> Option<u8> {
    if first & 1 == 0 {
        return Some(16);
    }
    match (first >> 1) & 0b111 {
        0 => match (first >> 4) & 0b111 {
            0 => Some(17),
            1 => None,
            m => Some(8 + m),
        },
        n => Some(17 + n),
    }
}

/// A Brotli body whose window is no larger than
/// [`MAX_BROTLI_WINDOW_BITS`], given back whole; `Err` says why it is
/// refused. Reads only as far as the first byte, before anything is sent
/// to the visitor, so a refusal can still be the edge's own page.
pub async fn brotli_checked(mut body: Body) -> Result<Body, String> {
    let mut seen = Vec::new();
    loop {
        if seen.len() >= FIRST_BYTE_FRAMES {
            return Err("br that sent nothing to read".to_string());
        }
        match body.frame().await {
            None => break,
            Some(Err(_)) => return Err("a broken br stream".to_string()),
            Some(Ok(frame)) => {
                let first = frame.data_ref().and_then(|d| d.first().copied());
                seen.push(frame);
                if let Some(first) = first {
                    match brotli_window_bits(first) {
                        Some(bits) if bits <= MAX_BROTLI_WINDOW_BITS => break,
                        Some(bits) => {
                            return Err(format!(
                                "br with a {} MiB window",
                                1u32 << (bits - 20).min(12)
                            ));
                        }
                        None => return Err("br with a large window".to_string()),
                    }
                }
            }
        }
    }
    let replay = futures::stream::iter(seen.into_iter().map(Ok));
    Ok(BodyExt::boxed(StreamBody::new(futures::StreamExt::chain(
        replay,
        BodyStream::new(body),
    ))))
}

/// The body, decoded as it streams. The slot is held until the decoder is
/// dropped, so it counts for as long as the window is held.
pub fn decode<B>(body: B, codec: Codec, slot: DecodeSlot) -> Body
where
    B: HttpBody<Data = Bytes> + Send + Sync + Unpin + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let bytes = body
        .into_data_stream()
        .map_err(|e| std::io::Error::other(e.into()));
    let reader = StreamReader::new(bytes);
    let decoded = match codec {
        Codec::Gzip => frames(GzipDecoder::new(reader), slot),
        Codec::Deflate => frames(ZlibDecoder::new(reader), slot),
        Codec::Brotli => frames(BrotliDecoder::new(reader), slot),
    };
    Deadline::new(decoded, DECODE_FOR).boxed()
}

/// A decoded body that ends with an error once its time is up, letting go
/// of the decoder (its window and its slot) at once.
struct Deadline {
    inner: Option<Body>,
    deadline: Pin<Box<tokio::time::Sleep>>,
}

impl Deadline {
    fn new(inner: Body, after: Duration) -> Self {
        Self {
            inner: Some(inner),
            deadline: Box::pin(tokio::time::sleep(after)),
        }
    }
}

impl HttpBody for Deadline {
    type Data = Bytes;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        // First, so a page that keeps coming cannot outrun it either.
        if self.inner.is_some() && self.deadline.as_mut().poll(cx).is_ready() {
            self.inner = None;
            return Poll::Ready(Some(Err("the page took too long to decode".into())));
        }
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(None);
        };
        let frame = ready!(Pin::new(inner).poll_frame(cx));
        if frame.is_none() {
            self.inner = None;
        }
        Poll::Ready(frame)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.as_ref().is_none_or(|b| b.is_end_stream())
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner
            .as_ref()
            .map_or_else(|| hyper::body::SizeHint::with_exact(0), |b| b.size_hint())
    }
}

/// A decoder's output as a body.
fn frames<R>(decoder: R, slot: DecodeSlot) -> Body
where
    R: tokio::io::AsyncRead + Send + Sync + 'static,
{
    StreamBody::new(
        ReaderStream::new(decoder)
            .map_ok(move |chunk| {
                let _held = &slot;
                Frame::data(chunk)
            })
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
    )
    .boxed()
}

/// Pages being decoded, per account and for the edge, so the windows they
/// hold stay within a bound however many pages visitors open.
pub struct Decodes {
    per_account: usize,
    total: usize,
    taken: Mutex<(usize, HashMap<String, usize>)>,
}

/// One page being decoded; given back when dropped.
pub struct DecodeSlot {
    decodes: Arc<Decodes>,
    account: String,
}

impl Default for Decodes {
    fn default() -> Self {
        Self {
            per_account: DECODES_PER_ACCOUNT,
            total: DECODES_TOTAL,
            taken: Mutex::new((0, HashMap::new())),
        }
    }
}

impl Decodes {
    #[cfg(test)]
    pub fn new(per_account: usize, total: usize) -> Arc<Self> {
        Arc::new(Self {
            per_account,
            total,
            taken: Mutex::new((0, HashMap::new())),
        })
    }

    /// A slot for one more page of this account, or `None` when the
    /// account or the edge has all it may have.
    pub fn take(self: &Arc<Self>, account: &str) -> Option<DecodeSlot> {
        let mut taken = self.taken.lock().unwrap_or_else(|e| e.into_inner());
        let (total, accounts) = &mut *taken;
        let mine = accounts.get(account).copied().unwrap_or(0);
        if *total >= self.total || mine >= self.per_account {
            return None;
        }
        *total += 1;
        accounts.insert(account.to_string(), mine + 1);
        Some(DecodeSlot {
            decodes: self.clone(),
            account: account.to_string(),
        })
    }

    #[cfg(test)]
    fn in_use(&self) -> usize {
        self.taken.lock().unwrap().0
    }
}

impl Drop for DecodeSlot {
    fn drop(&mut self) {
        let mut taken = self.decodes.taken.lock().unwrap_or_else(|e| e.into_inner());
        let (total, accounts) = &mut *taken;
        *total = total.saturating_sub(1);
        if let Some(mine) = accounts.get_mut(&self.account) {
            *mine = mine.saturating_sub(1);
            if *mine == 0 {
                accounts.remove(&self.account);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::Full;
    use tokio::io::AsyncWriteExt;

    async fn gzip(text: &[u8]) -> Vec<u8> {
        let mut encoder = async_compression::tokio::write::GzipEncoder::new(Vec::new());
        encoder.write_all(text).await.unwrap();
        encoder.shutdown().await.unwrap();
        encoder.into_inner()
    }

    #[test]
    fn encodings_are_read_or_refused() {
        assert_eq!(codec(None), Ok(None));
        assert_eq!(codec(Some("identity")), Ok(None));
        assert_eq!(codec(Some("GZIP")), Ok(Some(Codec::Gzip)));
        assert_eq!(codec(Some("br")), Ok(Some(Codec::Brotli)));
        assert_eq!(codec(Some("deflate")), Ok(Some(Codec::Deflate)));
        assert_eq!(codec(Some("zstd")), Err("zstd".to_string()));
        assert_eq!(codec(Some("gzip, br")), Err("gzip, br".to_string()));
    }

    fn slot() -> DecodeSlot {
        Decodes::new(8, 64).take("u").unwrap()
    }

    fn headers(values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(
                http::header::CONTENT_ENCODING,
                http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn every_encoding_header_and_part_is_read() {
        assert_eq!(codec_of(&headers(&[])), Ok(None));
        assert_eq!(codec_of(&headers(&["identity"])), Ok(None));
        assert_eq!(codec_of(&headers(&["gzip"])), Ok(Some(Codec::Gzip)));
        assert_eq!(codec_of(&headers(&[" BR "])), Ok(Some(Codec::Brotli)));
        // An empty first value hid a gzip body from the edge.
        assert!(codec_of(&headers(&["", "gzip"])).is_err());
        assert!(codec_of(&headers(&["gzip", "gzip"])).is_err());
        assert!(codec_of(&headers(&["gzip, br"])).is_err());
        assert!(codec_of(&headers(&["gzip,"])).is_err());
        assert!(codec_of(&headers(&[""])).is_err());
        assert!(codec_of(&headers(&["zstd"])).is_err());
    }

    #[test]
    fn the_brotli_window_is_read_from_the_first_byte() {
        assert_eq!(brotli_window_bits(0b0000_0000), Some(16));
        assert_eq!(brotli_window_bits(0b0000_1011), Some(22));
        assert_eq!(brotli_window_bits(0b0000_1111), Some(24));
        assert_eq!(brotli_window_bits(0b0000_0011), Some(18));
        assert_eq!(brotli_window_bits(0b0000_0001), Some(17));
        assert_eq!(brotli_window_bits(0b0010_0001), Some(10));
        assert_eq!(brotli_window_bits(0b0001_0001), None);
    }

    async fn brotli(text: &[u8], window: u32) -> Vec<u8> {
        let mut encoder = async_compression::tokio::write::BrotliEncoder::with_params(
            Vec::new(),
            async_compression::brotli::EncoderParams::default().window_size(window as i32),
        );
        encoder.write_all(text).await.unwrap();
        encoder.shutdown().await.unwrap();
        encoder.into_inner()
    }

    fn boxed(bytes: Vec<u8>) -> Body {
        Full::new(Bytes::from(bytes))
            .map_err(|e: std::convert::Infallible| match e {})
            .boxed()
    }

    #[tokio::test]
    async fn a_16_mib_brotli_window_is_refused_before_decoding() {
        let page = brotli(b"<html><head></head></html>", 24).await;
        assert_eq!(brotli_window_bits(page[0]), Some(24));
        let why = brotli_checked(boxed(page)).await.err().unwrap();
        assert!(why.contains("16 MiB"), "{why}");
    }

    #[tokio::test]
    async fn a_default_brotli_page_is_given_back_whole_and_decodes() {
        let page = b"<html><head><title>x</title></head></html>";
        let encoded = brotli(page, 22).await;
        let body = brotli_checked(boxed(encoded)).await.unwrap();
        let out = decode(body, Codec::Brotli, slot())
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&out[..], page);
    }

    #[tokio::test]
    async fn a_gzipped_page_comes_out_as_it_was_written() {
        let page = b"<html><head><title>x</title></head></html>";
        let body = Full::new(Bytes::from(gzip(page).await));
        let out = decode(body, Codec::Gzip, slot())
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&out[..], page);
    }

    #[tokio::test]
    async fn a_broken_stream_is_an_error() {
        let body = Full::new(Bytes::from_static(b"not gzip at all"));
        assert!(decode(body, Codec::Gzip, slot()).collect().await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_stalls_gives_its_slot_back_after_its_time() {
        let decodes = Decodes::new(1, 1);
        // The laptop sends the start of a gzipped page and then nothing.
        let page = gzip(&[b'a'; 64 * 1024]).await;
        let start = Bytes::copy_from_slice(&page[..page.len() / 2]);
        let stream = futures::StreamExt::chain(
            futures::stream::once(
                async move { Ok::<_, std::convert::Infallible>(Frame::data(start)) },
            ),
            futures::stream::pending(),
        );
        let mut body = decode(
            StreamBody::new(Box::pin(stream)),
            Codec::Gzip,
            decodes.take("a").unwrap(),
        );
        let started = tokio::time::Instant::now();
        let mut failed = false;
        while let Some(frame) = body.frame().await {
            if frame.is_err() {
                failed = true;
                break;
            }
        }
        assert!(failed, "broken off, not ended as if whole");
        assert!(started.elapsed() >= DECODE_FOR);
        assert_eq!(decodes.in_use(), 0, "the slot is given back at once");
        assert!(body.frame().await.is_none());
    }

    #[tokio::test]
    async fn decodes_are_capped_per_account_and_for_the_edge_and_given_back() {
        let decodes = Decodes::new(2, 3);
        let a1 = decodes.take("a").unwrap();
        let _a2 = decodes.take("a").unwrap();
        assert!(decodes.take("a").is_none(), "account cap");
        let _b1 = decodes.take("b").unwrap();
        assert!(decodes.take("c").is_none(), "edge cap");
        drop(a1);
        assert!(decodes.take("c").is_some());
        // A decoded body gives its slot back once dropped.
        let decodes = Decodes::new(1, 1);
        let body = decode(
            Full::new(Bytes::from(gzip(b"x").await)),
            Codec::Gzip,
            decodes.take("a").unwrap(),
        );
        assert_eq!(decodes.in_use(), 1);
        let _ = body.collect().await;
        assert_eq!(decodes.in_use(), 0);
    }
}
