//! The agent credential file (`packages/sdk/conformance/agent-credentials.md`):
//! where an agent keeps the identity assertions of its registrations, so a
//! connection a human approved once survives restarts. The MCP server, the
//! TypeScript, Python and Go SDKs and this CLI share one file.
//!
//! The rules are pure functions of their inputs, so the conformance vectors
//! can drive them; [`CredentialStore`] does the file I/O. Nothing here ever
//! prints the file's contents: `Slot` redacts itself in `Debug`, and errors
//! name the path only.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// A slot or a cached token closer to expiry than this counts as gone.
const LIVE_MARGIN_MS: i64 = 60_000;
const FORMAT_VERSION: f64 = 1.0;
const REQUIRED: [&str; 3] = ["registration_id", "identity_assertion", "assertion_expires"];
const FILE_NAME: &str = "agent.json";

/// The two registrations an issuer's entry can hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    /// Connected to a human's account by a claim (90 days).
    Claimed,
    /// An unclaimed anonymous registration (24 hours, sandbox only).
    Sandbox,
}

impl SlotKind {
    pub const ALL: [SlotKind; 2] = [SlotKind::Claimed, SlotKind::Sandbox];

    pub fn key(self) -> &'static str {
        match self {
            SlotKind::Claimed => "claimed",
            SlotKind::Sandbox => "sandbox",
        }
    }
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/// Milliseconds since the epoch of an RFC 3339 timestamp (`Z` or a numeric
/// offset, with or without a fraction), or `None` for anything else: a bare
/// date, a lowercase `t` or `z`, a date or time that does not exist, or a
/// leap second. Fractions below a millisecond are cut, as JavaScript's
/// `Date.parse` does.
pub fn parse_timestamp(value: &str) -> Option<i64> {
    if !looks_like_rfc3339(value.as_bytes()) {
        return None;
    }
    // chrono checks the month, the day within the month, the hour and the
    // minute; the shape check above already refused second 60, which chrono
    // would take as a leap second.
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn two_digits(b: &[u8]) -> u32 {
    u32::from(b[0] - b'0') * 10 + u32::from(b[1] - b'0')
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`, the
/// shape every port accepts, with a second of at most 59 and an offset of
/// at most 23:59. chrono alone would also take a lowercase `t` or a space.
fn looks_like_rfc3339(b: &[u8]) -> bool {
    const SHAPE: &[u8] = b"dddd-dd-ddTdd:dd:dd";
    if b.len() < SHAPE.len() + 1 {
        return false;
    }
    let shape_ok = SHAPE.iter().zip(b).all(|(want, got)| match want {
        b'd' => got.is_ascii_digit(),
        other => other == got,
    });
    if !shape_ok || two_digits(&b[17..19]) > 59 {
        return false;
    }
    let mut rest = &b[SHAPE.len()..];
    if let Some(after_dot) = rest.strip_prefix(b".") {
        let digits = after_dot.iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return false;
        }
        rest = &after_dot[digits..];
    }
    match rest {
        [b'Z'] => true,
        [sign, h1, h2, b':', m1, m2] => {
            (*sign == b'+' || *sign == b'-')
                && [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit())
                && two_digits(&[*h1, *h2]) <= 23
                && two_digits(&[*m1, *m2]) <= 59
        }
        _ => false,
    }
}

/// An instant as the file stores it: RFC 3339 in UTC with milliseconds.
pub fn format_timestamp(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The file's path for a platform (Node's `process.platform` names: `win32`,
/// `darwin`, anything else follows the XDG rules), a home directory and an
/// environment; `None` when there is none. The same directory as the CLI's
/// `token.json` (`dirs::config_dir()`), unless `WHK_AGENT_FILE` names a file.
pub fn resolve_credentials_path(
    platform: &str,
    home: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    if let Some(path) = set("WHK_AGENT_FILE") {
        return Some(path);
    }
    let home = home.filter(|home| !home.is_empty());
    if platform == "win32" {
        let base =
            set("APPDATA").or_else(|| home.map(|h| join_path(h, &["AppData", "Roaming"], '\\')));
        return base.map(|base| join_path(&base, &["whk", FILE_NAME], '\\'));
    }
    let base = if platform == "darwin" {
        home.map(|h| join_path(h, &["Library", "Application Support"], '/'))
    } else {
        set("XDG_CONFIG_HOME")
            .filter(|xdg| xdg.starts_with('/'))
            .or_else(|| home.map(|h| join_path(h, &[".config"], '/')))
    };
    base.map(|base| join_path(&base, &["whk", FILE_NAME], '/'))
}

fn join_path(base: &str, parts: &[&str], separator: char) -> String {
    let mut out = base.to_string();
    while out.len() > 1 && (out.ends_with('/') || out.ends_with('\\')) {
        out.pop();
    }
    for part in parts {
        out.push(separator);
        out.push_str(part);
    }
    out
}

/// The path for this process: `WHK_AGENT_FILE`, else `<config>/whk/agent.json`.
pub fn default_credentials_path() -> Option<PathBuf> {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let home = dirs::home_dir().and_then(|h| h.to_str().map(String::from));
    let env = |name: &str| std::env::var(name).ok();
    resolve_credentials_path(platform, home.as_deref(), &env).map(PathBuf::from)
}

/// The key of an app's entry: trailing slashes removed, scheme and host
/// lowercased (the path, if any, keeps its case).
pub fn normalize_issuer(base_url: &str) -> String {
    let url = base_url.trim_end_matches('/');
    let Some(scheme) = url.find("://") else {
        return url.to_string();
    };
    match url[scheme + 3..].find('/') {
        Some(offset) => {
            let path_start = scheme + 3 + offset;
            format!("{}{}", url[..path_start].to_lowercase(), &url[path_start..])
        }
        None => url.to_lowercase(),
    }
}

/// One registration from the file. Keeps the whole stored object, so a
/// rewrite (a new cached token) keeps its informational and unknown keys.
#[derive(Clone, PartialEq)]
pub struct Slot {
    fields: Map<String, Value>,
    assertion_expires_ms: i64,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot")
            .field("registration_id", &self.registration_id())
            .field("assertion_expires", &self.text("assertion_expires"))
            .field("identity_assertion", &"[REDACTED]")
            .finish()
    }
}

impl Slot {
    /// The slot when it is well formed (the three required keys are
    /// non-empty strings and the expiry is a timestamp), else `None`. Says
    /// nothing about expiry.
    pub fn parse(value: &Value) -> Option<Slot> {
        let fields = value.as_object()?;
        for key in REQUIRED {
            match fields.get(key) {
                Some(Value::String(text)) if !text.is_empty() => {}
                _ => return None,
            }
        }
        let assertion_expires_ms = parse_timestamp(fields["assertion_expires"].as_str()?)?;
        Some(Slot {
            fields: fields.clone(),
            assertion_expires_ms,
        })
    }

    /// A new slot from a registration the server just returned.
    pub fn new(
        registration_id: &str,
        identity_assertion: &str,
        assertion_expires: &str,
        extra: &[(&str, &str)],
    ) -> Option<Slot> {
        let mut fields = Map::new();
        fields.insert("registration_id".into(), registration_id.into());
        fields.insert("identity_assertion".into(), identity_assertion.into());
        fields.insert("assertion_expires".into(), assertion_expires.into());
        for (key, value) in extra {
            fields.insert((*key).into(), (*value).into());
        }
        fields.insert(
            "saved_at".into(),
            format_timestamp(Utc::now().timestamp_millis()).into(),
        );
        Slot::parse(&Value::Object(fields))
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    pub fn registration_id(&self) -> &str {
        self.text("registration_id").unwrap_or_default()
    }

    pub fn identity_assertion(&self) -> &str {
        self.text("identity_assertion").unwrap_or_default()
    }

    pub fn assertion_expires(&self) -> &str {
        self.text("assertion_expires").unwrap_or_default()
    }

    pub fn assertion_expires_ms(&self) -> i64 {
        self.assertion_expires_ms
    }

    /// `scope`, `email`, `client_name` or `saved_at`, when stored as a string.
    pub fn info(&self, key: &str) -> Option<&str> {
        self.text(key)
    }

    /// True when the assertion has more than a minute left.
    pub fn is_live(&self, now_ms: i64) -> bool {
        self.assertion_expires_ms - now_ms > LIVE_MARGIN_MS
    }

    /// The cached access token, when it starts with `whcc_` and has more
    /// than a minute left.
    pub fn usable_token(&self, now_ms: i64) -> Option<&str> {
        let token = self
            .text("access_token")
            .filter(|t| t.starts_with("whcc_"))?;
        let expires = parse_timestamp(self.text("access_token_expires")?)?;
        (expires - now_ms > LIVE_MARGIN_MS).then_some(token)
    }

    /// Caches a freshly exchanged token in the slot.
    pub fn set_token(&mut self, access_token: &str, expires_ms: i64) {
        self.fields
            .insert("access_token".into(), access_token.into());
        self.fields.insert(
            "access_token_expires".into(),
            format_timestamp(expires_ms).into(),
        );
    }

    /// Forgets the cached token, so the next use exchanges a new one.
    pub fn clear_token(&mut self) {
        self.fields.remove("access_token");
        self.fields.remove("access_token_expires");
    }

    pub fn to_value(&self) -> Value {
        Value::Object(self.fields.clone())
    }
}

/// The live slots for one issuer.
#[derive(Debug, Clone, Default)]
pub struct Slots {
    pub claimed: Option<Slot>,
    pub sandbox: Option<Slot>,
}

impl Slots {
    pub fn get(&self, kind: SlotKind) -> Option<&Slot> {
        match kind {
            SlotKind::Claimed => self.claimed.as_ref(),
            SlotKind::Sandbox => self.sandbox.as_ref(),
        }
    }
}

fn is_version_one(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64) == Some(FORMAT_VERSION)
}

/// The live slots for an issuer in a parsed file (`None` when there is no
/// file or it is not JSON).
pub fn read_slots(file: Option<&Value>, issuer: &str, now_ms: i64) -> Slots {
    let Some(root) = file.and_then(Value::as_object) else {
        return Slots::default();
    };
    if !is_version_one(root.get("version")) {
        return Slots::default();
    }
    let Some(entry) = root
        .get("issuers")
        .and_then(Value::as_object)
        .and_then(|issuers| issuers.get(&normalize_issuer(issuer)))
        .and_then(Value::as_object)
    else {
        return Slots::default();
    };
    let live = |kind: SlotKind| {
        entry
            .get(kind.key())
            .and_then(Slot::parse)
            .filter(|slot| slot.is_live(now_ms))
    };
    Slots {
        claimed: live(SlotKind::Claimed),
        sandbox: live(SlotKind::Sandbox),
    }
}

/// One change to the file. With `if_registration`, it applies only while
/// the slot still holds that registration: caching a token, or removing a
/// slot after `invalid_grant` or `sandbox_closed`, must never overwrite or
/// remove a slot another process has since replaced (or removed).
#[derive(Debug, Clone)]
pub enum WriteOp {
    /// Set a slot to exactly this value.
    Set {
        kind: SlotKind,
        slot: Value,
        if_registration: Option<String>,
    },
    Remove {
        kind: SlotKind,
        if_registration: Option<String>,
    },
}

impl WriteOp {
    fn kind(&self) -> SlotKind {
        match self {
            WriteOp::Set { kind, .. } | WriteOp::Remove { kind, .. } => *kind,
        }
    }

    fn if_registration(&self) -> Option<&str> {
        match self {
            WriteOp::Set {
                if_registration, ..
            }
            | WriteOp::Remove {
                if_registration, ..
            } => if_registration.as_deref(),
        }
    }
}

/// What a write does to the file.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteOutcome {
    /// Nothing may be written: a newer format owns the file, or the slot no
    /// longer holds the write's `if_registration`.
    Unchanged,
    /// Nothing is left: delete the file.
    Delete,
    Write(Value),
}

/// The file after a write. `before` is the parsed file (`None` when it is
/// missing or not JSON). An object with a `version` other than 1 belongs to
/// a newer tool and stays as it is; anything else that is not a version 1
/// object is replaced. A conditional write checks its slot in this same
/// `before`, so nothing another process wrote in between is undone. Every
/// issuer's dead or malformed slots go, and so do issuers left empty or
/// that are not objects.
pub fn apply_write(
    before: Option<&Value>,
    issuer: &str,
    op: &WriteOp,
    now_ms: i64,
) -> WriteOutcome {
    let before_obj = before.and_then(Value::as_object);
    if let Some(obj) = before_obj
        && obj.contains_key("version")
        && !is_version_one(obj.get("version"))
    {
        return WriteOutcome::Unchanged;
    }
    let mut root = match before_obj {
        Some(obj) if is_version_one(obj.get("version")) => obj.clone(),
        _ => {
            let mut fresh = Map::new();
            fresh.insert("version".into(), Value::from(1));
            fresh
        }
    };
    let mut issuers = match root.remove("issuers") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let key = normalize_issuer(issuer);
    let mut entry = match issuers.remove(&key) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if let Some(wanted) = op.if_registration() {
        let holds = entry
            .get(op.kind().key())
            .and_then(Slot::parse)
            .is_some_and(|slot| slot.registration_id() == wanted);
        if !holds {
            return WriteOutcome::Unchanged;
        }
    }
    match op {
        WriteOp::Set { kind, slot, .. } => {
            entry.insert(kind.key().into(), slot.clone());
        }
        WriteOp::Remove { kind, .. } => {
            entry.remove(kind.key());
        }
    }
    issuers.insert(key, Value::Object(entry));

    issuers.retain(|_, value| {
        let Some(entry) = value.as_object_mut() else {
            return false;
        };
        for kind in SlotKind::ALL {
            let dead = entry
                .get(kind.key())
                .is_some_and(|slot| !Slot::parse(slot).is_some_and(|s| s.is_live(now_ms)));
            if dead {
                entry.remove(kind.key());
            }
        }
        !entry.is_empty()
    });
    if issuers.is_empty() {
        return WriteOutcome::Delete;
    }
    root.insert("issuers".into(), Value::Object(issuers));
    WriteOutcome::Write(Value::Object(root))
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

static WARNED: AtomicBool = AtomicBool::new(false);

/// Reports a failed write once per process, on stderr, without contents.
fn warn_once(path: &Path, error: &io::Error) {
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "warning: could not update the agent credential file at {}: {error}",
            path.display()
        );
    }
}

/// Reads and writes one issuer's entry in the credential file. Every method
/// is best effort: a broken file reads as empty, and a failed write is
/// reported once while the caller carries on with what it holds in memory.
#[derive(Debug, Clone)]
pub struct CredentialStore {
    path: Option<PathBuf>,
    issuer: String,
}

impl CredentialStore {
    /// The store at `WHK_AGENT_FILE` or the default path, for an app's base URL.
    pub fn locate(base_url: &str) -> Self {
        Self::at(default_credentials_path(), base_url)
    }

    /// The store at a given path (`None`: no file, nothing is ever written).
    pub fn at(path: Option<PathBuf>, base_url: &str) -> Self {
        Self {
            path,
            issuer: normalize_issuer(base_url),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The normalised base URL this store's entry is keyed by.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// The parsed file: `Ok(None)` when it is missing or not JSON, an error
    /// when it exists but cannot be read now (permissions, a Windows sharing
    /// violation mid-rename), which must never be written over.
    fn read_raw(&self) -> io::Result<Option<Value>> {
        let Some(path) = self.path.as_ref() else {
            return Ok(None);
        };
        match fs::read_to_string(path) {
            Ok(text) => Ok(serde_json::from_str(&text).ok()),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(None)
            }
            Err(e) if e.kind() == io::ErrorKind::InvalidData => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The live slots for this issuer.
    pub fn load(&self) -> Slots {
        read_slots(
            self.read_raw().ok().flatten().as_ref(),
            &self.issuer,
            Utc::now().timestamp_millis(),
        )
    }

    /// Saves a new registration, whatever the slot held before.
    pub fn save(&self, kind: SlotKind, slot: &Slot) {
        self.write(WriteOp::Set {
            kind,
            slot: slot.to_value(),
            if_registration: None,
        });
    }

    /// Rewrites the slot (a newly cached token) while the file's slot still
    /// holds the same registration: another tool may have replaced it, or
    /// `whk sandbox forget` removed it, and a token must not bring it back.
    pub fn update(&self, kind: SlotKind, slot: &Slot) {
        self.write(WriteOp::Set {
            kind,
            slot: slot.to_value(),
            if_registration: Some(slot.registration_id().to_string()),
        });
    }

    pub fn remove(&self, kind: SlotKind) {
        self.write(WriteOp::Remove {
            kind,
            if_registration: None,
        });
    }

    /// Removes the slot when it still holds this registration, so a
    /// registration another process saved meanwhile is left alone.
    pub fn remove_registration(&self, kind: SlotKind, registration_id: &str) {
        self.write(WriteOp::Remove {
            kind,
            if_registration: Some(registration_id.to_string()),
        });
    }

    fn write(&self, op: WriteOp) {
        let Some(path) = &self.path else { return };
        if let Err(error) = self.try_write(path, &op) {
            warn_once(path, &error);
        }
    }

    /// Re-reads the file, applies the change (a conditional one checks the
    /// slot in what was just read) and replaces the file atomically: a new
    /// `agent.json.<random>.tmp` (mode 0600, created exclusively), flushed
    /// to disk, then renamed over the file.
    fn try_write(&self, path: &Path, op: &WriteOp) -> io::Result<()> {
        let before = self.read_raw()?;
        let next = apply_write(
            before.as_ref(),
            &self.issuer,
            op,
            Utc::now().timestamp_millis(),
        );
        let value = match next {
            WriteOutcome::Unchanged => return Ok(()),
            WriteOutcome::Delete => {
                return match fs::remove_file(path) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                    _ => Ok(()),
                };
            }
            WriteOutcome::Write(value) => value,
        };

        let dir = match path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
            _ => PathBuf::from("."),
        };
        create_private_dir(&dir)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| FILE_NAME.to_string());
        let temp = dir.join(format!("{name}.{:012x}.tmp", rand::random::<u64>() >> 16));
        let mut text = serde_json::to_string_pretty(&value).map_err(io::Error::other)?;
        text.push('\n');

        let result = (|| {
            let mut file = create_private_file(&temp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.is_dir() {
        return Ok(());
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const VECTORS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/sdk/conformance/agent-credentials.json"
    );

    fn vectors() -> Option<Value> {
        match fs::read_to_string(VECTORS) {
            Ok(text) => Some(serde_json::from_str(&text).expect("vectors are JSON")),
            Err(_) => {
                eprintln!("SKIPPING: {VECTORS} does not exist yet");
                None
            }
        }
    }

    fn ms(iso: &str) -> i64 {
        parse_timestamp(iso).expect("vector timestamp")
    }

    fn list<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
        v[key]
            .as_array()
            .unwrap_or_else(|| panic!("vectors have {key}"))
    }

    #[test]
    fn path_vectors() {
        let Some(v) = vectors() else { return };
        for case in list(&v, "paths") {
            let env: HashMap<String, String> =
                serde_json::from_value(case["env"].clone()).unwrap_or_default();
            let lookup = |name: &str| env.get(name).cloned();
            let got = resolve_credentials_path(
                case["platform"].as_str().unwrap(),
                case["home"].as_str(),
                &lookup,
            );
            let want = case["expected"].as_str().map(|s| s.replace('\\', "/"));
            assert_eq!(
                got.map(|s| s.replace('\\', "/")),
                want,
                "paths: {}",
                case["name"]
            );
        }
    }

    #[test]
    fn issuer_vectors() {
        let Some(v) = vectors() else { return };
        for case in list(&v, "issuers") {
            let input = case["input"].as_str().unwrap();
            assert_eq!(
                normalize_issuer(input),
                case["expected"].as_str().unwrap(),
                "{input}"
            );
        }
    }

    #[test]
    fn read_vectors() {
        let Some(v) = vectors() else { return };
        for case in list(&v, "reads") {
            let file = match (case.get("file"), case.get("fileText")) {
                (Some(file), _) => Some(file.clone()),
                (None, Some(Value::String(text))) => serde_json::from_str(text).ok(),
                _ => None,
            };
            let now = ms(case["now"].as_str().unwrap());
            let slots = read_slots(file.as_ref(), case["issuer"].as_str().unwrap(), now);
            let got = json!({
                "claimed": slots.claimed.is_some(),
                "sandbox": slots.sandbox.is_some(),
                "claimedToken": slots.claimed.as_ref().and_then(|s| s.usable_token(now)).is_some(),
                "sandboxToken": slots.sandbox.as_ref().and_then(|s| s.usable_token(now)).is_some(),
            });
            assert_eq!(got, case["expected"], "reads: {}", case["name"]);
        }
    }

    fn op_of(op: &Value) -> WriteOp {
        let kind = |name: &Value| match name.as_str() {
            Some("claimed") => SlotKind::Claimed,
            Some("sandbox") => SlotKind::Sandbox,
            other => panic!("unknown slot {other:?}"),
        };
        let if_registration = op
            .get("ifRegistration")
            .and_then(Value::as_str)
            .map(String::from);
        match (op.get("set"), op.get("remove")) {
            (Some(name), _) => WriteOp::Set {
                kind: kind(name),
                slot: op["slot"].clone(),
                if_registration,
            },
            (None, Some(name)) => WriteOp::Remove {
                kind: kind(name),
                if_registration,
            },
            _ => panic!("unknown op {op}"),
        }
    }

    #[test]
    fn write_vectors() {
        let Some(v) = vectors() else { return };
        for case in list(&v, "writes") {
            let before = Some(&case["before"]).filter(|b| !b.is_null());
            let got = apply_write(
                before,
                case["issuer"].as_str().unwrap(),
                &op_of(&case["op"]),
                ms(case["now"].as_str().unwrap()),
            );
            let want = match &case["expected"] {
                Value::Null => WriteOutcome::Delete,
                Value::String(s) if s == "unchanged" => WriteOutcome::Unchanged,
                value => WriteOutcome::Write(value.clone()),
            };
            assert_eq!(got, want, "writes: {}", case["name"]);
        }
    }

    #[test]
    fn timestamps_follow_the_shared_shape() {
        assert_eq!(
            parse_timestamp("2026-10-28T12:00:00Z"),
            Some(1_793_188_800_000)
        );
        assert_eq!(
            parse_timestamp("2026-10-28T12:00:00.123456Z"),
            Some(1_793_188_800_123)
        );
        assert_eq!(
            parse_timestamp("2026-10-28T14:00:00+02:00"),
            Some(1_793_188_800_000)
        );
        assert!(
            parse_timestamp("2028-02-29T12:00:00Z").is_some(),
            "a leap day"
        );
        assert!(parse_timestamp("2026-10-28T23:59:59-23:59").is_some());
        for bad in [
            "2026-10-28",
            "2026-10-28t12:00:00Z",
            "2026-10-28 12:00:00Z",
            "2026-10-28T12:00:00",
            "2026-10-28T12:00:00.Z",
            "2026-10-28T12:00:00+0200",
            "2026-10-28T12:00:00z",
            "2026-02-29T12:00:00Z",
            "2026-04-31T12:00:00Z",
            "2026-13-01T12:00:00Z",
            "2026-10-28T24:00:00Z",
            "2026-10-28T12:60:00Z",
            "2026-12-31T23:59:60Z",
            "2026-10-28T12:00:00+24:00",
            "2026-10-28T12:00:00+02:60",
            "tomorrow",
        ] {
            assert_eq!(parse_timestamp(bad), None, "{bad}");
        }
        assert_eq!(
            format_timestamp(1_793_188_800_000),
            "2026-10-28T12:00:00.000Z"
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("whk-cred-{name}-{:x}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn live_slot(id: &str) -> Slot {
        let expires = format_timestamp(Utc::now().timestamp_millis() + 3_600_000);
        Slot::new(
            id,
            "eyJ.assertion.sig",
            &expires,
            &[("client_name", "whk-cli")],
        )
        .unwrap()
    }

    #[test]
    fn writes_atomically_with_private_modes_and_deletes_when_empty() {
        let root = temp_dir("modes");
        let path = root.join("nested").join("agent.json");
        let store = CredentialStore::at(Some(path.clone()), "http://LocalHost:3000/");

        store.save(SlotKind::Sandbox, &live_slot("reg-1"));
        let loaded = store.load();
        assert_eq!(loaded.sandbox.unwrap().registration_id(), "reg-1");
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(raw["issuers"]["http://localhost:3000"]["sandbox"].is_object());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }
        // Only the file itself is left: the temporary file was renamed.
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["agent.json".to_string()]);

        store.remove(SlotKind::Sandbox);
        assert!(!path.exists(), "the last slot removed deletes the file");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_other_issuers_and_skips_newer_versions() {
        let root = temp_dir("keep");
        let path = root.join("agent.json");
        let other = json!({
            "version": 1,
            "issuers": { "https://webhooks.cc": { "claimed": live_slot("prod").to_value() } },
            "note": "kept"
        });
        fs::write(&path, other.to_string()).unwrap();
        let store = CredentialStore::at(Some(path.clone()), "http://127.0.0.1:3000");
        store.save(SlotKind::Sandbox, &live_slot("local"));
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["note"], "kept");
        assert_eq!(
            raw["issuers"]["https://webhooks.cc"]["claimed"]["registration_id"],
            "prod"
        );
        assert_eq!(
            raw["issuers"]["http://127.0.0.1:3000"]["sandbox"]["registration_id"],
            "local"
        );

        let newer = r#"{"version":2,"issuers":{}}"#;
        fs::write(&path, newer).unwrap();
        store.save(SlotKind::Sandbox, &live_slot("local"));
        assert_eq!(fs::read_to_string(&path).unwrap(), newer);
        assert!(store.load().sandbox.is_none());
        let _ = fs::remove_dir_all(&root);
    }

    fn file_with(issuer: &str, kind: SlotKind, slot: &Slot) -> Value {
        json!({ "version": 1, "issuers": { issuer: { kind.key(): slot.to_value() } } })
    }

    #[test]
    fn a_conditional_set_applies_only_while_the_slot_holds_the_registration() {
        let issuer = "https://webhooks.cc";
        let now = Utc::now().timestamp_millis();
        let mut refreshed = live_slot("reg-a");
        refreshed.set_token("whcc_new", now + 3_600_000);
        let op = WriteOp::Set {
            kind: SlotKind::Claimed,
            slot: refreshed.to_value(),
            if_registration: Some("reg-a".into()),
        };

        let held = file_with(issuer, SlotKind::Claimed, &live_slot("reg-a"));
        let WriteOutcome::Write(after) = apply_write(Some(&held), issuer, &op, now) else {
            panic!("the slot still holds reg-a, so the token is written");
        };
        assert_eq!(
            after["issuers"][issuer]["claimed"]["access_token"],
            "whcc_new"
        );

        // Replaced by another process, removed, or no file at all.
        let replaced = file_with(issuer, SlotKind::Claimed, &live_slot("reg-b"));
        let removed = file_with(issuer, SlotKind::Sandbox, &live_slot("reg-a"));
        for before in [Some(&replaced), Some(&removed), None] {
            assert_eq!(
                apply_write(before, issuer, &op, now),
                WriteOutcome::Unchanged,
                "{before:?}"
            );
        }
    }

    #[test]
    fn a_conditional_remove_applies_only_while_the_slot_holds_the_registration() {
        let issuer = "https://webhooks.cc";
        let now = Utc::now().timestamp_millis();
        let op = WriteOp::Remove {
            kind: SlotKind::Sandbox,
            if_registration: Some("reg-a".into()),
        };

        let held = file_with(issuer, SlotKind::Sandbox, &live_slot("reg-a"));
        assert_eq!(
            apply_write(Some(&held), issuer, &op, now),
            WriteOutcome::Delete
        );

        let replaced = file_with(issuer, SlotKind::Sandbox, &live_slot("reg-b"));
        assert_eq!(
            apply_write(Some(&replaced), issuer, &op, now),
            WriteOutcome::Unchanged
        );
        // The claimed slot holding the same id is not the sandbox slot.
        let other_kind = file_with(issuer, SlotKind::Claimed, &live_slot("reg-a"));
        assert_eq!(
            apply_write(Some(&other_kind), issuer, &op, now),
            WriteOutcome::Unchanged
        );
    }

    #[test]
    fn conditional_writes_leave_what_another_process_saved_meanwhile() {
        let root = temp_dir("conditional");
        let path = root.join("agent.json");
        let mine = CredentialStore::at(Some(path.clone()), "https://webhooks.cc");
        let other = CredentialStore::at(Some(path.clone()), "https://webhooks.cc");

        mine.save(SlotKind::Claimed, &live_slot("reg-a"));
        // This process holds reg-a in memory; another one reconnects the agent.
        let mut held = mine.load().claimed.unwrap();
        other.save(SlotKind::Claimed, &live_slot("reg-b"));

        held.set_token("whcc_stale", Utc::now().timestamp_millis() + 3_600_000);
        mine.update(SlotKind::Claimed, &held);
        mine.remove_registration(SlotKind::Claimed, "reg-a");
        let slot = mine.load().claimed.unwrap();
        assert_eq!(slot.registration_id(), "reg-b");
        assert_eq!(slot.usable_token(Utc::now().timestamp_millis()), None);

        // Forgotten meanwhile: a cached token must not bring it back.
        other.remove(SlotKind::Claimed);
        mine.update(SlotKind::Claimed, &held);
        assert!(!path.exists());

        // While it still holds the registration, both apply.
        mine.save(SlotKind::Claimed, &live_slot("reg-a"));
        mine.update(SlotKind::Claimed, &held);
        assert_eq!(
            mine.load()
                .claimed
                .unwrap()
                .usable_token(Utc::now().timestamp_millis()),
            Some("whcc_stale")
        );
        mine.remove_registration(SlotKind::Claimed, "reg-a");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_store_without_a_path_reads_empty_and_never_writes() {
        let store = CredentialStore::at(None, "https://webhooks.cc");
        store.save(SlotKind::Claimed, &live_slot("nowhere"));
        assert!(store.load().claimed.is_none());
    }

    #[test]
    fn slot_debug_never_shows_the_assertion_or_token() {
        let mut slot = live_slot("reg-debug");
        slot.set_token("whcc_secret", Utc::now().timestamp_millis() + 3_600_000);
        let shown = format!("{slot:?}");
        assert!(shown.contains("reg-debug"));
        assert!(!shown.contains("eyJ.assertion.sig"));
        assert!(!shown.contains("whcc_secret"));
    }
}
