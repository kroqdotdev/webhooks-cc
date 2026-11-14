//! `whk setup agent`: connects the coding agents on this machine to
//! webhooks.cc. Each one gets the MCP server (the remote server at
//! `https://webhooks.cc/mcp`, which signs in with OAuth, or with `--local`
//! the stdio server `npx -y @webhooks-cc/mcp`; no key is written anywhere)
//! in its user-level config, and the agent skill where the `skills` CLI
//! (`npx skills add`) puts one for that agent.
//!
//! Claude Code and Codex are changed through their own `mcp add` commands;
//! the others through a JSON merge into their config file. The agents and
//! their file locations follow `packages/mcp/src/setup.ts`, except that
//! Cursor and VS Code get their user-level files rather than a project's.
//!
//! What it writes is recorded in `setup-agent.json` beside `token.json`, so
//! `--remove` deletes exactly that and nothing a person or another tool put
//! there, and a re-run can replace its own older entry. A file is backed up
//! to `<file>.bak` the first time it is changed (never over an existing
//! backup), written through a temporary file and a rename, and left alone
//! when it is not valid JSON.

mod skill;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::cli::confirm;
use crate::cli::output::bold;

/// The server's name in every agent's config.
pub const SERVER_NAME: &str = "webhooks-cc";
/// The remote MCP server.
pub const REMOTE_URL: &str = "https://webhooks.cc/mcp";
const LOCAL_COMMAND: &str = "npx";
const LOCAL_ARGS: [&str; 2] = ["-y", "@webhooks-cc/mcp"];

/// A coding agent `whk setup agent` knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, clap::ValueEnum)]
pub enum Agent {
    ClaudeCode,
    ClaudeDesktop,
    Cursor,
    Vscode,
    Codex,
    /// Devin Desktop, formerly Windsurf, and the Devin CLI.
    #[value(alias = "windsurf")]
    Devin,
}

impl Agent {
    pub const ALL: [Agent; 6] = [
        Agent::ClaudeCode,
        Agent::ClaudeDesktop,
        Agent::Cursor,
        Agent::Vscode,
        Agent::Codex,
        Agent::Devin,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude-code",
            Agent::ClaudeDesktop => "claude-desktop",
            Agent::Cursor => "cursor",
            Agent::Vscode => "vscode",
            Agent::Codex => "codex",
            Agent::Devin => "devin",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "Claude Code",
            Agent::ClaudeDesktop => "Claude Desktop",
            Agent::Cursor => "Cursor",
            Agent::Vscode => "VS Code",
            Agent::Codex => "Codex",
            Agent::Devin => "Devin Desktop (formerly Windsurf)",
        }
    }
}

/// Which server is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Server {
    Remote,
    Local,
}

/// What the command was asked to do.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Only these agents; empty means every agent found on this machine.
    pub agents: Vec<Agent>,
    pub local: bool,
    pub dry_run: bool,
    pub remove: bool,
    pub yes: bool,
}

// ---------------------------------------------------------------------------
// Where things live

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    Mac,
    Windows,
}

/// The home directory, the platform and the environment variables the
/// paths depend on. Tests build one around a temporary home.
#[derive(Debug, Clone)]
pub struct Env {
    pub os: Os,
    pub home: PathBuf,
    pub vars: HashMap<String, String>,
}

impl Env {
    pub fn from_process() -> Result<Self> {
        let home = dirs::home_dir().context("could not determine the home directory")?;
        let os = if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        };
        Ok(Env {
            os,
            home,
            vars: std::env::vars().collect(),
        })
    }

    fn var(&self, name: &str) -> Option<&str> {
        self.vars
            .get(name)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
    }

    fn absolute_var(&self, name: &str) -> Option<PathBuf> {
        self.var(name)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() || (self.os == Os::Windows && p.has_root()))
    }

    fn appdata(&self) -> PathBuf {
        self.absolute_var("APPDATA")
            .unwrap_or_else(|| self.home.join("AppData").join("Roaming"))
    }

    /// `XDG_CONFIG_HOME` when it is absolute, else `~/.config`.
    fn xdg_config(&self) -> PathBuf {
        self.absolute_var("XDG_CONFIG_HOME")
            .unwrap_or_else(|| self.home.join(".config"))
    }

    /// What `dirs::config_dir()` answers, from this environment.
    fn config_dir(&self) -> PathBuf {
        match self.os {
            Os::Mac => self.home.join("Library").join("Application Support"),
            Os::Windows => self.appdata(),
            Os::Linux => self.xdg_config(),
        }
    }

    /// Where this command records what it wrote (beside `token.json`).
    pub fn manifest_path(&self) -> PathBuf {
        self.config_dir().join("whk").join("setup-agent.json")
    }

    fn claude_home(&self) -> PathBuf {
        self.var("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".claude"))
    }

    /// Claude Code's own settings file, where its user-scope MCP servers live.
    fn claude_json(&self) -> PathBuf {
        match self.var("CLAUDE_CONFIG_DIR") {
            Some(dir) => Path::new(dir).join(".claude.json"),
            None => self.home.join(".claude.json"),
        }
    }

    fn codex_home(&self) -> PathBuf {
        self.var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".codex"))
    }

    /// As `getClaudeDesktopConfigPath()` in setup.ts.
    pub fn claude_desktop_config(&self) -> PathBuf {
        let dir = match self.os {
            Os::Mac => self
                .home
                .join("Library")
                .join("Application Support")
                .join("Claude"),
            Os::Windows => self.appdata().join("Claude"),
            Os::Linux => self.home.join(".config").join("Claude"),
        };
        dir.join("claude_desktop_config.json")
    }

    /// Cursor's global MCP file (setup.ts writes the project's
    /// `.cursor/mcp.json`; this command stays out of projects).
    pub fn cursor_config(&self) -> PathBuf {
        self.home.join(".cursor").join("mcp.json")
    }

    /// VS Code's user profile directory.
    fn vscode_user_dir(&self) -> PathBuf {
        let base = match self.os {
            Os::Mac => self.home.join("Library").join("Application Support"),
            Os::Windows => self.appdata(),
            Os::Linux => self.xdg_config(),
        };
        base.join("Code").join("User")
    }

    /// VS Code's user-level `mcp.json` (setup.ts writes the project's
    /// `.vscode/mcp.json`).
    pub fn vscode_config(&self) -> PathBuf {
        self.vscode_user_dir().join("mcp.json")
    }

    /// As `devinMcpConfigPath()` in setup.ts.
    pub fn devin_config(&self) -> PathBuf {
        let base = match self.os {
            Os::Windows => self.appdata(),
            _ => self.xdg_config(),
        };
        base.join("devin").join("mcp_config.json")
    }

    /// As `legacyWindsurfConfigPath()` in setup.ts: only written where
    /// Windsurf from before the rename is installed.
    fn windsurf_dir(&self) -> PathBuf {
        self.home.join(".codeium").join("windsurf")
    }

    // Skill directories, as `globalSkillsDir` in the `skills` CLI's
    // src/agents.ts (github.com/vercel-labs/skills, commit b716f9d,
    // 2026-11-12). That tool copies a skill into one directory and links the
    // agents' directories to it by default; whk copies it into each, as the
    // tool's own `copy` mode does.

    /// `claude-code`: `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`.
    fn claude_skills(&self) -> PathBuf {
        self.claude_home().join("skills")
    }

    /// `cursor`: `~/.cursor/skills`.
    fn cursor_skills(&self) -> PathBuf {
        self.home.join(".cursor").join("skills")
    }

    /// `github-copilot` (VS Code's agent): `~/.copilot/skills`.
    fn copilot_skills(&self) -> PathBuf {
        self.home.join(".copilot").join("skills")
    }

    /// `codex`: `~/.agents/skills`.
    fn codex_skills(&self) -> PathBuf {
        self.home.join(".agents").join("skills")
    }

    /// `devin`: `devin/skills` in xdg-basedir's config directory, which is
    /// `XDG_CONFIG_HOME` or `~/.config` on every platform.
    fn devin_skills(&self) -> PathBuf {
        self.var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".config"))
            .join("devin")
            .join("skills")
    }

    /// `windsurf`: `~/.codeium/windsurf/skills`.
    fn windsurf_skills(&self) -> PathBuf {
        self.windsurf_dir().join("skills")
    }

    /// A program on `PATH`, with Windows' executable extensions.
    pub fn which(&self, name: &str) -> Option<PathBuf> {
        let path = self.vars.get("PATH").or_else(|| self.vars.get("Path"))?;
        let separator = if self.os == Os::Windows { ';' } else { ':' };
        let extensions: Vec<String> = if self.os == Os::Windows {
            self.var("PATHEXT")
                .unwrap_or(".COM;.EXE;.BAT;.CMD")
                .split(';')
                .filter(|e| !e.is_empty())
                .map(|e| e.to_ascii_lowercase())
                .collect()
        } else {
            vec![String::new()]
        };
        path.split(separator)
            .filter(|dir| !dir.is_empty())
            .flat_map(|dir| {
                extensions
                    .iter()
                    .map(move |ext| Path::new(dir).join(format!("{name}{ext}")))
            })
            .find(|candidate| candidate.is_file())
    }

    /// Whether the webhooks-cc Claude Code plugin is installed, which brings
    /// the skill itself. Claude Code records plugins as `<name>@<marketplace>`
    /// keys under `plugins` in `plugins/installed_plugins.json`.
    fn claude_plugin_installed(&self) -> bool {
        let path = self
            .claude_home()
            .join("plugins")
            .join("installed_plugins.json");
        let Ok(text) = fs::read_to_string(path) else {
            return false;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        value["plugins"].as_object().is_some_and(|plugins| {
            plugins
                .keys()
                .any(|key| key.starts_with(&format!("{SERVER_NAME}@")))
        })
    }

    /// Present when its program is on `PATH` or its config directory exists.
    pub fn detect(&self, agent: Agent) -> bool {
        let dir_of = |p: PathBuf| p.parent().is_some_and(Path::exists);
        match agent {
            Agent::ClaudeCode => self.which("claude").is_some() || self.claude_home().exists(),
            Agent::ClaudeDesktop => dir_of(self.claude_desktop_config()),
            Agent::Cursor => self.which("cursor").is_some() || dir_of(self.cursor_config()),
            Agent::Vscode => {
                self.which("code").is_some()
                    || self.vscode_user_dir().parent().is_some_and(Path::exists)
            }
            Agent::Codex => self.which("codex").is_some() || self.codex_home().exists(),
            Agent::Devin => {
                self.which("devin").is_some()
                    || self.which("windsurf").is_some()
                    || dir_of(self.devin_config())
                    || self.windsurf_dir().exists()
            }
        }
    }

    /// A path for people to read, with the home directory as `~`.
    fn show(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) if self.os != Os::Windows => format!("~/{}", rest.display()),
            _ => path.display().to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Running the agents' own commands

/// What a program run answered.
#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `claude` and `codex`. Tests replace it, so they never touch a real
/// agent's config.
pub trait Runner {
    /// Runs `program` with `args`. With `show`, the program talks to the
    /// person directly (Codex signs in this way) and nothing is captured.
    fn run(&mut self, program: &Path, args: &[String], show: bool) -> io::Result<RunOutput>;
}

/// Runs real programs.
pub struct ProcessRunner {
    /// Under `--json` a program's own output goes to stderr, so stdout
    /// stays one JSON document.
    pub json: bool,
}

impl Runner for ProcessRunner {
    fn run(&mut self, program: &Path, args: &[String], show: bool) -> io::Result<RunOutput> {
        let mut command = Process::new(program);
        command.args(args);
        if show {
            command.stdin(if io::stdin().is_terminal() {
                Stdio::inherit()
            } else {
                Stdio::null()
            });
            command.stdout(if self.json {
                Stdio::from(io::stderr())
            } else {
                Stdio::inherit()
            });
            command.stderr(Stdio::inherit());
            let status = command.status()?;
            return Ok(RunOutput {
                success: status.success(),
                ..RunOutput::default()
            });
        }
        let output = command.stdin(Stdio::null()).output()?;
        Ok(RunOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

// ---------------------------------------------------------------------------
// What is installed where

fn remote_entry() -> Value {
    json!({ "type": "http", "url": REMOTE_URL })
}

fn local_entry() -> Value {
    json!({ "type": "stdio", "command": LOCAL_COMMAND, "args": LOCAL_ARGS })
}

/// Without the `type` field, which Cursor, Claude Desktop and Devin do not
/// use (setup.ts writes them this way).
fn untyped(entry: Value) -> Value {
    let mut entry = entry;
    if let Some(map) = entry.as_object_mut() {
        map.remove("type");
    }
    entry
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    Claude,
    Codex,
}

impl Tool {
    fn program(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
        }
    }

    fn id(self) -> &'static str {
        match self {
            Tool::Claude => "claude-code",
            Tool::Codex => "codex",
        }
    }

    fn add_args(self, server: Server) -> Vec<String> {
        let mut args: Vec<&str> = match self {
            Tool::Claude => vec!["mcp", "add", "-s", "user", "--transport"],
            Tool::Codex => vec!["mcp", "add"],
        };
        match (self, server) {
            (Tool::Claude, Server::Remote) => args.extend(["http", SERVER_NAME, REMOTE_URL]),
            (Tool::Claude, Server::Local) => {
                args.extend(["stdio", SERVER_NAME, "--", LOCAL_COMMAND]);
                args.extend(LOCAL_ARGS);
            }
            (Tool::Codex, Server::Remote) => args.extend([SERVER_NAME, "--url", REMOTE_URL]),
            (Tool::Codex, Server::Local) => {
                args.extend([SERVER_NAME, "--", LOCAL_COMMAND]);
                args.extend(LOCAL_ARGS);
            }
        }
        args.into_iter().map(String::from).collect()
    }

    fn remove_args(self) -> Vec<String> {
        let args: &[&str] = match self {
            Tool::Claude => &["mcp", "remove", "-s", "user", SERVER_NAME],
            Tool::Codex => &["mcp", "remove", SERVER_NAME],
        };
        args.iter().map(|a| a.to_string()).collect()
    }
}

fn command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone)]
enum Kind {
    /// The server in a JSON config file, under `key`.
    JsonFile {
        path: PathBuf,
        key: &'static str,
        entry: Value,
        /// Every entry whk writes there, which a re-run may replace.
        ours: Vec<Value>,
    },
    /// The server through the agent's own `mcp add`.
    Command {
        tool: Tool,
        server: Server,
        entry: Value,
        ours: Vec<Value>,
    },
    /// The agent skill, in `<dir>/webhooks-cc`.
    Skill {
        dir: PathBuf,
        /// Why it is left out.
        skip: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct Target {
    kind: Kind,
    /// Only where this directory exists (Windsurf from before the rename).
    only_if: Option<PathBuf>,
}

impl Target {
    fn new(kind: Kind) -> Self {
        Target {
            kind,
            only_if: None,
        }
    }

    fn what(&self) -> &'static str {
        match self.kind {
            Kind::Skill { .. } => "skill",
            _ => "mcp",
        }
    }
}

/// The server an agent gets: Claude Desktop and Devin take local servers
/// only in their config files (the docs list them for the local server).
fn server_for(agent: Agent, asked: Server) -> Server {
    match agent {
        Agent::ClaudeDesktop | Agent::Devin => Server::Local,
        _ => asked,
    }
}

fn targets(agent: Agent, asked: Server, env: &Env) -> Vec<Target> {
    let server = server_for(agent, asked);
    let pick = |remote: Value, local: Value| match server {
        Server::Remote => remote,
        Server::Local => local,
    };
    let skill = |dir: PathBuf| Target::new(Kind::Skill { dir, skip: None });
    match agent {
        Agent::ClaudeCode => {
            let skip = env.claude_plugin_installed().then(|| {
                "the webhooks-cc Claude Code plugin is installed and brings the skill".to_string()
            });
            vec![
                Target::new(Kind::Command {
                    tool: Tool::Claude,
                    server,
                    entry: pick(remote_entry(), local_entry()),
                    ours: vec![remote_entry(), local_entry()],
                }),
                Target::new(Kind::Skill {
                    dir: env.claude_skills(),
                    skip,
                }),
            ]
        }
        Agent::ClaudeDesktop => vec![Target::new(Kind::JsonFile {
            path: env.claude_desktop_config(),
            key: "mcpServers",
            entry: untyped(local_entry()),
            ours: vec![untyped(local_entry())],
        })],
        Agent::Cursor => vec![
            Target::new(Kind::JsonFile {
                path: env.cursor_config(),
                key: "mcpServers",
                entry: pick(untyped(remote_entry()), untyped(local_entry())),
                ours: vec![untyped(remote_entry()), untyped(local_entry())],
            }),
            skill(env.cursor_skills()),
        ],
        Agent::Vscode => vec![
            Target::new(Kind::JsonFile {
                path: env.vscode_config(),
                key: "servers",
                entry: pick(remote_entry(), local_entry()),
                ours: vec![remote_entry(), local_entry()],
            }),
            skill(env.copilot_skills()),
        ],
        Agent::Codex => vec![
            Target::new(Kind::Command {
                tool: Tool::Codex,
                server,
                entry: pick(remote_entry(), local_entry()),
                ours: vec![remote_entry(), local_entry()],
            }),
            skill(env.codex_skills()),
        ],
        Agent::Devin => {
            let legacy = env.windsurf_dir();
            vec![
                Target::new(Kind::JsonFile {
                    path: env.devin_config(),
                    key: "mcpServers",
                    entry: untyped(local_entry()),
                    ours: vec![untyped(local_entry())],
                }),
                Target {
                    kind: Kind::JsonFile {
                        path: legacy.join("mcp_config.json"),
                        key: "mcpServers",
                        entry: untyped(local_entry()),
                        ours: vec![untyped(local_entry())],
                    },
                    only_if: Some(legacy.clone()),
                },
                skill(env.devin_skills()),
                Target {
                    kind: Kind::Skill {
                        dir: env.windsurf_skills(),
                        skip: None,
                    },
                    only_if: Some(legacy),
                },
            ]
        }
    }
}

// ---------------------------------------------------------------------------
// The record of what was written

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    version: u32,
    /// Config file path -> the entry written there.
    #[serde(default)]
    mcp_files: BTreeMap<String, FileRecord>,
    /// Agent -> the entry its `mcp add` made.
    #[serde(default)]
    mcp_commands: BTreeMap<String, Value>,
    /// Skill directory -> its files and their SHA-256.
    #[serde(default)]
    skills: BTreeMap<String, BTreeMap<String, String>>,
}

impl Manifest {
    fn load(path: &Path) -> Result<Self> {
        match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).with_context(|| {
                format!(
                    "{} is not valid JSON, so whk cannot tell what it set up before. Fix or move the file, then run this again",
                    path.display()
                )
            }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Manifest::default()),
            Err(e) => Err(e).with_context(|| format!("could not read {}", path.display())),
        }
    }

    fn is_empty(&self) -> bool {
        self.mcp_files.is_empty() && self.mcp_commands.is_empty() && self.skills.is_empty()
    }

    fn save(&self, path: &Path) -> Result<()> {
        if self.is_empty() {
            return match fs::remove_file(path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => {
                    Err(e).with_context(|| format!("could not remove {}", path.display()))
                }
                _ => Ok(()),
            };
        }
        let mut record = self.clone();
        record.version = 1;
        let text = serde_json::to_string_pretty(&record)? + "\n";
        write_atomic(path, text.as_bytes())
            .with_context(|| format!("could not write {}", path.display()))
    }
}

/// An entry whk wrote into a config file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FileRecord {
    entry: Value,
    /// Whether whk made the file: then it needs no backup, and `--remove`
    /// deletes it once nothing else is in it.
    #[serde(default)]
    created: bool,
}

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Files

/// Writes through a temporary file in the same directory and a rename, so a
/// crash never leaves half a file. A symlinked file is written at its target.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::other("the path has no directory"))?;
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("the path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(".{name}.{}.whk-tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Copies an existing file to `<file>.bak`, unless a backup is there already.
fn backup_once(path: &Path) -> io::Result<()> {
    let backup = backup_path(path);
    if path.exists() && !backup.exists() {
        fs::copy(path, &backup)?;
    }
    Ok(())
}

/// Null, `{}` and `[]` members say nothing, so `{"env": {}}` equals `{}`.
fn prune(value: &Value) -> Value {
    fn empty(v: &Value) -> bool {
        v.is_null()
            || v.as_object().is_some_and(Map::is_empty)
            || v.as_array().is_some_and(Vec::is_empty)
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| !empty(v))
                .map(|(k, v)| (k.clone(), prune(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    prune(a) == prune(b)
}

/// A config file read as a JSON object; `Ok(None)` when there is none.
fn read_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Err(format!(
            "{} is not a JSON object, so it was left as it is",
            path.display()
        )),
        Err(e) => Err(format!(
            "{} is not valid JSON ({e}), so it was left as it is; fix it (comments are not JSON) and run this again",
            path.display()
        )),
    }
}

// ---------------------------------------------------------------------------
// Deciding and doing

/// What happens to one target.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Install,
    Update,
    Remove,
    Unchanged,
    /// Nothing to remove.
    Absent,
    Skip(String),
    Fail(String),
}

impl Step {
    fn is_change(&self) -> bool {
        matches!(self, Step::Install | Step::Update | Step::Remove)
    }
}

/// What to do with an entry that is there now (`current`), given the one
/// to install and the one whk wrote before.
fn decide_entry(
    current: Option<&Value>,
    entry: &Value,
    ours: &[Value],
    recorded: Option<&Value>,
    remove: bool,
    place: &str,
) -> Step {
    if remove {
        return match (current, recorded) {
            (_, None) => Step::Absent,
            (None, _) => Step::Absent,
            (Some(current), Some(recorded)) if same(current, recorded) => Step::Remove,
            _ => Step::Skip(format!(
                "the {SERVER_NAME} entry in {place} changed since whk wrote it, so it was left as it is"
            )),
        };
    }
    match current {
        None => Step::Install,
        Some(current) if same(current, entry) => Step::Unchanged,
        Some(current)
            if recorded.is_some_and(|r| same(current, r))
                || ours.iter().any(|o| same(current, o)) =>
        {
            Step::Update
        }
        Some(_) => Step::Skip(format!(
            "{place} already has a {SERVER_NAME} entry that whk did not write (it may hold an API key), so it was left as it is; remove it first to use this one"
        )),
    }
}

struct Cx<'a> {
    env: &'a Env,
    runner: &'a mut dyn Runner,
    manifest: &'a mut Manifest,
    remove: bool,
}

/// Decides what happens to `target` and, with `execute`, does it. Planning
/// and doing share this, so they cannot disagree.
fn process(target: &Target, cx: &mut Cx, execute: bool) -> Step {
    match &target.kind {
        Kind::JsonFile {
            path,
            key: servers_key,
            entry,
            ours,
        } => json_file(path, servers_key, entry, ours, cx, execute),
        Kind::Command {
            tool,
            server,
            entry,
            ours,
        } => command(*tool, *server, entry, ours, cx, execute),
        Kind::Skill { dir, skip } => {
            skill_dir(&dir.join(skill::NAME), skip.as_deref(), cx, execute)
        }
    }
}

fn json_file(
    path: &Path,
    servers_key: &str,
    entry: &Value,
    ours: &[Value],
    cx: &mut Cx,
    execute: bool,
) -> Step {
    let (existed, mut root) = match read_json_object(path) {
        Ok(Some(root)) => (true, root),
        Ok(None) => (false, Map::new()),
        Err(message) => return Step::Fail(message),
    };
    let current = match root.get(servers_key) {
        None => None,
        Some(Value::Object(servers)) => servers.get(SERVER_NAME).cloned(),
        Some(_) => {
            return Step::Fail(format!(
                "\"{servers_key}\" in {} is not an object, so the file was left as it is",
                path.display()
            ));
        }
    };
    let record = key(path);
    let recorded = cx.manifest.mcp_files.get(&record).cloned();
    let step = decide_entry(
        current.as_ref(),
        entry,
        ours,
        recorded.as_ref().map(|r| &r.entry),
        cx.remove,
        &path.display().to_string(),
    );
    if cx.remove && step == Step::Absent && current.is_none() {
        cx.manifest.mcp_files.remove(&record);
    }
    if !execute || !step.is_change() {
        return step;
    }
    let created = recorded.as_ref().map_or(!existed, |r| r.created);
    let servers = root
        .entry(servers_key.to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("checked above");
    if step == Step::Remove {
        servers.remove(SERVER_NAME);
    } else {
        servers.insert(SERVER_NAME.to_string(), entry.clone());
    }
    let only_ours_left = step == Step::Remove
        && created
        && root.len() == 1
        && root[servers_key].as_object().is_some_and(Map::is_empty);
    if only_ours_left {
        if let Err(e) = fs::remove_file(path) {
            return Step::Fail(format!("could not remove {}: {e}", path.display()));
        }
        cx.manifest.mcp_files.remove(&record);
        return step;
    }
    let text = match serde_json::to_string_pretty(&Value::Object(root)) {
        Ok(text) => text + "\n",
        Err(e) => return Step::Fail(e.to_string()),
    };
    if existed
        && !created
        && let Err(e) = backup_once(path)
    {
        return Step::Fail(format!("could not back up {}: {e}", path.display()));
    }
    if let Err(e) = write_atomic(path, text.as_bytes()) {
        return Step::Fail(format!("could not write {}: {e}", path.display()));
    }
    if step == Step::Remove {
        cx.manifest.mcp_files.remove(&record);
    } else {
        cx.manifest.mcp_files.insert(
            record,
            FileRecord {
                entry: prune(entry),
                created,
            },
        );
    }
    step
}

/// The server's entry as Codex reports it (`codex mcp get --json`), in the
/// shape whk compares: `{"type": "http", "url": ...}` or
/// `{"type": "stdio", "command": ..., "args": [...]}`, plus anything else set.
fn codex_entry(get: &Value) -> Value {
    let transport = &get["transport"];
    let mut out = Map::new();
    let extras: &[&str] = match transport["type"].as_str() {
        Some("streamable_http") => {
            out.insert("type".into(), json!("http"));
            out.insert("url".into(), transport["url"].clone());
            &[
                "bearer_token_env_var",
                "http_headers",
                "env_http_headers",
                "http_headers_helper",
            ]
        }
        Some("stdio") => {
            out.insert("type".into(), json!("stdio"));
            out.insert("command".into(), transport["command"].clone());
            out.insert("args".into(), transport["args"].clone());
            &["env", "env_vars", "cwd"]
        }
        _ => return prune(get),
    };
    for name in extras {
        out.insert((*name).into(), transport[*name].clone());
    }
    if get["enabled"] == json!(false) {
        out.insert("enabled".into(), json!(false));
    }
    prune(&Value::Object(out))
}

/// The server's entry as the agent has it now.
fn command_state(tool: Tool, program: Option<&Path>, cx: &mut Cx) -> Result<Option<Value>, String> {
    match tool {
        // Claude Code keeps user-scope servers under `mcpServers` in its own
        // settings file; reading it avoids `claude mcp get`, which connects.
        Tool::Claude => {
            let path = cx.env.claude_json();
            let root = read_json_object(&path)?;
            Ok(root.and_then(|root| root.get("mcpServers")?.get(SERVER_NAME).cloned()))
        }
        Tool::Codex => {
            let Some(program) = program else {
                return Err(not_on_path(tool, None));
            };
            let args: Vec<String> = ["mcp", "get", SERVER_NAME, "--json"]
                .iter()
                .map(|a| a.to_string())
                .collect();
            let output = cx
                .runner
                .run(program, &args, false)
                .map_err(|e| format!("could not run codex: {e}"))?;
            if !output.success {
                if output.stderr.contains("No MCP server named") {
                    return Ok(None);
                }
                return Err(format!(
                    "`codex mcp get {SERVER_NAME}` failed, so Codex was left as it is: {}",
                    output.stderr.trim()
                ));
            }
            let value: Value = serde_json::from_str(&output.stdout)
                .map_err(|e| format!("`codex mcp get --json` answered something else: {e}"))?;
            Ok(Some(codex_entry(&value)))
        }
    }
}

fn not_on_path(tool: Tool, server: Option<Server>) -> String {
    let program = tool.program();
    match server {
        Some(server) => format!(
            "`{program}` is not on PATH; once it is, run this again or run `{}`",
            command_line(program, &tool.add_args(server))
        ),
        None => format!("`{program}` is not on PATH; run this again once it is"),
    }
}

fn command(
    tool: Tool,
    server: Server,
    entry: &Value,
    ours: &[Value],
    cx: &mut Cx,
    execute: bool,
) -> Step {
    let program = cx.env.which(tool.program());
    let current = match command_state(tool, program.as_deref(), cx) {
        Ok(current) => current,
        Err(message) => return Step::Fail(message),
    };
    let recorded = cx.manifest.mcp_commands.get(tool.id()).cloned();
    let place = match tool {
        Tool::Claude => format!("Claude Code ({})", cx.env.claude_json().display()),
        Tool::Codex => "Codex".to_string(),
    };
    let step = decide_entry(
        current.as_ref(),
        entry,
        ours,
        recorded.as_ref(),
        cx.remove,
        &place,
    );
    if cx.remove && step == Step::Absent && current.is_none() {
        cx.manifest.mcp_commands.remove(tool.id());
    }
    if !step.is_change() {
        return step;
    }
    let Some(program) = program else {
        return Step::Fail(not_on_path(tool, (!cx.remove).then_some(server)));
    };
    if !execute {
        return step;
    }
    let mut runs = Vec::new();
    // `claude mcp add` refuses a name it has; `codex mcp add` replaces it.
    if step == Step::Remove || (step == Step::Update && tool == Tool::Claude) {
        runs.push((tool.remove_args(), false));
    }
    if step != Step::Remove {
        // Codex signs in to a remote server as part of `mcp add`, in the
        // browser, so the person sees what it prints.
        let show = tool == Tool::Codex && server == Server::Remote;
        runs.push((tool.add_args(server), show));
    }
    for (args, show) in runs {
        let line = command_line(tool.program(), &args);
        match cx.runner.run(&program, &args, show) {
            Ok(output) if output.success => {}
            Ok(output) => {
                let detail = output.stderr.trim();
                return Step::Fail(if detail.is_empty() {
                    format!("`{line}` failed")
                } else {
                    format!("`{line}` failed: {detail}")
                });
            }
            Err(e) => return Step::Fail(format!("could not run `{line}`: {e}")),
        }
    }
    if step == Step::Remove {
        cx.manifest.mcp_commands.remove(tool.id());
    } else {
        cx.manifest
            .mcp_commands
            .insert(tool.id().to_string(), prune(entry));
    }
    step
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Every file under `dir`, by its path inside it with `/` separators.
fn read_tree(dir: &Path) -> io::Result<BTreeMap<String, Vec<u8>>> {
    fn walk(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let path = entry.path();
            if fs::metadata(&path)?.is_dir() {
                walk(&path, &rel, out)?;
            } else {
                out.insert(rel, fs::read(&path)?);
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(dir, "", &mut out)?;
    Ok(out)
}

fn hashes(tree: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    tree.iter().map(|(k, v)| (k.clone(), sha256(v))).collect()
}

fn embedded_hashes() -> BTreeMap<String, String> {
    skill::FILES
        .iter()
        .map(|(path, text)| (path.to_string(), sha256(text.as_bytes())))
        .collect()
}

/// Removes `dir` and the directories under it once they are empty.
fn remove_empty_dirs(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                remove_empty_dirs(&entry.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

fn skill_dir(dir: &Path, skip: Option<&str>, cx: &mut Cx, execute: bool) -> Step {
    let record = key(dir);
    let recorded = cx.manifest.skills.get(&record).cloned();
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => Some(meta),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Step::Fail(format!("could not read {}: {e}", dir.display())),
    };
    let link = meta.as_ref().is_some_and(|m| m.file_type().is_symlink());
    let current = match &meta {
        None => None,
        Some(_) if !dir.is_dir() => {
            return Step::Skip(format!(
                "{} is not a directory, so it was left as it is",
                dir.display()
            ));
        }
        Some(_) => match read_tree(dir) {
            Ok(tree) => Some(hashes(&tree)),
            Err(e) => return Step::Fail(format!("could not read {}: {e}", dir.display())),
        },
    };
    let wanted = embedded_hashes();

    let step = if cx.remove {
        match (&current, &recorded) {
            (_, None) | (None, _) => Step::Absent,
            (Some(_), Some(_)) if link => Step::Skip(format!(
                "{} is a link, which whk never makes, so it was left as it is",
                dir.display()
            )),
            (Some(current), Some(recorded)) if current == recorded => Step::Remove,
            _ => Step::Skip(format!(
                "{} changed since whk wrote it, so it was left as it is",
                dir.display()
            )),
        }
    } else if let Some(reason) = skip {
        Step::Skip(reason.to_string())
    } else {
        match &current {
            None => Step::Install,
            Some(current) if *current == wanted => Step::Unchanged,
            Some(_) if link => Step::Skip(format!(
                "{} is a link to another copy of the skill (`npx skills add` makes these), so it was left as it is",
                dir.display()
            )),
            Some(current) if recorded.as_ref() == Some(current) => Step::Update,
            Some(_) => Step::Skip(format!(
                "{} holds a skill that whk did not write, or one changed since, so it was left as it is",
                dir.display()
            )),
        }
    };
    if cx.remove && current.is_none() {
        cx.manifest.skills.remove(&record);
    }
    if !execute || !step.is_change() {
        return step;
    }
    if step == Step::Remove {
        for rel in recorded.unwrap_or_default().keys() {
            if let Err(e) = fs::remove_file(dir.join(rel)) {
                return Step::Fail(format!("could not remove {}: {e}", dir.join(rel).display()));
            }
        }
        remove_empty_dirs(dir);
        // The agent's skills directory too, when whk's skill was all it held.
        if let Some(parent) = dir.parent() {
            let _ = fs::remove_dir(parent);
        }
        cx.manifest.skills.remove(&record);
        return step;
    }
    for (rel, text) in skill::FILES {
        let path = dir.join(rel);
        if let Err(e) = write_atomic(&path, text.as_bytes()) {
            return Step::Fail(format!("could not write {}: {e}", path.display()));
        }
    }
    // Files an older whk wrote that this version no longer has.
    for rel in recorded.unwrap_or_default().keys() {
        if !wanted.contains_key(rel) {
            let _ = fs::remove_file(dir.join(rel));
        }
    }
    remove_empty_subdirs(dir);
    cx.manifest.skills.insert(record, wanted);
    step
}

fn remove_empty_subdirs(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                remove_empty_dirs(&entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The report

/// One target's outcome.
#[derive(Debug, Clone)]
pub struct ItemReport {
    pub what: &'static str,
    pub path: Option<PathBuf>,
    pub command: Option<String>,
    pub step: Step,
}

/// One agent's outcome.
#[derive(Debug, Clone)]
pub struct AgentReport {
    pub agent: Agent,
    pub detected: bool,
    pub server: Server,
    pub items: Vec<ItemReport>,
}

impl AgentReport {
    fn failed(&self) -> bool {
        self.items.iter().any(|i| matches!(i.step, Step::Fail(_)))
    }

    fn changes(&self) -> bool {
        self.items.iter().any(|i| i.step.is_change())
    }
}

/// The whole outcome.
#[derive(Debug, Clone)]
pub struct Report {
    pub server: Server,
    pub remove: bool,
    pub dry_run: bool,
    /// Whether the changes were made (false for a dry run and for the
    /// preview shown before asking).
    pub applied: bool,
    pub agents: Vec<AgentReport>,
}

impl Report {
    pub fn failed(&self) -> bool {
        self.agents.iter().any(AgentReport::failed)
    }

    fn status(&self, step: &Step) -> &'static str {
        match (step, self.applied) {
            (Step::Install, true) => "installed",
            (Step::Update, true) => "updated",
            (Step::Remove, true) => "removed",
            (Step::Install, false) => "would_install",
            (Step::Update, false) => "would_update",
            (Step::Remove, false) => "would_remove",
            (Step::Unchanged, _) => "unchanged",
            (Step::Absent, _) => "absent",
            (Step::Skip(_), _) => "skipped",
            (Step::Fail(_), _) => "failed",
        }
    }

    fn agent_status(&self, agent: &AgentReport) -> &'static str {
        if agent.failed() {
            "failed"
        } else if agent.changes() {
            if self.applied {
                "changed"
            } else {
                "would_change"
            }
        } else if !agent.items.is_empty()
            && agent.items.iter().all(|i| matches!(i.step, Step::Skip(_)))
        {
            "skipped"
        } else if self.remove {
            "absent"
        } else {
            "unchanged"
        }
    }

    pub fn to_json(&self) -> Value {
        let agents: Vec<Value> = self
            .agents
            .iter()
            .map(|a| {
                let items: Vec<Value> = a
                    .items
                    .iter()
                    .map(|i| {
                        let mut item = json!({ "what": i.what, "status": self.status(&i.step) });
                        if let Some(path) = &i.path {
                            item["path"] = json!(path.display().to_string());
                        }
                        if let Some(command) = &i.command {
                            item["command"] = json!(command);
                        }
                        if let Step::Skip(m) | Step::Fail(m) = &i.step {
                            item["message"] = json!(m);
                        }
                        item
                    })
                    .collect();
                let mut agent = json!({
                    "agent": a.agent.id(),
                    "name": a.agent.label(),
                    "detected": a.detected,
                    "server": server_json(a.server),
                    "status": self.agent_status(a),
                    "items": items,
                });
                if let Some(next) = self.next_step(a) {
                    agent["next"] = json!(next);
                }
                agent
            })
            .collect();
        json!({
            "server": server_json(self.server),
            "dryRun": self.dry_run,
            "remove": self.remove,
            "agents": agents,
        })
    }

    /// What the person does next, once the server is in place.
    fn next_step(&self, a: &AgentReport) -> Option<&'static str> {
        if self.remove || !self.applied {
            return None;
        }
        let mcp_ready = a.items.iter().any(|i| {
            i.what == "mcp" && matches!(i.step, Step::Install | Step::Update | Step::Unchanged)
        });
        if !mcp_ready {
            return None;
        }
        Some(match (a.agent, a.server) {
            (Agent::ClaudeCode, Server::Remote) => {
                "In Claude Code, run /mcp and pick webhooks-cc to sign in."
            }
            (Agent::Codex, Server::Remote) => {
                "Codex signs in when the server is added; if no browser opened, run `codex mcp login webhooks-cc`."
            }
            (Agent::Cursor, Server::Remote) => {
                "Restart Cursor or reload its window; it asks you to sign in to webhooks.cc when it connects."
            }
            (Agent::Vscode, Server::Remote) => {
                "Reload the VS Code window and start webhooks-cc from its MCP servers; it asks you to sign in."
            }
            (Agent::ClaudeDesktop, _) => {
                "Restart Claude Desktop. Its config file runs local servers only; for the remote server, add a custom connector with https://webhooks.cc/mcp under Settings, Connectors."
            }
            (Agent::Devin, _) => {
                "Restart Devin Desktop (or Windsurf). It runs the local server, which starts in the agent sandbox until the agent connects your account (connect_account)."
            }
            (_, Server::Local) => {
                "Restart the agent. The local server starts in the agent sandbox until the agent connects your account (connect_account), or uses a connection saved before."
            }
        })
    }

    fn status_words(&self, step: &Step) -> &'static str {
        match self.status(step) {
            "would_install" => "would install",
            "would_update" => "would update",
            "would_remove" => "would remove",
            "absent" => "not there",
            other => other,
        }
    }

    pub fn write_text(&self, env: &Env, out: &mut dyn Write) -> io::Result<()> {
        let server = match self.server {
            Server::Remote => format!("the remote server, {REMOTE_URL}"),
            Server::Local => format!("the local server, {LOCAL_COMMAND} {}", LOCAL_ARGS.join(" ")),
        };
        if self.remove {
            writeln!(out, "Removing what whk set up for your coding agents")?;
        } else {
            writeln!(
                out,
                "Connecting your coding agents to webhooks.cc ({server})"
            )?;
        }
        if self.dry_run {
            writeln!(out, "Dry run: nothing is changed.")?;
        }
        if self.agents.is_empty() {
            writeln!(
                out,
                "\nNo coding agents found on this machine. Name one with --agent: claude-code, claude-desktop, cursor, vscode, codex or devin."
            )?;
            return Ok(());
        }
        for a in &self.agents {
            let found = if a.detected {
                ""
            } else {
                " (not found on this machine)"
            };
            writeln!(out, "\n{}{found}", bold(a.agent.label()))?;
            for i in &a.items {
                let what = if i.what == "mcp" {
                    "MCP server"
                } else {
                    "Skill"
                };
                let place = match (&i.path, &i.command) {
                    (_, Some(command)) => format!("  {command}"),
                    (Some(path), None) => format!("  {}", env.show(path)),
                    _ => String::new(),
                };
                writeln!(
                    out,
                    "  {what:<11} {:<14}{place}",
                    self.status_words(&i.step)
                )?;
                if let Step::Skip(m) | Step::Fail(m) = &i.step {
                    writeln!(out, "              {m}")?;
                }
            }
            if let Some(next) = self.next_step(a) {
                writeln!(out, "  Next: {next}")?;
            }
        }
        Ok(())
    }
}

fn server_json(server: Server) -> Value {
    match server {
        Server::Remote => json!({ "kind": "remote", "url": REMOTE_URL }),
        Server::Local => json!({
            "kind": "local",
            "command": format!("{LOCAL_COMMAND} {}", LOCAL_ARGS.join(" ")),
        }),
    }
}

fn item_report(target: &Target, server: Server, env: &Env, remove: bool, step: Step) -> ItemReport {
    let (path, command) = match &target.kind {
        Kind::JsonFile { path, .. } => (Some(path.clone()), None),
        Kind::Command { tool, .. } => {
            let args = if remove {
                tool.remove_args()
            } else {
                tool.add_args(server)
            };
            let path = (*tool == Tool::Claude).then(|| env.claude_json());
            (path, Some(command_line(tool.program(), &args)))
        }
        Kind::Skill { dir, .. } => (Some(dir.join(skill::NAME)), None),
    };
    ItemReport {
        what: target.what(),
        path,
        command,
        step,
    }
}

/// An agent, whether it was found, and what happens to each of its targets.
type Plan = (Agent, bool, Vec<(Target, Step)>);

/// Plans, asks through `gate` when something would change (unless `--yes`
/// or a dry run), then makes the changes. `gate` gets the plan and the
/// question; it fails with `confirmation_required` without a terminal.
pub fn execute(
    opts: &Options,
    env: &Env,
    runner: &mut dyn Runner,
    gate: &mut dyn FnMut(&Report, &str) -> Result<()>,
) -> Result<Report> {
    let manifest_path = env.manifest_path();
    let mut manifest = Manifest::load(&manifest_path)?;
    let before = manifest.clone();
    let server = if opts.local {
        Server::Local
    } else {
        Server::Remote
    };

    let mut chosen: Vec<(Agent, bool)> = Vec::new();
    if opts.agents.is_empty() {
        for agent in Agent::ALL {
            if env.detect(agent) {
                chosen.push((agent, true));
            }
        }
    } else {
        for agent in &opts.agents {
            if !chosen.iter().any(|(a, _)| a == agent) {
                chosen.push((*agent, env.detect(*agent)));
            }
        }
    }

    // Plan: decide every target without changing anything. A target that
    // fails stops its agent.
    let mut plans: Vec<Plan> = Vec::new();
    {
        let mut cx = Cx {
            env,
            runner: &mut *runner,
            manifest: &mut manifest,
            remove: opts.remove,
        };
        for (agent, detected) in &chosen {
            let mut items = Vec::new();
            let mut failure: Option<String> = None;
            for target in targets(*agent, server, env) {
                if target.only_if.as_ref().is_some_and(|dir| !dir.exists()) {
                    continue;
                }
                let step = process(&target, &mut cx, false);
                if let Step::Fail(m) = &step
                    && failure.is_none()
                {
                    failure = Some(m.clone());
                }
                items.push((target, step));
            }
            if failure.is_some() {
                for (_, step) in items.iter_mut() {
                    if step.is_change() {
                        *step = Step::Skip(format!(
                            "not changed, because of the failure for {}",
                            agent.label()
                        ));
                    }
                }
            }
            plans.push((*agent, *detected, items));
        }
    }

    let report_of = |plans: &[Plan], applied: bool| Report {
        server,
        remove: opts.remove,
        dry_run: opts.dry_run,
        applied,
        agents: plans
            .iter()
            .map(|(agent, detected, items)| {
                let agent_server = server_for(*agent, server);
                AgentReport {
                    agent: *agent,
                    detected: *detected,
                    server: agent_server,
                    items: items
                        .iter()
                        .map(|(t, s)| item_report(t, agent_server, env, opts.remove, s.clone()))
                        .collect(),
                }
            })
            .collect(),
    };

    let changes = plans
        .iter()
        .flat_map(|(_, _, items)| items)
        .any(|(_, step)| step.is_change());
    if opts.dry_run {
        return Ok(report_of(&plans, false));
    }
    if changes && !opts.yes {
        let names: Vec<&str> = plans
            .iter()
            .filter(|(_, _, items)| items.iter().any(|(_, s)| s.is_change()))
            .map(|(agent, _, _)| agent.label())
            .collect();
        let verb = if opts.remove {
            "Remove webhooks.cc from"
        } else {
            "Change the config of"
        };
        let question = format!("{verb} {}?", names.join(", "));
        gate(&report_of(&plans, false), &question)?;
    }

    // Apply.
    {
        let mut cx = Cx {
            env,
            runner: &mut *runner,
            manifest: &mut manifest,
            remove: opts.remove,
        };
        for (agent, _, items) in plans.iter_mut() {
            let mut stopped = false;
            for (target, step) in items.iter_mut() {
                if !step.is_change() {
                    continue;
                }
                if stopped {
                    *step = Step::Skip(format!(
                        "not changed, because of the failure for {}",
                        agent.label()
                    ));
                    continue;
                }
                *step = process(target, &mut cx, true);
                if matches!(step, Step::Fail(_)) {
                    stopped = true;
                }
            }
        }
    }
    if manifest != before {
        manifest.save(&manifest_path)?;
    }
    Ok(report_of(&plans, true))
}

/// `whk setup agent`.
pub fn run(opts: Options, json: bool) -> Result<()> {
    let env = Env::from_process()?;
    let mut runner = ProcessRunner { json };
    let mut gate = |plan: &Report, question: &str| -> Result<()> {
        if !json {
            let mut err = io::stderr();
            plan.write_text(&env, &mut err)?;
            writeln!(err)?;
        }
        confirm::confirm(question, false)
    };
    let report = execute(&opts, &env, &mut runner, &mut gate)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report.to_json())?);
    } else {
        report.write_text(&env, &mut io::stdout())?;
    }
    if report.failed() {
        let failed: Vec<&str> = report
            .agents
            .iter()
            .filter(|a| a.failed())
            .map(|a| a.agent.label())
            .collect();
        return Err(anyhow!(
            "setting up {} failed; see above, fix it and run this again",
            failed.join(", ")
        ));
    }
    Ok(())
}
