//! A visitor's request body that must keep coming: a pause longer than
//! [`BODY_IDLE`] between pieces, or an average below [`BODY_MIN_RATE`] once
//! [`BODY_GRACE`] has passed, ends it with an error. Without it, a visitor
//! sending a body a byte now and then holds one of the visitor's and the
//! account's streams for as long as they like (limits.rs), and a few such
//! visitors would turn every visitor of the account away.

use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use hyper::body::{Body as HttpBody, Frame, SizeHint};
use tokio::time::{Instant, Sleep};

/// The longest pause between two pieces of a body.
pub const BODY_IDLE: Duration = Duration::from_secs(30);
/// How long a body may come slowly before its average counts.
pub const BODY_GRACE: Duration = Duration::from_secs(60);
/// The slowest average, in bytes a second, after [`BODY_GRACE`]: far below
/// any real upload, well above a drip.
pub const BODY_MIN_RATE: u64 = 1024;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub struct Steady<B> {
    inner: B,
    started: Instant,
    bytes: u64,
    idle: Pin<Box<Sleep>>,
}

impl<B> Steady<B> {
    pub fn new(inner: B) -> Self {
        let now = Instant::now();
        Self {
            inner,
            started: now,
            bytes: 0,
            idle: Box::pin(tokio::time::sleep_until(now + BODY_IDLE)),
        }
    }
}

fn too_slow() -> BoxError {
    "the request body came too slowly".into()
}

impl<B> HttpBody for Steady<B>
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
        let this = &mut *self;
        if let Poll::Ready(frame) = Pin::new(&mut this.inner).poll_frame(cx) {
            return Poll::Ready(match frame {
                Some(Ok(frame)) => {
                    let now = Instant::now();
                    if let Some(data) = frame.data_ref() {
                        this.bytes += data.len() as u64;
                    }
                    let took = now.duration_since(this.started);
                    if took > BODY_GRACE && this.bytes < BODY_MIN_RATE * took.as_secs() {
                        return Poll::Ready(Some(Err(too_slow())));
                    }
                    this.idle.as_mut().reset(now + BODY_IDLE);
                    Some(Ok(frame))
                }
                Some(Err(e)) => Some(Err(e.into())),
                None => None,
            });
        }
        ready!(this.idle.as_mut().poll(cx));
        Poll::Ready(Some(Err(too_slow())))
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{BodyExt, StreamBody};

    fn pieces(
        gaps: Vec<(Duration, usize)>,
    ) -> impl HttpBody<Data = Bytes, Error = std::convert::Infallible> + Unpin {
        let stream = futures::stream::unfold(gaps.into_iter(), |mut gaps| async move {
            let (gap, size) = gaps.next()?;
            tokio::time::sleep(gap).await;
            Some((
                Ok::<_, std::convert::Infallible>(Frame::data(Bytes::from(vec![b'x'; size]))),
                gaps,
            ))
        });
        StreamBody::new(Box::pin(stream))
    }

    #[tokio::test(start_paused = true)]
    async fn a_steady_body_comes_whole() {
        let body = Steady::new(pieces(vec![(Duration::from_secs(1), 10_000); 5]));
        assert_eq!(body.collect().await.unwrap().to_bytes().len(), 50_000);
    }

    #[tokio::test(start_paused = true)]
    async fn a_long_pause_ends_it() {
        let body = Steady::new(pieces(vec![
            (Duration::from_secs(1), 10),
            (BODY_IDLE + Duration::from_secs(1), 10),
        ]));
        assert!(body.collect().await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_drip_ends_it_after_the_grace() {
        // A byte every 20 seconds: never paused long, far too slow.
        let body = Steady::new(pieces(vec![(Duration::from_secs(20), 1); 10]));
        assert!(body.collect().await.is_err());
    }
}
