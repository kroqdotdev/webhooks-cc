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

use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
use bytes::Bytes;
use futures::TryStreamExt;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Body as HttpBody, Frame};
use tokio_util::io::{ReaderStream, StreamReader};

use crate::Body;

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

/// The body, decoded as it streams.
pub fn decode<B>(body: B, codec: Codec) -> Body
where
    B: HttpBody<Data = Bytes> + Send + Sync + Unpin + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let bytes = body
        .into_data_stream()
        .map_err(|e| std::io::Error::other(e.into()));
    let reader = StreamReader::new(bytes);
    match codec {
        Codec::Gzip => frames(GzipDecoder::new(reader)),
        Codec::Deflate => frames(ZlibDecoder::new(reader)),
        Codec::Brotli => frames(BrotliDecoder::new(reader)),
    }
}

/// A decoder's output as a body.
fn frames<R>(decoder: R) -> Body
where
    R: tokio::io::AsyncRead + Send + Sync + 'static,
{
    StreamBody::new(
        ReaderStream::new(decoder)
            .map_ok(Frame::data)
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
    )
    .boxed()
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

    #[tokio::test]
    async fn a_gzipped_page_comes_out_as_it_was_written() {
        let page = b"<html><head><title>x</title></head></html>";
        let body = Full::new(Bytes::from(gzip(page).await));
        let out = decode(body, Codec::Gzip)
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&out[..], page);
    }

    #[tokio::test]
    async fn a_broken_stream_is_an_error() {
        let body = Full::new(Bytes::from_static(b"not gzip at all"));
        assert!(decode(body, Codec::Gzip).collect().await.is_err());
    }
}
