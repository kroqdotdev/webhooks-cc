//! Copying both ways between two connections, for a visitor's WebSocket
//! (the edge) and a stream to the local port (the CLI).
//!
//! tokio's `copy_bidirectional` waits for both directions to end. Once one
//! side has hung up that can be never: Node's HTTP server, for one, keeps
//! an upgraded socket half-open when the other end leaves, so a WebSocket a
//! visitor closed would hold its stream, the visitor's and the account's
//! counts (the edge's limits.rs) and the CLI's yamux stream for as long as
//! the share runs. Here, once one direction has ended, the other is passed
//! on its end (shut down) and gets [`LINGER`] to finish; then both close,
//! as Go's and Caddy's proxies do.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// How long the other direction may go on once one has ended.
pub const LINGER: Duration = Duration::from_secs(5);

/// Copies `a` to `b` and `b` to `a` until one direction ends, then gives
/// the other `linger` to end too. Returns the bytes copied each way.
pub async fn splice<A, B>(a: &mut A, b: &mut B, linger: Duration) -> (u64, u64)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (mut a_read, mut a_write) = tokio::io::split(a);
    let (mut b_read, mut b_write) = tokio::io::split(b);
    let a_to_b = async {
        let copied = tokio::io::copy(&mut a_read, &mut b_write)
            .await
            .unwrap_or(0);
        let _ = b_write.shutdown().await;
        copied
    };
    let b_to_a = async {
        let copied = tokio::io::copy(&mut b_read, &mut a_write)
            .await
            .unwrap_or(0);
        let _ = a_write.shutdown().await;
        copied
    };
    tokio::pin!(a_to_b, b_to_a);
    tokio::select! {
        sent = &mut a_to_b => {
            let received = tokio::time::timeout(linger, &mut b_to_a).await.unwrap_or(0);
            (sent, received)
        }
        received = &mut b_to_a => {
            let sent = tokio::time::timeout(linger, &mut a_to_b).await.unwrap_or(0);
            (sent, received)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, duplex};

    #[tokio::test]
    async fn bytes_go_both_ways_until_both_end() {
        let (mut visitor, mut a) = duplex(1024);
        let (mut b, mut local) = duplex(1024);
        let spliced = tokio::spawn(async move { splice(&mut a, &mut b, LINGER).await });
        visitor.write_all(b"hello").await.unwrap();
        let mut got = [0u8; 5];
        local.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello");
        local.write_all(b"back").await.unwrap();
        let mut got = [0u8; 4];
        visitor.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"back");
        visitor.shutdown().await.unwrap();
        // The local side hears the end, and ends too.
        let mut rest = Vec::new();
        local.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        local.shutdown().await.unwrap();
        assert_eq!(spliced.await.unwrap(), (5, 4));
    }

    #[tokio::test(start_paused = true)]
    async fn a_side_left_half_open_is_closed_after_the_linger() {
        let (mut visitor, mut a) = duplex(1024);
        let (mut b, mut local) = duplex(1024);
        let spliced = tokio::spawn(async move { splice(&mut a, &mut b, LINGER).await });
        visitor.write_all(b"bye").await.unwrap();
        // The visitor leaves; the local server never ends its side.
        drop(visitor);
        let started = tokio::time::Instant::now();
        let mut got = Vec::new();
        local.read_to_end(&mut got).await.unwrap();
        assert_eq!(got, b"bye", "what was sent before arrives");
        let (sent, _) = spliced.await.unwrap();
        assert_eq!(sent, 3);
        assert!(started.elapsed() >= LINGER);
        assert!(started.elapsed() < LINGER * 2);
        // Both ends are closed: the local server's writes now fail.
        assert!(local.write_all(&[0u8; 4096]).await.is_err());
    }

    #[tokio::test]
    async fn the_other_direction_may_finish_within_the_linger() {
        let (mut visitor, mut a) = duplex(1024);
        let (mut b, mut local) = duplex(1024);
        let spliced = tokio::spawn(async move { splice(&mut a, &mut b, LINGER).await });
        // The server says goodbye and closes; the visitor's last words
        // still reach it.
        local.write_all(b"closing").await.unwrap();
        local.shutdown().await.unwrap();
        let mut got = Vec::new();
        visitor.read_to_end(&mut got).await.unwrap();
        assert_eq!(got, b"closing");
        visitor.write_all(b"ok").await.unwrap();
        visitor.shutdown().await.unwrap();
        let mut last = Vec::new();
        local.read_to_end(&mut last).await.unwrap();
        assert_eq!(last, b"ok");
        assert_eq!(spliced.await.unwrap(), (2, 7));
    }
}
