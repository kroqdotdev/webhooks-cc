use chrono::{DateTime, Local, TimeZone, Utc};

/// Format a unix timestamp (ms) as a local time string.
pub fn format_timestamp(ts_ms: i64) -> String {
    let dt = Utc
        .timestamp_millis_opt(ts_ms)
        .single()
        .map(|utc| utc.with_timezone(&Local));
    match dt {
        Some(local) => local.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => "unknown".to_string(),
    }
}

/// Format bytes into human-readable string.
pub fn format_bytes(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Format a DateTime as ISO 8601 string, or parse one.
pub fn format_iso(ts_ms: i64) -> String {
    Utc.timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt: DateTime<Utc>| dt.to_rfc3339())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Parse a duration string like "30s", "5m", "1h", "7d" into milliseconds.
pub fn parse_duration(input: &str) -> anyhow::Result<i64> {
    let input = input.trim();
    if let Ok(ms) = input.parse::<i64>() {
        return Ok(ms);
    }

    let (num_str, unit) = if input.ends_with("ms") {
        (&input[..input.len() - 2], "ms")
    } else {
        let last = &input[input.len() - 1..];
        (&input[..input.len() - 1], last)
    };

    let num: f64 = num_str
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid duration: {input}"))?;

    let ms = match unit {
        "ms" => num,
        "s" => num * 1000.0,
        "m" => num * 60_000.0,
        "h" => num * 3_600_000.0,
        "d" => num * 86_400_000.0,
        _ => anyhow::bail!("unknown duration unit: {unit} (use ms, s, m, h, or d)"),
    };

    Ok(ms as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(500), "500 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1_572_864), "1.5 MB");
    }

    #[test]
    fn test_parse_duration() {
        assert_eq!(parse_duration("500").unwrap(), 500);
        assert_eq!(parse_duration("30s").unwrap(), 30_000);
        assert_eq!(parse_duration("5m").unwrap(), 300_000);
        assert_eq!(parse_duration("1h").unwrap(), 3_600_000);
        assert_eq!(parse_duration("7d").unwrap(), 604_800_000);
        assert_eq!(parse_duration("500ms").unwrap(), 500);
    }
}
