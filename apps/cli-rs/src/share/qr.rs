//! A QR code of a link, drawn in the terminal so a phone can open it:
//! two rows of the code to a line of half blocks, black on white whatever
//! the terminal's colours, since a phone's camera wants dark on light.

use qrcode::{EcLevel, QrCode};

/// The light border the code needs around it, in modules. The standard
/// asks for four; two scans as well on a screen and keeps it short.
const QUIET: usize = 2;

/// Black on white, from the 256-colour palette so a theme cannot tint it.
const INK_ON_PAPER: &str = "\x1b[38;5;16;48;5;231m";
const RESET: &str = "\x1b[0m";

/// The lines of the code, ready to print, or None when the text is too
/// long for a QR code.
pub fn lines(text: &str) -> Option<Vec<String>> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L).ok()?;
    let width = code.width();
    let dark = |x: usize, y: usize| -> bool {
        // Outside the code is the light border.
        let inside = |v: usize| v >= QUIET && v < width + QUIET;
        inside(x) && inside(y) && code[(x - QUIET, y - QUIET)] == qrcode::Color::Dark
    };
    let size = width + 2 * QUIET;
    let mut lines = Vec::with_capacity(size.div_ceil(2));
    for y in (0..size).step_by(2) {
        let mut line = String::from(INK_ON_PAPER);
        for x in 0..size {
            line.push(match (dark(x, y), y + 1 < size && dark(x, y + 1)) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        line.push_str(RESET);
        lines.push(line);
    }
    Some(lines)
}

/// Prints the code for a link, indented like the lines around it, with
/// what it is for.
pub fn print(url: &str) {
    let Some(lines) = lines(url) else { return };
    for line in lines {
        println!("  {line}");
    }
    println!("  Scan it to open the link on a phone.");
}

/// Whether to draw it: at a terminal that takes colours (term.rs), unless
/// they are off (NO_COLOR), since without them a dark terminal shows the
/// code inverted.
pub fn wanted(at_terminal: bool) -> bool {
    wanted_with(at_terminal, std::env::var_os("NO_COLOR"))
}

fn wanted_with(at_terminal: bool, no_color: Option<std::ffi::OsString>) -> bool {
    at_terminal && no_color.is_none_or(|v| v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The code's modules back from the drawing.
    fn modules(lines: &[String]) -> Vec<Vec<bool>> {
        let mut rows = Vec::new();
        for line in lines {
            let text = line
                .strip_prefix(INK_ON_PAPER)
                .and_then(|l| l.strip_suffix(RESET))
                .expect("coloured black on white");
            let (top, bottom): (Vec<bool>, Vec<bool>) = text
                .chars()
                .map(|c| match c {
                    '█' => (true, true),
                    '▀' => (true, false),
                    '▄' => (false, true),
                    _ => (false, false),
                })
                .unzip();
            rows.push(top);
            rows.push(bottom);
        }
        rows
    }

    #[test]
    fn draws_the_code_with_a_light_border() {
        let url = "https://quiet-otter-1234.sharehooks.cc";
        let lines = lines(url).unwrap();
        let code = QrCode::with_error_correction_level(url.as_bytes(), EcLevel::L).unwrap();
        let size = code.width() + 2 * QUIET;
        assert_eq!(lines.len(), size.div_ceil(2));
        let drawn = modules(&lines);
        for (y, row) in drawn.iter().take(size).enumerate() {
            assert_eq!(row.len(), size);
            for (x, &dark) in row.iter().enumerate() {
                let want = (QUIET..code.width() + QUIET).contains(&x)
                    && (QUIET..code.width() + QUIET).contains(&y)
                    && code[(x - QUIET, y - QUIET)] == qrcode::Color::Dark;
                assert_eq!(dark, want, "module {x},{y}");
            }
        }
        // Short enough for any terminal.
        assert!(size <= 41, "{size} columns");
    }

    #[test]
    fn a_reader_gets_the_link_back_from_the_drawing() {
        let url = "https://acme.sharehooks.cc";
        let drawn = modules(&lines(url).unwrap());
        // Four pixels a module, as a camera would see the screen.
        let scale = 4;
        let size = drawn[0].len();
        let mut image = rqrr::PreparedImage::prepare_from_greyscale(
            size * scale,
            drawn.len() * scale,
            |x, y| {
                if drawn[y / scale][x / scale] { 0 } else { 255 }
            },
        );
        let grids = image.detect_grids();
        assert_eq!(grids.len(), 1);
        let (_, content) = grids[0].decode().unwrap();
        assert_eq!(content, url);
    }

    #[test]
    fn drawn_only_at_a_terminal_with_colours() {
        assert!(wanted_with(true, None));
        assert!(wanted_with(true, Some("".into())), "NO_COLOR set empty");
        assert!(!wanted_with(true, Some("1".into())));
        assert!(!wanted_with(false, None), "piped or in a file");
    }

    #[test]
    fn too_long_a_text_has_no_code() {
        assert!(lines(&"x".repeat(8000)).is_none());
    }
}
