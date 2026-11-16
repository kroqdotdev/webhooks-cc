pub mod body;
pub mod format;
pub mod live;
pub mod parsed;
pub mod star;
pub mod url;

/// A request id as given on the command line, trimmed, or a usage error
/// (exit 2) when it cannot be one: the API's request ids are UUIDs, so
/// nothing is asked for an id that cannot exist.
pub fn request_id(value: &str) -> anyhow::Result<&str> {
    let value = value.trim();
    if is_uuid(value) {
        return Ok(value);
    }
    Err(crate::error::CliError::Usage(format!(
        "{} is not a request id: `whk requests list <slug>` shows them",
        crate::cli::output::sanitize_line(value)
    ))
    .into())
}

/// Whether a value is a UUID in its usual 8-4-4-4-12 hex form, as the API's
/// ids are.
pub fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}
