use ratatui::style::{Color, Modifier, Style};

// Neobrutalism palette — bold, high-contrast
pub const PRIMARY: Color = Color::Rgb(255, 107, 53); // #FF6B35 orange
pub const SECONDARY: Color = Color::Rgb(0, 78, 137); // #004E89 dark blue
pub const ACCENT: Color = Color::Rgb(252, 191, 73); // #FCBF49 yellow
pub const SUCCESS: Color = Color::Rgb(46, 196, 182); // #2EC4B6 teal
pub const DANGER: Color = Color::Rgb(231, 29, 54); // #E71D36 red
pub const MUTED: Color = Color::Rgb(107, 114, 128); // #6B7280 gray
pub const SURFACE: Color = Color::Rgb(17, 24, 39); // #111827 dark bg
pub const SURFACE_RAISED: Color = Color::Rgb(31, 41, 55); // #1F2937 slightly lighter
pub const BORDER: Color = Color::Rgb(55, 65, 81); // #374151 border gray
pub const TEXT: Color = Color::Rgb(243, 244, 246); // #F3F4F6 light text
pub const TEXT_DIM: Color = Color::Rgb(156, 163, 175); // #9CA3AF dimmed text

// Method colors (matching Go CLI)
pub const METHOD_GET: Color = Color::Rgb(16, 185, 129); // #10B981 green
pub const METHOD_POST: Color = Color::Rgb(59, 130, 246); // #3B82F6 blue
pub const METHOD_PUT: Color = Color::Rgb(245, 158, 11); // #F59E0B amber
pub const METHOD_DELETE: Color = Color::Rgb(239, 68, 68); // #EF4444 red
pub const METHOD_PATCH: Color = Color::Rgb(168, 85, 247); // #A855F7 purple

// Status colors
pub const STATUS_OK: Color = Color::Rgb(34, 197, 94); // #22C55E green
pub const STATUS_REDIRECT: Color = Color::Rgb(234, 179, 8); // #EAB308 yellow
pub const STATUS_CLIENT_ERR: Color = Color::Rgb(249, 115, 22); // #F97316 orange
pub const STATUS_SERVER_ERR: Color = Color::Rgb(239, 68, 68); // #EF4444 red

pub fn method_color(method: &str) -> Color {
    match method.to_uppercase().as_str() {
        "GET" => METHOD_GET,
        "POST" => METHOD_POST,
        "PUT" => METHOD_PUT,
        "DELETE" => METHOD_DELETE,
        "PATCH" => METHOD_PATCH,
        "HEAD" => METHOD_GET,
        "OPTIONS" => MUTED,
        _ => TEXT,
    }
}

pub fn status_color(status: u16) -> Color {
    match status {
        200..=299 => STATUS_OK,
        300..=399 => STATUS_REDIRECT,
        400..=499 => STATUS_CLIENT_ERR,
        500..=599 => STATUS_SERVER_ERR,
        _ => TEXT,
    }
}

// Reusable style constructors
pub fn style() -> Style {
    Style::default().fg(TEXT)
}

pub fn style_dim() -> Style {
    Style::default().fg(TEXT_DIM)
}

pub fn style_bold() -> Style {
    Style::default().fg(TEXT).add_modifier(Modifier::BOLD)
}

pub fn style_primary() -> Style {
    Style::default().fg(PRIMARY)
}

pub fn style_primary_bold() -> Style {
    Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD)
}

pub fn style_accent() -> Style {
    Style::default().fg(ACCENT)
}

pub fn style_success() -> Style {
    Style::default().fg(SUCCESS)
}

pub fn style_danger() -> Style {
    Style::default().fg(DANGER)
}

pub fn style_muted() -> Style {
    Style::default().fg(MUTED)
}

pub fn style_surface() -> Style {
    Style::default().bg(SURFACE)
}

pub fn style_highlight() -> Style {
    Style::default()
        .bg(Color::Rgb(55, 65, 81))
        .fg(TEXT)
}

pub fn style_selected() -> Style {
    Style::default()
        .bg(PRIMARY)
        .fg(Color::Rgb(17, 24, 39))
        .add_modifier(Modifier::BOLD)
}
