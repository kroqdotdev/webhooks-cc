//! Egress for file drops: a SOCKS5 CONNECT proxy (RFC 1928, with RFC 1929
//! username and password) that the web app's file drops (SFTP, FTP, S3)
//! connect through, so a customer's server sees this host's address, never
//! the production web host's. It listens on the private network only
//! (`MX_EGRESS_LISTEN`), takes the shared secret as the password
//! (`MX_EGRESS_SECRET`), resolves names itself, and refuses loopback,
//! private, link-local, CGNAT, multicast and other reserved addresses, and
//! the ports the web app refuses, so it cannot be used to reach anything but
//! the public internet. Nothing about the targets is logged.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

/// Connections through the proxy at once.
const MAX_CONNECTIONS: usize = 64;
/// Greeting, login and request must arrive within this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The longest a connection may stay open (a drop writes a few files).
const MAX_LIFETIME: Duration = Duration::from_secs(15 * 60);

/// The web app's refused ports (lib/forwarding/target.ts BLOCKED_PORTS without 22).
const BLOCKED_PORTS: &[u16] = &[
    23, 25, 135, 139, 389, 445, 636, 3306, 3389, 5432, 5672, 5900, 6379, 9200, 9300, 11211, 15672,
    27017, 27018, 27019,
];

/// Addresses of a name tried at most, within one CONNECT_TIMEOUT.
const MAX_ADDRESSES: usize = 4;

#[derive(Clone)]
pub struct Egress {
    secret: Arc<String>,
    /// Development only: let loopback and private addresses through.
    allow_private: bool,
    /// Public addresses never to connect to: this host's own and the web
    /// host's (a connection to them stays inside the box, past the firewall).
    deny: Arc<Vec<IpAddr>>,
}

impl Egress {
    pub fn new(secret: String, allow_private: bool, deny: Vec<IpAddr>) -> Self {
        Self {
            secret: Arc::new(secret),
            allow_private,
            deny: Arc::new(deny.into_iter().map(|ip| ip.to_canonical()).collect()),
        }
    }

    /// Judged in canonical form: an IPv4-mapped IPv6 answer
    /// (`::ffff:a.b.c.d`) is the IPv4 address, for the deny list too.
    fn refuses(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.deny.contains(&ip) || (!self.allow_private && is_blocked(ip))
    }
}

/// Whether an address is one a drop may never reach.
pub fn is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => {
            // Anything that carries an IPv4 address is judged by it.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_v4(v4);
            }
            let s = v6.segments();
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0..6] == [0, 0, 0, 0, 0, 0]) // IPv4-compatible
                || (s[0] == 0x64 && s[1] == 0xff9b) // NAT64
                || s[0] == 0x2002 // 6to4
                || (s[0] == 0x2001 && s[1] == 0) // Teredo
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0) // discard 100::/64
        }
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
        || o[0] >= 240
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking 198.18/15
}

/// Accepts connections until `stopped` turns true.
pub async fn serve(listener: TcpListener, egress: Egress, mut stopped: watch::Receiver<bool>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    // Full: refuse rather than queue.
                    drop(stream);
                    continue;
                };
                let egress = egress.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = handle(stream, &egress).await {
                        tracing::debug!(error, "egress connection ended");
                    }
                });
            }
            _ = stopped.changed() => {
                if *stopped.borrow() { return; }
            }
        }
    }
}

/// SOCKS5 reply codes.
mod reply {
    pub const OK: u8 = 0;
    pub const NOT_ALLOWED: u8 = 2;
    pub const HOST_UNREACHABLE: u8 = 4;
    pub const REFUSED: u8 = 5;
    pub const TIMED_OUT: u8 = 6;
    pub const COMMAND: u8 = 7;
    pub const ADDRESS_TYPE: u8 = 8;
}

async fn send_reply(stream: &mut TcpStream, code: u8, bound: Option<SocketAddr>) {
    let mut out = vec![5, code, 0];
    match bound {
        Some(SocketAddr::V4(a)) => {
            out.push(1);
            out.extend_from_slice(&a.ip().octets());
            out.extend_from_slice(&a.port().to_be_bytes());
        }
        Some(SocketAddr::V6(a)) => {
            out.push(4);
            out.extend_from_slice(&a.ip().octets());
            out.extend_from_slice(&a.port().to_be_bytes());
        }
        None => out.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0]),
    }
    let _ = stream.write_all(&out).await;
}

/// Equal in constant time for equal lengths.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

enum Target {
    Name(String),
    Ip(IpAddr),
}

async fn handshake(stream: &mut TcpStream, egress: &Egress) -> Result<(Target, u16), &'static str> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.map_err(|_| "greeting")?;
    if head[0] != 5 || head[1] == 0 {
        return Err("not socks5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|_| "greeting")?;
    if !methods.contains(&2) {
        let _ = stream.write_all(&[5, 0xff]).await;
        return Err("no password method");
    }
    stream.write_all(&[5, 2]).await.map_err(|_| "write")?;

    let mut version = [0u8; 2];
    stream.read_exact(&mut version).await.map_err(|_| "login")?;
    let mut user = vec![0u8; version[1] as usize];
    stream.read_exact(&mut user).await.map_err(|_| "login")?;
    let mut length = [0u8; 1];
    stream.read_exact(&mut length).await.map_err(|_| "login")?;
    let mut password = vec![0u8; length[0] as usize];
    stream
        .read_exact(&mut password)
        .await
        .map_err(|_| "login")?;
    if version[0] != 1 || !same(&password, egress.secret.as_bytes()) {
        let _ = stream.write_all(&[1, 1]).await;
        return Err("refused login");
    }
    stream.write_all(&[1, 0]).await.map_err(|_| "write")?;

    let mut request = [0u8; 4];
    stream
        .read_exact(&mut request)
        .await
        .map_err(|_| "request")?;
    if request[0] != 5 {
        return Err("request version");
    }
    if request[1] != 1 {
        send_reply(stream, reply::COMMAND, None).await;
        return Err("not connect");
    }
    let target = match request[3] {
        1 => {
            let mut octets = [0u8; 4];
            stream
                .read_exact(&mut octets)
                .await
                .map_err(|_| "request")?;
            Target::Ip(IpAddr::V4(Ipv4Addr::from(octets)))
        }
        4 => {
            let mut octets = [0u8; 16];
            stream
                .read_exact(&mut octets)
                .await
                .map_err(|_| "request")?;
            Target::Ip(IpAddr::V6(Ipv6Addr::from(octets)))
        }
        3 => {
            let mut length = [0u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|_| "request")?;
            let mut name = vec![0u8; length[0] as usize];
            stream.read_exact(&mut name).await.map_err(|_| "request")?;
            let name = String::from_utf8(name).map_err(|_| "name")?;
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            {
                send_reply(stream, reply::ADDRESS_TYPE, None).await;
                return Err("bad name");
            }
            Target::Name(name)
        }
        _ => {
            send_reply(stream, reply::ADDRESS_TYPE, None).await;
            return Err("address type");
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await.map_err(|_| "request")?;
    Ok((target, u16::from_be_bytes(port)))
}

async fn handle(mut stream: TcpStream, egress: &Egress) -> Result<(), &'static str> {
    let (target, port) = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, egress))
        .await
        .map_err(|_| "handshake timeout")??;
    if BLOCKED_PORTS.contains(&port) || port == 0 {
        send_reply(&mut stream, reply::NOT_ALLOWED, None).await;
        return Err("blocked port");
    }
    // One deadline for the lookup and every address of the name, and only a
    // few of them: the web app has given up by then, and the slot must not
    // stay taken (a slow resolver included).
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    let addresses: Vec<SocketAddr> = match target {
        Target::Ip(ip) => vec![SocketAddr::new(ip, port)],
        Target::Name(name) => {
            match tokio::time::timeout_at(deadline, tokio::net::lookup_host((name.as_str(), port)))
                .await
            {
                Ok(Ok(found)) => found.collect(),
                Ok(Err(_)) => {
                    send_reply(&mut stream, reply::HOST_UNREACHABLE, None).await;
                    return Err("lookup");
                }
                Err(_) => {
                    send_reply(&mut stream, reply::TIMED_OUT, None).await;
                    return Err("lookup timeout");
                }
            }
        }
    };
    // Any blocked address refuses the whole name, as the web app does: a
    // name that mixes public and private addresses is not a drop target.
    if addresses.is_empty() || addresses.iter().any(|a| egress.refuses(a.ip())) {
        send_reply(&mut stream, reply::NOT_ALLOWED, None).await;
        return Err("blocked address");
    }
    let mut upstream = None;
    let mut last = reply::HOST_UNREACHABLE;
    for address in addresses.iter().take(MAX_ADDRESSES) {
        match tokio::time::timeout_at(deadline, TcpStream::connect(address)).await {
            Ok(Ok(connected)) => {
                upstream = Some(connected);
                break;
            }
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                last = reply::REFUSED;
            }
            Ok(Err(_)) => last = reply::HOST_UNREACHABLE,
            Err(_) => {
                last = reply::TIMED_OUT;
                break;
            }
        }
    }
    let Some(mut upstream) = upstream else {
        send_reply(&mut stream, last, None).await;
        return Err("connect");
    };
    let _ = upstream.set_nodelay(true);
    // The address reached, where RFC 1928 has the bound one: the web app
    // sends an FTP data connection to that same address, never to the name
    // again (which could resolve elsewhere by then).
    let reached = upstream.peer_addr().ok();
    send_reply(&mut stream, reply::OK, reached).await;
    let _ = tokio::time::timeout(
        MAX_LIFETIME,
        tokio::io::copy_bidirectional(&mut stream, &mut upstream),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_what_is_not_the_public_internet() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "2002::1",
            "2001::1",
        ] {
            assert!(is_blocked(ip.parse().unwrap()), "{ip} should be blocked");
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "::ffff:1.1.1.1",
        ] {
            assert!(!is_blocked(ip.parse().unwrap()), "{ip} should pass");
        }
    }

    async fn echo_server() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut read, mut write) = stream.split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });
        address
    }

    async fn proxy(allow_private: bool) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (_stop, stopped) = watch::channel(false);
        tokio::spawn(async move {
            let _keep = _stop;
            serve(
                listener,
                Egress::new("s3cret-value".into(), allow_private, Vec::new()),
                stopped,
            )
            .await;
        });
        address
    }

    /// Greets, logs in and asks for `name:port`; returns the reply code and the stream.
    async fn connect(proxy: SocketAddr, password: &str, name: &str, port: u16) -> (u8, TcpStream) {
        let mut stream = TcpStream::connect(proxy).await.unwrap();
        stream.write_all(&[5, 1, 2]).await.unwrap();
        let mut method = [0u8; 2];
        stream.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [5, 2]);
        let mut login = vec![1, 5];
        login.extend_from_slice(b"drops");
        login.push(password.len() as u8);
        login.extend_from_slice(password.as_bytes());
        stream.write_all(&login).await.unwrap();
        let mut status = [0u8; 2];
        stream.read_exact(&mut status).await.unwrap();
        if status[1] != 0 {
            return (0xff, stream);
        }
        let mut request = vec![5, 1, 0, 3, name.len() as u8];
        request.extend_from_slice(name.as_bytes());
        request.extend_from_slice(&port.to_be_bytes());
        stream.write_all(&request).await.unwrap();
        let mut head = [0u8; 4];
        stream.read_exact(&mut head).await.unwrap();
        let rest = if head[3] == 4 { 18 } else { 6 };
        let mut bound = vec![0u8; rest];
        stream.read_exact(&mut bound).await.unwrap();
        (head[1], stream)
    }

    #[test]
    fn refuses_denied_addresses_however_they_are_written() {
        let egress = Egress::new("s".into(), false, vec!["203.0.113.7".parse().unwrap()]);
        assert!(egress.refuses("203.0.113.7".parse().unwrap()));
        assert!(egress.refuses("::ffff:203.0.113.7".parse().unwrap()));
        assert!(!egress.refuses("203.0.113.8".parse().unwrap()));
    }

    #[tokio::test]
    async fn tunnels_after_the_login_and_refuses_private_addresses() {
        let echo = echo_server().await;

        // Production rules: loopback is refused, a wrong password too.
        let strict = proxy(false).await;
        let (code, _) = connect(strict, "s3cret-value", "localhost", echo.port()).await;
        assert_eq!(code, reply::NOT_ALLOWED);
        let (code, _) = connect(strict, "wrong", "localhost", echo.port()).await;
        assert_eq!(code, 0xff);
        let (code, _) = connect(strict, "s3cret-value", "localhost", 25).await;
        assert_eq!(code, reply::NOT_ALLOWED);

        // Development: the tunnel carries bytes both ways.
        let open = proxy(true).await;
        let (code, mut stream) = connect(open, "s3cret-value", "127.0.0.1", echo.port()).await;
        assert_eq!(code, reply::OK);
        stream.write_all(b"hello").await.unwrap();
        let mut back = [0u8; 5];
        stream.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"hello");
    }
}
