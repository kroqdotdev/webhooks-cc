//! Every failure a command can meet exits with the status and code the
//! table in `whk --help` gives it (src/error.rs). The binary runs against a
//! local axum server that plays the API's routes and its failures, and with
//! no server at all for mistakes in the arguments.
//!
//! Run with: cargo test --test exit_codes

use axum::Json;
use axum::Router;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use futures::StreamExt as _;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

const MISSING: &str = "11111111-2222-4333-8444-555555555555";
const BROKEN: &str = "22222222-2222-4333-8444-555555555555";

fn endpoint(i: usize) -> Value {
    json!({ "id": format!("ep{i}"), "slug": format!("acme-{i}"), "name": "Orders" })
}

/// The routes the commands below call, each answering what the test needs:
/// lists that hold nothing by the names asked for, a bare-code 404, a 500,
/// an HTML 404 page, and big answers for the closed-pipe cases.
async fn server() -> String {
    let app = Router::new()
        .route("/api/teams", get(|| async { Json(json!([])) }))
        .route(
            "/api/shares",
            get(|| async { Json(json!({ "shares": [] })) }),
        )
        .route(
            "/api/endpoints",
            get(|| async {
                let owned: Vec<Value> = (0..3000).map(endpoint).collect();
                Json(json!({ "owned": owned, "shared": [] }))
            }),
        )
        .route(
            "/api/requests/{id}",
            get(|axum::extract::Path(id): axum::extract::Path<String>| async move {
                if id == BROKEN {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "Failed to get request" })),
                    )
                } else {
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "not_found" })),
                    )
                }
            }),
        )
        .route(
            "/api/endpoints/{slug}/requests",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "not_found", "message": "Endpoint not found" })),
                )
            }),
        )
        .route(
            "/api/stream/{slug}",
            get(|axum::extract::Path(slug): axum::extract::Path<String>| async move {
                if slug != "live" {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Endpoint not found" })),
                    )
                        .into_response();
                }
                // One capture, then a stream that stays open, as a quiet
                // endpoint's does.
                let frames = [
                    "event: connected\ndata: {\"slug\":\"live\"}\n\n".to_string(),
                    format!(
                        "event: request\ndata: {}\n\n",
                        json!({
                            "_id": "r1", "endpointId": "ep", "method": "POST", "path": "/",
                            "headers": {}, "queryParams": {}, "ip": "203.0.113.1",
                            "size": 0, "receivedAt": 1
                        })
                    ),
                ];
                let chunks = futures::stream::iter(
                    frames.map(|f| Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(f))),
                )
                .chain(futures::stream::pending());
                (
                    [("content-type", "text/event-stream")],
                    axum::body::Body::from_stream(chunks),
                )
                    .into_response()
            }),
        )
        .route(
            "/api/approvals/{id}",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Approval not found" })),
                )
            }),
        )
        .route(
            "/api/big",
            get(|| async { Json(json!({ "data": "x".repeat(1 << 20) })) }),
        )
        .fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                Html(format!(
                    "<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body>{}</body></html>",
                    "<div>page</div>".repeat(50)
                )),
            )
                .into_response()
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// A home of its own, so no saved login or agent registration is read.
struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("whk-exit-test-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn command(&self, base: &str, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_whk"));
        cmd.args(args)
            .env("WHK_API_URL", base)
            .env("WHK_WEBHOOK_URL", "http://receiver.test")
            .env("WHK_AUTH", "key")
            .env("WHK_API_KEY", "whcc_test")
            .env("WHK_AGENT_FILE", self.0.join("agent.json"))
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("APPDATA", self.0.join("config"))
            .env_remove("NO_COLOR")
            .env_remove("WHK_SHARE_PASSWORD")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        cmd
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Ran {
    exit: i32,
    stdout: String,
    stderr: String,
}

async fn run(home: &Home, base: &str, args: &[&str]) -> Ran {
    let output = home.command(base, args).output().await.unwrap();
    Ran {
        exit: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// The `{"error": ...}` a failure writes to stderr under `--json`, or for
/// `whk share`, whose output is a stream of events, its last event on stdout.
fn error_of(ran: &Ran) -> Value {
    let parse = |line: &str| {
        serde_json::from_str::<Value>(line)
            .unwrap_or_else(|e| panic!("{e}: stderr {:?}, stdout {:?}", ran.stderr, ran.stdout))
    };
    match ran.stderr.lines().last() {
        Some(line) => parse(line)["error"].clone(),
        None => {
            let event = parse(ran.stdout.lines().last().unwrap_or_default());
            assert_eq!(event["event"], "error", "{event}");
            event
        }
    }
}

#[tokio::test]
async fn every_failure_exits_with_its_documented_status() {
    let base = server().await;
    let home = Home::new();
    // (arguments, code, exit status)
    let cases: &[(&[&str], &str, i32)] = &[
        // Arguments the CLI can tell are wrong before asking anything.
        (&["create", "--mock-status", "999"], "usage", 2),
        (
            &["update-endpoint", "acme", "--mock-status", "42"],
            "usage",
            2,
        ),
        (&["create", "--signing-secret", "s"], "usage", 2),
        (&["create", "--expires-in", "soon"], "usage", 2),
        (
            &["create", "--mock-status", "200", "--mock-header", "nocolon"],
            "usage",
            2,
        ),
        (&["wait", "acme", "--timeout", "5x"], "usage", 2),
        (&["names", "reserve", "Qa1116_Bad"], "usage", 2),
        (&["names", "reserve", "acme-free"], "usage", 2),
        (&["share", "99999"], "usage", 2),
        (&["share", "3000/path"], "usage", 2),
        (&["share", "example.com:3000"], "usage", 2),
        (&["share", "3000", "--name", "Bad Name"], "usage", 2),
        (&["requests", "get", "nope"], "usage", 2),
        (&["requests", "download", "nope", "-o", "x.eml"], "usage", 2),
        (&["replay", "nope"], "usage", 2),
        (&["send", "acme", "-d", "@/no/such/file"], "usage", 2),
        // Nothing by that name or id.
        (&["shares", "stop", "nope-nope"], "not_found", 4),
        (&["shares", "log", "nope-nope"], "not_found", 4),
        (&["list", "--team", "nope"], "not_found", 4),
        (&["teams", "members", "nope"], "not_found", 4),
        (
            &["names", "reserve", "acme-team", "--team", "nope"],
            "not_found",
            4,
        ),
        (&["requests", "get", MISSING], "not_found", 4),
        (&["requests", "list", "acme-gone"], "not_found", 4),
        (
            &["approvals", "wait", MISSING, "--timeout", "5s"],
            "not_found",
            4,
        ),
        (
            &["sandbox", "wait", "acme", "--timeout", "3s"],
            "not_found",
            4,
        ),
        (&["api", "endpointz"], "not_found", 4),
        // Our side failed: retry.
        (&["requests", "get", BROKEN], "server_error", 7),
        // Not confirmed, and no terminal to ask on.
        (&["delete", "acme"], "confirmation_required", 9),
    ];
    let mut wrong = Vec::new();
    for (args, code, exit) in cases {
        let mut with_json = args.to_vec();
        with_json.push("--json");
        let ran = run(&home, &base, &with_json).await;
        let error = error_of(&ran);
        if (error["code"].as_str(), error["exit"].as_i64(), ran.exit)
            != (Some(code), Some(*exit as i64), *exit)
        {
            wrong.push(format!(
                "whk {}: exit {} {error}, expected {code} ({exit})",
                args.join(" "),
                ran.exit
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[tokio::test]
async fn failures_read_as_sentences() {
    let base = server().await;
    let home = Home::new();

    // A bare code is said in words; the route's own message wins.
    let ran = run(&home, &base, &["requests", "list", "acme-gone"]).await;
    assert_eq!(ran.stderr.lines().next(), Some("Error: Endpoint not found"));

    // A not-found approval is not something to try again.
    let ran = run(
        &home,
        &base,
        &["approvals", "wait", MISSING, "--timeout", "5s"],
    )
    .await;
    assert!(ran.stderr.contains("no approval with id"), "{}", ran.stderr);
    assert!(!ran.stderr.contains("try again"), "{}", ran.stderr);

    // The --yes hint is given once.
    let ran = run(&home, &base, &["delete", "acme"]).await;
    assert_eq!(ran.exit, 9);
    assert_eq!(ran.stderr.matches("--yes").count(), 1, "{}", ran.stderr);

    // An HTML page is summed up, never printed.
    for json in [false, true] {
        let mut args = vec!["api", "endpointz"];
        if json {
            args.push("--json");
        }
        let ran = run(&home, &base, &args).await;
        assert_eq!(ran.exit, 4);
        assert!(ran.stdout.is_empty(), "{}", ran.stdout);
        assert!(!ran.stderr.contains('<'), "{}", ran.stderr);
        assert!(
            ran.stderr.contains("No API route at /api/endpointz"),
            "{}",
            ran.stderr
        );
        assert!(ran.stderr.len() < 400, "{}", ran.stderr);
    }

    // `listen` says it is listening only once the stream is open.
    let ran = run(&home, &base, &["listen", "acme-gone"]).await;
    assert_eq!(ran.exit, 4, "{}", ran.stderr);
    assert!(!ran.stdout.contains("Listening"), "{}", ran.stdout);
}

#[tokio::test]
async fn share_json_failures_carry_the_code_and_exit() {
    let base = server().await;
    let home = Home::new();
    let ran = run(&home, &base, &["share", "99999", "--json"]).await;
    assert_eq!(ran.exit, 2);
    let event: Value = serde_json::from_str(ran.stdout.lines().last().unwrap()).unwrap();
    assert_eq!(event["event"], "error");
    assert_eq!(event["code"], "usage");
    assert_eq!(event["exit"], 2);
    assert!(event["message"].as_str().unwrap().contains("local port"));
}

#[tokio::test]
async fn piped_output_has_no_colour_and_lines_up() {
    let base = server().await;
    let home = Home::new();
    let ran = run(&home, &base, &["list"]).await;
    assert_eq!(ran.exit, 0, "{}", ran.stderr);
    assert!(!ran.stdout.contains('\x1b'), "colour codes in piped output");
    let lines: Vec<&str> = ran.stdout.lines().filter(|l| l.contains("http")).collect();
    let column = lines[0].find("http");
    assert!(lines.iter().all(|l| l.find("http") == column));
}

/// A reader that stops early (`whk list | head -1`) ends whk quietly.
#[tokio::test]
async fn a_closed_pipe_is_no_failure() {
    let base = server().await;
    let home = Home::new();
    for args in [
        &["list"][..],
        &["api", "big"],
        &["completions", "bash"],
        &["--json", "list"],
        // A stream that would run until stopped: the closed pipe stops it.
        &["listen", "live"],
        &["--json", "listen", "live"],
    ] {
        let mut child = home
            .command(&base, args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Close the reading end before whk writes anything.
        drop(child.stdout.take());
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
                .await
                .unwrap_or_else(|_| panic!("whk {args:?} kept running with nobody reading"))
                .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(0), "whk {args:?}: {stderr}");
        assert!(!stderr.contains("panicked"), "whk {args:?}: {stderr}");
        assert!(stderr.is_empty(), "whk {args:?}: {stderr}");
    }
}
