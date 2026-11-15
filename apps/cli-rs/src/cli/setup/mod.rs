//! `whk setup agent`: connects the coding agents on this machine to
//! webhooks.cc. Each one gets the MCP server (the remote server at
//! `https://webhooks.cc/mcp`, which signs in with OAuth, or with `--local`
//! the stdio server `npx -y @webhooks-cc/mcp`; no key is written anywhere)
//! in its user-level config, and the agent skill where the `skills` CLI
//! (`npx skills add`) puts one for that agent.
//!
//! Claude Code and Codex are changed through their own `mcp add` commands;
//! the others through a JSON merge into their config file. `codex mcp add
//! --url` signs in to the remote server in the browser before it returns
//! (Codex has no way to add it and sign in later), so without a terminal
//! whk does not run it: Codex is reported as `needs_sign_in`, with the
//! command for the person to run. The agents and
//! their file locations follow `packages/mcp/src/setup.ts`, except that
//! Cursor and VS Code get their user-level files rather than a project's.
//!
//! What it writes is recorded in `setup-agent.json` beside `token.json`, so
//! `--remove` deletes exactly that and nothing a person or another tool put
//! there, and a re-run can replace its own older entry. The record is saved
//! after every change, and before each one with a note of what is about to
//! be written (`pending`), so a run that ends early or cannot save the
//! record afterwards leaves a re-run what it needs to record the change; a
//! record that cannot be written at all stops the run before anything
//! changes. A file is backed up
//! to `<file>.bak` the first time it is changed (never over an existing
//! backup), written through a temporary file and a rename with the file's
//! own mode, and left alone when it is not valid JSON, is read-only, or
//! holds a number whk could not write back exactly. A rewrite keeps the
//! file's key order, indentation, line endings and byte order mark.

mod skill;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::time::{Duration, SystemTime};

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
    /// Whether a person is at a terminal (`confirm::interactive()`), who
    /// can finish Codex's sign-in in the browser.
    pub terminal: bool,
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

    /// `~/.claude/skills` as written, whatever `CLAUDE_CONFIG_DIR` says:
    /// Cursor and VS Code read skills from there too.
    fn home_claude_skills(&self) -> PathBuf {
        self.home.join(".claude").join("skills")
    }

    /// Every skills directory whk knows, for finding links between them.
    fn known_skill_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.claude_skills(),
            self.home_claude_skills(),
            self.cursor_skills(),
            self.copilot_skills(),
            self.codex_skills(),
            self.devin_skills(),
            self.windsurf_skills(),
        ]
    }

    /// The `skills` CLI's global lock file, as `getSkillLockPath()` in its
    /// src/skill-lock.ts (same commit): `$XDG_STATE_HOME/skills/.skill-lock.json`
    /// when that is set, else `~/.agents/.skill-lock.json`.
    fn skills_lock_path(&self) -> PathBuf {
        match self.var("XDG_STATE_HOME") {
            Some(state) => Path::new(state).join("skills").join(".skill-lock.json"),
            None => self.home.join(".agents").join(".skill-lock.json"),
        }
    }

    /// Whether the `skills` CLI's lock lists the webhooks-cc skill: its
    /// `skills` object is keyed by the name the skill is installed under.
    fn skills_cli_lists_skill(&self) -> bool {
        let Ok(text) = fs::read_to_string(self.skills_lock_path()) else {
            return false;
        };
        serde_json::from_str::<Value>(strip_bom(&text))
            .ok()
            .and_then(|lock| lock.get("skills")?.as_object().cloned())
            .is_some_and(|skills| skills.contains_key(skill::NAME))
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
        let Ok(value) = serde_json::from_str::<Value>(strip_bom(&text)) else {
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
            // Ctrl-C at the program's prompt (Codex's sign-in) is the
            // person's answer to that program: it ends the program, not
            // whk, which still records what the program added.
            let interrupt = IgnoreInterrupt::new();
            let status = command.status()?;
            interrupt.program_ended(&status);
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

/// Keeps SIGINT from ending whk while it lasts, and restores what was there
/// before when dropped. A handler that does nothing, not `SIG_IGN`: an
/// ignored signal stays ignored across `exec`, so the program whk runs
/// would ignore Ctrl-C too, while a handled one is reset to the default
/// there. On Windows a console control handler that answers Ctrl-C does
/// the same, and handlers are not inherited either. Should whk end all the
/// same, the record was saved before the program ran with what whk was
/// about to add, so a re-run finds it.
struct IgnoreInterrupt {
    #[cfg(unix)]
    saved: Option<libc::sigaction>,
    #[cfg(windows)]
    added: bool,
}

#[cfg(unix)]
extern "C" fn on_interrupt(_: libc::c_int) {}

#[cfg(windows)]
unsafe extern "system" fn on_console_control(kind: u32) -> windows_sys::core::BOOL {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
    (kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT) as windows_sys::core::BOOL
}

impl IgnoreInterrupt {
    fn new() -> Self {
        #[cfg(unix)]
        {
            // SAFETY: sigaction with zeroed, then filled structs; the
            // handler does nothing, so it is async-signal-safe.
            unsafe {
                let mut saved: libc::sigaction = std::mem::zeroed();
                if libc::sigaction(libc::SIGINT, std::ptr::null(), &mut saved) != 0
                    || saved.sa_sigaction == libc::SIG_IGN
                {
                    // Already ignored (started with nohup, say): kept so.
                    return IgnoreInterrupt { saved: None };
                }
                let mut quiet: libc::sigaction = std::mem::zeroed();
                quiet.sa_sigaction = on_interrupt as extern "C" fn(libc::c_int) as usize;
                quiet.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&mut quiet.sa_mask);
                if libc::sigaction(libc::SIGINT, &quiet, std::ptr::null_mut()) != 0 {
                    return IgnoreInterrupt { saved: None };
                }
                IgnoreInterrupt { saved: Some(saved) }
            }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
            // SAFETY: adds a handler that only answers the event.
            let added = unsafe { SetConsoleCtrlHandler(Some(on_console_control), 1) } != 0;
            IgnoreInterrupt { added }
        }
        #[cfg(not(any(unix, windows)))]
        {
            IgnoreInterrupt {}
        }
    }
}

/// Discards a SIGINT still pending for whk: setting its action to `SIG_IGN`
/// drops a pending SIGINT in the kernel, whichever thread it was meant for
/// (POSIX), so nothing waits and no thread can take it in between. One
/// already being delivered runs the quiet handler. `Drop` then restores the
/// action that was there before.
#[cfg(unix)]
fn discard_pending_interrupt() {
    // SAFETY: sigaction with a zeroed struct whose mask is emptied.
    unsafe {
        let mut ignore: libc::sigaction = std::mem::zeroed();
        ignore.sa_sigaction = libc::SIG_IGN;
        libc::sigemptyset(&mut ignore.sa_mask);
        libc::sigaction(libc::SIGINT, &ignore, std::ptr::null_mut());
    }
}

impl IgnoreInterrupt {
    /// Notes how the program ended. On Windows each Ctrl-C handler runs on
    /// a thread of its own, so after a Ctrl-C whk's handler may not have run
    /// yet: a short wait lets it answer the event before the handler is
    /// removed, or the default would end whk after all. The wait follows
    /// any program that did not succeed, not only one Ctrl-C ended
    /// (`STATUS_CONTROL_C_EXIT`), because a program that handles Ctrl-C
    /// itself exits with a code of its own.
    fn program_ended(&self, status: &std::process::ExitStatus) {
        #[cfg(windows)]
        if self.added && !status.success() {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        #[cfg(not(windows))]
        let _ = status;
    }
}

impl Drop for IgnoreInterrupt {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(saved) = &self.saved {
            // A Ctrl-C sent while the program ran may not have reached whk
            // yet (a signal is acted on when it is delivered, not when it is
            // sent): discard it before the default action comes back, or
            // that action would end whk after all.
            discard_pending_interrupt();
            // SAFETY: restores the action read in `new`.
            unsafe {
                libc::sigaction(libc::SIGINT, saved, std::ptr::null_mut());
            }
        }
        #[cfg(windows)]
        if self.added {
            use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
            // SAFETY: removes the handler `new` added.
            unsafe {
                SetConsoleCtrlHandler(Some(on_console_control), 0);
            }
        }
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

/// A remote server in Devin's `mcp_config.json`, as docs.devin.ai's MCP
/// configuration page writes one: `url`, and `transport` `http` for
/// Streamable HTTP. `devin mcp login webhooks-cc` then signs in.
fn devin_remote_entry() -> Value {
    json!({ "url": REMOTE_URL, "transport": "http" })
}

/// Without the `type` field, which Cursor, Claude Desktop and Devin do not
/// use (setup.ts writes them this way).
fn untyped(entry: Value) -> Value {
    let mut entry = entry;
    if let Some(map) = entry.as_object_mut() {
        map.shift_remove("type");
    }
    entry
}

/// Whether an entry starts the local server through `npx`.
fn runs_npx(entry: &Value) -> bool {
    entry["command"] == json!(LOCAL_COMMAND)
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
        /// The agent reads the file as JSON with comments (VS Code), so a
        /// file with comments is the person's to edit, not a broken one.
        jsonc: bool,
    },
    /// The server through the agent's own `mcp add`.
    Command {
        tool: Tool,
        server: Server,
        /// The configuration the command changes, as recorded.
        config: PathBuf,
        entry: Value,
        ours: Vec<Value>,
        /// Why it is left out: an entry whk added before is then taken
        /// out (the Claude Code plugin brings its own).
        skip: Option<String>,
    },
    /// The agent skill, in `<dir>/webhooks-cc`.
    Skill {
        dir: PathBuf,
        /// Why it is left out: a copy whk added before is then taken out
        /// (the Claude Code plugin brings its own).
        skip: Option<Leave>,
    },
}

/// Why a skill is left out of a directory, and what is said when whk takes
/// out the copy it added there before.
#[derive(Debug, Clone)]
struct Leave {
    reason: String,
    /// Said once whk took it out.
    took_out: String,
    /// Said in a dry run and in the plan shown before asking.
    would_take_out: String,
}

impl Leave {
    fn retired(&self, done: bool) -> String {
        if done {
            self.took_out.clone()
        } else {
            self.would_take_out.clone()
        }
    }
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

    /// The entry this target installs, for an MCP server.
    fn entry(&self) -> Option<&Value> {
        match &self.kind {
            Kind::JsonFile { entry, .. } | Kind::Command { entry, .. } => Some(entry),
            Kind::Skill { .. } => None,
        }
    }

    /// Whether `setup-agent.json` records something whk wrote here.
    /// A note of what whk was about to write counts too.
    fn recorded(&self, manifest: &Manifest) -> bool {
        [&manifest.records, &manifest.pending]
            .into_iter()
            .any(|records| match &self.kind {
                Kind::JsonFile { path, .. } => records.mcp_files.contains_key(&key(path)),
                Kind::Command { tool, config, .. } => records.command(*tool, config).is_some(),
                Kind::Skill { dir, .. } => {
                    records.skills.contains_key(&key(&dir.join(skill::NAME)))
                }
            })
    }
}

/// The server an agent gets: Claude Desktop takes local servers only in its
/// config file (its remote servers are connectors, added in the app).
fn server_for(agent: Agent, asked: Server) -> Server {
    match agent {
        Agent::ClaudeDesktop => Server::Local,
        _ => asked,
    }
}

/// Why Claude Code is left out while the plugin is installed.
const PLUGIN_REASON: &str = "the webhooks-cc Claude Code plugin is installed and brings its own MCP server and the skill, so whk adds neither (a second server would list every tool twice)";

fn targets(agent: Agent, asked: Server, env: &Env) -> Vec<Target> {
    let server = server_for(agent, asked);
    let pick = |remote: Value, local: Value| match server {
        Server::Remote => remote,
        Server::Local => local,
    };
    let skill = |dir: PathBuf| Target::new(Kind::Skill { dir, skip: None });
    match agent {
        Agent::ClaudeCode => {
            let skip = env
                .claude_plugin_installed()
                .then(|| PLUGIN_REASON.to_string());
            let leave = skip.as_ref().map(|reason| Leave {
                reason: reason.clone(),
                took_out: format!(
                    "the {SERVER_NAME} Claude Code plugin is installed and brings the skill, so whk took out the copy it added before, which would load the skill twice"
                ),
                would_take_out: format!(
                    "the {SERVER_NAME} Claude Code plugin is installed and brings the skill, so whk would take out the copy it added before, which would otherwise load the skill twice"
                ),
            });
            vec![
                Target::new(Kind::Command {
                    tool: Tool::Claude,
                    server,
                    config: env.claude_json(),
                    entry: pick(remote_entry(), local_entry()),
                    ours: vec![remote_entry(), local_entry()],
                    skip,
                }),
                Target::new(Kind::Skill {
                    dir: env.claude_skills(),
                    skip: leave,
                }),
            ]
        }
        Agent::ClaudeDesktop => vec![Target::new(Kind::JsonFile {
            path: env.claude_desktop_config(),
            key: "mcpServers",
            entry: untyped(local_entry()),
            ours: vec![untyped(local_entry())],
            jsonc: false,
        })],
        Agent::Cursor => vec![
            Target::new(Kind::JsonFile {
                path: env.cursor_config(),
                key: "mcpServers",
                entry: pick(untyped(remote_entry()), untyped(local_entry())),
                ours: vec![untyped(remote_entry()), untyped(local_entry())],
                jsonc: false,
            }),
            skill(env.cursor_skills()),
        ],
        Agent::Vscode => vec![
            Target::new(Kind::JsonFile {
                path: env.vscode_config(),
                key: "servers",
                entry: pick(remote_entry(), local_entry()),
                ours: vec![remote_entry(), local_entry()],
                jsonc: true,
            }),
            skill(env.copilot_skills()),
        ],
        Agent::Codex => vec![
            Target::new(Kind::Command {
                tool: Tool::Codex,
                server,
                config: env.codex_home(),
                entry: pick(remote_entry(), local_entry()),
                ours: vec![remote_entry(), local_entry()],
                skip: None,
            }),
            skill(env.codex_skills()),
        ],
        Agent::Devin => {
            let legacy = env.windsurf_dir();
            vec![
                Target::new(Kind::JsonFile {
                    path: env.devin_config(),
                    key: "mcpServers",
                    entry: pick(devin_remote_entry(), untyped(local_entry())),
                    ours: vec![devin_remote_entry(), untyped(local_entry())],
                    jsonc: false,
                }),
                // Windsurf from before the rename runs local servers from
                // its file, so it keeps the local server.
                Target {
                    kind: Kind::JsonFile {
                        path: legacy.join("mcp_config.json"),
                        key: "mcpServers",
                        entry: untyped(local_entry()),
                        ours: vec![untyped(local_entry())],
                        jsonc: false,
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

/// What whk wrote, by where it wrote it.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Records {
    /// Config file path -> the entry written there.
    #[serde(default)]
    mcp_files: BTreeMap<String, FileRecord>,
    /// Agent -> the configuration its `mcp add` changed (`CODEX_HOME`,
    /// Claude Code's settings file under `CLAUDE_CONFIG_DIR`) -> the entry
    /// it made. A record made for one configuration says nothing about an
    /// identical entry in another.
    #[serde(default)]
    mcp_commands: BTreeMap<String, BTreeMap<String, Value>>,
    /// Skill directory -> its files and their SHA-256.
    #[serde(default)]
    skills: BTreeMap<String, BTreeMap<String, String>>,
}

impl Records {
    fn is_empty(&self) -> bool {
        self.mcp_files.is_empty() && self.mcp_commands.is_empty() && self.skills.is_empty()
    }

    fn command(&self, tool: Tool, config: &Path) -> Option<&Value> {
        self.mcp_commands.get(tool.id())?.get(&key(config))
    }

    fn set_command(&mut self, tool: Tool, config: &Path, entry: Value) {
        self.mcp_commands
            .entry(tool.id().to_string())
            .or_default()
            .insert(key(config), entry);
    }

    fn take_command(&mut self, tool: Tool, config: &Path) -> Option<Value> {
        let configs = self.mcp_commands.get_mut(tool.id())?;
        let entry = configs.remove(&key(config));
        if configs.is_empty() {
            self.mcp_commands.remove(tool.id());
        }
        entry
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    version: u32,
    #[serde(flatten)]
    records: Records,
    /// What whk is about to write, saved before it writes it: should the
    /// record not be saved afterwards (whk was ended, or the file could
    /// not be written), a re-run that finds exactly this in place records
    /// it, and drops the note otherwise.
    #[serde(default, skip_serializing_if = "Records::is_empty")]
    pending: Records,
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
        self.records.is_empty() && self.pending.is_empty()
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

/// Whether the record can be written where it lives, checked before any
/// agent's file is changed: the directory takes a new file, and the
/// record, if there is one, is not read-only.
fn preflight(path: &Path) -> io::Result<()> {
    let target = atomic_target(path)?;
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::other("the path has no directory"))?;
    fs::create_dir_all(dir)?;
    match fs::symlink_metadata(&target) {
        Ok(meta) if !meta.is_file() => {
            return Err(io::Error::other("it is not a file"));
        }
        Ok(_) if !writable(&target) => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the file is read-only",
            ));
        }
        _ => {}
    }
    let probe = dir.join(format!(
        ".setup-agent.{:016x}.whk-tmp",
        rand::random::<u64>()
    ));
    create_new(&probe, None)?;
    fs::remove_file(&probe)
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

/// The file's permissions, or `0600` for a new one, so a private config is
/// never readable by others, not even for a moment.
fn mode_for(target: &Path) -> io::Result<Option<fs::Permissions>> {
    match fs::metadata(target) {
        Ok(meta) => Ok(Some(meta.permissions())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Creates `path`, which must not exist yet (so a file or link planted
/// there is never written through), with `permissions` or `0600`.
fn create_new(path: &Path, permissions: Option<&fs::Permissions>) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(permissions.map_or(0o600, |p| p.mode() & 0o7777));
    }
    let file = options.open(path)?;
    // The umask may have taken bits away; the copy gets the file's own.
    if let Some(permissions) = permissions {
        file.set_permissions(permissions.clone())?;
    }
    Ok(file)
}

/// Whether this process may write `path` (false when it is read-only).
fn writable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `c_path` is a valid NUL-terminated string for the call.
        unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        fs::metadata(path).is_ok_and(|m| !m.permissions().readonly())
    }
}

/// Where [`write_atomic`] writes `path`: at its target when it is a link.
fn atomic_target(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path),
        _ => Ok(path.to_path_buf()),
    }
}

/// Writes through a temporary file in the same directory and a rename, so a
/// crash never leaves half a file. A symlinked file is written at its
/// target. The temporary file has a random name, is created only if nothing
/// is there, and has the file's mode from the start. A read-only file is
/// refused: the rename would replace it whatever its mode says.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = atomic_target(path)?;
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::other("the path has no directory"))?;
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("the path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let permissions = mode_for(&target)?;
    if permissions.is_some() && !writable(&target) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the file is read-only",
        ));
    }
    let tmp = dir.join(format!(".{name}.{:016x}.whk-tmp", rand::random::<u64>()));
    let mut file = create_new(&tmp, permissions.as_ref())?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
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

/// Copies an existing file to `<file>.bak`, with its mode, unless anything
/// is there already (a backup, or a link, which is never written through).
fn backup_once(path: &Path) -> io::Result<()> {
    let backup = backup_path(path);
    if !path.exists() || fs::symlink_metadata(&backup).is_ok() {
        return Ok(());
    }
    let bytes = fs::read(path)?;
    let mut file = create_new(&backup, mode_for(path)?.as_ref())?;
    file.write_all(&bytes)?;
    file.sync_all()
}

/// Codex's settings on a server rather than its transport: which tools it
/// offers and how long Codex waits for it. Set at all, even to an empty
/// list (`enabled_tools = []` offers no tools), they make the entry the
/// person's.
const CODEX_SERVER_FIELDS: [&str; 4] = [
    "enabled_tools",
    "disabled_tools",
    "startup_timeout_sec",
    "tool_timeout_sec",
];

/// Null, `{}` and `[]` members say nothing, so `{"env": {}}` equals `{}`.
/// Codex's server fields are the exception: only null says nothing there.
fn prune(value: &Value) -> Value {
    fn empty(k: &str, v: &Value) -> bool {
        v.is_null()
            || (!CODEX_SERVER_FIELDS.contains(&k)
                && (v.as_object().is_some_and(Map::is_empty)
                    || v.as_array().is_some_and(Vec::is_empty)))
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, v)| !empty(k, v))
                .map(|(k, v)| (k.clone(), prune(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    prune(a) == prune(b)
}

const BOM: char = '\u{feff}';

fn strip_bom(text: &str) -> &str {
    text.strip_prefix(BOM).unwrap_or(text)
}

/// A config file read as a JSON object, with what a rewrite keeps of how
/// it was written.
#[derive(Debug, Clone)]
struct JsonDoc {
    root: Map<String, Value>,
    bom: bool,
    crlf: bool,
    indent: String,
    newline_at_end: bool,
    /// A number serde_json would not write back as it was: an integer past
    /// 64 bits, which it reads as a float.
    inexact: Option<String>,
}

impl JsonDoc {
    fn new() -> Self {
        JsonDoc {
            root: Map::new(),
            bom: false,
            crlf: false,
            indent: "  ".into(),
            newline_at_end: true,
            inexact: None,
        }
    }

    fn render(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(self.indent.as_bytes());
        let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
        Value::Object(self.root.clone())
            .serialize(&mut serializer)
            .map_err(|e| e.to_string())?;
        let mut text = String::from_utf8(out).map_err(|e| e.to_string())?;
        if self.newline_at_end {
            text.push('\n');
        }
        // Serialized JSON has newlines only between tokens (a string's are
        // escaped), so this changes line endings and nothing else.
        if self.crlf {
            text = text.replace('\n', "\r\n");
        }
        if self.bom {
            text.insert(0, BOM);
        }
        Ok(text.into_bytes())
    }
}

/// The indentation of the first indented line: a tab, or that many spaces.
fn detect_indent(text: &str) -> String {
    for line in text.lines().skip(1) {
        let rest = line.trim_start_matches([' ', '\t']);
        if rest.is_empty() || rest.len() == line.len() {
            continue;
        }
        let lead = &line[..line.len() - rest.len()];
        return if lead.starts_with('\t') {
            "\t".into()
        } else {
            " ".repeat(lead.len().min(8))
        };
    }
    "  ".into()
}

/// The number literals outside strings, as written.
fn number_literals(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                while i < bytes.len()
                    && matches!(bytes[i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                {
                    i += 1;
                }
                out.push(&text[start..i]);
            }
            _ => i += 1,
        }
    }
    out
}

/// An integer literal that does not fit in 64 bits, if there is one.
fn inexact_number(text: &str) -> Option<String> {
    number_literals(text)
        .into_iter()
        .find(|n| {
            !n.contains(['.', 'e', 'E']) && n.parse::<i64>().is_err() && n.parse::<u64>().is_err()
        })
        .map(str::to_string)
}

/// JSON with comments and trailing commas taken out, for telling a JSONC
/// file from a broken one.
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                }
                out.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                out.push('"');
            }
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if c == ',' {
            let next = chars[i + 1..]
                .iter()
                .position(|c| !c.is_whitespace())
                .map(|at| chars[i + 1 + at]);
            if !matches!(next, Some('}') | Some(']')) {
                out.push(c);
            }
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Why a config file could not be read as JSON.
#[derive(Debug)]
struct Unreadable {
    message: String,
    /// Valid JSON with comments or trailing commas.
    jsonc: bool,
}

impl From<String> for Unreadable {
    fn from(message: String) -> Self {
        Unreadable {
            message,
            jsonc: false,
        }
    }
}

/// A config file read as a JSON object; `Ok(None)` when there is none.
fn read_json_doc(path: &Path) -> Result<Option<JsonDoc>, Unreadable> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", path.display()).into()),
    };
    let mut doc = JsonDoc::new();
    doc.bom = raw.starts_with(BOM);
    let text = strip_bom(&raw);
    doc.crlf = text.contains("\r\n");
    if text.trim().is_empty() {
        return Ok(Some(doc));
    }
    doc.newline_at_end = text.ends_with('\n');
    doc.indent = detect_indent(text);
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => {
            doc.root = map;
            doc.inexact = inexact_number(text);
            Ok(Some(doc))
        }
        Ok(_) => Err(format!(
            "{} is not a JSON object, so it was left as it is",
            path.display()
        )
        .into()),
        Err(_) if serde_json::from_str::<Value>(&strip_jsonc(&strip_jsonc(text))).is_ok() => Err(Unreadable {
            message: format!(
                "{} is not valid JSON: it has comments or trailing commas, which a rewrite would lose, so it was left as it is; add the {SERVER_NAME} server there yourself, or take them out and run this again",
                path.display()
            ),
            jsonc: true,
        }),
        Err(e) => Err(format!(
            "{} is not valid JSON ({e}), so it was left as it is; fix it (comments are not JSON) and run this again",
            path.display()
        )
        .into()),
    }
}

/// The object only, for reading a file whk never writes.
fn read_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    read_json_doc(path)
        .map(|doc| doc.map(|d| d.root))
        .map_err(|e| e.message)
}

// ---------------------------------------------------------------------------
// Deciding and doing

/// What happens to one target.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Install,
    Update,
    Remove,
    /// Removed though no `--remove` asked for it, for the reason given.
    Retire(String),
    Unchanged,
    /// Nothing to remove.
    Absent,
    Skip(String),
    /// Skipped, and the agent's other changes with it: a config file it
    /// needs is read-only.
    Blocked(String),
    Fail(String),
    /// Left to the person, because adding it signs in and no one is at a
    /// terminal to do that (Codex with the remote server).
    NeedsSignIn(String),
}

impl Step {
    fn is_change(&self) -> bool {
        matches!(
            self,
            Step::Install | Step::Update | Step::Remove | Step::Retire(_)
        )
    }

    fn removes(&self) -> bool {
        matches!(self, Step::Remove | Step::Retire(_))
    }

    /// Whether it stops the agent's other changes.
    fn stops(&self) -> bool {
        matches!(self, Step::Fail(_) | Step::Blocked(_))
    }

    fn message(&self) -> Option<&str> {
        match self {
            Step::Retire(m)
            | Step::Skip(m)
            | Step::Blocked(m)
            | Step::Fail(m)
            | Step::NeedsSignIn(m) => Some(m),
            _ => None,
        }
    }
}

/// The other server's name, for the message about an unrecorded entry.
fn kind_of(entry: &Value) -> &'static str {
    if entry.get("url").is_some() {
        "remote"
    } else {
        "local"
    }
}

/// What to do with an entry that is there now (`current`), given the one
/// to install and the one whk wrote before. `named` is whether the person
/// picked this agent with `--agent`.
fn decide_entry(
    current: Option<&Value>,
    entry: &Value,
    ours: &[Value],
    recorded: Option<&Value>,
    remove: bool,
    named: bool,
    place: &str,
) -> Step {
    if remove {
        return match (current, recorded) {
            (None, _) => Step::Absent,
            (Some(_), None) => Step::Skip(format!(
                "the {SERVER_NAME} entry in {place} was not written by whk, so it was left as it is"
            )),
            (Some(current), Some(recorded)) if same(current, recorded) => Step::Remove,
            _ => Step::Skip(format!(
                "the {SERVER_NAME} entry in {place} changed since whk wrote it, so it was left as it is"
            )),
        };
    }
    match current {
        None => Step::Install,
        Some(current) if same(current, entry) => Step::Unchanged,
        Some(current) if recorded.is_some_and(|r| same(current, r)) => Step::Update,
        Some(_) if recorded.is_some() => Step::Skip(format!(
            "the {SERVER_NAME} entry in {place} changed since whk wrote it, so it was left as it is; remove it first to use this one"
        )),
        // The other kind of server, as whk writes it, but not recorded: the
        // person may have added it. Replaced only when they name the agent.
        Some(current) if ours.iter().any(|o| same(current, o)) => {
            if named {
                Step::Update
            } else {
                Step::Skip(format!(
                    "{place} already has the {} {SERVER_NAME} server, which whk has no record of adding, so it was left as it is; name the agent with --agent to replace it",
                    kind_of(current)
                ))
            }
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
    terminal: bool,
    /// Whether the agent being processed was named with `--agent`.
    named: bool,
    /// Where the record is saved while changes are made; none while
    /// planning, which changes nothing.
    store: Option<&'a Path>,
}

impl Cx<'_> {
    /// Saves the record now, so it never lags behind a change.
    fn save(&self) -> Result<(), String> {
        match self.store {
            Some(path) => self.manifest.save(path).map_err(|e| format!("{e:#}")),
            None => Ok(()),
        }
    }

    /// Notes what whk is about to write in `place`, and saves the note
    /// before anything is written there. When it cannot be saved, nothing
    /// is written.
    fn note(&mut self, place: &str, note: impl FnOnce(&mut Records)) -> Result<(), Step> {
        if self.store.is_none() {
            return Ok(());
        }
        note(&mut self.manifest.pending);
        self.save().map_err(|e| {
            Step::Fail(format!(
                "whk could not save its record before changing {place}, so it was left as it is: {e}"
            ))
        })
    }
}

/// Takes the note of what whk was about to write at `name`, and records it
/// when `in_place` says it is there exactly as noted.
fn adopt<T>(
    records: &mut BTreeMap<String, T>,
    pending: &mut BTreeMap<String, T>,
    name: &str,
    in_place: impl FnOnce(&T) -> bool,
) {
    if let Some(noted) = pending.remove(name)
        && in_place(&noted)
    {
        records.insert(name.to_string(), noted);
    }
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
            jsonc,
        } => json_file(path, servers_key, entry, ours, *jsonc, cx, execute),
        Kind::Command {
            tool,
            server,
            config,
            entry,
            ours,
            skip,
        } => command(
            *tool,
            *server,
            config,
            entry,
            ours,
            skip.as_deref(),
            cx,
            execute,
        ),
        Kind::Skill { dir, skip } => skill_dir(&dir.join(skill::NAME), skip.as_ref(), cx, execute),
    }
}

fn json_file(
    path: &Path,
    servers_key: &str,
    entry: &Value,
    ours: &[Value],
    jsonc: bool,
    cx: &mut Cx,
    execute: bool,
) -> Step {
    let (existed, mut doc) = match read_json_doc(path) {
        Ok(Some(doc)) => (true, doc),
        Ok(None) => (false, JsonDoc::new()),
        // The agent reads comments, so the file is fine, only not whk's to
        // rewrite: a skip, unless the person asked for this agent.
        Err(e) if e.jsonc && jsonc && !cx.named => return Step::Skip(e.message),
        Err(e) => return Step::Fail(e.message),
    };
    let current = match doc.root.get(servers_key) {
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
    adopt(
        &mut cx.manifest.records.mcp_files,
        &mut cx.manifest.pending.mcp_files,
        &record,
        |noted| current.as_ref().is_some_and(|c| same(c, &noted.entry)),
    );
    let recorded = cx.manifest.records.mcp_files.get(&record).cloned();
    let step = decide_entry(
        current.as_ref(),
        entry,
        ours,
        recorded.as_ref().map(|r| &r.entry),
        cx.remove,
        cx.named,
        &path.display().to_string(),
    );
    if cx.remove && step == Step::Absent && current.is_none() {
        cx.manifest.records.mcp_files.remove(&record);
    }
    if !step.is_change() {
        return step;
    }
    if existed && !writable(path) {
        return Step::Blocked(format!(
            "{} is read-only, so it was left as it is, and nothing else was changed for this agent",
            path.display()
        ));
    }
    if let Some(number) = &doc.inexact {
        return Step::Fail(format!(
            "{} holds the number {number}, which whk could not write back exactly, so the file was left as it is; add the {SERVER_NAME} server there yourself",
            path.display()
        ));
    }
    if !execute {
        return step;
    }
    let created = recorded.as_ref().map_or(!existed, |r| r.created);
    let root = &mut doc.root;
    let servers = root
        .entry(servers_key.to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("checked above");
    if step == Step::Remove {
        // shift_remove keeps the other servers in their order.
        servers.shift_remove(SERVER_NAME);
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
        cx.manifest.records.mcp_files.remove(&record);
        return step;
    }
    let bytes = match doc.render() {
        Ok(bytes) => bytes,
        Err(e) => return Step::Fail(e),
    };
    if existed
        && !created
        && let Err(e) = backup_once(path)
    {
        return Step::Fail(format!("could not back up {}: {e}", path.display()));
    }
    let written = FileRecord {
        entry: prune(entry),
        created,
    };
    if step != Step::Remove
        && let Err(failed) = cx.note(&path.display().to_string(), |p| {
            p.mcp_files.insert(record.clone(), written.clone());
        })
    {
        return failed;
    }
    let result = write_atomic(path, &bytes);
    cx.manifest.pending.mcp_files.remove(&record);
    if let Err(e) = result {
        return Step::Fail(format!("could not write {}: {e}", path.display()));
    }
    if step == Step::Remove {
        cx.manifest.records.mcp_files.remove(&record);
    } else {
        cx.manifest.records.mcp_files.insert(record, written);
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
    let mut out = prune(&Value::Object(out));
    // Copied after pruning, so an empty list stays: it is set.
    for name in CODEX_SERVER_FIELDS {
        if !get[name].is_null() {
            out[name] = get[name].clone();
        }
    }
    out
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

/// An agent found by its config directory whose program is not on PATH:
/// nothing to run, so its server is left for later, and its skill is still
/// copied.
fn missing_program(tool: Tool, server: Server, remove: bool) -> String {
    let program = tool.program();
    if remove {
        format!(
            "`{program}` is not on PATH, so its {SERVER_NAME} server was left as it is; run this again once it is"
        )
    } else {
        format!(
            "`{program}` is not on PATH, so the server was not added; once it is, run this again or run `{}`",
            command_line(program, &tool.add_args(server))
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn command(
    tool: Tool,
    server: Server,
    config: &Path,
    entry: &Value,
    ours: &[Value],
    retire: Option<&str>,
    cx: &mut Cx,
    execute: bool,
) -> Step {
    // `retire` holds only while installing; --remove goes by the record.
    let retire = retire.filter(|_| !cx.remove);
    let program = cx.env.which(tool.program());
    // Without the program, an agent the person named fails with the command
    // to run; one only found on this machine is skipped.
    let no_program = |cx: &Cx| {
        if let Some(reason) = retire {
            Step::Skip(reason.to_string())
        } else if cx.named {
            Step::Fail(not_on_path(tool, (!cx.remove).then_some(server)))
        } else {
            Step::Skip(missing_program(tool, server, cx.remove))
        }
    };
    if program.is_none() && tool == Tool::Codex {
        return no_program(cx);
    }
    let current = match command_state(tool, program.as_deref(), cx) {
        Ok(current) => current,
        Err(message) => return Step::Fail(message),
    };
    if let Some(noted) = cx.manifest.pending.take_command(tool, config)
        && current.as_ref().is_some_and(|c| same(c, &noted))
    {
        cx.manifest.records.set_command(tool, config, noted);
    }
    let recorded = cx.manifest.records.command(tool, config).cloned();
    let place = match tool {
        Tool::Claude => format!("Claude Code ({})", cx.env.claude_json().display()),
        Tool::Codex => format!("Codex ({})", cx.env.codex_home().display()),
    };
    let step = match retire {
        // The Claude Code plugin brings the server: whk's own earlier entry
        // would list every tool twice, so it goes; anything else stays.
        Some(reason) => match (&current, &recorded) {
            (Some(current), Some(recorded)) if same(current, recorded) => {
                Step::Retire(if execute {
                    format!(
                        "the {SERVER_NAME} Claude Code plugin is installed and brings its own MCP server, so whk took out the one it added before, which would list every tool twice"
                    )
                } else {
                    format!(
                        "the {SERVER_NAME} Claude Code plugin is installed and brings its own MCP server, so whk would take out the one it added before, which would otherwise list every tool twice"
                    )
                })
            }
            _ => Step::Skip(reason.to_string()),
        },
        None => decide_entry(
            current.as_ref(),
            entry,
            ours,
            recorded.as_ref(),
            cx.remove,
            cx.named,
            &place,
        ),
    };
    if cx.remove && step == Step::Absent && current.is_none() {
        cx.manifest.records.take_command(tool, config);
    }
    if !step.is_change() {
        return step;
    }
    let Some(program) = program else {
        return no_program(cx);
    };
    let removing = step.removes();
    // `codex mcp add --url` writes the entry and then waits for a sign-in in
    // the browser, with no flag to skip it; without a terminal it would wait
    // for good, so the person runs it instead.
    if tool == Tool::Codex && server == Server::Remote && !removing && !cx.terminal {
        return Step::NeedsSignIn(format!(
            "Codex signs in to the remote server while adding it, in your browser, and no terminal is attached, so it was not added; run `{}` in a terminal",
            command_line(tool.program(), &tool.add_args(server))
        ));
    }
    if !execute {
        return step;
    }
    let mut runs = Vec::new();
    // `claude mcp add` refuses a name it has; `codex mcp add` replaces it.
    if removing || (step == Step::Update && tool == Tool::Claude) {
        runs.push((tool.remove_args(), false));
    }
    if !removing {
        // Codex signs in to a remote server as part of `mcp add`, in the
        // browser, so the person sees what it prints.
        let show = tool == Tool::Codex && server == Server::Remote;
        runs.push((tool.add_args(server), show));
        // Saved before the agent's command runs, so that whatever ends
        // whk meanwhile, a re-run finds the entry and records it.
        if let Err(failed) = cx.note(&place, |p| p.set_command(tool, config, prune(entry))) {
            return failed;
        }
    }
    for (args, show) in runs {
        let line = command_line(tool.program(), &args);
        let failure = match cx.runner.run(&program, &args, show) {
            Ok(output) if output.success => continue,
            Ok(output) => {
                let detail = output.stderr.trim();
                if detail.is_empty() {
                    format!("`{line}` failed")
                } else {
                    format!("`{line}` failed: {detail}")
                }
            }
            Err(e) => format!("could not run `{line}`: {e}"),
        };
        cx.manifest.pending.take_command(tool, config);
        // A failed add may still have written the entry (Codex writes it,
        // then signs in): when it is the one whk asked for, record it, so
        // a re-run or --remove knows it is whk's.
        if !removing
            && let Ok(Some(now)) = command_state(tool, Some(&program), cx)
            && same(&now, entry)
        {
            cx.manifest.records.set_command(tool, config, prune(entry));
            return Step::Fail(format!(
                "{failure}; the entry it added is in place, and --remove takes it out"
            ));
        }
        return Step::Fail(failure);
    }
    cx.manifest.pending.take_command(tool, config);
    if removing {
        cx.manifest.records.take_command(tool, config);
    } else {
        cx.manifest.records.set_command(tool, config, prune(entry));
    }
    step
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// A skill directory as read, without following any link inside it.
struct Tree {
    /// Every regular file, by its path inside the directory with `/`
    /// separators.
    files: BTreeMap<String, Vec<u8>>,
    /// The first entry that is neither a file nor a directory: a link,
    /// which whk never makes, or something stranger.
    odd: Option<String>,
}

/// Reads `dir` (through a link, if `dir` itself is one) and everything
/// under it, inspecting each entry without following it.
fn read_tree(dir: &Path) -> io::Result<Tree> {
    fn walk(dir: &Path, prefix: &str, tree: &mut Tree) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(&entry.path(), &rel, tree)?;
            } else if kind.is_file() {
                tree.files.insert(rel, fs::read(entry.path())?);
            } else {
                tree.odd.get_or_insert(rel);
                return Ok(());
            }
            if tree.odd.is_some() {
                return Ok(());
            }
        }
        Ok(())
    }
    let mut tree = Tree {
        files: BTreeMap::new(),
        odd: None,
    };
    walk(dir, "", &mut tree)?;
    Ok(tree)
}

/// Whether every file in `current` is one whk recorded, unchanged. Files
/// the record lists that are gone (a removal that stopped part way) do
/// not count against it.
fn owned(current: &BTreeMap<String, String>, recorded: &BTreeMap<String, String>) -> bool {
    current
        .iter()
        .all(|(rel, hash)| recorded.get(rel) == Some(hash))
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

/// Why a copy of the skill belongs to the `skills` CLI, if it does: its
/// lock lists the skill (so it may have written or adopted this copy), or
/// another agent's skills directory links here, as its default install
/// does. whk never updates or removes such a copy.
fn skills_cli_owner(dir: &Path, env: &Env) -> Option<String> {
    if env.skills_cli_lists_skill() {
        return Some(format!(
            "the skills CLI lists {} in {}, so it may manage {}; whk left it as it is (`npx skills remove --global {}` removes it)",
            skill::NAME,
            env.show(&env.skills_lock_path()),
            env.show(dir),
            skill::NAME
        ));
    }
    let here = fs::canonicalize(dir).ok()?;
    let parent = dir.parent()?;
    env.known_skill_dirs()
        .into_iter()
        .filter(|other| other != parent)
        .map(|other| other.join(skill::NAME))
        .find(|other| {
            fs::symlink_metadata(other).is_ok_and(|m| m.file_type().is_symlink())
                && fs::canonicalize(other).is_ok_and(|target| target == here)
        })
        .map(|other| {
            format!(
                "{} links to {}, so another tool (`npx skills add`) uses it; whk left it as it is",
                env.show(&other),
                env.show(dir)
            )
        })
}

fn skill_dir(dir: &Path, skip: Option<&Leave>, cx: &mut Cx, execute: bool) -> Step {
    let record = key(dir);
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
            Ok(Tree { odd: Some(rel), .. }) => {
                return Step::Skip(format!(
                    "{} holds {rel}, a link or other entry that whk never writes, so it was left as it is",
                    dir.display()
                ));
            }
            Ok(tree) => Some(hashes(&tree.files)),
            Err(e) => return Step::Fail(format!("could not read {}: {e}", dir.display())),
        },
    };
    adopt(
        &mut cx.manifest.records.skills,
        &mut cx.manifest.pending.skills,
        &record,
        |noted| !link && current.as_ref() == Some(noted),
    );
    let recorded = cx.manifest.records.skills.get(&record).cloned();
    let wanted = embedded_hashes();

    let step = if cx.remove {
        match (&current, &recorded) {
            (None, _) => Step::Absent,
            (Some(_), None) => Step::Skip(format!(
                "{} was not written by whk, so it was left as it is",
                dir.display()
            )),
            (Some(_), Some(_)) if link => Step::Skip(format!(
                "{} is a link, which whk never makes, so it was left as it is",
                dir.display()
            )),
            (Some(current), Some(recorded)) if owned(current, recorded) => Step::Remove,
            _ => Step::Skip(format!(
                "{} changed since whk wrote it, so it was left as it is",
                dir.display()
            )),
        }
    } else if let Some(leave) = skip {
        // What whk copied here before goes, unchanged; anything else stays.
        match (&current, &recorded) {
            (Some(current), Some(recorded)) if !link && owned(current, recorded) => {
                Step::Retire(leave.retired(execute))
            }
            _ => Step::Skip(leave.reason.clone()),
        }
    } else {
        match &current {
            None => Step::Install,
            Some(current) if *current == wanted => Step::Unchanged,
            Some(_) if link => Step::Skip(format!(
                "{} is a link to another copy of the skill (`npx skills add` makes these), so it was left as it is",
                dir.display()
            )),
            Some(current) if recorded.as_ref().is_some_and(|r| owned(current, r)) => Step::Update,
            Some(_) if recorded.is_some() => Step::Skip(format!(
                "{} changed since whk wrote it, so it was left as it is",
                dir.display()
            )),
            Some(_) => Step::Skip(format!(
                "{} holds a skill that whk did not write, so it was left as it is",
                dir.display()
            )),
        }
    };
    // A copy whk wrote that the skills CLI has taken on since.
    let step = match step {
        Step::Remove | Step::Retire(_) | Step::Update => match skills_cli_owner(dir, cx.env) {
            Some(reason) => {
                if cx.remove {
                    // No longer whk's to remove, so no longer whk's record.
                    cx.manifest.records.skills.remove(&record);
                }
                Step::Skip(reason)
            }
            None => step,
        },
        step => step,
    };
    if cx.remove && current.is_none() {
        cx.manifest.records.skills.remove(&record);
    }
    if !execute || !step.is_change() {
        return step;
    }
    if step.removes() {
        // The record loses each file as it goes, so a removal that stops
        // part way is taken up again by the next one.
        let mut left = recorded.unwrap_or_default();
        let files: Vec<String> = left.keys().cloned().collect();
        for rel in files {
            let path = dir.join(&rel);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => {
                    cx.manifest.records.skills.insert(record, left);
                    return Step::Fail(format!("could not remove {}: {e}", path.display()));
                }
            }
            left.remove(&rel);
        }
        remove_empty_dirs(dir);
        // The agent's skills directory too, when whk's skill was all it held.
        if let Some(parent) = dir.parent() {
            let _ = fs::remove_dir(parent);
        }
        cx.manifest.records.skills.remove(&record);
        return step;
    }
    if let Err(failed) = cx.note(&dir.display().to_string(), |p| {
        p.skills.insert(record.clone(), wanted.clone());
    }) {
        return failed;
    }
    let result = put_skill(dir, step == Step::Update);
    cx.manifest.pending.skills.remove(&record);
    if let Err(e) = result {
        return Step::Fail(format!(
            "could not write the skill to {}: {e}; it was left as it was",
            dir.display()
        ));
    }
    cx.manifest.records.skills.insert(record, wanted);
    step
}

/// Writes the skill into a new directory beside `dir`, then puts that in
/// its place, so `dir` is never half written and never mixes two versions.
/// The copy being replaced (`update`) is moved aside first and put back if
/// the new one cannot take its place. A failure removes what was written,
/// the directories made for it included.
fn put_skill(dir: &Path, update: bool) -> io::Result<()> {
    let parent = dir
        .parent()
        .ok_or_else(|| io::Error::other("the path has no directory"))?;
    let made_from = parent
        .ancestors()
        .take_while(|p| !p.exists())
        .last()
        .map(Path::to_path_buf);
    let aside = |what: &str| {
        parent.join(format!(
            ".{}.{:016x}.whk-{what}",
            skill::NAME,
            rand::random::<u64>()
        ))
    };
    let stage = aside("tmp");
    let result = (|| {
        fs::create_dir_all(parent)?;
        fs::create_dir(&stage)?;
        write_skill_files(&stage)?;
        if !update {
            return fs::rename(&stage, dir);
        }
        let old = aside("old");
        fs::rename(dir, &old)?;
        if let Err(e) = fs::rename(&stage, dir) {
            let _ = fs::rename(&old, dir);
            return Err(e);
        }
        // The old copy held only files whk recorded, so it is whk's.
        let _ = fs::remove_dir_all(&old);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
        if let Some(top) = made_from {
            for made in parent.ancestors() {
                if fs::remove_dir(made).is_err() || made == top {
                    break;
                }
            }
        }
    }
    result
}

#[cfg(test)]
thread_local! {
    /// Makes the next [`write_skill_files`] fail at this file, in tests.
    static FAIL_SKILL_FILE: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn fails_at(file: usize) -> bool {
    FAIL_SKILL_FILE.with(|f| {
        let fails = f.get() == Some(file);
        if fails {
            f.set(None);
        }
        fails
    })
}

#[cfg(not(test))]
fn fails_at(_: usize) -> bool {
    false
}

/// The skill's files in `dir`, which is new and empty; each is private.
fn write_skill_files(dir: &Path) -> io::Result<()> {
    for (at, (rel, text)) in skill::FILES.iter().enumerate() {
        if fails_at(at) {
            return Err(io::Error::other("a write failed"));
        }
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = create_new(&path, None)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    Ok(())
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
    /// It runs the local server through `npx`, which is not on PATH.
    pub npx_missing: bool,
}

impl AgentReport {
    fn failed(&self) -> bool {
        self.items.iter().any(|i| matches!(i.step, Step::Fail(_)))
    }

    fn changes(&self) -> bool {
        self.items.iter().any(|i| i.step.is_change())
    }

    fn needs_sign_in(&self) -> bool {
        self.items
            .iter()
            .any(|i| matches!(i.step, Step::NeedsSignIn(_)))
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
    /// What this run leaves for another one to tidy.
    pub notes: Vec<String>,
}

impl Report {
    pub fn failed(&self) -> bool {
        self.agents.iter().any(AgentReport::failed)
    }

    fn status(&self, step: &Step) -> &'static str {
        match (step, self.applied) {
            (Step::Install, true) => "installed",
            (Step::Update, true) => "updated",
            (Step::Remove | Step::Retire(_), true) => "removed",
            (Step::Install, false) => "would_install",
            (Step::Update, false) => "would_update",
            (Step::Remove | Step::Retire(_), false) => "would_remove",
            (Step::Unchanged, _) => "unchanged",
            (Step::Absent, _) => "absent",
            (Step::Skip(_) | Step::Blocked(_), _) => "skipped",
            (Step::Fail(_), _) => "failed",
            (Step::NeedsSignIn(_), _) => "needs_sign_in",
        }
    }

    fn agent_status(&self, agent: &AgentReport) -> &'static str {
        if agent.failed() {
            "failed"
        } else if agent.needs_sign_in() {
            "needs_sign_in"
        } else if agent.changes() {
            if self.applied {
                "changed"
            } else {
                "would_change"
            }
        } else if !agent.items.is_empty()
            && agent
                .items
                .iter()
                .all(|i| matches!(i.step, Step::Skip(_) | Step::Blocked(_)))
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
                        if let Some(m) = i.step.message() {
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
        let mut report = json!({
            "server": server_json(self.server),
            "dryRun": self.dry_run,
            "remove": self.remove,
            "agents": agents,
        });
        if !self.notes.is_empty() {
            report["notes"] = json!(self.notes);
        }
        report
    }

    /// What the person does next, once the server is in place.
    fn next_step(&self, a: &AgentReport) -> Option<String> {
        let next = self.next_words(a)?;
        Some(if a.npx_missing {
            format!(
                "{next} `npx` is not on PATH, so the agent cannot start the local server yet: install Node.js, which brings npx."
            )
        } else {
            next.to_string()
        })
    }

    fn next_words(&self, a: &AgentReport) -> Option<&'static str> {
        if self.remove {
            return None;
        }
        if a.agent == Agent::Codex && a.needs_sign_in() {
            return Some(CODEX_SIGN_IN);
        }
        if !self.applied {
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
                "Restart Claude Desktop. It runs the local server, the only kind its config file runs, which starts in the agent sandbox until the agent connects your account (connect_account), or uses a connection saved before; for the remote server, add a custom connector with https://webhooks.cc/mcp under Settings, Connectors."
            }
            (Agent::Devin, Server::Remote) => {
                "Run `devin mcp login webhooks-cc` to sign in to webhooks.cc, then restart Devin Desktop."
            }
            (Agent::Devin, Server::Local) => {
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
            "needs_sign_in" => "needs sign-in",
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
                if let Some(m) = i.step.message() {
                    writeln!(out, "              {m}")?;
                }
            }
            if let Some(next) = self.next_step(a) {
                writeln!(out, "  Next: {next}")?;
            }
        }
        for note in &self.notes {
            writeln!(out, "\nNote: {note}")?;
        }
        Ok(())
    }
}

/// What Codex needs once it was left for the person to add.
const CODEX_SIGN_IN: &str = "In a terminal, run `codex mcp add webhooks-cc --url https://webhooks.cc/mcp`: Codex adds the server and opens your browser to sign in.";

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

/// An agent, whether it was found, whether it was named with `--agent`, and
/// what happens to each of its targets.
type Plan = (Agent, bool, bool, Vec<(Target, Step)>);

fn stopped_because(agent: Agent, step: &Step) -> String {
    match step {
        Step::Blocked(_) => format!(
            "not changed, because a config file of {} is read-only",
            agent.label()
        ),
        _ => format!("not changed, because of the failure for {}", agent.label()),
    }
}

/// Whether `dir` holds a SKILL.md of the skill that can be read, not any
/// entry: an empty directory or a dangling link gives an agent nothing.
fn readable_skill(dir: &Path) -> bool {
    let skill_md = dir.join(skill::NAME).join("SKILL.md");
    fs::metadata(&skill_md).is_ok_and(|m| m.is_file()) && fs::read(&skill_md).is_ok()
}

/// The skill directories Cursor and VS Code read besides their own:
/// `~/.agents/skills` and `~/.claude/skills` (cursor.com/docs/context/skills,
/// code.visualstudio.com/docs/copilot/customization/agent-skills; the
/// skills CLI installs both into `~/.agents/skills` for the same reason).
fn shared_skill_dirs(env: &Env) -> [PathBuf; 2] {
    [env.codex_skills(), env.home_claude_skills()]
}

/// What Cursor or VS Code is told about its own copy while it reads the
/// skill from `shared`: a second copy would load it twice.
fn read_elsewhere(agent: Agent, shared: &Path, env: &Env) -> Leave {
    let label = agent.label();
    let there = env.show(&shared.join(skill::NAME));
    Leave {
        reason: format!(
            "{label} reads the skill from {there} too, so it was not copied here as well"
        ),
        took_out: format!(
            "{label} reads the skill from {there} too, so whk took out the copy it added here before, which would load the skill twice"
        ),
        would_take_out: format!(
            "{label} reads the skill from {there} too, so whk would take out the copy it added here before, which would otherwise load the skill twice"
        ),
    }
}

/// The places in the plan of Cursor's and VS Code's skill, which
/// [`plan_skills_read_elsewhere`] changed and the apply decides again.
type Deferred = Vec<(usize, usize)>;

/// Cursor and VS Code get no copy of their own while a shared directory has
/// the skill or gets it in this run, and whk's own earlier copy there is
/// taken out. Only planned here, from what is there now and what the rest
/// of the plan writes; [`decide_skills_read_elsewhere`] decides again from
/// the directories once the rest is applied, since a copy the plan counted
/// on may not have been written.
fn plan_skills_read_elsewhere(plans: &mut [Plan], cx: &mut Cx) -> Deferred {
    let env = cx.env;
    let planned = |dir: &Path, plans: &[Plan]| {
        plans
            .iter()
            .flat_map(|p| &p.3)
            .find(|(t, _)| matches!(&t.kind, Kind::Skill { dir: d, .. } if d == dir))
            .map(|(_, step)| step.clone())
    };
    let mut copied_in_this_run = false;
    let Some(covering) = shared_skill_dirs(env)
        .into_iter()
        .find(|dir| match planned(dir, plans) {
            Some(Step::Install | Step::Update) => {
                copied_in_this_run = !readable_skill(dir);
                true
            }
            Some(step) if step.removes() => false,
            _ => readable_skill(dir),
        })
    else {
        return Vec::new();
    };
    let mut deferred = Vec::new();
    for (at, (agent, _, named, items)) in plans.iter_mut().enumerate() {
        if !matches!(agent, Agent::Cursor | Agent::Vscode) || items.iter().any(|(_, s)| s.stops()) {
            continue;
        }
        cx.named = *named;
        let leave = read_elsewhere(*agent, &covering, env);
        for (index, (target, step)) in items.iter_mut().enumerate() {
            let Kind::Skill { dir, .. } = &target.kind else {
                continue;
            };
            match step {
                Step::Install => {
                    *step = Step::Skip(if copied_in_this_run {
                        format!(
                            "{} reads the skill from {} too, which whk copies there, so it is not copied here as well",
                            agent.label(),
                            env.show(&covering.join(skill::NAME))
                        )
                    } else {
                        leave.reason.clone()
                    });
                }
                Step::Unchanged | Step::Update => {
                    let retire = skill_dir(&dir.join(skill::NAME), Some(&leave), cx, false);
                    if !matches!(retire, Step::Retire(_)) {
                        continue;
                    }
                    *step = retire;
                }
                _ => continue,
            }
            deferred.push((at, index));
        }
    }
    deferred
}

/// Notes for Cursor and VS Code when they are not in this run but have a
/// copy whk added, and this run writes the skill to a shared directory
/// they read too: they would load it twice until a run that includes them
/// takes their copy out.
fn left_for_a_full_run(
    plans: &[Plan],
    manifest: &Manifest,
    env: &Env,
    applied: bool,
) -> Vec<String> {
    let shared = shared_skill_dirs(env);
    let Some(written) =
        plans
            .iter()
            .flat_map(|p| &p.3)
            .find_map(|(target, step)| match &target.kind {
                Kind::Skill { dir, .. }
                    if matches!(step, Step::Install | Step::Update) && shared.contains(dir) =>
                {
                    Some(dir.join(skill::NAME))
                }
                _ => None,
            })
    else {
        return Vec::new();
    };
    let mut notes = Vec::new();
    for agent in [Agent::Cursor, Agent::Vscode] {
        if plans.iter().any(|p| p.0 == agent) {
            continue;
        }
        for target in targets(agent, Server::Remote, env) {
            let Kind::Skill { dir, .. } = &target.kind else {
                continue;
            };
            let own = dir.join(skill::NAME);
            if !target.recorded(manifest) || fs::symlink_metadata(&own).is_err() {
                continue;
            }
            let label = agent.label();
            let tidy = if env.detect(agent) {
                "a full run, `whk setup agent` without --agent, takes it out".to_string()
            } else {
                format!("`whk setup agent --agent {}` takes it out", agent.id())
            };
            let reads = if applied {
                "now reads"
            } else {
                "would then read"
            };
            notes.push(format!(
                "{label} {reads} the skill from {} as well as from the copy whk added at {}, so it loads the skill twice until that copy goes: {tidy}.",
                env.show(&written),
                env.show(&own),
            ));
        }
    }
    notes
}

/// Decides Cursor's and VS Code's skill again from the shared directories
/// as they are once the rest is applied: their own copy is skipped, or
/// whk's earlier one taken out, only when a shared copy is there to read;
/// otherwise it is what it would be without one.
fn decide_skills_read_elsewhere(
    plans: &mut [Plan],
    deferred: &Deferred,
    cx: &mut Cx,
    stopped: &[Option<String>],
    unrecorded: &mut Option<String>,
) {
    let env = cx.env;
    let covering = shared_skill_dirs(env)
        .into_iter()
        .find(|dir| readable_skill(dir));
    for &(at, index) in deferred {
        let (agent, _, named, items) = &mut plans[at];
        cx.named = *named;
        let leave = covering
            .as_ref()
            .map(|shared| read_elsewhere(*agent, shared, env));
        let (target, step) = &mut items[index];
        let Kind::Skill { dir, .. } = &target.kind else {
            continue;
        };
        let dir = dir.join(skill::NAME);
        let decided = skill_dir(&dir, leave.as_ref(), cx, false);
        if !decided.is_change() {
            *step = decided;
            continue;
        }
        if let Some(reason) = unrecorded.as_ref().or(stopped[at].as_ref()) {
            *step = Step::Skip(reason.clone());
            continue;
        }
        *step = skill_dir(&dir, leave.as_ref(), cx, true);
        record_after(step, cx, unrecorded);
    }
}

/// Saves the record after `step` was applied. When it cannot be saved, the
/// step becomes a failure saying so, and `unrecorded` stops the rest.
fn record_after(step: &mut Step, cx: &Cx, unrecorded: &mut Option<String>) {
    let Err(e) = cx.save() else {
        return;
    };
    let path = cx.store.map(Path::display).map(|p| p.to_string());
    let path = path.unwrap_or_default();
    let done = if step.is_change() {
        "the change was made"
    } else {
        "this may have been changed"
    };
    *step = Step::Fail(format!(
        "{done}, but whk could not save its record of it: {e}. Run this again once {path} can be written: it finds what whk wrote and records it, so --remove can take it out"
    ));
    *unrecorded = Some(format!(
        "not changed, because whk could not save its record in {path}"
    ));
}

/// Whether `name` is one whk gives a copy of the skill while it writes one
/// (`put_skill`): `.webhooks-cc.<16 hex digits>.whk-tmp` or `.whk-old`.
fn crash_leftover_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(&format!(".{}.", skill::NAME)) else {
        return false;
    };
    let Some(hex) = rest
        .strip_suffix(".whk-tmp")
        .or_else(|| rest.strip_suffix(".whk-old"))
    else {
        return false;
    };
    hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// How long a copy named as whk names its leftovers is left alone after it
/// last changed: it may be another run's, still writing.
const LEFTOVER_AGE: Duration = Duration::from_secs(10 * 60);

#[cfg(test)]
thread_local! {
    /// Moves the clock [`clear_crash_leftovers`] reads ahead, in tests.
    static CLOCK_AHEAD: std::cell::Cell<Duration> =
        const { std::cell::Cell::new(Duration::ZERO) };
}

#[cfg(test)]
fn leftover_clock() -> SystemTime {
    SystemTime::now() + CLOCK_AHEAD.with(std::cell::Cell::get)
}

#[cfg(not(test))]
fn leftover_clock() -> SystemTime {
    SystemTime::now()
}

/// Whether `path` last changed at least [`LEFTOVER_AGE`] before `now`. A
/// time that cannot be read, or one ahead of `now`, counts as recent.
fn old_enough(path: &Path, now: SystemTime) -> bool {
    fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age >= LEFTOVER_AGE)
}

/// Removes what a run that was ended while writing the skill left beside it
/// in `parent`: directories named as whk names them that hold only regular
/// files and have not changed for [`LEFTOVER_AGE`], so two runs at once
/// never delete each other's copy. A link, or a directory holding one or
/// anything stranger, is left as it is, and no link is followed.
fn clear_crash_leftovers(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let now = leftover_clock();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !crash_leftover_name(&name) || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        if !old_enough(&path, now) {
            continue;
        }
        if read_tree(&path).is_ok_and(|tree| {
            tree.odd.is_none()
                && tree
                    .files
                    .iter()
                    .all(|(file, _)| old_enough(&path.join(file), now))
        }) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Clears crash leftovers beside every skill directory of the plan.
fn clear_skill_leftovers(plans: &[Plan]) {
    for (target, _) in plans.iter().flat_map(|p| &p.3) {
        if let Kind::Skill { dir, .. } = &target.kind {
            clear_crash_leftovers(dir);
        }
    }
}

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

    // (agent, found on this machine, named with --agent)
    let mut chosen: Vec<(Agent, bool, bool)> = Vec::new();
    if opts.agents.is_empty() {
        for agent in Agent::ALL {
            let detected = env.detect(agent);
            // --remove also goes through what whk recorded, so copies for an
            // agent uninstalled since are taken out too.
            let recorded = opts.remove
                && [Server::Remote, Server::Local]
                    .into_iter()
                    .any(|s| targets(agent, s, env).iter().any(|t| t.recorded(&manifest)));
            if detected || recorded {
                chosen.push((agent, detected, false));
            }
        }
    } else {
        for agent in &opts.agents {
            if !chosen.iter().any(|(a, _, _)| a == agent) {
                chosen.push((*agent, env.detect(*agent), true));
            }
        }
    }

    // Plan: decide every target without changing anything. A target that
    // fails (or finds a read-only file) stops its agent.
    let mut plans: Vec<Plan> = Vec::new();
    let mut deferred: Deferred = Vec::new();
    {
        let mut cx = Cx {
            env,
            runner: &mut *runner,
            manifest: &mut manifest,
            remove: opts.remove,
            terminal: opts.terminal,
            named: false,
            store: None,
        };
        for (agent, detected, named) in &chosen {
            cx.named = *named;
            let mut items = Vec::new();
            let mut stop: Option<String> = None;
            for target in targets(*agent, server, env) {
                if target.only_if.as_ref().is_some_and(|dir| !dir.exists())
                    && !(opts.remove && target.recorded(cx.manifest))
                {
                    continue;
                }
                let step = process(&target, &mut cx, false);
                if step.stops() && stop.is_none() {
                    stop = Some(stopped_because(*agent, &step));
                }
                items.push((target, step));
            }
            if let Some(reason) = stop {
                for (_, step) in items.iter_mut() {
                    if step.is_change() {
                        *step = Step::Skip(reason.clone());
                    }
                }
            }
            plans.push((*agent, *detected, *named, items));
        }
        if !opts.remove {
            deferred = plan_skills_read_elsewhere(&mut plans, &mut cx);
        }
    }

    let npx_missing = env.which(LOCAL_COMMAND).is_none();
    let report_of = |plans: &[Plan], applied: bool, manifest: &Manifest| Report {
        server,
        remove: opts.remove,
        dry_run: opts.dry_run,
        applied,
        notes: if opts.remove {
            Vec::new()
        } else {
            left_for_a_full_run(plans, manifest, env, applied)
        },
        agents: plans
            .iter()
            .map(|(agent, detected, _, items)| {
                let agent_server = server_for(*agent, server);
                let npx_missing = npx_missing
                    && items.iter().any(|(t, s)| {
                        t.entry().is_some_and(runs_npx)
                            && matches!(s, Step::Install | Step::Update | Step::Unchanged)
                    });
                AgentReport {
                    agent: *agent,
                    detected: *detected,
                    server: agent_server,
                    items: items
                        .iter()
                        .map(|(t, s)| item_report(t, agent_server, env, opts.remove, s.clone()))
                        .collect(),
                    npx_missing,
                }
            })
            .collect(),
    };

    let changes = plans
        .iter()
        .flat_map(|(_, _, _, items)| items)
        .any(|(_, step)| step.is_change());
    if opts.dry_run {
        return Ok(report_of(&plans, false, &manifest));
    }
    if !changes {
        clear_skill_leftovers(&plans);
        // Records of what is gone, or notes of what turned out to be in
        // place, are all that changed.
        if manifest != before {
            manifest.save(&manifest_path)?;
        }
        return Ok(report_of(&plans, true, &manifest));
    }
    if !opts.yes {
        let names: Vec<&str> = plans
            .iter()
            .filter(|(_, _, _, items)| items.iter().any(|(_, s)| s.is_change()))
            .map(|(agent, _, _, _)| agent.label())
            .collect();
        let verb = if opts.remove {
            "Remove webhooks.cc from"
        } else {
            "Change the config of"
        };
        let question = format!("{verb} {}?", names.join(", "));
        gate(&report_of(&plans, false, &manifest), &question)?;
    }
    // A change whk could not record could not be removed later either.
    preflight(&manifest_path).map_err(|e| {
        anyhow!(
            "whk records what it sets up in {}, and could not write there ({e}), so nothing was changed; make it writable and run this again",
            manifest_path.display()
        )
    })?;
    clear_skill_leftovers(&plans);

    // Apply, saving the record after every change.
    {
        let mut cx = Cx {
            env,
            runner: &mut *runner,
            manifest: &mut manifest,
            remove: opts.remove,
            terminal: opts.terminal,
            named: false,
            store: Some(&manifest_path),
        };
        // Once the record cannot be saved, nothing else is changed.
        let mut unrecorded: Option<String> = None;
        let mut stopped: Vec<Option<String>> = vec![None; plans.len()];
        for (at, (agent, _, named, items)) in plans.iter_mut().enumerate() {
            cx.named = *named;
            for (index, (target, step)) in items.iter_mut().enumerate() {
                if !step.is_change() || deferred.contains(&(at, index)) {
                    continue;
                }
                if let Some(reason) = unrecorded.as_ref().or(stopped[at].as_ref()) {
                    *step = Step::Skip(reason.clone());
                    continue;
                }
                *step = process(target, &mut cx, true);
                record_after(step, &cx, &mut unrecorded);
                if step.stops() && stopped[at].is_none() {
                    stopped[at] = Some(stopped_because(*agent, step));
                }
            }
        }
        decide_skills_read_elsewhere(&mut plans, &deferred, &mut cx, &stopped, &mut unrecorded);
    }
    Ok(report_of(&plans, true, &manifest))
}

/// `whk setup agent`.
pub fn run(opts: Options, json: bool) -> Result<()> {
    let env = Env::from_process()?;
    let opts = Options {
        terminal: confirm::interactive(),
        ..opts
    };
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
