//! The webhooks.cc agent skill, embedded at build time from the one copy in
//! `plugins/webhooks-cc/skills/webhooks-cc/`. A test fails when a file is
//! added there and not here.

/// The skill's directory name, and its `name` in SKILL.md.
pub const NAME: &str = "webhooks-cc";

macro_rules! skill_file {
    ($path:literal) => {
        (
            $path,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/webhooks-cc/skills/webhooks-cc/",
                $path
            )),
        )
    };
}

/// (path inside the skill directory, contents), with `/` as the separator.
pub const FILES: &[(&str, &str)] = &[
    skill_file!("SKILL.md"),
    skill_file!("references/account.md"),
    skill_file!("references/cli.md"),
    skill_file!("references/email.md"),
    skill_file!("references/forwarding.md"),
    skill_file!("references/responses.md"),
    skill_file!("references/sdk-tests.md"),
    skill_file!("references/testing.md"),
    skill_file!("references/tunnels.md"),
];

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use super::*;

    fn read_tree(dir: &Path, prefix: &str, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if entry.file_type().unwrap().is_dir() {
                read_tree(&entry.path(), &rel, out);
            } else {
                out.insert(rel, std::fs::read_to_string(entry.path()).unwrap());
            }
        }
    }

    #[test]
    fn embeds_exactly_the_plugins_skill() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugins/webhooks-cc/skills/webhooks-cc");
        let mut on_disk = BTreeMap::new();
        read_tree(&dir, "", &mut on_disk);
        let embedded: BTreeMap<String, String> = FILES
            .iter()
            .map(|(path, text)| (path.to_string(), text.to_string()))
            .collect();
        assert_eq!(
            on_disk.keys().collect::<Vec<_>>(),
            embedded.keys().collect::<Vec<_>>(),
            "list every file of plugins/webhooks-cc/skills/webhooks-cc in FILES"
        );
        assert_eq!(
            on_disk, embedded,
            "the embedded skill differs from the plugin's"
        );
        assert!(
            embedded["SKILL.md"].contains(&format!("name: {NAME}\n")),
            "the skill's name is its directory name"
        );
    }
}
