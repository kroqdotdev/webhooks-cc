use base64::Engine;

/// Resolve the request body for forwarding/replay.
///
/// Prefers base64-decoded `body_raw` (exact bytes) when present.
/// Falls back to the lossy text `body` if raw decoding fails or is absent.
pub fn resolve_body(body_raw: Option<&str>, body: Option<&str>) -> Option<Vec<u8>> {
    if let Some(raw) = body_raw {
        match base64::engine::general_purpose::STANDARD.decode(raw) {
            Ok(bytes) => return Some(bytes),
            Err(e) => {
                eprintln!("warn: body_raw base64 decode failed: {e}, falling back to text body");
            }
        }
    }
    body.map(|b| b.as_bytes().to_vec())
}
