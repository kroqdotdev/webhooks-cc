//! Every test runs in a temporary home of its own, with `HOME`,
//! `XDG_CONFIG_HOME`, `APPDATA` and `PATH` pointing into it, and a fake in
//! place of `claude` and `codex`: nothing here reads or writes this
//! machine's real agent config.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::cli::confirm;
use crate::error::classify;

/// Stands in for `claude` and `codex`, keeping their state where the real
/// ones do (Claude Code's settings file) or in memory (Codex, which whk
/// only reads through `codex mcp get --json`).
struct Fake {
    claude_json: PathBuf,
    codex: Option<Value>,
    /// What `codex mcp get` fails with, as for a broken config.toml.
    codex_broken: Option<String>,
    /// What `codex mcp add --url` fails with after writing the entry, as
    /// when the sign-in in the browser does not finish.
    codex_sign_in_fails: Option<String>,
    /// `codex mcp add --url` writes the entry and then whk is ended, as by
    /// a Ctrl-C that reached it during the sign-in (a panic stands in).
    codex_add_ends_whk: bool,
    /// A directory `claude mcp add` makes read-only once it has added the
    /// entry, so the record cannot be saved after the change (Unix only).
    #[cfg_attr(not(unix), allow(dead_code))]
    lock_after_claude_add: Option<PathBuf>,
    calls: Vec<String>,
    /// The runs whose output goes to the person (Codex's sign-in).
    shown: Vec<String>,
}

fn fail(stderr: &str) -> io::Result<RunOutput> {
    Ok(RunOutput {
        success: false,
        stdout: String::new(),
        stderr: stderr.to_string(),
    })
}

fn ok(stdout: String) -> io::Result<RunOutput> {
    Ok(RunOutput {
        success: true,
        stdout,
        stderr: String::new(),
    })
}

impl Fake {
    fn claude_servers(&self) -> Map<String, Value> {
        fs::read_to_string(&self.claude_json)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["mcpServers"].as_object().cloned())
            .unwrap_or_default()
    }

    fn set_claude(&self, name: &str, entry: Option<Value>) {
        let mut root: Map<String, Value> = fs::read_to_string(&self.claude_json)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let servers = root
            .entry("mcpServers")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap();
        match entry {
            Some(entry) => servers.insert(name.to_string(), entry),
            None => servers.remove(name),
        };
        fs::create_dir_all(self.claude_json.parent().unwrap()).unwrap();
        fs::write(
            &self.claude_json,
            serde_json::to_string_pretty(&Value::Object(root)).unwrap(),
        )
        .unwrap();
    }
}

impl Runner for Fake {
    fn run(&mut self, program: &Path, args: &[String], show: bool) -> io::Result<RunOutput> {
        let name = program.file_name().unwrap().to_string_lossy().into_owned();
        self.calls.push(format!("{name} {}", args.join(" ")));
        if show {
            self.shown.push(format!("{name} {}", args.join(" ")));
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let after_dashes = |args: &[&str]| -> Vec<String> {
            let at = args.iter().position(|a| *a == "--").unwrap();
            args[at + 1..].iter().map(|a| a.to_string()).collect()
        };
        match (name.as_str(), args.as_slice()) {
            (
                "claude",
                [
                    "mcp",
                    "add",
                    "-s",
                    "user",
                    "--transport",
                    transport,
                    name,
                    rest @ ..,
                ],
            ) => {
                if self.claude_servers().contains_key(*name) {
                    return fail(&format!("MCP server {name} already exists in user config"));
                }
                let entry = if *transport == "http" {
                    json!({ "type": "http", "url": rest[0] })
                } else {
                    let command = after_dashes(&args);
                    json!({ "type": "stdio", "command": command[0], "args": command[1..], "env": {} })
                };
                self.set_claude(name, Some(entry));
                #[cfg(unix)]
                if let Some(dir) = &self.lock_after_claude_add {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
                }
                ok(String::new())
            }
            ("claude", ["mcp", "remove", "-s", "user", name]) => {
                if !self.claude_servers().contains_key(*name) {
                    return fail("No user-scoped MCP server found");
                }
                self.set_claude(name, None);
                ok(String::new())
            }
            ("codex", ["mcp", "get", _, "--json"]) => {
                if let Some(error) = &self.codex_broken {
                    return fail(error);
                }
                match &self.codex {
                    Some(value) => ok(value.to_string()),
                    None => fail("Error: No MCP server named 'webhooks-cc' found."),
                }
            }
            ("codex", ["mcp", "add", name, "--url", url]) => {
                self.codex = Some(json!({
                    "name": name,
                    "enabled": true,
                    "transport": {
                        "type": "streamable_http", "url": url, "bearer_token_env_var": null,
                        "http_headers": null, "env_http_headers": null, "http_headers_helper": null
                    },
                    "enabled_tools": null, "startup_timeout_sec": null
                }));
                if self.codex_add_ends_whk {
                    panic!("whk was ended during the sign-in");
                }
                match &self.codex_sign_in_fails {
                    Some(error) => fail(error),
                    None => ok(String::new()),
                }
            }
            ("codex", ["mcp", "add", name, "--", ..]) => {
                let command = after_dashes(&args);
                self.codex = Some(json!({
                    "name": name,
                    "enabled": true,
                    "transport": {
                        "type": "stdio", "command": command[0], "args": command[1..],
                        "env": null, "env_vars": [], "cwd": null
                    }
                }));
                ok(String::new())
            }
            ("codex", ["mcp", "remove", _]) => {
                self.codex = None;
                ok(String::new())
            }
            _ => panic!("unexpected command: {name} {args:?}"),
        }
    }
}

struct Home {
    dir: PathBuf,
    env: Env,
    fake: Fake,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A Linux home with `claude` and `codex` on its PATH.
fn home(name: &str) -> Home {
    let dir = std::env::temp_dir().join(format!("whk-setup-{name}-{:x}", rand::random::<u64>()));
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    for program in ["claude", "codex"] {
        fs::write(bin.join(program), "").unwrap();
    }
    let vars: HashMap<String, String> = [
        ("HOME", dir.display().to_string()),
        ("XDG_CONFIG_HOME", dir.join("xdg").display().to_string()),
        ("APPDATA", dir.join("appdata").display().to_string()),
        ("PATH", bin.display().to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let env = Env {
        os: Os::Linux,
        home: dir.clone(),
        vars,
    };
    let fake = Fake {
        claude_json: env.claude_json(),
        codex: None,
        codex_broken: None,
        codex_sign_in_fails: None,
        codex_add_ends_whk: false,
        lock_after_claude_add: None,
        calls: Vec::new(),
        shown: Vec::new(),
    };
    Home { dir, env, fake }
}

fn opts(agent: Agent) -> Options {
    Options {
        agents: vec![agent],
        ..Options::default()
    }
}

fn yes(mut o: Options) -> Options {
    o.yes = true;
    o
}

/// As run by a person at a terminal, who can sign in to Codex. The gate in
/// [`run`] still answers as without one, so these pass `--yes` too.
fn tty(mut o: Options) -> Options {
    o.terminal = true;
    o
}

/// Runs the command as it runs without a terminal.
fn run(h: &mut Home, o: &Options) -> Result<Report> {
    execute(o, &h.env, &mut h.fake, &mut |_, question| {
        confirm::decide(question, false, || {
            panic!("must not ask without a terminal")
        })
    })
}

/// Every file under the home, except the fake programs.
fn snapshot(h: &Home) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.insert(path.clone(), fs::read(&path).unwrap_or_default());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(&h.dir, &mut out);
    out.retain(|path, _| !path.starts_with(h.dir.join("bin")));
    out
}

/// Where the agent's server entry lives, and what it is now.
fn mcp_entry(h: &Home, agent: Agent) -> Option<Value> {
    let from_file = |path: PathBuf, key: &str| -> Option<Value> {
        let root: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        root.get(key)?.get(SERVER_NAME).cloned()
    };
    match agent {
        Agent::ClaudeCode => h.fake.claude_servers().get(SERVER_NAME).cloned(),
        Agent::Codex => h.fake.codex.as_ref().map(codex_entry),
        Agent::ClaudeDesktop => from_file(h.env.claude_desktop_config(), "mcpServers"),
        Agent::Cursor => from_file(h.env.cursor_config(), "mcpServers"),
        Agent::Vscode => from_file(h.env.vscode_config(), "servers"),
        Agent::Devin => from_file(h.env.devin_config(), "mcpServers"),
    }
}

fn expected_entry(agent: Agent, server: Server) -> Value {
    let remote = server_for(agent, server) == Server::Remote;
    match agent {
        Agent::ClaudeCode | Agent::Codex | Agent::Vscode => {
            if remote {
                remote_entry()
            } else {
                local_entry()
            }
        }
        Agent::Devin if remote => devin_remote_entry(),
        _ => {
            if remote {
                json!({ "url": REMOTE_URL })
            } else {
                json!({ "command": "npx", "args": ["-y", "@webhooks-cc/mcp"] })
            }
        }
    }
}

/// The agent's skill directory, for the agents that take one.
fn skill_path(h: &Home, agent: Agent) -> Option<PathBuf> {
    let x = &h.dir;
    Some(match agent {
        Agent::ClaudeCode => x.join(".claude/skills/webhooks-cc"),
        Agent::Cursor => x.join(".cursor/skills/webhooks-cc"),
        Agent::Vscode => x.join(".copilot/skills/webhooks-cc"),
        Agent::Codex => x.join(".agents/skills/webhooks-cc"),
        Agent::Devin => x.join("xdg/devin/skills/webhooks-cc"),
        Agent::ClaudeDesktop => return None,
    })
}

/// Text with `/` for every path separator, so a rendered path compares
/// the same on Windows, where joined paths use backslashes.
fn slashes(text: &str) -> String {
    text.replace('\\', "/")
}

fn steps(report: &Report) -> Vec<Step> {
    report.agents[0]
        .items
        .iter()
        .map(|i| i.step.clone())
        .collect()
}

fn skill_is_embedded(dir: &Path) {
    for (rel, text) in skill::FILES {
        assert_eq!(
            fs::read_to_string(dir.join(rel)).unwrap(),
            *text,
            "{rel} in {}",
            dir.display()
        );
    }
}

#[test]
fn installs_every_agent_then_changes_nothing_then_removes_it_all() {
    for agent in Agent::ALL {
        let mut h = home(agent.id());
        let before = snapshot(&h);

        let report = run(&mut h, &yes(tty(opts(agent)))).unwrap();
        assert!(!report.failed(), "{agent:?}: {report:?}");
        assert!(
            steps(&report).iter().all(|s| *s == Step::Install),
            "{agent:?}: {:?}",
            steps(&report)
        );
        assert_eq!(
            report.to_json()["agents"][0]["status"],
            "changed",
            "{agent:?}"
        );
        assert_eq!(
            prune(&mcp_entry(&h, agent).expect("installed")),
            prune(&expected_entry(agent, Server::Remote)),
            "{agent:?}"
        );
        if let Some(dir) = skill_path(&h, agent) {
            skill_is_embedded(&dir);
        }
        assert!(h.env.manifest_path().exists());
        // No backup of a file whk made itself.
        assert!(
            snapshot(&h)
                .keys()
                .all(|p| !p.to_string_lossy().ends_with(".bak")),
            "{agent:?}"
        );

        // A re-run changes nothing and says so.
        let installed = snapshot(&h);
        let calls = h.fake.calls.len();
        let report = run(&mut h, &tty(opts(agent))).unwrap();
        assert!(
            steps(&report).iter().all(|s| *s == Step::Unchanged),
            "{agent:?}: {:?}",
            steps(&report)
        );
        assert_eq!(report.to_json()["agents"][0]["status"], "unchanged");
        assert_eq!(snapshot(&h), installed, "{agent:?}");
        assert!(
            h.fake.calls[calls..].iter().all(|c| c.contains(" get ")),
            "{agent:?} ran {:?}",
            &h.fake.calls[calls..]
        );

        // --remove takes out exactly that.
        let report = run(
            &mut h,
            &yes(Options {
                remove: true,
                ..opts(agent)
            }),
        )
        .unwrap();
        assert!(
            steps(&report).iter().all(|s| *s == Step::Remove),
            "{agent:?}: {:?}",
            steps(&report)
        );
        assert_eq!(mcp_entry(&h, agent), None, "{agent:?}");
        if let Some(dir) = skill_path(&h, agent) {
            assert!(!dir.exists(), "{agent:?}");
        }
        assert!(!h.env.manifest_path().exists(), "{agent:?}");
        let mut left = snapshot(&h);
        // Claude Code's own settings file is Claude Code's, emptied by its
        // own `mcp remove`.
        left.remove(&h.env.claude_json());
        assert_eq!(left, before, "{agent:?} left files behind");

        let report = run(&mut h, &opts(agent).clone_with_remove()).unwrap();
        assert!(steps(&report).iter().all(|s| *s == Step::Absent));
    }
}

impl Options {
    fn clone_with_remove(&self) -> Options {
        Options {
            remove: true,
            ..self.clone()
        }
    }
}

#[test]
fn the_agents_own_commands_are_run_with_their_flags() {
    let mut h = home("commands");
    run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
    assert_eq!(
        h.fake.calls,
        [
            "claude mcp add -s user --transport http webhooks-cc https://webhooks.cc/mcp",
            "codex mcp get webhooks-cc --json",
            "codex mcp get webhooks-cc --json",
            "codex mcp add webhooks-cc --url https://webhooks.cc/mcp",
        ]
    );

    // Switching to the local server replaces whk's own entry.
    h.fake.calls.clear();
    let local = |agent| Options {
        local: true,
        ..yes(opts(agent))
    };
    let report = run(&mut h, &local(Agent::ClaudeCode)).unwrap();
    assert_eq!(steps(&report)[0], Step::Update);
    run(&mut h, &local(Agent::Codex)).unwrap();
    assert_eq!(
        h.fake.calls,
        [
            "claude mcp remove -s user webhooks-cc",
            "claude mcp add -s user --transport stdio webhooks-cc -- npx -y @webhooks-cc/mcp",
            "codex mcp get webhooks-cc --json",
            "codex mcp get webhooks-cc --json",
            "codex mcp add webhooks-cc -- npx -y @webhooks-cc/mcp",
        ]
    );
    assert_eq!(prune(&mcp_entry(&h, Agent::Codex).unwrap()), local_entry());
}

#[test]
fn a_dry_run_writes_nothing_and_says_what_it_would_do() {
    for agent in Agent::ALL {
        let mut h = home(&format!("dry-{}", agent.id()));
        let before = snapshot(&h);
        let report = run(
            &mut h,
            &Options {
                dry_run: true,
                ..tty(opts(agent))
            },
        )
        .unwrap();
        assert!(steps(&report).iter().all(|s| *s == Step::Install));
        let json = report.to_json();
        assert_eq!(json["dryRun"], true);
        assert_eq!(json["agents"][0]["status"], "would_change");
        assert_eq!(json["agents"][0]["items"][0]["status"], "would_install");
        assert_eq!(snapshot(&h), before, "{agent:?}");
        assert!(!h.env.manifest_path().exists());
        assert!(h.fake.calls.iter().all(|c| c.contains(" get ")));
    }
}

#[test]
fn without_a_terminal_nothing_changes_unless_yes_is_given() {
    for agent in Agent::ALL {
        let mut h = home(&format!("tty-{}", agent.id()));
        let before = snapshot(&h);
        let error = run(&mut h, &opts(agent)).unwrap_err();
        let c = classify(&error);
        assert_eq!((c.code, c.exit), ("confirmation_required", 9), "{agent:?}");
        assert!(error.to_string().contains(agent.label()));
        assert_eq!(snapshot(&h), before, "{agent:?}");
        assert!(h.fake.calls.iter().all(|c| c.contains(" get ")));

        // Removing asks too.
        run(&mut h, &yes(opts(agent))).unwrap();
        let installed = snapshot(&h);
        let error = run(&mut h, &opts(agent).clone_with_remove()).unwrap_err();
        assert_eq!(classify(&error).code, "confirmation_required");
        assert_eq!(snapshot(&h), installed, "{agent:?}");
    }
}

#[test]
fn without_a_terminal_codex_is_left_to_sign_in_and_still_gets_the_skill() {
    let mut h = home("codex-sign-in");
    let report = run(&mut h, &yes(opts(Agent::Codex))).unwrap();
    assert!(!report.failed());
    let Step::NeedsSignIn(message) = &steps(&report)[0] else {
        panic!("{:?}", steps(&report));
    };
    let add = "codex mcp add webhooks-cc --url https://webhooks.cc/mcp";
    assert!(message.contains(add), "{message}");
    assert_eq!(steps(&report)[1], Step::Install);
    // Codex was only read, never asked to add (which would wait to sign in).
    assert_eq!(h.fake.calls, ["codex mcp get webhooks-cc --json"]);
    assert_eq!(h.fake.codex, None);
    skill_is_embedded(&skill_path(&h, Agent::Codex).unwrap());

    let json = report.to_json();
    let agent = &json["agents"][0];
    assert_eq!(agent["agent"], "codex");
    assert_eq!(agent["status"], "needs_sign_in");
    assert_eq!(agent["server"]["kind"], "remote");
    assert_eq!(
        agent["items"][0],
        json!({
            "what": "mcp",
            "status": "needs_sign_in",
            "command": add,
            "message": message,
        })
    );
    assert_eq!(agent["items"][1]["status"], "installed");
    let next = agent["next"].as_str().unwrap();
    assert!(next.contains(add), "{next}");
    assert!(!next.contains("login"), "{next}");

    let mut text = Vec::new();
    report.write_text(&h.env, &mut text).unwrap();
    let text = String::from_utf8(text).unwrap();
    assert!(text.contains("needs sign-in"), "{text}");
    assert!(text.contains(&format!("Next: {CODEX_SIGN_IN}")), "{text}");

    // A dry run says the same, and asks for nothing.
    let dry = run(
        &mut h,
        &Options {
            dry_run: true,
            ..opts(Agent::Codex)
        },
    )
    .unwrap();
    assert!(matches!(steps(&dry)[0], Step::NeedsSignIn(_)));
    assert_eq!(dry.to_json()["agents"][0]["status"], "needs_sign_in");
    assert_eq!(dry.to_json()["agents"][0]["next"], CODEX_SIGN_IN);

    // A re-run leaves the skill and asks for nothing: only the sign-in is
    // left, so it needs no --yes.
    let report = run(&mut h, &opts(Agent::Codex)).unwrap();
    assert!(matches!(steps(&report)[0], Step::NeedsSignIn(_)));
    assert_eq!(steps(&report)[1], Step::Unchanged);

    // The local server is a choice, never made for the person.
    assert!(h.fake.calls.iter().all(|c| !c.contains("npx")));

    // --remove takes out the skill; Codex has nothing of whk's to remove,
    // and it is never told to sign in for that.
    h.fake.calls.clear();
    let report = run(&mut h, &yes(opts(Agent::Codex)).clone_with_remove()).unwrap();
    assert!(!report.failed());
    assert_eq!(steps(&report), [Step::Absent, Step::Remove]);
    let json = report.to_json();
    assert_eq!(json["agents"][0]["status"], "changed");
    assert_eq!(json["agents"][0]["next"], Value::Null);
    assert!(!skill_path(&h, Agent::Codex).unwrap().exists());
    assert!(!h.env.manifest_path().exists());
    assert!(h.fake.calls.iter().all(|c| c.contains(" get ")));
}

#[test]
fn without_a_terminal_codex_keeps_its_local_server_until_the_person_signs_in() {
    // Moving from --local to the remote server would sign in too, so the
    // local entry stays as it is and the person is told what to run.
    let mut h = home("codex-local-to-remote");
    let local = Options {
        local: true,
        ..yes(opts(Agent::Codex))
    };
    run(&mut h, &local).unwrap();
    assert_eq!(prune(&mcp_entry(&h, Agent::Codex).unwrap()), local_entry());
    // The local server needs no sign-in, so it is added without a terminal.
    assert!(
        h.fake
            .calls
            .contains(&"codex mcp add webhooks-cc -- npx -y @webhooks-cc/mcp".to_string())
    );

    h.fake.calls.clear();
    let report = run(&mut h, &yes(opts(Agent::Codex))).unwrap();
    assert!(matches!(steps(&report)[0], Step::NeedsSignIn(_)));
    assert_eq!(prune(&mcp_entry(&h, Agent::Codex).unwrap()), local_entry());
    assert!(h.fake.calls.iter().all(|c| c.contains(" get ")));

    // At a terminal the same run replaces it, and Codex signs in.
    let report = run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
    assert_eq!(steps(&report)[0], Step::Update);
    assert_eq!(prune(&mcp_entry(&h, Agent::Codex).unwrap()), remote_entry());
    assert!(
        report.to_json()["agents"][0]["next"]
            .as_str()
            .unwrap()
            .contains("codex mcp login webhooks-cc")
    );

    // And --remove then takes it out, at a terminal or not.
    let report = run(&mut h, &yes(opts(Agent::Codex)).clone_with_remove()).unwrap();
    assert_eq!(steps(&report), [Step::Remove, Step::Remove]);
    assert_eq!(h.fake.codex, None);
}

#[test]
fn at_a_terminal_codex_is_added_and_shown_to_the_person() {
    let mut h = home("codex-tty");
    let report = run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
    assert_eq!(steps(&report), [Step::Install, Step::Install]);
    assert_eq!(
        h.fake.shown,
        ["codex mcp add webhooks-cc --url https://webhooks.cc/mcp"]
    );
    let json = report.to_json();
    assert_eq!(json["agents"][0]["status"], "changed");
    assert_eq!(json["agents"][0]["items"][0]["status"], "installed");
}

#[test]
fn a_config_file_that_is_not_json_is_left_alone_and_stops_its_agent() {
    for agent in Agent::ALL {
        let mut h = home(&format!("bad-{}", agent.id()));
        let broken = "{ \"mcpServers\": { // a comment\n } }\n";
        let file = match agent {
            Agent::ClaudeCode => Some(h.env.claude_json()),
            Agent::Codex => {
                h.fake.codex_broken =
                    Some("Error: failed to parse config.toml: expected `=`".into());
                None
            }
            Agent::ClaudeDesktop => Some(h.env.claude_desktop_config()),
            Agent::Cursor => Some(h.env.cursor_config()),
            Agent::Vscode => Some(h.env.vscode_config()),
            Agent::Devin => Some(h.env.devin_config()),
        };
        if let Some(file) = &file {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, broken).unwrap();
        }
        let before = snapshot(&h);
        let report = run(&mut h, &yes(opts(agent))).unwrap();
        assert!(report.failed(), "{agent:?}");
        let json = report.to_json();
        assert_eq!(json["agents"][0]["status"], "failed");
        let message = json["agents"][0]["items"][0]["message"].as_str().unwrap();
        match &file {
            Some(file) => assert!(
                message.contains(&file.display().to_string()) && message.contains("not valid JSON"),
                "{message}"
            ),
            None => assert!(message.contains("config.toml"), "{message}"),
        }
        // Nothing of that agent changed, the skill included.
        for item in &report.agents[0].items[1..] {
            assert!(matches!(item.step, Step::Skip(_)), "{agent:?}: {item:?}");
        }
        assert_eq!(snapshot(&h), before, "{agent:?}");
        assert!(h.fake.calls.iter().all(|c| c.contains(" get ")));
    }
}

#[test]
fn other_servers_and_key_order_stay_and_one_backup_is_kept() {
    let mut h = home("merge");
    let path = h.env.cursor_config();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original =
        "{\"zeta\": 1, \"mcpServers\": {\"other\": {\"command\": \"x\"}}, \"alpha\": true}";
    fs::write(&path, original).unwrap();

    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["zeta", "mcpServers", "alpha"]);
    assert_eq!(value["mcpServers"]["other"], json!({ "command": "x" }));
    assert_eq!(
        value["mcpServers"]["webhooks-cc"],
        json!({ "url": REMOTE_URL })
    );
    let backup = backup_path(&path);
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);

    // A second change keeps the first backup.
    let report = run(
        &mut h,
        &Options {
            local: true,
            ..yes(opts(Agent::Cursor))
        },
    )
    .unwrap();
    assert_eq!(steps(&report)[0], Step::Update);
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);

    // Removing leaves the rest of the file.
    run(&mut h, &yes(opts(Agent::Cursor).clone_with_remove())).unwrap();
    let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(value["mcpServers"], json!({ "other": { "command": "x" } }));
    assert_eq!(value["zeta"], 1);
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);
}

#[test]
fn an_entry_whk_did_not_write_is_never_replaced_or_removed() {
    let mut h = home("foreign");
    let path = h.env.cursor_config();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let theirs = json!({ "mcpServers": { "webhooks-cc": {
        "command": "npx", "args": ["-y", "@webhooks-cc/mcp"], "env": { "WHK_API_KEY": "whcc_test" }
    } } });
    fs::write(&path, theirs.to_string()).unwrap();
    let before = fs::read_to_string(&path).unwrap();

    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let Step::Skip(message) = &steps(&report)[0] else {
        panic!("{:?}", steps(&report));
    };
    assert!(message.contains("did not write"), "{message}");
    assert_eq!(fs::read_to_string(&path).unwrap(), before);

    // --remove says it is there and not whk's, rather than not there.
    let report = run(&mut h, &yes(opts(Agent::Cursor).clone_with_remove())).unwrap();
    let message = message_of(&steps(&report)[0]);
    assert!(message.contains("not written by whk"), "{message}");
    assert_eq!(
        report.to_json()["agents"][0]["items"][0]["status"],
        "skipped"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}

#[test]
fn what_is_already_in_place_is_left_and_never_removed() {
    let mut h = home("in-place");
    h.fake.set_claude(
        SERVER_NAME,
        Some(json!({ "type": "http", "url": REMOTE_URL })),
    );
    let dir = skill_path(&h, Agent::ClaudeCode).unwrap();
    for (rel, text) in skill::FILES {
        fs::create_dir_all(dir.join(rel).parent().unwrap()).unwrap();
        fs::write(dir.join(rel), text).unwrap();
    }
    let report = run(&mut h, &opts(Agent::ClaudeCode)).unwrap();
    assert_eq!(steps(&report), [Step::Unchanged, Step::Unchanged]);
    assert!(!h.env.manifest_path().exists());

    let report = run(&mut h, &yes(opts(Agent::ClaudeCode).clone_with_remove())).unwrap();
    for step in steps(&report) {
        let message = message_of(&step);
        assert!(matches!(step, Step::Skip(_)), "{step:?}");
        assert!(message.contains("not written by whk"), "{message}");
    }
    assert_eq!(report.to_json()["agents"][0]["status"], "skipped");
    assert!(mcp_entry(&h, Agent::ClaudeCode).is_some());
    skill_is_embedded(&dir);
    assert!(h.fake.calls.is_empty());
}

#[test]
fn someone_elses_skill_is_left_alone() {
    let mut h = home("their-skill");
    let dir = skill_path(&h, Agent::Cursor).unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), "---\nname: webhooks-cc\n---\nmine\n").unwrap();
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[0], Step::Install);
    assert!(matches!(steps(&report)[1], Step::Skip(_)));
    assert_eq!(
        fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "---\nname: webhooks-cc\n---\nmine\n"
    );
}

#[cfg(unix)]
#[test]
fn a_linked_skill_from_npx_skills_add_counts_as_in_place() {
    let mut h = home("linked");
    let canonical = h.dir.join(".agents/skills/webhooks-cc");
    for (rel, text) in skill::FILES {
        fs::create_dir_all(canonical.join(rel).parent().unwrap()).unwrap();
        fs::write(canonical.join(rel), text).unwrap();
    }
    let dir = skill_path(&h, Agent::Cursor).unwrap();
    fs::create_dir_all(dir.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&canonical, &dir).unwrap();
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[1], Step::Unchanged);
    let report = run(&mut h, &yes(opts(Agent::Cursor).clone_with_remove())).unwrap();
    assert!(
        message_of(&steps(&report)[1]).contains("not written by whk"),
        "{:?}",
        steps(&report)
    );
    assert!(fs::symlink_metadata(&dir).unwrap().file_type().is_symlink());
    skill_is_embedded(&canonical);
}

#[test]
fn an_older_skill_whk_wrote_is_brought_up_to_date() {
    let mut h = home("old-skill");
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let dir = skill_path(&h, Agent::Cursor).unwrap();
    // As an older whk would have left it, and recorded it.
    fs::write(dir.join("SKILL.md"), "old\n").unwrap();
    fs::write(dir.join("references/gone.md"), "gone\n").unwrap();
    let path = h.env.manifest_path();
    let mut manifest: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let files = &mut manifest["skills"][dir.display().to_string()];
    files["SKILL.md"] = json!(sha256(b"old\n"));
    files["references/gone.md"] = json!(sha256(b"gone\n"));
    fs::write(&path, manifest.to_string()).unwrap();

    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[1], Step::Update);
    skill_is_embedded(&dir);
    assert!(!dir.join("references/gone.md").exists());

    // Edited by hand since: left as it is.
    fs::write(dir.join("SKILL.md"), "edited\n").unwrap();
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(matches!(steps(&report)[1], Step::Skip(_)));
    let report = run(&mut h, &yes(opts(Agent::Cursor).clone_with_remove())).unwrap();
    assert!(matches!(steps(&report)[1], Step::Skip(_)));
    assert_eq!(
        fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "edited\n"
    );
}

#[test]
fn the_claude_code_plugin_brings_the_server_and_the_skill_itself() {
    let mut h = home("plugin");
    // whk set Claude Code up before the plugin was installed.
    run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    let plugins = h.dir.join(".claude/plugins");
    fs::create_dir_all(&plugins).unwrap();
    fs::write(
        plugins.join("installed_plugins.json"),
        // With a byte order mark, which is still JSON to read.
        format!(
            "\u{feff}{}",
            json!({ "version": 2, "plugins": { "webhooks-cc@webhooks-cc": [{ "scope": "user" }] } })
        ),
    )
    .unwrap();

    let mut h2 = home("plugin-fresh");
    fs::create_dir_all(h2.dir.join(".claude/plugins")).unwrap();
    fs::copy(
        plugins.join("installed_plugins.json"),
        h2.dir.join(".claude/plugins/installed_plugins.json"),
    )
    .unwrap();
    let report = run(&mut h2, &yes(opts(Agent::ClaudeCode))).unwrap();
    let both = steps(&report);
    let [Step::Skip(server), Step::Skip(skill)] = both.as_slice() else {
        panic!("{both:?}");
    };
    // The same reason for both: the plugin's own server would double every tool.
    assert_eq!(server, skill);
    assert_eq!(server, PLUGIN_REASON);
    assert!(h2.fake.calls.is_empty(), "{:?}", h2.fake.calls);
    assert_eq!(mcp_entry(&h2, Agent::ClaudeCode), None);
    assert!(!skill_path(&h2, Agent::ClaudeCode).unwrap().exists());
    assert_eq!(report.to_json()["agents"][0]["status"], "skipped");

    // What whk added before the plugin: its server entry would list every
    // tool twice beside the plugin's, and its skill would load twice, so a
    // plain run takes both out and says so.
    let dry = run(
        &mut h,
        &Options {
            dry_run: true,
            ..opts(Agent::ClaudeCode)
        },
    )
    .unwrap();
    assert!(
        matches!(steps(&dry)[0], Step::Retire(_)),
        "{:?}",
        steps(&dry)
    );
    for item in 0..2 {
        assert_eq!(
            dry.to_json()["agents"][0]["items"][item]["status"],
            "would_remove"
        );
        // A dry run says what whk would do, not what it did.
        let message = message_of(&steps(&dry)[item]);
        assert!(message.contains("whk would take out"), "{message}");
        assert!(!message.contains("took out"), "{message}");
    }
    assert!(matches!(steps(&dry)[1], Step::Retire(_)));
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    let Step::Retire(message) = &steps(&report)[0] else {
        panic!("{:?}", steps(&report));
    };
    assert!(
        message.contains("plugin") && message.contains("twice") && message.contains("took out"),
        "{message}"
    );
    let Step::Retire(skill_message) = &steps(&report)[1] else {
        panic!("{:?}", steps(&report));
    };
    assert!(
        skill_message.contains("plugin") && skill_message.contains("took out the copy"),
        "{skill_message}"
    );
    assert!(!skill_path(&h, Agent::ClaudeCode).unwrap().exists());
    let json = report.to_json();
    assert_eq!(json["agents"][0]["items"][0]["status"], "removed");
    assert_eq!(json["agents"][0]["items"][1]["status"], "removed");
    assert_eq!(json["agents"][0]["items"][0]["message"], message.as_str());
    assert_eq!(json["agents"][0]["status"], "changed");
    assert_eq!(mcp_entry(&h, Agent::ClaudeCode), None);
    assert!(
        h.fake
            .calls
            .contains(&"claude mcp remove -s user webhooks-cc".to_string())
    );
    // Then there is nothing of whk's in Claude Code's config to take out.
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    assert_eq!(
        steps(&report),
        [
            Step::Skip(PLUGIN_REASON.to_string()),
            Step::Skip(PLUGIN_REASON.to_string())
        ]
    );
    assert!(!h.env.manifest_path().exists());

    // An entry changed since whk wrote it is the person's, plugin or not.
    let mut h3 = home("plugin-changed");
    run(&mut h3, &yes(opts(Agent::ClaudeCode))).unwrap();
    h3.fake.set_claude(
        SERVER_NAME,
        Some(json!({ "type": "http", "url": REMOTE_URL, "headers": { "X": "1" } })),
    );
    write_file(
        &h3.dir.join(".claude/plugins/installed_plugins.json"),
        &fs::read_to_string(plugins.join("installed_plugins.json")).unwrap(),
    );
    // So is a skill changed since, which the plugin does not take out.
    let skill = skill_path(&h3, Agent::ClaudeCode).unwrap();
    fs::write(skill.join("SKILL.md"), "mine\n").unwrap();
    let report = run(&mut h3, &yes(opts(Agent::ClaudeCode))).unwrap();
    assert_eq!(
        steps(&report),
        [
            Step::Skip(PLUGIN_REASON.to_string()),
            Step::Skip(PLUGIN_REASON.to_string())
        ]
    );
    assert!(mcp_entry(&h3, Agent::ClaudeCode).is_some());
    assert_eq!(
        fs::read_to_string(skill.join("SKILL.md")).unwrap(),
        "mine\n"
    );

    // --remove takes out what is left of whk's: nothing here.
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode)).clone_with_remove()).unwrap();
    assert_eq!(steps(&report), [Step::Absent, Step::Absent]);
    assert!(!h.env.manifest_path().exists());
}

#[test]
fn without_agent_only_the_agents_found_are_set_up() {
    let mut h = home("detect");
    h.env.vars.insert("PATH".into(), String::new());
    let report = run(
        &mut h,
        &Options {
            dry_run: true,
            ..Options::default()
        },
    )
    .unwrap();
    assert!(report.agents.is_empty());

    fs::create_dir_all(h.dir.join(".cursor")).unwrap();
    fs::create_dir_all(h.dir.join(".codex")).unwrap();
    fs::create_dir_all(h.dir.join("xdg/devin")).unwrap();
    let report = run(
        &mut h,
        &Options {
            dry_run: true,
            ..Options::default()
        },
    )
    .unwrap();
    let found: Vec<Agent> = report.agents.iter().map(|a| a.agent).collect();
    assert_eq!(found, [Agent::Cursor, Agent::Codex, Agent::Devin]);

    // A program on PATH counts too.
    h.env
        .vars
        .insert("PATH".into(), h.dir.join("bin").display().to_string());
    let found: Vec<Agent> = Agent::ALL
        .into_iter()
        .filter(|a| h.env.detect(*a))
        .collect();
    assert_eq!(
        found,
        [Agent::ClaudeCode, Agent::Cursor, Agent::Codex, Agent::Devin]
    );
}

#[test]
fn a_named_agent_without_its_program_fails_with_the_command_to_run() {
    let mut h = home("no-claude");
    h.env.vars.insert("PATH".into(), String::new());
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    assert!(report.failed());
    assert!(!report.agents[0].detected);
    let Step::Fail(message) = &steps(&report)[0] else {
        panic!("{:?}", steps(&report));
    };
    assert!(message.contains("not on PATH"));
    assert!(message.contains("claude mcp add -s user --transport http webhooks-cc"));
    assert!(!skill_path(&h, Agent::ClaudeCode).unwrap().exists());
}

#[test]
fn windsurf_from_before_the_rename_is_updated_only_where_it_is_installed() {
    let mut h = home("windsurf");
    run(&mut h, &yes(opts(Agent::Devin))).unwrap();
    assert!(!h.dir.join(".codeium").exists());

    let mut h = home("windsurf-old");
    fs::create_dir_all(h.dir.join(".codeium/windsurf")).unwrap();
    let report = run(&mut h, &yes(opts(Agent::Devin))).unwrap();
    assert_eq!(steps(&report).len(), 4);
    let legacy: Value = serde_json::from_str(
        &fs::read_to_string(h.dir.join(".codeium/windsurf/mcp_config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        legacy["mcpServers"]["webhooks-cc"],
        expected_entry(Agent::Devin, Server::Local)
    );
    skill_is_embedded(&h.dir.join(".codeium/windsurf/skills/webhooks-cc"));
}

#[test]
fn the_json_report_names_each_agent_and_what_happened() {
    let mut h = home("json");
    let report = run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    let json = report.to_json();
    assert_eq!(
        json["server"],
        json!({ "kind": "remote", "url": REMOTE_URL })
    );
    assert_eq!(json["remove"], false);
    let agent = &json["agents"][0];
    assert_eq!(agent["agent"], "vscode");
    assert_eq!(agent["detected"], false);
    assert_eq!(agent["items"][0]["what"], "mcp");
    assert_eq!(agent["items"][0]["status"], "installed");
    assert_eq!(
        agent["items"][0]["path"],
        h.env.vscode_config().display().to_string()
    );
    assert_eq!(agent["items"][1]["what"], "skill");
    assert!(agent["next"].as_str().unwrap().contains("VS Code"));

    let mut text = Vec::new();
    report.write_text(&h.env, &mut text).unwrap();
    let text = slashes(&String::from_utf8(text).unwrap());
    assert!(text.contains("~/xdg/Code/User/mcp.json"), "{text}");
}

#[test]
fn paths_follow_each_platform() {
    let vars = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    };
    let mac = Env {
        os: Os::Mac,
        home: PathBuf::from("/Users/a"),
        vars: vars(&[]),
    };
    assert_eq!(
        mac.claude_desktop_config(),
        Path::new("/Users/a/Library/Application Support/Claude/claude_desktop_config.json")
    );
    assert_eq!(
        mac.vscode_config(),
        Path::new("/Users/a/Library/Application Support/Code/User/mcp.json")
    );
    assert_eq!(
        mac.devin_config(),
        Path::new("/Users/a/.config/devin/mcp_config.json")
    );
    assert_eq!(
        mac.manifest_path(),
        Path::new("/Users/a/Library/Application Support/whk/setup-agent.json")
    );

    let windows = Env {
        os: Os::Windows,
        home: PathBuf::from("/c/Users/a"),
        vars: vars(&[("APPDATA", "/d/Roaming")]),
    };
    assert_eq!(
        windows.claude_desktop_config(),
        Path::new("/d/Roaming/Claude/claude_desktop_config.json")
    );
    assert_eq!(
        windows.vscode_config(),
        Path::new("/d/Roaming/Code/User/mcp.json")
    );
    assert_eq!(
        windows.devin_config(),
        Path::new("/d/Roaming/devin/mcp_config.json")
    );
    assert_eq!(
        windows.cursor_config(),
        Path::new("/c/Users/a/.cursor/mcp.json")
    );
    assert_eq!(
        windows.devin_skills(),
        Path::new("/c/Users/a/.config/devin/skills")
    );

    let linux = Env {
        os: Os::Linux,
        home: PathBuf::from("/home/a"),
        vars: vars(&[
            ("CLAUDE_CONFIG_DIR", "/cc"),
            ("CODEX_HOME", "/cx"),
            ("XDG_CONFIG_HOME", "relative"),
        ]),
    };
    assert_eq!(linux.claude_json(), Path::new("/cc/.claude.json"));
    assert_eq!(linux.claude_skills(), Path::new("/cc/skills"));
    assert_eq!(linux.codex_home(), Path::new("/cx"));
    // A relative XDG_CONFIG_HOME is ignored, as setup.ts and dirs do.
    assert_eq!(
        linux.devin_config(),
        Path::new("/home/a/.config/devin/mcp_config.json")
    );
    assert_eq!(
        linux.claude_desktop_config(),
        Path::new("/home/a/.config/Claude/claude_desktop_config.json")
    );
}

fn write_file(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn message_of(step: &Step) -> String {
    step.message()
        .unwrap_or_else(|| panic!("no message: {step:?}"))
        .to_string()
}

fn lock_listing_the_skill() -> String {
    json!({
        "version": 3,
        "skills": { "webhooks-cc": {
            "source": "kroqdotdev/webhooks-cc", "sourceType": "github",
            "sourceUrl": "https://github.com/kroqdotdev/webhooks-cc.git",
            "skillFolderHash": "abc", "installedAt": "2026-11-15T00:00:00Z",
            "updatedAt": "2026-11-15T00:00:00Z"
        } }
    })
    .to_string()
}

#[test]
fn a_skill_the_skills_cli_lists_in_its_lock_is_never_updated_or_removed() {
    for state_home in [false, true] {
        let mut h = home(&format!("skills-lock-{state_home}"));
        run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
        let dir = skill_path(&h, Agent::Cursor).unwrap();
        let lock = if state_home {
            let state = h.dir.join("state");
            h.env
                .vars
                .insert("XDG_STATE_HOME".into(), state.display().to_string());
            state.join("skills/.skill-lock.json")
        } else {
            h.dir.join(".agents/.skill-lock.json")
        };
        write_file(&lock, &lock_listing_the_skill());

        // An update (an older whk's copy) is left to the skills CLI.
        let path = h.env.manifest_path();
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        fs::write(dir.join("SKILL.md"), "old\n").unwrap();
        manifest["skills"][dir.display().to_string()]["SKILL.md"] = json!(sha256(b"old\n"));
        fs::write(&path, manifest.to_string()).unwrap();
        let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
        let message = message_of(&steps(&report)[1]);
        assert!(matches!(steps(&report)[1], Step::Skip(_)));
        assert!(message.contains("skills CLI"), "{message}");
        assert!(
            message.contains("npx skills remove --global webhooks-cc"),
            "{message}"
        );
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "old\n");

        // So is --remove, and whk lets go of its record.
        let report = run(&mut h, &yes(opts(Agent::Cursor)).clone_with_remove()).unwrap();
        assert_eq!(steps(&report)[0], Step::Remove);
        assert!(
            matches!(steps(&report)[1], Step::Skip(_)),
            "{:?}",
            steps(&report)
        );
        assert!(dir.join("SKILL.md").exists());
        assert!(!h.env.manifest_path().exists());
    }
}

#[cfg(unix)]
#[test]
fn a_copy_another_agents_skills_directory_links_to_is_left_alone() {
    let mut h = home("skills-linked-to");
    run(
        &mut h,
        &yes(Options {
            local: true,
            ..opts(Agent::Codex)
        }),
    )
    .unwrap();
    let canonical = skill_path(&h, Agent::Codex).unwrap();
    // `npx skills add` links Claude Code's directory to the copy it found.
    let link = h.dir.join(".claude/skills/webhooks-cc");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&canonical, &link).unwrap();

    let report = run(&mut h, &yes(opts(Agent::Codex)).clone_with_remove()).unwrap();
    assert_eq!(steps(&report)[0], Step::Remove);
    let message = slashes(&message_of(&steps(&report)[1]));
    assert!(
        message.contains("~/.claude/skills/webhooks-cc links to"),
        "{message}"
    );
    skill_is_embedded(&canonical);
    skill_is_embedded(&link);
}

#[test]
fn devin_gets_the_remote_server_and_windsurf_keeps_the_local_one() {
    let mut h = home("devin-remote");
    fs::create_dir_all(h.dir.join(".codeium/windsurf")).unwrap();
    let report = run(&mut h, &yes(opts(Agent::Devin))).unwrap();
    assert!(steps(&report).iter().all(|s| *s == Step::Install));
    let devin: Value =
        serde_json::from_str(&fs::read_to_string(h.env.devin_config()).unwrap()).unwrap();
    assert_eq!(
        devin["mcpServers"]["webhooks-cc"],
        json!({ "url": "https://webhooks.cc/mcp", "transport": "http" })
    );
    let legacy: Value = serde_json::from_str(
        &fs::read_to_string(h.dir.join(".codeium/windsurf/mcp_config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        legacy["mcpServers"]["webhooks-cc"],
        json!({ "command": "npx", "args": ["-y", "@webhooks-cc/mcp"] })
    );
    let json = report.to_json();
    assert_eq!(json["agents"][0]["server"]["kind"], "remote");
    let next = json["agents"][0]["next"].as_str().unwrap();
    assert!(next.contains("devin mcp login webhooks-cc"), "{next}");
    // The legacy file runs npx, which this PATH lacks.
    assert!(next.contains("`npx` is not on PATH"), "{next}");

    // --local keeps npx for Devin's own file too, and replaces whk's entry.
    let report = run(
        &mut h,
        &yes(Options {
            local: true,
            ..opts(Agent::Devin)
        }),
    )
    .unwrap();
    assert_eq!(steps(&report)[0], Step::Update);
    assert_eq!(
        mcp_entry(&h, Agent::Devin).unwrap(),
        json!({ "command": "npx", "args": ["-y", "@webhooks-cc/mcp"] })
    );
}

#[test]
fn the_next_step_says_when_npx_is_missing_for_the_local_server() {
    let mut h = home("npx");
    let local = Options {
        local: true,
        ..yes(opts(Agent::Cursor))
    };
    let report = run(&mut h, &local).unwrap();
    let next = report.to_json()["agents"][0]["next"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        next.contains("`npx` is not on PATH") && next.contains("Node.js"),
        "{next}"
    );

    fs::write(h.dir.join("bin/npx"), "").unwrap();
    let report = run(&mut h, &local).unwrap();
    let next = report.to_json()["agents"][0]["next"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!next.contains("npx"), "{next}");

    // The remote server needs no npx.
    let mut h = home("npx-remote");
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let next = report.to_json()["agents"][0]["next"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!next.contains("npx"), "{next}");
}

#[test]
fn removing_keeps_the_other_servers_in_their_order() {
    let mut h = home("remove-order");
    let path = h.env.cursor_config();
    write_file(&path, r#"{"mcpServers": {"a": {"command": "a"}}}"#);
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    // The person adds servers after it, and moves whk's between them.
    let mut root: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let ours = root["mcpServers"]["webhooks-cc"].clone();
    root["mcpServers"] = json!({
        "a": { "command": "a" }, "webhooks-cc": ours, "b": { "command": "b" }, "c": { "command": "c" }
    });
    fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();

    run(&mut h, &yes(opts(Agent::Cursor)).clone_with_remove()).unwrap();
    let root: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let names: Vec<&String> = root["mcpServers"].as_object().unwrap().keys().collect();
    assert_eq!(names, ["a", "b", "c"]);
}

#[cfg(unix)]
#[test]
fn a_read_only_config_is_reported_and_its_agent_skipped() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = home("read-only");
    let path = h.env.cursor_config();
    write_file(&path, "{}\n");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
    if writable(&path) {
        // Running as root, which may write anything.
        return;
    }
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(!report.failed());
    let Step::Blocked(message) = &steps(&report)[0] else {
        panic!("{:?}", steps(&report));
    };
    assert!(message.contains(&path.display().to_string()) && message.contains("read-only"));
    assert!(matches!(steps(&report)[1], Step::Skip(_)));
    let json = report.to_json();
    assert_eq!(json["agents"][0]["status"], "skipped");
    assert_eq!(json["agents"][0]["items"][0]["status"], "skipped");
    assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
    assert!(!skill_path(&h, Agent::Cursor).unwrap().exists());
    assert!(!backup_path(&path).exists());
    // And write_atomic refuses it too.
    assert_eq!(
        write_atomic(&path, b"{}").unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
}

#[cfg(unix)]
#[test]
fn files_keep_their_mode_and_new_ones_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let mut h = home("modes");
    let path = h.env.cursor_config();
    write_file(&path, "{}\n");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(mode(&path), 0o640);
    assert_eq!(mode(&backup_path(&path)), 0o640);
    assert_eq!(mode(&h.env.manifest_path()), 0o600);
    let skill = skill_path(&h, Agent::Cursor).unwrap();
    assert_eq!(mode(&skill.join("SKILL.md")), 0o600);
    // No temporary file is left behind.
    let names: Vec<String> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().all(|n| !n.contains("whk-tmp")), "{names:?}");

    // A link planted where the backup goes is never written through.
    let mut h = home("planted-backup");
    let path = h.env.cursor_config();
    write_file(&path, "{}\n");
    let elsewhere = h.dir.join("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, backup_path(&path)).unwrap();
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(!elsewhere.exists());
}

#[test]
fn claude_code_and_codex_found_without_their_programs_are_skipped() {
    let mut h = home("found-no-program");
    h.env.vars.insert("PATH".into(), String::new());
    fs::create_dir_all(h.dir.join(".claude")).unwrap();
    fs::create_dir_all(h.dir.join(".codex")).unwrap();
    let report = run(&mut h, &yes(Options::default())).unwrap();
    assert!(!report.failed(), "{report:?}");
    let found: Vec<Agent> = report.agents.iter().map(|a| a.agent).collect();
    assert_eq!(found, [Agent::ClaudeCode, Agent::Codex]);
    for (a, program) in report.agents.iter().zip(["claude", "codex"]) {
        let Step::Skip(message) = &a.items[0].step else {
            panic!("{:?}", a.items);
        };
        assert!(
            message.contains(&format!("`{program}` is not on PATH"))
                && message.contains(&format!("{program} mcp add")),
            "{message}"
        );
        assert_eq!(a.items[1].step, Step::Install);
    }
    skill_is_embedded(&skill_path(&h, Agent::ClaudeCode).unwrap());
    skill_is_embedded(&skill_path(&h, Agent::Codex).unwrap());
    assert!(h.fake.calls.is_empty());

    // Named, Codex fails with the command to run.
    let report = run(&mut h, &yes(opts(Agent::Codex))).unwrap();
    assert!(report.failed());
    let message = message_of(&steps(&report)[0]);
    assert!(
        message.contains("codex mcp add webhooks-cc --url"),
        "{message}"
    );
}

#[test]
fn cursor_and_vs_code_get_no_second_copy_of_a_skill_they_read_elsewhere() {
    // Codex's copy in ~/.agents/skills, made in the same run, serves Cursor
    // and VS Code too.
    let mut h = home("shared-skill");
    let report = run(
        &mut h,
        &Options {
            agents: vec![Agent::Cursor, Agent::Vscode, Agent::Codex],
            local: true,
            yes: true,
            ..Options::default()
        },
    )
    .unwrap();
    assert!(!report.failed());
    for a in &report.agents[..2] {
        let Step::Skip(message) = &a.items[1].step else {
            panic!("{:?}", a.items);
        };
        assert!(
            slashes(message).contains("~/.agents/skills/webhooks-cc"),
            "{message}"
        );
    }
    assert_eq!(report.agents[2].items[1].step, Step::Install);
    assert!(!skill_path(&h, Agent::Cursor).unwrap().exists());
    assert!(!skill_path(&h, Agent::Vscode).unwrap().exists());

    // A copy already in ~/.claude/skills counts too, whoever made it.
    let mut h = home("shared-claude-skill");
    write_file(
        &h.dir.join(".claude/skills/webhooks-cc/SKILL.md"),
        "theirs\n",
    );
    let report = run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    let message = slashes(&message_of(&steps(&report)[1]));
    assert!(
        message.contains("~/.claude/skills/webhooks-cc"),
        "{message}"
    );
    assert!(!skill_path(&h, Agent::Vscode).unwrap().exists());
}

#[test]
fn a_codex_entry_added_by_a_failed_sign_in_is_recorded_and_removable() {
    let mut h = home("codex-sign-in-fails");
    h.fake.codex_sign_in_fails = Some("Error: OAuth login was cancelled".into());
    let report = run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
    assert!(report.failed());
    let message = message_of(&steps(&report)[0]);
    assert!(
        message.contains("cancelled") && message.contains("--remove"),
        "{message}"
    );
    assert_eq!(prune(&mcp_entry(&h, Agent::Codex).unwrap()), remote_entry());

    h.fake.codex_sign_in_fails = None;
    let report = run(&mut h, &yes(opts(Agent::Codex)).clone_with_remove()).unwrap();
    assert_eq!(steps(&report)[0], Step::Remove);
    assert_eq!(h.fake.codex, None);
}

#[test]
fn an_unrecorded_entry_of_the_other_kind_is_replaced_only_for_a_named_agent() {
    let mut h = home("other-kind");
    let local = json!({
        "name": "webhooks-cc", "enabled": true,
        "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@webhooks-cc/mcp"] }
    });
    h.fake.codex = Some(local.clone());
    fs::create_dir_all(h.dir.join(".codex")).unwrap();

    // Found, not named: left as it is.
    let report = run(
        &mut h,
        &yes(tty(Options {
            agents: vec![],
            ..Options::default()
        })),
    )
    .unwrap();
    let codex = report
        .agents
        .iter()
        .find(|a| a.agent == Agent::Codex)
        .unwrap();
    let Step::Skip(message) = &codex.items[0].step else {
        panic!("{:?}", codex.items);
    };
    assert!(
        message.contains("local") && message.contains("--agent"),
        "{message}"
    );
    assert_eq!(h.fake.codex, Some(local.clone()));

    // Named (and confirmed with --yes): replaced.
    let report = run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
    assert_eq!(steps(&report)[0], Step::Update);
    assert_eq!(prune(&mcp_entry(&h, Agent::Codex).unwrap()), remote_entry());
}

#[test]
fn an_entry_changed_since_whk_wrote_it_says_so() {
    let mut h = home("changed-since");
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let path = h.env.cursor_config();
    write_file(
        &path,
        &json!({ "mcpServers": { "webhooks-cc": { "url": REMOTE_URL, "headers": { "X": "1" } } } })
            .to_string(),
    );
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let message = message_of(&steps(&report)[0]);
    assert!(message.contains("changed since whk wrote it"), "{message}");
    assert!(!message.contains("did not write"), "{message}");
}

#[test]
fn a_rewrite_keeps_the_byte_order_mark_line_endings_and_indentation() {
    for (indent, crlf, bom) in [
        ("    ", true, true),
        ("\t", false, false),
        ("  ", true, false),
    ] {
        let mut h = home("fidelity");
        let path = h.env.cursor_config();
        let nl = if crlf { "\r\n" } else { "\n" };
        let original = format!(
            "{}{{{nl}{indent}\"mcpServers\": {{{nl}{indent}{indent}\"other\": {{ \"command\": \"x\" }}{nl}{indent}}},{nl}{indent}\"big\": 12345678901234567890{nl}}}{nl}",
            if bom { "\u{feff}" } else { "" }
        );
        write_file(&path, &original);
        let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
        assert_eq!(steps(&report)[0], Step::Install, "{:?}", steps(&report));
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.starts_with('\u{feff}'), bom, "{text:?}");
        assert_eq!(text.contains("\r\n"), crlf, "{text:?}");
        if !crlf {
            assert!(!text.contains('\r'));
        } else {
            assert_eq!(text.matches('\n').count(), text.matches("\r\n").count());
        }
        assert!(
            text.contains(&format!("{nl}{indent}\"mcpServers\"")),
            "{text:?}"
        );
        assert!(
            text.contains(&format!("{nl}{indent}{indent}\"webhooks-cc\"")),
            "{text:?}"
        );
        // A u64 is kept as it was.
        assert!(text.contains("12345678901234567890"), "{text:?}");
        assert_eq!(fs::read_to_string(backup_path(&path)).unwrap(), original);

        run(&mut h, &yes(opts(Agent::Cursor)).clone_with_remove()).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.starts_with('\u{feff}'), bom);
        assert_eq!(text.contains("\r\n"), crlf);
    }
}

#[test]
fn a_number_whk_cannot_write_back_exactly_leaves_the_file_alone() {
    let mut h = home("big-number");
    let path = h.env.cursor_config();
    let original = "{\"id\": 123456789012345678901234567890, \"mcpServers\": {}}\n";
    write_file(&path, original);
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(report.failed());
    let message = message_of(&steps(&report)[0]);
    assert!(
        message.contains("123456789012345678901234567890"),
        "{message}"
    );
    assert!(message.contains("exactly"), "{message}");
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    // Inside a string it is only text.
    let mut h = home("big-number-string");
    let path = h.env.cursor_config();
    write_file(&path, "{\"id\": \"123456789012345678901234567890\"}");
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[0], Step::Install);
}

#[test]
fn a_vs_code_mcp_json_with_comments_is_skipped_unless_vs_code_is_named() {
    let mut h = home("jsonc");
    let path = h.env.vscode_config();
    let original = "{\n  // my servers\n  \"servers\": {\n    \"other\": { \"url\": \"https://x\" },\n  },\n}\n";
    write_file(&path, original);
    let report = run(&mut h, &yes(Options::default())).unwrap();
    assert!(!report.failed(), "{report:?}");
    let vscode = report
        .agents
        .iter()
        .find(|a| a.agent == Agent::Vscode)
        .unwrap();
    let Step::Skip(message) = &vscode.items[0].step else {
        panic!("{:?}", vscode.items);
    };
    assert!(message.contains("comments or trailing commas"), "{message}");
    let json = report.to_json();
    let item = json["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["agent"] == "vscode")
        .unwrap()["items"][0]
        .clone();
    assert_eq!(item["status"], "skipped");
    assert_eq!(fs::read_to_string(&path).unwrap(), original);

    let report = run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    assert!(report.failed());
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn remove_without_agent_also_takes_out_copies_for_an_agent_gone_since() {
    let mut h = home("gone-since");
    run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    let skill = skill_path(&h, Agent::Vscode).unwrap();
    assert!(skill.exists());
    // VS Code is uninstalled, its profile with it; the skill copy stays.
    fs::remove_dir_all(h.dir.join("xdg/Code")).unwrap();
    assert!(!h.env.detect(Agent::Vscode));

    let report = run(&mut h, &yes(Options::default()).clone_with_remove()).unwrap();
    let vscode = report
        .agents
        .iter()
        .find(|a| a.agent == Agent::Vscode)
        .unwrap();
    assert!(!vscode.detected);
    assert_eq!(vscode.items[0].step, Step::Absent);
    assert_eq!(vscode.items[1].step, Step::Remove);
    assert!(!skill.exists());
    assert!(!h.env.manifest_path().exists());
}

fn manifest_json(h: &Home) -> Value {
    serde_json::from_str(&fs::read_to_string(h.env.manifest_path()).unwrap()).unwrap()
}

#[cfg(unix)]
#[test]
fn ctrl_c_during_a_shown_program_ends_the_program_and_not_whk() {
    // The program sends SIGINT to whk (this test process), as a Ctrl-C at
    // the terminal reaches both, and then to itself. whk lives on; the
    // program, which gets the default action back, ends at once.
    let _signals = crate::test_support::signal_test_lock();

    /// The SIGINT action now.
    fn current() -> libc::sighandler_t {
        // SAFETY: reads the current action into a zeroed struct.
        unsafe {
            let mut now: libc::sigaction = std::mem::zeroed();
            libc::sigaction(libc::SIGINT, std::ptr::null(), &mut now);
            now.sa_sigaction
        }
    }

    /// Whether a SIGINT sent to this process is still waiting to be handled.
    /// Linux reports only the pending signals the calling thread blocks, so
    /// this thread blocks SIGINT while it asks (see below).
    fn sigint_pending() -> bool {
        // SAFETY: sigpending fills a set emptied first.
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigpending(&mut set) == 0 && libc::sigismember(&set, libc::SIGINT) == 1
        }
    }

    extern "C" fn outer(_: libc::c_int) {}

    // A handler of the test's own around the run: the SIGINT to this process
    // may still be on its way when the run puts back what it found, and
    // must not meet the default action then, which ends the test binary.
    // The run restores this handler, which shows it restores whatever was
    // there; once the signal has been handled, the default comes back.
    let before = current();
    assert_eq!(before, libc::SIG_DFL);
    // SAFETY: sigaction with zeroed, then filled structs; the handler does
    // nothing, so it is async-signal-safe.
    unsafe {
        let mut quiet: libc::sigaction = std::mem::zeroed();
        quiet.sa_sigaction = outer as extern "C" fn(libc::c_int) as usize;
        quiet.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut quiet.sa_mask);
        assert_eq!(
            libc::sigaction(libc::SIGINT, &quiet, std::ptr::null_mut()),
            0
        );
    }
    let ours = current();

    let mut runner = ProcessRunner { json: true };
    let started = std::time::Instant::now();
    let output = runner
        .run(
            Path::new("/bin/sh"),
            &[
                "-c".to_string(),
                "kill -INT $PPID; kill -INT $$; sleep 5".to_string(),
            ],
            true,
        )
        .unwrap();
    // whk's own Ctrl-C is as it was before the run.
    let after = current();

    // The SIGINT sent to this process was queued before the program ended,
    // and the run discards it if no thread has taken it by then, so none
    // should be left pending. With SIGINT blocked here one that was would
    // stay visible to sigpending until a thread took it, under the test's
    // own handler; only then does the default come back.
    // SAFETY: a signal set emptied, then filled, for this thread's mask.
    let mut only_sigint: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut only_sigint);
        libc::sigaddset(&mut only_sigint, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &only_sigint, std::ptr::null_mut());
    }
    let waited = std::time::Instant::now();
    while sigint_pending() && waited.elapsed() < std::time::Duration::from_secs(10) {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let left_pending = sigint_pending();
    if !left_pending {
        // SAFETY: puts back the default action, then this thread's mask.
        unsafe {
            let mut default: libc::sigaction = std::mem::zeroed();
            default.sa_sigaction = libc::SIG_DFL;
            libc::sigemptyset(&mut default.sa_mask);
            libc::sigaction(libc::SIGINT, &default, std::ptr::null_mut());
            libc::pthread_sigmask(libc::SIG_UNBLOCK, &only_sigint, std::ptr::null_mut());
        }
    }
    // Left pending, the handler and this thread's mask stay as they are,
    // so the signal still does no harm once a thread takes it.
    assert!(!left_pending, "no thread took the SIGINT sent to whk");

    assert!(!output.success);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(4),
        "the program ignored Ctrl-C"
    );
    assert_eq!(after, ours, "the run did not restore the action it found");
}

/// Set for the copy of this test binary that
/// `a_ctrl_c_still_pending_when_a_shown_program_ends_does_not_end_whk` runs.
#[cfg(unix)]
const PENDING_CTRL_C_CHILD: &str = "WHK_TEST_PENDING_CTRL_C_CHILD";

#[cfg(unix)]
#[test]
fn a_ctrl_c_still_pending_when_a_shown_program_ends_does_not_end_whk() {
    // The case runs in a copy of this test binary with SIGINT at the
    // default action, as whk has it: if the run let the program's SIGINT
    // through to that default, the copy is ended by it, which the test
    // binary itself must never be.
    //
    // A SIGINT not yet delivered when the program ends is the case
    // discard_pending_interrupt() is for (macOS often delivers it late).
    // The copy starts with SIGINT blocked, so every one of its threads
    // (the harness's and the test's) inherits the mask and the program's
    // SIGINT stays pending through the run whatever the platform's timing.
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().unwrap();
    let mut command = std::process::Command::new(exe);
    command
        .args(["--exact", "cli::setup::tests::pending_ctrl_c_child"])
        .env(PENDING_CTRL_C_CHILD, "1")
        .stdin(std::process::Stdio::null());
    // SAFETY: runs in the forked child before exec, after std has emptied
    // its signal mask; sigprocmask is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            let mut only_sigint: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut only_sigint);
            libc::sigaddset(&mut only_sigint, libc::SIGINT);
            if libc::sigprocmask(libc::SIG_BLOCK, &only_sigint, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            output.status.signal(),
            None,
            "the SIGINT left pending ended whk\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
    }
    assert!(
        output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    // The filter matched the case, so it did run.
    assert!(
        stdout.contains("1 passed"),
        "stdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

/// The case behind the test above. It does nothing unless that test runs
/// it: it leaves SIGINT at the default action, and a run that let the
/// program's SIGINT through would end the test binary.
#[cfg(unix)]
#[test]
fn pending_ctrl_c_child() {
    if std::env::var_os(PENDING_CTRL_C_CHILD).is_none() {
        return;
    }
    let _signals = crate::test_support::signal_test_lock();
    // SAFETY: reads the current action and this thread's mask into zeroed
    // structs, then builds a set holding SIGINT alone.
    let (before, blocked, only_sigint) = unsafe {
        let mut now: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGINT, std::ptr::null(), &mut now);
        let mut mask: libc::sigset_t = std::mem::zeroed();
        libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &mut mask);
        let mut only_sigint: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut only_sigint);
        libc::sigaddset(&mut only_sigint, libc::SIGINT);
        (
            now.sa_sigaction,
            libc::sigismember(&mask, libc::SIGINT) == 1,
            only_sigint,
        )
    };
    assert_eq!(before, libc::SIG_DFL);
    assert!(blocked, "started without SIGINT blocked");

    let mut runner = ProcessRunner { json: true };
    let output = runner
        .run(
            Path::new("/bin/sh"),
            &["-c".to_string(), "kill -INT $PPID; exit 0".to_string()],
            true,
        )
        .unwrap();
    // Unblocked, a SIGINT still pending now meets the default action and
    // ends this process before the next line.
    // SAFETY: changes this thread's mask only.
    unsafe {
        libc::pthread_sigmask(libc::SIG_UNBLOCK, &only_sigint, std::ptr::null_mut());
    }
    assert!(output.success);
}

#[test]
fn a_run_ended_during_the_codex_sign_in_keeps_its_records() {
    let mut h = home("ended-in-sign-in");
    h.fake.codex_add_ends_whk = true;
    let o = yes(tty(Options {
        agents: vec![Agent::Cursor, Agent::Codex],
        ..Options::default()
    }));
    let ended = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut h, &o)));
    assert!(ended.is_err());
    // Cursor's change was saved as it was made, and what Codex was about to
    // add is noted.
    let saved = manifest_json(&h);
    let cursor = key(&h.env.cursor_config());
    assert_eq!(
        saved["mcpFiles"][&cursor]["entry"],
        json!({ "url": REMOTE_URL })
    );
    let codex_home = key(&h.env.codex_home());
    assert_eq!(
        saved["pending"]["mcpCommands"]["codex"][&codex_home],
        remote_entry()
    );
    assert_eq!(saved["mcpCommands"], json!({}));

    // A re-run finds the entry Codex added and records it as whk's.
    h.fake.codex_add_ends_whk = false;
    let report = run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
    assert_eq!(steps(&report), [Step::Unchanged, Step::Install]);
    let saved = manifest_json(&h);
    assert_eq!(saved["mcpCommands"]["codex"][&codex_home], remote_entry());
    assert!(saved.get("pending").is_none(), "{saved}");
    let report = run(&mut h, &yes(opts(Agent::Codex)).clone_with_remove()).unwrap();
    assert_eq!(steps(&report), [Step::Remove, Step::Remove]);
    assert_eq!(h.fake.codex, None);
}

#[test]
fn a_note_for_an_entry_that_is_not_in_place_is_dropped() {
    let mut h = home("stale-note");
    let path = h.env.cursor_config();
    // whk noted an entry and was ended before writing it; the person then
    // added one of their own.
    write_file(
        &h.env.manifest_path(),
        &json!({ "version": 1, "pending": { "mcpFiles": {
            key(&path): { "entry": { "url": REMOTE_URL }, "created": true }
        } } })
        .to_string(),
    );
    write_file(
        &path,
        &json!({ "mcpServers": { "webhooks-cc": { "url": REMOTE_URL, "headers": { "Authorization": "x" } } } })
            .to_string(),
    );
    let report = run(&mut h, &yes(opts(Agent::Cursor).clone_with_remove())).unwrap();
    assert!(matches!(steps(&report)[0], Step::Skip(_)));
    assert!(fs::read_to_string(&path).unwrap().contains("Authorization"));
    assert!(!h.env.manifest_path().exists());
}

#[cfg(unix)]
#[test]
fn nothing_changes_when_the_record_cannot_be_written() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = home("record-read-only");
    let dir = h.env.manifest_path().parent().unwrap().to_path_buf();
    fs::create_dir_all(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
    if writable(&dir) {
        // Running as root, which may write anything.
        return;
    }
    let before = snapshot(&h);
    let error = run(&mut h, &yes(opts(Agent::Cursor))).unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains(&h.env.manifest_path().display().to_string())
            && message.contains("nothing was changed"),
        "{message}"
    );
    assert_eq!(snapshot(&h), before);
    assert!(!h.env.cursor_config().exists());
    // A dry run still says what it would do.
    let dry = run(
        &mut h,
        &Options {
            dry_run: true,
            ..opts(Agent::Cursor)
        },
    )
    .unwrap();
    assert_eq!(steps(&dry)[0], Step::Install);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_record_that_could_not_be_saved_after_a_change_is_repaired_by_a_re_run() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = home("record-lost");
    let dir = h.env.manifest_path().parent().unwrap().to_path_buf();
    h.fake.lock_after_claude_add = Some(dir.clone());
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    if writable(&dir) {
        // Running as root, which may write anything.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    assert!(report.failed());
    let message = message_of(&steps(&report)[0]);
    assert!(
        message.contains("the change was made")
            && message.contains("Run this again")
            && message.contains(&h.env.manifest_path().display().to_string()),
        "{message}"
    );
    // Nothing else is changed while the record cannot be saved.
    let skill = message_of(&steps(&report)[1]);
    assert!(skill.contains("could not save its record"), "{skill}");
    assert!(!skill_path(&h, Agent::ClaudeCode).unwrap().exists());
    assert!(mcp_entry(&h, Agent::ClaudeCode).is_some());
    // The note saved before the change is the way back.
    let claude_json = key(&h.env.claude_json());
    assert_eq!(
        manifest_json(&h)["pending"]["mcpCommands"]["claude-code"][&claude_json],
        remote_entry()
    );

    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    h.fake.lock_after_claude_add = None;
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode))).unwrap();
    assert!(!report.failed(), "{report:?}");
    assert_eq!(steps(&report), [Step::Unchanged, Step::Install]);
    assert_eq!(
        manifest_json(&h)["mcpCommands"]["claude-code"][&claude_json],
        remote_entry()
    );
    let report = run(&mut h, &yes(opts(Agent::ClaudeCode)).clone_with_remove()).unwrap();
    assert_eq!(steps(&report), [Step::Remove, Step::Remove]);
    assert_eq!(mcp_entry(&h, Agent::ClaudeCode), None);
}

#[test]
fn a_command_record_holds_for_its_own_configuration_only() {
    for (agent, var) in [
        (Agent::Codex, "CODEX_HOME"),
        (Agent::ClaudeCode, "CLAUDE_CONFIG_DIR"),
    ] {
        let mut h = home(&format!("config-dir-{}", agent.id()));
        let a = h.dir.join("config-a").display().to_string();
        let b = h.dir.join("config-b").display().to_string();
        let local = |o: Options| Options { local: true, ..o };
        h.env.vars.insert(var.into(), a.clone());
        h.fake.claude_json = h.env.claude_json();
        run(&mut h, &local(yes(opts(agent)))).unwrap();
        let installed = mcp_entry(&h, agent).unwrap();

        // The same entry under another configuration is not whk's: the
        // fake Codex answers alike for both, and Claude Code's file is
        // copied over.
        h.env.vars.insert(var.into(), b.clone());
        if agent == Agent::ClaudeCode {
            write_file(
                &h.env.claude_json(),
                &fs::read_to_string(&h.fake.claude_json).unwrap(),
            );
            h.fake.claude_json = h.env.claude_json();
        }
        h.fake.calls.clear();
        let report = run(&mut h, &local(yes(opts(agent))).clone_with_remove()).unwrap();
        let message = message_of(&steps(&report)[0]);
        assert!(
            message.contains("not written by whk"),
            "{agent:?}: {message}"
        );
        assert_eq!(mcp_entry(&h, agent), Some(installed), "{agent:?}");
        assert!(
            h.fake.calls.iter().all(|c| !c.contains(" remove")),
            "{agent:?}: {:?}",
            h.fake.calls
        );

        // Under the first it still is.
        h.env.vars.insert(var.into(), a);
        h.fake.claude_json = h.env.claude_json();
        let report = run(&mut h, &local(yes(opts(agent))).clone_with_remove()).unwrap();
        assert_eq!(steps(&report)[0], Step::Remove, "{agent:?}");
        assert_eq!(mcp_entry(&h, agent), None, "{agent:?}");
    }
}

#[test]
fn a_codex_entry_with_its_tools_or_timeouts_set_is_the_persons() {
    for (field, value) in [
        ("enabled_tools", json!(["create_endpoint"])),
        // An empty list is set too: it offers no tools at all.
        ("enabled_tools", json!([])),
        ("disabled_tools", json!(["delete_endpoint"])),
        ("disabled_tools", json!([])),
        ("startup_timeout_sec", json!(30)),
        ("tool_timeout_sec", json!(120)),
    ] {
        let mut h = home(&format!("codex-{field}-{}", value.to_string().len()));
        let local = Options {
            local: true,
            ..yes(opts(Agent::Codex))
        };
        run(&mut h, &local).unwrap();
        h.fake.codex.as_mut().unwrap()[field] = value.clone();
        let customised = h.fake.codex.clone();

        let report = run(&mut h, &local).unwrap();
        let message = message_of(&steps(&report)[0]);
        assert!(
            message.contains("changed since whk wrote it"),
            "{field}: {message}"
        );
        // Nor is it reset by moving to the other server.
        let report = run(&mut h, &yes(tty(opts(Agent::Codex)))).unwrap();
        assert!(matches!(steps(&report)[0], Step::Skip(_)), "{field}");
        let report = run(&mut h, &local.clone_with_remove()).unwrap();
        assert!(matches!(steps(&report)[0], Step::Skip(_)), "{field}");
        assert_eq!(h.fake.codex, customised, "{field}");
        assert!(
            h.fake.calls.iter().filter(|c| c.contains(" add ")).count() == 1,
            "{field}: {:?}",
            h.fake.calls
        );
    }
}

#[cfg(unix)]
#[test]
fn a_skill_holding_a_link_is_never_whks() {
    let mut h = home("skill-link-inside");
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let dir = skill_path(&h, Agent::Cursor).unwrap();
    // The same text, through a link to a file outside: what a hash of the
    // followed link would take for whk's own.
    let outside = h.dir.join("outside.md");
    let cli = dir.join("references/cli.md");
    fs::copy(&cli, &outside).unwrap();
    fs::remove_file(&cli).unwrap();
    std::os::unix::fs::symlink(&outside, &cli).unwrap();

    for o in [
        yes(opts(Agent::Cursor)).clone_with_remove(),
        yes(opts(Agent::Cursor)),
    ] {
        let report = run(&mut h, &o).unwrap();
        let message = message_of(&steps(&report)[1]);
        assert!(
            message.contains("references/cli.md") && message.contains("link"),
            "{message}"
        );
    }
    assert!(fs::symlink_metadata(&cli).unwrap().file_type().is_symlink());
    assert!(outside.exists());
    assert!(dir.join("SKILL.md").exists());
}

#[cfg(unix)]
#[test]
fn a_skill_removal_that_stops_part_way_is_taken_up_again() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = home("skill-partial-remove");
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let dir = skill_path(&h, Agent::Cursor).unwrap();
    let references = dir.join("references");
    fs::set_permissions(&references, fs::Permissions::from_mode(0o555)).unwrap();
    if writable(&references) {
        // Running as root, which may write anything.
        return;
    }
    let report = run(&mut h, &yes(opts(Agent::Cursor)).clone_with_remove()).unwrap();
    assert!(report.failed());
    assert_eq!(steps(&report)[0], Step::Remove);
    assert!(message_of(&steps(&report)[1]).contains("could not remove"));
    // SKILL.md went first, and the record no longer lists it.
    assert!(!dir.join("SKILL.md").exists());
    let saved = manifest_json(&h);
    let files = saved["skills"][key(&dir)].as_object().unwrap();
    assert!(!files.contains_key("SKILL.md"), "{files:?}");
    assert!(files.contains_key("references/cli.md"), "{files:?}");

    fs::set_permissions(&references, fs::Permissions::from_mode(0o755)).unwrap();
    let report = run(&mut h, &yes(opts(Agent::Cursor)).clone_with_remove()).unwrap();
    assert!(!report.failed(), "{report:?}");
    assert_eq!(steps(&report), [Step::Absent, Step::Remove]);
    assert!(!dir.exists());
    assert!(!h.env.manifest_path().exists());
}

/// Entries whk leaves beside a skill while it writes one.
fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.contains("whk-"))
                .collect()
        })
        .unwrap_or_default()
}

struct FailSkillFile;

impl FailSkillFile {
    fn at(file: usize) -> Self {
        FAIL_SKILL_FILE.with(|f| f.set(Some(file)));
        FailSkillFile
    }
}

impl Drop for FailSkillFile {
    fn drop(&mut self) {
        FAIL_SKILL_FILE.with(|f| f.set(None));
    }
}

#[test]
fn a_skill_update_that_fails_leaves_the_old_copy_whole() {
    let mut h = home("skill-update-fails");
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    let dir = skill_path(&h, Agent::Cursor).unwrap();
    // As an older whk left it, and recorded it.
    fs::write(dir.join("SKILL.md"), "old\n").unwrap();
    let path = h.env.manifest_path();
    let mut manifest = manifest_json(&h);
    manifest["skills"][key(&dir)]["SKILL.md"] = json!(sha256(b"old\n"));
    fs::write(&path, manifest.to_string()).unwrap();
    let old: BTreeMap<String, Vec<u8>> = read_tree(&dir).unwrap().files;

    let failing = FailSkillFile::at(3);
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    drop(failing);
    assert!(report.failed());
    assert!(message_of(&steps(&report)[1]).contains("left as it was"));
    assert_eq!(read_tree(&dir).unwrap().files, old);
    assert_eq!(leftovers(dir.parent().unwrap()), Vec::<String>::new());
    assert_eq!(
        manifest_json(&h)["skills"][key(&dir)]["SKILL.md"],
        json!(sha256(b"old\n"))
    );
    assert!(manifest_json(&h).get("pending").is_none());

    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[1], Step::Update);
    skill_is_embedded(&dir);
    assert_eq!(leftovers(dir.parent().unwrap()), Vec::<String>::new());
}

#[test]
fn a_first_skill_copy_that_fails_leaves_nothing_behind() {
    let mut h = home("skill-install-fails");
    let failing = FailSkillFile::at(2);
    let report = run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    drop(failing);
    assert!(report.failed());
    assert_eq!(steps(&report)[0], Step::Install);
    assert!(matches!(steps(&report)[1], Step::Fail(_)));
    // Not the skill, nor the directories made for it.
    assert!(!h.dir.join(".copilot").exists());
    let saved = manifest_json(&h);
    assert_eq!(saved["skills"], json!({}));
    assert!(saved.get("pending").is_none(), "{saved}");

    let report = run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    assert_eq!(steps(&report)[1], Step::Install);
    skill_is_embedded(&skill_path(&h, Agent::Vscode).unwrap());
}

#[test]
fn only_a_readable_shared_skill_spares_cursor_and_vs_code_their_copy() {
    // An empty directory where the shared skill would be gives Cursor and
    // VS Code nothing to read.
    let mut h = home("shared-empty");
    fs::create_dir_all(h.dir.join(".claude/skills/webhooks-cc")).unwrap();
    fs::create_dir_all(h.dir.join(".agents/skills/webhooks-cc/references")).unwrap();
    let report = run(&mut h, &yes(opts(Agent::Vscode))).unwrap();
    assert_eq!(steps(&report)[1], Step::Install, "{:?}", steps(&report));
    skill_is_embedded(&skill_path(&h, Agent::Vscode).unwrap());

    // Nor does a link to nothing.
    #[cfg(unix)]
    {
        let mut h = home("shared-dangling");
        let link = h.dir.join(".claude/skills/webhooks-cc");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(h.dir.join("gone"), &link).unwrap();
        let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
        assert_eq!(steps(&report)[1], Step::Install, "{:?}", steps(&report));
    }
}

#[test]
fn claude_desktop_is_told_it_runs_the_local_server_and_where_the_remote_one_goes() {
    let mut h = home("claude-desktop-next");
    let report = run(&mut h, &yes(opts(Agent::ClaudeDesktop))).unwrap();
    let json = report.to_json();
    assert_eq!(json["server"]["kind"], "remote");
    assert_eq!(json["agents"][0]["server"]["kind"], "local");
    let next = json["agents"][0]["next"].as_str().unwrap();
    for words in [
        "local server",
        "agent sandbox",
        "connection saved before",
        "Settings, Connectors",
        REMOTE_URL,
    ] {
        assert!(next.contains(words), "{words}: {next}");
    }
}

/// Cursor and VS Code, with Codex, whose copy in `~/.agents/skills` they read.
fn cursor_vscode_codex() -> Options {
    Options {
        agents: vec![Agent::Cursor, Agent::Vscode, Agent::Codex],
        local: true,
        yes: true,
        ..Options::default()
    }
}

#[test]
fn a_shared_skill_that_could_not_be_written_spares_no_one_their_copy() {
    // The plan counts on Codex's copy in ~/.agents/skills, which then
    // fails: Cursor and VS Code get their own instead of being told they
    // read one that is not there.
    let mut h = home("shared-fails");
    let failing = FailSkillFile::at(0);
    let report = run(&mut h, &cursor_vscode_codex()).unwrap();
    drop(failing);
    assert!(matches!(report.agents[2].items[1].step, Step::Fail(_)));
    assert!(!h.dir.join(".agents/skills/webhooks-cc").exists());
    for (a, agent) in report.agents[..2]
        .iter()
        .zip([Agent::Cursor, Agent::Vscode])
    {
        assert_eq!(a.items[1].step, Step::Install, "{:?}", a.items);
        skill_is_embedded(&skill_path(&h, agent).unwrap());
    }

    // The plan says the shared copy is yet to be written.
    let mut h = home("shared-plan");
    let dry = run(
        &mut h,
        &Options {
            dry_run: true,
            ..cursor_vscode_codex()
        },
    )
    .unwrap();
    let message = message_of(&dry.agents[0].items[1].step);
    assert!(message.contains("which whk copies there"), "{message}");
}

#[test]
fn cursor_and_vs_code_lose_whks_own_copy_once_a_shared_one_is_there() {
    let mut h = home("shared-retire");
    run(
        &mut h,
        &Options {
            agents: vec![Agent::Cursor, Agent::Vscode],
            yes: true,
            ..Options::default()
        },
    )
    .unwrap();
    let cursor = skill_path(&h, Agent::Cursor).unwrap();
    let vscode = skill_path(&h, Agent::Vscode).unwrap();
    skill_is_embedded(&cursor);

    // While the shared copy cannot be written, theirs stays.
    let failing = FailSkillFile::at(0);
    let report = run(&mut h, &cursor_vscode_codex()).unwrap();
    drop(failing);
    assert!(matches!(report.agents[2].items[1].step, Step::Fail(_)));
    assert_eq!(report.agents[0].items[1].step, Step::Unchanged);
    assert_eq!(report.agents[1].items[1].step, Step::Unchanged);
    skill_is_embedded(&cursor);
    skill_is_embedded(&vscode);

    let dry = run(
        &mut h,
        &Options {
            dry_run: true,
            ..cursor_vscode_codex()
        },
    )
    .unwrap();
    let message = message_of(&dry.agents[0].items[1].step);
    assert!(
        matches!(dry.agents[0].items[1].step, Step::Retire(_))
            && message.contains("whk would take out the copy it added here before"),
        "{message}"
    );

    let report = run(&mut h, &cursor_vscode_codex()).unwrap();
    assert!(!report.failed());
    assert_eq!(report.agents[2].items[1].step, Step::Install);
    for a in &report.agents[..2] {
        let Step::Retire(message) = &a.items[1].step else {
            panic!("{:?}", a.items);
        };
        assert!(
            slashes(message).contains("~/.agents/skills/webhooks-cc")
                && message.contains("took out the copy it added here before"),
            "{message}"
        );
    }
    assert!(!cursor.exists());
    assert!(!vscode.exists());
    let skills = manifest_json(&h)["skills"].clone();
    assert!(skills.get(key(&cursor)).is_none(), "{skills}");
    assert!(skills.get(key(&vscode)).is_none(), "{skills}");

    // A copy someone else put there is never taken out.
    let mut h = home("shared-theirs");
    write_file(
        &h.dir.join(".agents/skills/webhooks-cc/SKILL.md"),
        "shared\n",
    );
    write_file(
        &h.dir.join(".cursor/skills/webhooks-cc/SKILL.md"),
        "theirs\n",
    );
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(
        matches!(steps(&report)[1], Step::Skip(_)),
        "{:?}",
        steps(&report)
    );
    assert_eq!(
        fs::read_to_string(h.dir.join(".cursor/skills/webhooks-cc/SKILL.md")).unwrap(),
        "theirs\n"
    );
}

#[test]
fn a_skill_copy_left_by_a_crash_is_cleared_and_nothing_else() {
    let mut h = home("skill-crash-leftovers");
    CLOCK_AHEAD.with(|c| c.set(LEFTOVER_AGE));
    let skills = h.dir.join(".cursor/skills");
    let stage = skills.join(".webhooks-cc.0123456789abcdef.whk-tmp");
    let old = skills.join(".webhooks-cc.fedcba9876543210.whk-old");
    write_file(&stage.join("SKILL.md"), "half\n");
    write_file(&old.join("references/a.md"), "old\n");
    // Named otherwise, or holding a file whk did not name: not whk's.
    let other = skills.join(".webhooks-cc.backup");
    let short = skills.join(".webhooks-cc.0123.whk-tmp");
    write_file(&other.join("SKILL.md"), "mine\n");
    write_file(&short.join("SKILL.md"), "mine\n");

    // A dry run leaves them.
    run(
        &mut h,
        &Options {
            dry_run: true,
            ..opts(Agent::Cursor)
        },
    )
    .unwrap();
    assert!(stage.exists() && old.exists());

    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(!report.failed());
    assert!(!stage.exists() && !old.exists());
    assert!(other.exists() && short.exists());
    skill_is_embedded(&skill_path(&h, Agent::Cursor).unwrap());

    // Also when nothing else changes.
    write_file(&stage.join("SKILL.md"), "half\n");
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[1], Step::Unchanged);
    assert!(!stage.exists());

    // One holding a link is left, and the link is not followed.
    #[cfg(unix)]
    {
        let outside = h.dir.join("outside");
        write_file(&outside.join("keep.txt"), "keep\n");
        write_file(&stage.join("SKILL.md"), "half\n");
        std::os::unix::fs::symlink(&outside, stage.join("link")).unwrap();
        run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
        assert!(stage.join("SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep\n"
        );
        // A link named as whk names its copies is left too.
        let linked = skills.join(".webhooks-cc.aaaaaaaaaaaaaaaa.whk-old");
        std::os::unix::fs::symlink(&outside, &linked).unwrap();
        run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
        assert!(fs::symlink_metadata(&linked).is_ok());
        assert!(outside.join("keep.txt").exists());
    }
}

#[test]
fn a_skill_copy_another_run_may_still_be_writing_is_left() {
    let mut h = home("skill-fresh-leftovers");
    let skills = h.dir.join(".cursor/skills");
    let stage = skills.join(".webhooks-cc.0123456789abcdef.whk-tmp");
    let old = skills.join(".webhooks-cc.fedcba9876543210.whk-old");
    write_file(&stage.join("SKILL.md"), "half\n");
    write_file(&old.join("references/a.md"), "old\n");

    // Changed within the last ten minutes: another run may be writing it.
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(!report.failed());
    assert!(stage.exists() && old.exists());
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[1], Step::Unchanged);
    assert!(stage.exists() && old.exists());

    // Nine minutes on, still left; ten minutes on, cleared.
    CLOCK_AHEAD.with(|c| c.set(LEFTOVER_AGE - Duration::from_secs(60)));
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(stage.exists() && old.exists());
    CLOCK_AHEAD.with(|c| c.set(LEFTOVER_AGE));
    run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert!(!stage.exists() && !old.exists());
}

#[test]
fn a_shared_copy_written_without_cursor_or_vs_code_says_a_full_run_tidies_theirs() {
    let mut h = home("shared-skill-note");
    let report = run(&mut h, &yes(opts(Agent::Cursor))).unwrap();
    assert_eq!(steps(&report)[1], Step::Install);
    assert!(report.notes.is_empty());
    let cursor_copy = skill_path(&h, Agent::Cursor).unwrap();

    // Codex alone writes ~/.agents/skills, which Cursor reads too.
    let dry = run(
        &mut h,
        &Options {
            dry_run: true,
            ..opts(Agent::Codex)
        },
    )
    .unwrap();
    assert_eq!(dry.notes.len(), 1, "{:?}", dry.notes);
    assert!(dry.notes[0].contains("would then read"), "{}", dry.notes[0]);
    let report = run(&mut h, &yes(opts(Agent::Codex))).unwrap();
    assert!(!report.failed());
    assert_eq!(report.notes.len(), 1, "{:?}", report.notes);
    let note = slashes(&report.notes[0]);
    assert!(note.starts_with("Cursor now reads"), "{note}");
    assert!(note.contains("~/.agents/skills/webhooks-cc"), "{note}");
    assert!(note.contains("~/.cursor/skills/webhooks-cc"), "{note}");
    assert!(note.contains("`whk setup agent` without --agent"), "{note}");
    assert_eq!(report.to_json()["notes"][0], json!(report.notes[0]));
    let mut text = Vec::new();
    report.write_text(&h.env, &mut text).unwrap();
    assert!(
        String::from_utf8(text)
            .unwrap()
            .contains("\nNote: Cursor now reads")
    );
    assert!(cursor_copy.exists());

    // The note comes with the run that writes the shared copy; a full run
    // takes Cursor's copy out.
    let report = run(&mut h, &yes(opts(Agent::Codex))).unwrap();
    assert!(report.notes.is_empty(), "{:?}", report.notes);
    let report = run(&mut h, &yes(Options::default())).unwrap();
    assert!(report.notes.is_empty(), "{:?}", report.notes);
    assert!(!cursor_copy.exists());
}
