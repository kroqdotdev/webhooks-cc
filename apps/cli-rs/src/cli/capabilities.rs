//! `capabilities.json` at the repository root names, for each capability,
//! the `whk` commands that reach it. These tests hold that column to the
//! command tree; the SDK's and the MCP server's tests check the rest.

use std::collections::BTreeSet;

use clap::CommandFactory;
use serde_json::Value;

use super::Cli;

/// Every command that runs something, as typed after `whk` ("requests list").
fn leaf_commands() -> BTreeSet<String> {
    fn walk(command: &clap::Command, prefix: &str, out: &mut BTreeSet<String>) {
        for sub in command.get_subcommands() {
            let name = sub.get_name();
            if name == "help" {
                continue;
            }
            let path = if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix} {name}")
            };
            if sub.has_subcommands() {
                // A command that also runs on its own (`whk billing`) is
                // one too.
                if !sub.is_subcommand_required_set() {
                    out.insert(path.clone());
                }
                walk(sub, &path, out);
            } else {
                out.insert(path);
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(&Cli::command(), "", &mut out);
    out
}

/// (where it is listed, command) for every command the file names.
fn listed() -> Vec<(String, String)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../capabilities.json");
    let text = std::fs::read_to_string(path).expect("capabilities.json at the repository root");
    let manifest: Value = serde_json::from_str(&text).expect("capabilities.json is JSON");
    let mut out = Vec::new();
    for capability in manifest["capabilities"].as_array().expect("capabilities") {
        let id = capability["id"].as_str().unwrap_or("?").to_string();
        // A string is the reason the CLI has no command for it.
        if let Some(commands) = capability["cli"].as_array() {
            for command in commands {
                out.push((id.clone(), command.as_str().unwrap_or("").to_string()));
            }
        }
    }
    for command in manifest["local"]["cli"]
        .as_object()
        .expect("local.cli")
        .keys()
    {
        out.push(("local.cli".to_string(), command.clone()));
    }
    out
}

#[test]
fn names_commands_whk_has() {
    let commands = leaf_commands();
    for (id, command) in listed() {
        assert!(
            commands.contains(&command),
            "{id}: whk has no command `{command}`"
        );
    }
}

#[test]
fn lists_every_command() {
    let names: BTreeSet<String> = listed().into_iter().map(|(_, command)| command).collect();
    let missing: Vec<_> = leaf_commands().difference(&names).cloned().collect();
    assert!(
        missing.is_empty(),
        "add these commands to a capability in capabilities.json (or to local.cli): {missing:?}"
    );
}
