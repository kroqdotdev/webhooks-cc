use std::sync::atomic::{AtomicBool, Ordering};

use crate::types::{CapturedRequest, Endpoint, UsageInfo};
use crate::util::format::{format_bytes, format_timestamp};

static NO_COLOR: AtomicBool = AtomicBool::new(false);

pub fn set_no_color(val: bool) {
    NO_COLOR.store(val, Ordering::Relaxed);
}

fn no_color() -> bool {
    NO_COLOR.load(Ordering::Relaxed)
}

pub fn bold(s: &str) -> String {
    if no_color() { s.to_string() } else { format!("\x1b[1m{s}\x1b[0m") }
}

pub fn dim(s: &str) -> String {
    if no_color() { s.to_string() } else { format!("\x1b[2m{s}\x1b[0m") }
}

pub fn green(s: &str) -> String {
    if no_color() { s.to_string() } else { format!("\x1b[32m{s}\x1b[0m") }
}

pub fn red(s: &str) -> String {
    if no_color() { s.to_string() } else { format!("\x1b[31m{s}\x1b[0m") }
}

pub fn method_color(method: &str) -> String {
    if no_color() {
        return method.to_string();
    }
    match method.to_uppercase().as_str() {
        "GET" => format!("\x1b[32m{method}\x1b[0m"),
        "POST" => format!("\x1b[34m{method}\x1b[0m"),
        "PUT" => format!("\x1b[33m{method}\x1b[0m"),
        "DELETE" => format!("\x1b[31m{method}\x1b[0m"),
        "PATCH" => format!("\x1b[36m{method}\x1b[0m"),
        _ => method.to_string(),
    }
}

pub fn print_endpoint_table(endpoints: &[Endpoint], webhook_url: &str) {
    if endpoints.is_empty() {
        println!("  No endpoints found.");
        return;
    }
    println!(
        "  {:<20} {:<20} {:<16} {}",
        dim("SLUG"), dim("NAME"), dim("TEAM"), dim("URL"),
    );
    for ep in endpoints {
        let name = ep.name.as_deref().unwrap_or("-");
        let url = format!("{}/w/{}", webhook_url, ep.slug);
        let team = if let Some(ref from) = ep.from_team {
            format!("[-> {}]", from.team_name)
        } else if !ep.shared_with.is_empty() {
            format!("[{}]", ep.shared_with.iter().map(|t| t.team_name.as_str()).collect::<Vec<_>>().join(", "))
        } else {
            String::new()
        };
        println!("  {:<20} {:<20} {:<16} {}", bold(&ep.slug), dim(name), dim(&team), dim(&url));
    }
}

pub fn print_request_line(req: &CapturedRequest) {
    let time = format_timestamp(req.received_at);
    let method = method_color(&req.method);
    let size = format_bytes(req.size);
    println!("  {} {} {} {}", dim(&time), method, req.path, dim(&size));
}

pub fn print_request_detail(req: &CapturedRequest) {
    println!("{}", bold("Request Details"));
    println!("  {} {}", dim("ID:"), req.id);
    println!("  {} {} {}", dim("Method:"), method_color(&req.method), req.path);
    println!("  {} {}", dim("IP:"), req.ip);
    println!("  {} {}", dim("Size:"), format_bytes(req.size));
    println!("  {} {}", dim("Time:"), format_timestamp(req.received_at));

    if let Some(ref ct) = req.content_type {
        println!("  {} {}", dim("Content-Type:"), ct);
    }

    if !req.query_params.is_empty() {
        println!("\n{}", bold("Query Parameters"));
        for (k, v) in &req.query_params {
            println!("  {} = {}", bold(k), v);
        }
    }

    if !req.headers.is_empty() {
        println!("\n{}", bold("Headers"));
        let mut headers: Vec<_> = req.headers.iter().collect();
        headers.sort_by_key(|(k, _)| k.to_lowercase());
        for (k, v) in headers {
            println!("  {}: {}", bold(k), v);
        }
    }

    if let Some(ref body) = req.body {
        println!("\n{}", bold("Body"));
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(body) {
            println!("{}", serde_json::to_string_pretty(&val).unwrap_or_else(|_| body.clone()));
        } else {
            println!("{body}");
        }
    }
}

pub fn print_usage(usage: &UsageInfo) {
    println!("{}", bold("Usage"));
    println!("  {} {}", dim("Plan:"), usage.plan);
    println!(
        "  {} {}/{} ({} remaining)",
        dim("Requests:"), usage.used, usage.limit, usage.remaining
    );
    if let Some(pe) = usage.period_end {
        println!("  {} {}", dim("Period ends:"), format_timestamp(pe));
    }
}
