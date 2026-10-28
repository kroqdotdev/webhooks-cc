//! `whk sandbox` and the agent credential file, end to end: the binary runs
//! against a local axum server that plays the auth.md routes, the sandbox
//! and one regular route. Never production: anonymous registration there is
//! rate limited per IP.
//!
//! Run with: cargo test --test sandbox

use axum::extract::{Form, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Output;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const DIFFICULTY: u32 = 4;
const COUNT: u32 = 2;
const CLAIM_TOKEN: &str = "clm_test_claim_token";

#[derive(Default)]
struct Fake {
    /// Refuse the first proof of work with a fresh challenge.
    refuse_first_pow: bool,
    challenges: u32,
    registrations: u32,
    exchanges: u32,
    /// Assertions the token endpoint answers invalid_grant for.
    revoked: HashSet<String>,
    /// Tokens the API accepts, with the registration they act for.
    tokens: HashMap<String, String>,
    /// Bearers the regular API route saw.
    api_bearers: Vec<String>,
    endpoints: Vec<String>,
    claim_polls: u32,
    /// The human entered the code.
    approved: bool,
}

type Shared = Arc<Mutex<Fake>>;

fn oauth_error(code: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": code, "error_description": code })),
    )
        .into_response()
}

fn later(seconds: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn new_challenge(fake: &mut Fake) -> Value {
    fake.challenges += 1;
    json!({
        "challenge": format!("pow1.test-{}", fake.challenges),
        "algorithm": "sha256-zero-bits",
        "difficulty": DIFFICULTY,
        "count": COUNT,
        "expires_at": later(300),
    })
}

async fn challenge(State(fake): State<Shared>) -> Json<Value> {
    Json(new_challenge(&mut fake.lock().unwrap()))
}

async fn identity(State(fake): State<Shared>, Json(body): Json<Value>) -> Response {
    let mut fake = fake.lock().unwrap();
    match body["type"].as_str() {
        Some("anonymous") => {
            let pow = &body["proof_of_work"];
            let nonces: Vec<String> =
                serde_json::from_value(pow["nonces"].clone()).unwrap_or_default();
            let solved = whk::agent::pow::verify(
                pow["challenge"].as_str().unwrap_or_default(),
                DIFFICULTY,
                COUNT,
                &nonces,
            );
            if !solved || fake.refuse_first_pow {
                fake.refuse_first_pow = false;
                let mut refusal = new_challenge(&mut fake);
                refusal["error"] = "invalid_challenge".into();
                refusal["error_description"] = "Solve this new challenge.".into();
                return (StatusCode::BAD_REQUEST, Json(refusal)).into_response();
            }
            fake.registrations += 1;
            let n = fake.registrations;
            Json(json!({
                "registration_id": format!("reg-{n}"),
                "registration_type": "anonymous",
                "identity_assertion": format!("assert-{n}"),
                "assertion_expires": later(86_400),
                "claim_token": format!("clm_anonymous_{n}"),
                "claim_token_expires": later(86_400),
                "sandbox": { "status": "available" },
            }))
            .into_response()
        }
        Some("service_auth") => Json(json!({
            "registration_id": "reg-service",
            "registration_type": "service_auth",
            "claim_token": CLAIM_TOKEN,
            "claim_token_expires": later(86_400),
            "claim": {
                "user_code": "123456",
                "expires_in": 900,
                "verification_uri": "http://example.test/agent/claim?attempt=cat_x",
                "interval": 1,
            },
        }))
        .into_response(),
        _ => oauth_error("invalid_request"),
    }
}

async fn token(State(fake): State<Shared>, Form(form): Form<HashMap<String, String>>) -> Response {
    let mut fake = fake.lock().unwrap();
    assert!(
        !form.contains_key("resource"),
        "the exchange leaves resource out"
    );
    match form.get("grant_type").map(String::as_str) {
        Some("urn:ietf:params:oauth:grant-type:jwt-bearer") => {
            let assertion = form.get("assertion").cloned().unwrap_or_default();
            if fake.revoked.contains(&assertion) {
                return oauth_error("invalid_grant");
            }
            fake.exchanges += 1;
            let token = format!("whcc_{}_{}", assertion, fake.exchanges);
            fake.tokens.insert(token.clone(), assertion);
            Json(json!({ "access_token": token, "token_type": "Bearer", "expires_in": 3600, "scope": "webhooks:sandbox" }))
                .into_response()
        }
        Some("urn:workos:agent-auth:grant-type:claim") => {
            assert_eq!(
                form.get("claim_token").map(String::as_str),
                Some(CLAIM_TOKEN)
            );
            fake.claim_polls += 1;
            if !fake.approved {
                return oauth_error("authorization_pending");
            }
            let token = "whcc_claimed_first".to_string();
            fake.tokens.insert(token.clone(), "claimed-assert".into());
            Json(json!({
                "access_token": token,
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "webhooks:read webhooks:write",
                "identity_assertion": "claimed-assert",
                "assertion_expires": later(90 * 86_400),
            }))
            .into_response()
        }
        _ => oauth_error("unsupported_grant_type"),
    }
}

/// The assertion the bearer token was exchanged from, when the token is live.
fn bearer(fake: &Fake, headers: &HeaderMap) -> Option<String> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    fake.tokens.get(token).cloned()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn endpoint_json(slug: &str) -> Value {
    json!({
        "id": format!("id-{slug}"),
        "slug": slug,
        "url": format!("http://receiver.test/w/{slug}"),
        "requestCount": 0,
        "sandbox": { "expiresAt": 1_900_000_000_000_i64, "maxEndpoints": 3, "requestLimit": 25, "budget": { "used": 0, "limit": 100 } },
    })
}

async fn sandbox_endpoints(
    State(fake): State<Shared>,
    headers: HeaderMap,
    method: axum::http::Method,
) -> Response {
    let mut fake = fake.lock().unwrap();
    if bearer(&fake, &headers).is_none() {
        return unauthorized();
    }
    if method == axum::http::Method::POST {
        let slug = format!("sbx{}", fake.endpoints.len() + 1);
        fake.endpoints.push(slug.clone());
        return (StatusCode::CREATED, Json(endpoint_json(&slug))).into_response();
    }
    let endpoints: Vec<Value> = fake.endpoints.iter().map(|s| endpoint_json(s)).collect();
    Json(json!({ "endpoints": endpoints, "sandbox": { "expiresAt": 1_900_000_000_000_i64, "maxEndpoints": 3, "requestLimit": 25, "budget": { "used": 1, "limit": 100 } } }))
        .into_response()
}

async fn sandbox_requests(
    State(fake): State<Shared>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    let fake = fake.lock().unwrap();
    if bearer(&fake, &headers).is_none() {
        return unauthorized();
    }
    let now = chrono::Utc::now().timestamp_millis();
    Json(json!([{
        "id": "6f1c2d4e-8a1b-4c3d-9e2f-0a1b2c3d4e5f",
        "endpointId": format!("id-{slug}"),
        "method": "POST",
        "path": "/hook",
        "headers": { "content-type": "application/json" },
        "body": "{\"ok\":true}",
        "queryParams": {},
        "ip": "192.0.2.1",
        "size": 11,
        "receivedAt": now,
    }]))
    .into_response()
}

async fn api_endpoints(State(fake): State<Shared>, headers: HeaderMap) -> Response {
    let mut fake = fake.lock().unwrap();
    let Some(assertion) = bearer(&fake, &headers) else {
        return unauthorized();
    };
    fake.api_bearers.push(assertion);
    Json(json!({ "owned": [], "shared": [] })).into_response()
}

async fn start(fake: Fake) -> (String, Shared) {
    let shared = Arc::new(Mutex::new(fake));
    let app = Router::new()
        .route("/api/agent/identity/challenge", post(challenge))
        .route("/api/agent/identity", post(identity))
        .route("/api/oauth2/token", post(token))
        .route(
            "/api/agent/sandbox/endpoints",
            get(sandbox_endpoints).post(sandbox_endpoints),
        )
        .route(
            "/api/agent/sandbox/endpoints/{slug}/requests",
            get(sandbox_requests),
        )
        .route("/api/endpoints", get(api_endpoints))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://127.0.0.1:{}", addr.port()), shared)
}

/// A home of its own, so neither a real token.json nor a real agent.json is read.
struct Env {
    dir: PathBuf,
    base: String,
}

impl Env {
    fn new(base: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("whk-sandbox-test-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            dir,
            base: base.to_string(),
        }
    }

    fn agent_file(&self) -> PathBuf {
        self.dir.join("creds").join("agent.json")
    }

    fn file(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.agent_file()).unwrap()).unwrap()
    }

    fn entry(&self) -> Value {
        self.file()["issuers"][&self.base].clone()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_whk"));
        cmd.args(args)
            .env("WHK_API_URL", &self.base)
            .env("WHK_WEBHOOK_URL", "http://receiver.test")
            .env("WHK_AGENT_FILE", self.agent_file())
            .env("HOME", &self.dir)
            .env("XDG_CONFIG_HOME", self.dir.join("config"))
            .env("APPDATA", self.dir.join("config"))
            .env("NO_COLOR", "1")
            .kill_on_drop(true);
        cmd
    }

    async fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().await.unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stdout_json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "whk failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("stdout is JSON")
}

#[tokio::test(flavor = "multi_thread")]
async fn create_registers_with_a_retried_proof_of_work_then_reuses_the_saved_sandbox() {
    let (base, fake) = start(Fake {
        refuse_first_pow: true,
        ..Fake::default()
    })
    .await;
    let env = Env::new(&base);

    let created = stdout_json(&env.run(&["sandbox", "create", "--json"]).await);
    assert_eq!(created["slug"], "sbx1");
    assert_eq!(created["url"], "http://receiver.test/w/sbx1");
    {
        let fake = fake.lock().unwrap();
        assert_eq!(fake.challenges, 2, "the refusal carried a fresh challenge");
        assert_eq!(fake.registrations, 1);
        assert_eq!(fake.exchanges, 1);
    }

    let slot = &env.entry()["sandbox"];
    assert_eq!(slot["registration_id"], "reg-1");
    assert_eq!(slot["client_name"], "whk-cli");
    assert!(slot["access_token"].as_str().unwrap().starts_with("whcc_"));
    let text = std::fs::read_to_string(env.agent_file()).unwrap();
    assert!(!text.contains("clm_"), "the claim token is never written");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(env.agent_file())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // A second process reuses the registration and its cached token.
    let again = stdout_json(&env.run(&["sandbox", "create", "--json"]).await);
    assert_eq!(again["slug"], "sbx2");
    let fake = fake.lock().unwrap();
    assert_eq!(fake.registrations, 1);
    assert_eq!(fake.exchanges, 1, "the cached token was reused");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_401_exchanges_the_assertion_once_more() {
    let (base, fake) = start(Fake::default()).await;
    let env = Env::new(&base);
    stdout_json(&env.run(&["sandbox", "create", "--json"]).await);

    // The server forgets the cached token, as after a revocation.
    fake.lock().unwrap().tokens.clear();
    let listed = stdout_json(&env.run(&["sandbox", "list", "--json"]).await);
    assert_eq!(listed["endpoints"][0]["slug"], "sbx1");
    assert_eq!(fake.lock().unwrap().exchanges, 2);
    let cached = env.entry()["sandbox"]["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        fake.lock().unwrap().tokens.contains_key(&cached),
        "the new token was saved"
    );

    let requests = stdout_json(&env.run(&["sandbox", "requests", "sbx1", "--json"]).await);
    assert_eq!(requests[0]["path"], "/hook");
    let waited = stdout_json(
        &env.run(&["sandbox", "wait", "sbx1", "--timeout", "5s", "--json"])
            .await,
    );
    assert_eq!(waited["method"], "POST");
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_grant_removes_the_slot_and_create_registers_again() {
    let (base, fake) = start(Fake::default()).await;
    let env = Env::new(&base);
    stdout_json(&env.run(&["sandbox", "create", "--json"]).await);
    {
        let mut fake = fake.lock().unwrap();
        fake.tokens.clear();
        fake.revoked.insert("assert-1".into());
    }

    let listed = env.run(&["sandbox", "list", "--json"]).await;
    assert!(!listed.status.success());
    let stderr = String::from_utf8_lossy(&listed.stderr);
    assert!(stderr.contains("invalid_grant"), "{stderr}");
    assert!(!env.agent_file().exists(), "the dead slot was removed");

    stdout_json(&env.run(&["sandbox", "create", "--json"]).await);
    assert_eq!(env.entry()["sandbox"]["registration_id"], "reg-2");

    // A saved but revoked sandbox is replaced by create, with a note.
    {
        let mut fake = fake.lock().unwrap();
        fake.tokens.clear();
        fake.revoked.insert("assert-2".into());
    }
    let created = env.run(&["sandbox", "create", "--json"]).await;
    let stderr = String::from_utf8_lossy(&created.stderr).to_string();
    assert!(stderr.contains("registering a new one"), "{stderr}");
    stdout_json(&created);
    assert_eq!(env.entry()["sandbox"]["registration_id"], "reg-3");
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_prints_the_code_at_once_then_saves_the_claimed_slot() {
    let (base, fake) = start(Fake::default()).await;
    let env = Env::new(&base);

    let mut child = env
        .command(&["sandbox", "connect", "--email", "dev@example.com", "--json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    let first: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(first["status"], "pending");
    assert_eq!(first["user_code"], "123456");
    assert_eq!(
        first["verification_uri"],
        "http://example.test/agent/claim?attempt=cat_x"
    );
    assert!(first["expires_at"].as_str().unwrap().ends_with('Z'));

    // Still pending while the human has not entered the code.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert!(fake.lock().unwrap().claim_polls >= 1);
    fake.lock().unwrap().approved = true;

    let second: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(second["status"], "claimed");
    assert_eq!(second["email"], "dev@example.com");
    assert_eq!(second["registration_id"], "reg-service");
    assert!(second.get("identity_assertion").is_none() && second.get("access_token").is_none());
    assert!(child.wait().await.unwrap().success());

    let slot = &env.entry()["claimed"];
    assert_eq!(slot["registration_id"], "reg-service");
    assert_eq!(slot["identity_assertion"], "claimed-assert");
    assert_eq!(slot["email"], "dev@example.com");
    assert_eq!(slot["scope"], "webhooks:read webhooks:write");
    assert!(
        !std::fs::read_to_string(env.agent_file())
            .unwrap()
            .contains(CLAIM_TOKEN)
    );

    // A second connect sees the live connection and registers nothing.
    let again = stdout_json(
        &env.run(&["sandbox", "connect", "--email", "dev@example.com", "--json"])
            .await,
    );
    assert_eq!(again["status"], "already_connected");
}

#[tokio::test(flavor = "multi_thread")]
async fn regular_commands_act_through_the_claimed_slot() {
    let (base, fake) = start(Fake::default()).await;
    let env = Env::new(&base);
    let claimed = json!({
        "version": 1,
        "issuers": { base.clone(): { "claimed": {
            "registration_id": "reg-claimed",
            "identity_assertion": "claimed-assert",
            "assertion_expires": later(90 * 86_400),
            "email": "dev@example.com",
            "client_name": "webhooks-cc-mcp",
        } } },
    });
    std::fs::create_dir_all(env.agent_file().parent().unwrap()).unwrap();
    std::fs::write(env.agent_file(), claimed.to_string()).unwrap();

    let status = stdout_json(&env.run(&["auth", "status", "--json"]).await);
    assert_eq!(status["logged_in"], true);
    assert_eq!(status["via"], "agent");
    assert_eq!(status["email"], "dev@example.com");

    let listed = stdout_json(&env.run(&["list", "--json"]).await);
    assert_eq!(listed["owned"], json!([]));
    // A second command reuses the token the first one cached.
    stdout_json(&env.run(&["list", "--json"]).await);
    {
        let fake = fake.lock().unwrap();
        assert_eq!(fake.api_bearers, vec!["claimed-assert", "claimed-assert"]);
        assert_eq!(fake.exchanges, 1);
    }

    let shown = env.run(&["sandbox", "status", "--json"]).await;
    let text = String::from_utf8_lossy(&shown.stdout).to_string();
    let summary = stdout_json(&shown);
    assert_eq!(summary["regular_commands"], "agent");
    assert_eq!(summary["claimed"]["registration_id"], "reg-claimed");
    assert!(
        !text.contains("claimed-assert") && !text.contains("whcc_"),
        "{text}"
    );

    // Disconnected by the human: the next command drops the slot.
    {
        let mut fake = fake.lock().unwrap();
        fake.tokens.clear();
        fake.revoked.insert("claimed-assert".into());
    }
    let refused = env.run(&["list", "--json"]).await;
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("invalid_grant"));
    assert!(!env.agent_file().exists());

    let forgotten = stdout_json(&env.run(&["sandbox", "forget", "--all", "--json"]).await);
    assert_eq!(forgotten["removed"], json!([]));
}
