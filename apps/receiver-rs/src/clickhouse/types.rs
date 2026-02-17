use std::collections::HashMap;

use sha2::{Digest, Sha256};

use serde::{Deserialize, Serialize};

use crate::convex::types::{BufferedRequest, EndpointInfo};

/// A request row for ClickHouse insertion.
#[derive(Debug, Clone, Serialize)]
pub struct ClickHouseRequest {
    pub endpoint_id: String,
    pub slug: String,
    pub user_id: String,
    pub method: String,
    pub path: String,
    pub headers: String,
    pub body: String,
    pub query_params: String,
    pub ip: String,
    pub content_type: String,
    pub size: u32,
    pub is_ephemeral: bool,
    pub received_at: String, // DateTime64(3) as decimal seconds (e.g. "1739800496.789")
}

impl ClickHouseRequest {
    /// Convert a BufferedRequest + endpoint metadata into a ClickHouse row.
    pub fn from_buffered(req: &BufferedRequest, slug: &str, info: &EndpointInfo) -> Self {
        let content_type = req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| v.as_str())
            .unwrap_or_default()
            .to_string();

        let body_size = u32::try_from(req.body.len()).unwrap_or(u32::MAX);
        let headers_json = serde_json::to_string(&req.headers).unwrap_or_default();
        let query_json = serde_json::to_string(&req.query_params).unwrap_or_default();

        // Convert epoch ms to ISO 8601 with milliseconds for DateTime64(3)
        let received_at = epoch_ms_to_ch_decimal(req.received_at);

        Self {
            endpoint_id: info.endpoint_id.clone(),
            slug: slug.to_string(),
            user_id: info.user_id.clone().unwrap_or_default(),
            method: req.method.clone(),
            path: req.path.clone(),
            headers: headers_json,
            body: req.body.clone(),
            query_params: query_json,
            ip: req.ip.clone(),
            content_type,
            size: body_size,
            is_ephemeral: info.is_ephemeral,
            received_at,
        }
    }
}

/// Convert epoch milliseconds to a ClickHouse DateTime64(3) compatible string.
/// ClickHouse accepts epoch seconds as a float (e.g. "1739800496.789").
/// Uses div_euclid/rem_euclid for correct handling of negative timestamps.
fn epoch_ms_to_ch_decimal(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let subsec_ms = ms.rem_euclid(1000) as u64;
    format!("{secs}.{subsec_ms:03}")
}

/// A request row returned from ClickHouse queries.
#[derive(Debug, Clone, Deserialize)]
pub struct ClickHouseResponseRow {
    pub endpoint_id: String,
    pub slug: String,
    pub user_id: String,
    pub method: String,
    pub path: String,
    pub headers: String,
    pub body: String,
    pub query_params: String,
    pub ip: String,
    pub content_type: String,
    pub size: u32,
    pub is_ephemeral: bool,
    pub received_at: String,
}

/// Parsed request for API response (JSON-friendly).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultRequest {
    pub id: String,
    pub slug: String,
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub query_params: HashMap<String, String>,
    pub content_type: Option<String>,
    pub ip: String,
    pub size: u32,
    pub received_at: f64,
}

impl SearchResultRequest {
    pub fn from_row(row: &ClickHouseResponseRow) -> Self {
        let headers: HashMap<String, String> =
            serde_json::from_str(&row.headers).unwrap_or_default();
        let query_params: HashMap<String, String> =
            serde_json::from_str(&row.query_params).unwrap_or_default();

        // Parse received_at from ClickHouse DateTime64 string to epoch ms
        let received_at = parse_received_at(&row.received_at);

        let body = if row.body.is_empty() {
            None
        } else {
            Some(row.body.clone())
        };

        let content_type = if row.content_type.is_empty() {
            None
        } else {
            Some(row.content_type.clone())
        };

        // Synthetic ID: slug:received_at_ms:hash
        // Uses SHA-256 (stable across Rust versions) with all distinguishing fields.
        // Null byte separators prevent field-boundary collisions.
        let mut hasher = Sha256::new();
        hasher.update(row.method.as_bytes());
        hasher.update(b"\x00");
        hasher.update(row.path.as_bytes());
        hasher.update(b"\x00");
        hasher.update(row.headers.as_bytes());
        hasher.update(b"\x00");
        hasher.update(row.body.as_bytes());
        hasher.update(b"\x00");
        hasher.update(row.query_params.as_bytes());
        hasher.update(b"\x00");
        hasher.update(row.ip.as_bytes());
        let digest = hasher.finalize();
        let hash_suffix = u64::from_le_bytes(digest[..8].try_into().unwrap());
        let id = format!("{}:{}:{:016x}", row.slug, received_at as i64, hash_suffix);

        Self {
            id,
            slug: row.slug.clone(),
            method: row.method.clone(),
            path: row.path.clone(),
            headers,
            body,
            query_params,
            content_type,
            ip: row.ip.clone(),
            size: row.size,
            received_at,
        }
    }
}

/// Parse ClickHouse DateTime64 response to epoch milliseconds.
/// ClickHouse returns DateTime64(3) as "2026-02-17 12:34:56.789" in JSON format.
fn parse_received_at(s: &str) -> f64 {
    // Try parsing as epoch seconds with millis (e.g. "1739800496.789")
    // Sanity check: epoch seconds should be in a reasonable range (2000-01-01 to 2100-01-01)
    if let Ok(f) = s.parse::<f64>()
        && f > 946_684_800.0
        && f < 4_102_444_800.0
    {
        return f * 1000.0;
    }
    // Try parsing as "YYYY-MM-DD HH:MM:SS.mmm" format
    // Simple manual parse for the common ClickHouse format
    if s.len() >= 19 {
        // We have at least "YYYY-MM-DD HH:MM:SS"
        let parts: Vec<&str> = s.split('.').collect();
        let datetime_part = parts[0];
        let millis: u64 = if parts.len() > 1 {
            let frac = &parts[1][..parts[1].len().min(3)];
            // Right-pad with zeros: "7" → 700, "78" → 780, "789" → 789
            match frac.len() {
                1 => frac.parse::<u64>().unwrap_or(0) * 100,
                2 => frac.parse::<u64>().unwrap_or(0) * 10,
                _ => frac.parse::<u64>().unwrap_or(0),
            }
        } else {
            0
        };

        // Parse "YYYY-MM-DD HH:MM:SS" manually
        if let Some(epoch_secs) = parse_datetime_to_epoch(datetime_part) {
            return (epoch_secs * 1000 + millis as i64) as f64;
        }
    }
    tracing::warn!(value = s, "failed to parse ClickHouse received_at timestamp");
    0.0
}

/// Parse "YYYY-MM-DD HH:MM:SS" to epoch seconds.
fn parse_datetime_to_epoch(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }

    let year: i64 = s[0..4].parse().ok()?;
    let month: i64 = s[5..7].parse().ok()?;
    let day: i64 = s[8..10].parse().ok()?;
    let hour: i64 = s[11..13].parse().ok()?;
    let min: i64 = s[14..16].parse().ok()?;
    let sec: i64 = s[17..19].parse().ok()?;

    // Validate ranges to prevent panics on malformed data
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&min)
        || !(0..=59).contains(&sec)
    {
        return None;
    }

    // Simplified days-from-epoch calculation (no leap second handling)
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let month_days = [
        31,
        28 + i64::from(is_leap_year(year)),
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    for &d in &month_days[..(month - 1) as usize] {
        days += d;
    }
    days += day - 1;

    Some(days * 86400 + hour * 3600 + min * 60 + sec)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
