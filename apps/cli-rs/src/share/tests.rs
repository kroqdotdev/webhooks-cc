use super::*;

use std::sync::{Arc, Mutex};

use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

#[test]
fn durations_read_plainly() {
    assert_eq!(duration(7200), "2 h");
    assert_eq!(duration(5400), "1 h 30 min");
    assert_eq!(duration(2700), "45 min");
    assert_eq!(duration(7199), "2 h");
}

#[test]
fn visitor_text_is_safe_to_print() {
    assert_eq!(printable("/pricing?plan=pro", 160), "/pricing?plan=pro");
    assert_eq!(printable("/a\u{1b}[31mred", 160), "/a\\u{1b}[31mred");
    assert_eq!(printable("/\u{202e}txt.exe", 160), "/\\u{202e}txt.exe");
    assert_eq!(printable("/abcdef", 3), "/ab...");
}

#[test]
fn passwords_go_as_hex_and_are_checked() {
    assert_eq!(password_header("pässword"), "70c3a47373776f7264");
    assert!(password_problem("short").is_some());
    assert!(password_problem(&"x".repeat(201)).is_some());
    assert!(password_problem("long enough").is_none());
}

fn at(host: LocalHost, port: u16) -> LocalTarget {
    LocalTarget { host, port }
}

#[test]
fn share_targets_are_local_ports() {
    assert_eq!(
        parse_share_target("3000").unwrap(),
        at(LocalHost::Localhost, 3000)
    );
    assert_eq!(
        parse_share_target("localhost:5173").unwrap(),
        at(LocalHost::Localhost, 5173)
    );
    assert_eq!(
        parse_share_target("http://localhost:8080/").unwrap(),
        at(LocalHost::Localhost, 8080)
    );
    assert_eq!(
        parse_share_target("127.0.0.1:4321").unwrap(),
        at(LocalHost::V4, 4321)
    );
    assert_eq!(
        parse_share_target("[::1]:5173").unwrap(),
        at(LocalHost::V6, 5173)
    );
    assert_eq!(
        parse_share_target("HTTP://LOCALHOST:3000").unwrap(),
        at(LocalHost::Localhost, 3000)
    );
    assert!(parse_share_target("0").is_err());
    assert!(parse_share_target("65536").is_err());
    assert!(parse_share_target("example.com:80").is_err());
    assert!(parse_share_target("abc").is_err());
}

#[test]
fn share_targets_say_what_is_not_supported() {
    let https = parse_share_target("https://localhost:3000").unwrap_err();
    assert!(https.to_string().contains("HTTPS"), "{https}");
    let path = parse_share_target("http://127.0.0.1:3000/app").unwrap_err();
    assert!(path.to_string().contains("whole port"), "{path}");
    assert!(path.to_string().contains("whk share 3000"), "{path}");
    let port = parse_share_target("65536").unwrap_err();
    assert!(port.to_string().contains("local port"), "{port}");
}

#[test]
fn targets_print_the_address_they_reach() {
    assert_eq!(at(LocalHost::Localhost, 3000).display(), "localhost:3000");
    assert_eq!(at(LocalHost::V4, 5173).display(), "127.0.0.1:5173");
    assert_eq!(at(LocalHost::V6, 5173).display(), "[::1]:5173");
}

#[test]
fn a_refusal_after_the_share_was_live_is_a_stop() {
    assert!(refusal_is_a_stop(410, false));
    assert!(refusal_is_a_stop(403, true));
    assert!(refusal_is_a_stop(409, true));
    assert!(!refusal_is_a_stop(403, false));
    // A revoked key while reconnecting: the share was live, so it stopped.
    assert!(refusal_is_a_stop(401, true));
    assert!(!refusal_is_a_stop(401, false));
}

#[test]
fn other_schemes_are_refused_by_name() {
    let err = parse_local_target("ftp://localhost:5173")
        .unwrap_err()
        .to_string();
    assert!(
        err.starts_with("ftp:// isn't something whk can forward to"),
        "{err}"
    );
    let err = parse_local_target("ws://localhost:5173")
        .unwrap_err()
        .to_string();
    assert!(err.starts_with("ws://"), "{err}");
    assert!(parse_local_target("HTTP://localhost:5173").is_ok());
}

#[test]
fn instance_ids_differ_per_run() {
    let a = instance_id();
    assert_eq!(a.len(), 32);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, instance_id());
}

#[test]
fn refusals_and_the_edges_trouble_are_told_apart() {
    assert_eq!(
        refusal(
            403,
            Some(br#"{"error":"Passwords on links come with Pro."}"#)
        ),
        Failure::Refused {
            status: 403,
            message: "Passwords on links come with Pro.".to_string()
        }
    );
    // Without the edge's own body it never came from the edge: a
    // Cloudflare page or a proxy, so try again.
    assert_eq!(
        refusal(409, Some(b"not json")),
        Failure::Transient("The tunnel answered 409.".to_string())
    );
    assert_eq!(
        refusal(403, Some(b"<html>Access denied</html>")),
        Failure::Transient("The tunnel answered 403.".to_string())
    );
    assert_eq!(
        refusal(502, None),
        Failure::Transient("The tunnel answered 502.".to_string())
    );
    // 429 is passing trouble even in the edge's words.
    assert_eq!(
        refusal(429, Some(br#"{"error":"Slow down."}"#)),
        Failure::Transient("Slow down.".to_string())
    );
    assert_eq!(
        refusal(410, Some(br#"{"error":"This share was stopped."}"#)),
        Failure::Refused {
            status: 410,
            message: "This share was stopped.".to_string()
        }
    );
}

#[test]
fn reconnect_waits_get_up_to_half_again_at_random() {
    for _ in 0..50 {
        let got = jittered(Duration::from_secs(4));
        assert!(
            got >= Duration::from_secs(4) && got <= Duration::from_secs(6),
            "{got:?}"
        );
    }
}

#[test]
fn reconnect_waits_grow_and_start_over_after_a_long_share() {
    let second = Duration::from_secs(1);
    assert_eq!(doubled(second), Duration::from_secs(2));
    assert_eq!(doubled(Duration::from_secs(20)), MAX_WAIT);
    assert_eq!(
        next_wait(Duration::from_secs(16), Duration::from_secs(60)),
        second
    );
    assert_eq!(
        next_wait(Duration::from_secs(16), Duration::from_secs(5)),
        Duration::from_secs(16)
    );
}

#[test]
fn a_relayed_request_goes_under_the_base_path_with_the_headers() {
    let rewrite = Rewrite {
        base_path: "/api/webhooks".to_string(),
        headers: vec![("X-Test".to_string(), "1".to_string())],
    };
    let head = b"POST /stripe?x=1 HTTP/1.1\r\nhost: localhost:3000\r\nx-test: old\r\nx-forwarded-uri: /forged\r\ncontent-length: 2\r\n\r\n";
    let out = String::from_utf8(rewrite_head(head, &rewrite).unwrap()).unwrap();
    // The original path rides along (the sender's own copy dropped), so the
    // app can rebuild the URL the sender signed.
    assert_eq!(
        out,
        "POST /api/webhooks/stripe?x=1 HTTP/1.1\r\nhost: localhost:3000\r\ncontent-length: 2\r\nX-Test: 1\r\nX-Forwarded-Uri: /stripe?x=1\r\n\r\n"
    );
    // A header that would start a new line is left out.
    let sneaky = Rewrite {
        base_path: String::new(),
        headers: vec![("X-A".to_string(), "1\r\nX-B: 2".to_string())],
    };
    let out = String::from_utf8(rewrite_head(b"GET / HTTP/1.1\r\n\r\n", &sneaky).unwrap()).unwrap();
    assert_eq!(out, "GET / HTTP/1.1\r\nX-Forwarded-Uri: /\r\n\r\n");
    assert!(rewrite_head(b"not http\r\n\r\n", &rewrite).is_none());
}

#[tokio::test]
async fn the_head_is_read_whole_and_the_body_follows() {
    let rewrite = Rewrite {
        base_path: "/hooks".to_string(),
        headers: vec![],
    };
    let (mut a, mut b) = tokio::io::duplex(64);
    tokio::spawn(async move {
        // In small pieces, as a stream may deliver it.
        for piece in [
            &b"POST /x HT"[..],
            b"TP/1.1\r\ncontent-length: 2\r",
            b"\n\r\nhi",
        ] {
            a.write_all(piece).await.unwrap();
        }
    });
    let Head::Ready { bytes: out, .. } = rewritten_head(&mut b, &rewrite, false).await.unwrap()
    else {
        panic!("a head that ends is read");
    };
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "POST /hooks/x HTTP/1.1\r\ncontent-length: 2\r\nX-Forwarded-Uri: /x\r\n\r\nhi"
    );
}

#[test]
fn nothing_listening_is_marked_for_the_edge() {
    let text = String::from_utf8(nothing_listening(at(LocalHost::Localhost, 3000))).unwrap();
    assert!(text.starts_with("HTTP/1.1 502 "));
    assert!(text.contains("x-whk-nothing-listening: 1\r\n"));
    assert!(text.ends_with("Nothing is running on localhost:3000.\n"));
    let v4 = String::from_utf8(nothing_listening(at(LocalHost::V4, 5173))).unwrap();
    assert!(v4.ends_with("Nothing is running on 127.0.0.1:5173.\n"));
}

/// A local server that answers every request with "hello".
async fn hello_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let mut got = Vec::new();
                while find_head_end(&got).is_none() {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                }
                let line = String::from_utf8_lossy(&got)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                let body = format!("hello {line}");
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    port
}

/// A stand-in for the edge: checks the headers, says Ready, opens one
/// stream with a request, reads the answer, then closes the share.
#[allow(clippy::result_large_err)]
async fn fake_edge(
    seen: Arc<Mutex<Vec<(String, String)>>>,
    answer: Arc<Mutex<String>>,
    request_line: &'static str,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let headers = seen.clone();
        let callback = move |request: &Request, response: Response| {
            let mut seen = headers.lock().unwrap();
            for (name, value) in request.headers() {
                seen.push((
                    name.as_str().to_string(),
                    value.to_str().unwrap_or("").to_string(),
                ));
            }
            seen.push(("path".to_string(), request.uri().path().to_string()));
            Ok(response)
        };
        let ws =
            tokio_tungstenite::accept_hdr_async_with_config(socket, callback, Some(ws::config()))
                .await
                .unwrap();
        let (bytes, text) = ws::split(ws);
        let (opener, _none, _task) = mux::spawn(bytes, yamux::Mode::Client);
        let ready = EdgeMessage::Ready {
            name: "acme".into(),
            url: "https://acme.sharehooks.cc".into(),
            expires_at: None,
            expires_in: Some(7200),
            notice: true,
            password: false,
        };
        text.send(serde_json::to_string(&ready).unwrap()).await;
        let mut stream = opener.open().await.unwrap();
        stream
            .write_all(format!("{request_line}\r\nhost: localhost\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut got = Vec::new();
        let _ = stream.read_to_end(&mut got).await;
        *answer.lock().unwrap() = String::from_utf8_lossy(&got).to_string();
        let request = EdgeMessage::Request {
            method: "GET".into(),
            path: "/".into(),
            status: 200,
            ms: 3,
            request_id: None,
        };
        text.send(serde_json::to_string(&request).unwrap()).await;
        let closing = EdgeMessage::Closing {
            reason: "you stopped it on webhooks.cc".into(),
        };
        text.send(serde_json::to_string(&closing).unwrap()).await;
        // Keep the socket open until the CLI has read it all.
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    format!("ws://{addr}")
}

fn test_api() -> ApiClient {
    ApiClient::with_credentials(
        Some("http://127.0.0.1:9"),
        Some("http://127.0.0.1:9"),
        Some("whcc_test".to_string()),
        None,
    )
    .unwrap()
}

#[tokio::test]
async fn a_share_opens_pipes_a_visitor_and_stops_when_the_edge_says() {
    let port = hello_server().await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::new(Mutex::new(String::new()));
    let tunnel_url = fake_edge(seen.clone(), answer.clone(), "GET /pricing HTTP/1.1").await;
    let session = Session {
        tunnel_url,
        api: test_api(),
        kind: Kind::Share {
            name: Some("acme".into()),
            password: Some("open sesame".into()),
        },
        host: LocalHost::Localhost,
        port,
        rewrite: None,
        client: "laptop, Linux".into(),
        on_relayed: None,
    };
    let mut updates = Vec::new();
    let reason = tokio::time::timeout(
        Duration::from_secs(10),
        run(&session, &mut |u| updates.push(u)),
    )
    .await
    .expect("the share ends")
    .unwrap();
    assert_eq!(reason, "you stopped it on webhooks.cc");
    assert!(
        answer
            .lock()
            .unwrap()
            .ends_with("hello GET /pricing HTTP/1.1")
    );
    assert!(
        matches!(&updates[0], Update::Ready { name, notice: true, expires_in: Some(7200), .. } if name == "acme")
    );
    assert!(
        updates
            .iter()
            .any(|u| matches!(u, Update::Request { status: 200, .. }))
    );
    let seen = seen.lock().unwrap();
    let header = |name: &str| {
        seen.iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    assert_eq!(header("path"), CONNECT_PATH);
    assert_eq!(header("authorization"), "Bearer whcc_test");
    assert_eq!(header(HEADER_NAME), "acme");
    assert_eq!(header(HEADER_PORT), port.to_string());
    assert_eq!(header(HEADER_CLIENT), "laptop, Linux");
    assert_eq!(header(HEADER_PASSWORD), password_header("open sesame"));
    assert_eq!(header(HEADER_INSTANCE).len(), 32);
    assert_eq!(header(HEADER_KIND), "", "a share sends no kind");
}

#[tokio::test]
async fn a_live_session_names_its_endpoint_and_rewrites_the_path() {
    let port = hello_server().await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::new(Mutex::new(String::new()));
    let tunnel_url = fake_edge(seen.clone(), answer.clone(), "POST /stripe HTTP/1.1").await;
    let session = Session {
        tunnel_url,
        api: test_api(),
        kind: Kind::Live {
            endpoint: "abc123".into(),
        },
        host: LocalHost::Localhost,
        port,
        rewrite: Some(Rewrite {
            base_path: "/api/webhooks".into(),
            headers: vec![],
        }),
        client: "laptop, Linux".into(),
        on_relayed: None,
    };
    let mut updates = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        run(&session, &mut |u| updates.push(u)),
    )
    .await
    .expect("the session ends")
    .unwrap();
    assert!(
        answer
            .lock()
            .unwrap()
            .ends_with("hello POST /api/webhooks/stripe HTTP/1.1")
    );
    let seen = seen.lock().unwrap();
    assert!(seen.contains(&(HEADER_KIND.to_string(), "live".to_string())));
    assert!(seen.contains(&(HEADER_ENDPOINT.to_string(), "abc123".to_string())));
    assert!(!seen.iter().any(|(n, _)| n == HEADER_NAME));
}

#[tokio::test]
async fn a_refusal_ends_the_session_with_the_edges_words() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = socket.read(&mut buf).await;
        let body = r#"{"error":"That name is taken."}"#;
        let response = format!(
            "HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    let session = Session {
        tunnel_url: format!("ws://{addr}"),
        api: test_api(),
        kind: Kind::Share {
            name: Some("taken".into()),
            password: None,
        },
        host: LocalHost::Localhost,
        port: 1,
        rewrite: None,
        client: "test".into(),
        on_relayed: None,
    };
    let err = tokio::time::timeout(Duration::from_secs(10), run(&session, &mut |_| {}))
        .await
        .expect("refused at once")
        .unwrap_err();
    assert_eq!(err.to_string(), "That name is taken.");
}

#[tokio::test]
async fn nothing_listening_gets_the_clis_own_502() {
    // A port nothing listens on: bind, then let it go.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let (edge_end, cli_end) = tokio::io::duplex(1 << 16);
    let (opener, _none, _edge) = mux::spawn(edge_end, yamux::Mode::Client);
    let (_unused, mut inbound, _cli) = mux::spawn(cli_end, yamux::Mode::Server);
    let mut stream = opener.open().await.unwrap();
    stream.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    let local = inbound.recv().await.unwrap();
    tokio::spawn(pipe(local, at(LocalHost::Localhost, port), None, None));
    let mut got = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut got)).await;
    let text = String::from_utf8_lossy(&got);
    assert!(text.contains("x-whk-nothing-listening: 1"), "{text}");
}

#[tokio::test]
async fn a_head_over_the_limit_gets_431_and_never_reaches_the_app() {
    let port = hello_server().await;
    let rewrite = Rewrite {
        base_path: "/api".into(),
        headers: vec![("x-extra".into(), "1".into())],
    };
    for padding in [70 * 1024, MAX_HEAD + 100] {
        let (edge_end, cli_end) = tokio::io::duplex(1 << 16);
        let (opener, _none, _edge) = mux::spawn(edge_end, yamux::Mode::Client);
        let (_unused, mut inbound, _cli) = mux::spawn(cli_end, yamux::Mode::Server);
        let mut stream = opener.open().await.unwrap();
        let head = format!(
            "POST /hooks HTTP/1.1\r\nx-big: {}\r\n\r\n",
            "a".repeat(padding)
        );
        let writer = tokio::spawn(async move {
            let _ = stream.write_all(head.as_bytes()).await;
            let mut got = Vec::new();
            let _ =
                tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut got)).await;
            got
        });
        let local = inbound.recv().await.unwrap();
        tokio::spawn(pipe(
            local,
            at(LocalHost::Localhost, port),
            Some(rewrite.clone()),
            None,
        ));
        let got = writer.await.unwrap();
        let text = String::from_utf8_lossy(&got);
        assert!(
            text.starts_with("HTTP/1.1 431 Request Header Fields Too Large\r\n"),
            "{padding}: {text}"
        );
        assert!(
            text.ends_with("more than whk passes to the app.\n"),
            "{text}"
        );
        assert!(!text.contains("hello"), "the app never saw it: {text}");
    }
}

#[tokio::test]
async fn an_edge_that_never_answers_the_upgrade_is_tried_again() {
    // Accepts the connection (the kernel does) and never says a word.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let session = Session {
        tunnel_url: format!("ws://{addr}"),
        api: test_api(),
        kind: Kind::Share {
            name: None,
            password: None,
        },
        host: LocalHost::Localhost,
        port: 1,
        rewrite: None,
        client: "test".into(),
        on_relayed: None,
    };
    let started = Instant::now();
    let failed = once(&session, "instance", &mut None, false, &mut |_| {}).await;
    assert!(started.elapsed() < CONNECT_TIMEOUT * 3);
    assert_eq!(
        failed.err(),
        Some(Failure::Transient(format!(
            "The tunnel did not answer within {} s.",
            CONNECT_TIMEOUT.as_secs()
        )))
    );
    drop(listener);
}

/// A local server that answers with the head it got, and notes when a
/// request first reached it.
async fn echo_head_server(reached: Arc<Mutex<bool>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let reached = reached.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let mut got = Vec::new();
                while find_head_end(&got).is_none() {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    *reached.lock().unwrap() = true;
                    got.extend_from_slice(&buf[..n]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    got.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(&got).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    port
}

#[tokio::test]
async fn a_relayed_capture_is_marked_before_the_app_has_it_and_its_id_stays_out() {
    let reached = Arc::new(Mutex::new(false));
    let port = echo_head_server(reached.clone()).await;
    // Each id told, with whether the app had the request by then.
    let marked: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
    let seen = marked.clone();
    let app_reached = reached.clone();
    let on_relayed: OnRelayed = Arc::new(move |id: &str| {
        let reached = *app_reached.lock().unwrap();
        seen.lock().unwrap().push((id.to_string(), reached));
    });
    let send = async |head: &str, relayed: Option<Relayed>| {
        let (edge_end, cli_end) = tokio::io::duplex(1 << 16);
        let (opener, _none, _edge) = mux::spawn(edge_end, yamux::Mode::Client);
        let (_unused, mut inbound, _cli) = mux::spawn(cli_end, yamux::Mode::Server);
        let mut stream = opener.open().await.unwrap();
        stream.write_all(head.as_bytes()).await.unwrap();
        let local = inbound.recv().await.unwrap();
        tokio::spawn(pipe(
            local,
            at(LocalHost::Localhost, port),
            Some(Rewrite::default()),
            relayed,
        ));
        let mut got = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut got)).await;
        String::from_utf8_lossy(&got).to_lowercase()
    };
    let live = Some(Relayed(Some(on_relayed)));
    let app_saw = send(
        "POST /hooks HTTP/1.1\r\nX-Whk-Request-Id: 3f2a8c1e-0000-4000-8000-000000000001\r\nx-whk-request-id: other\r\ncontent-length: 0\r\n\r\n",
        live.clone(),
    )
    .await;
    assert!(app_saw.contains("post /hooks http/1.1"), "{app_saw}");
    assert!(!app_saw.contains(HEADER_REQUEST_ID), "{app_saw}");
    assert_eq!(
        *marked.lock().unwrap(),
        [("3f2a8c1e-0000-4000-8000-000000000001".to_string(), false)]
    );
    // An older edge sends no id: nothing is marked, the request goes as before.
    *reached.lock().unwrap() = false;
    let app_saw = send("POST /old HTTP/1.1\r\ncontent-length: 0\r\n\r\n", live).await;
    assert!(app_saw.contains("post /old http/1.1"), "{app_saw}");
    assert_eq!(marked.lock().unwrap().len(), 1);
    // A share is no relay: a visitor's header of that name is theirs.
    let app_saw = send("GET / HTTP/1.1\r\nx-whk-request-id: visitor\r\n\r\n", None).await;
    assert!(app_saw.contains("x-whk-request-id: visitor"), "{app_saw}");
    assert_eq!(marked.lock().unwrap().len(), 1);
}
