pub mod body;
pub mod format;
pub mod live;
pub mod parsed;
pub mod star;
pub mod url;

/// Whether a value is a UUID in its usual 8-4-4-4-12 hex form, as the API's
/// ids are.
pub fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}
