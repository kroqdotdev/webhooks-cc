//! Turning cell values into the strings the web app receives.
//!
//! Every format renders numbers, dates and text the same way, so a value
//! looks identical whether it arrived in an XLSX, an XLS or an ODS file.

/// A cell longer than this is cut, so one cell cannot dominate the output.
pub(crate) const MAX_CELL_BYTES: usize = 32 * 1024;
/// Columns past this are dropped from every row.
pub(crate) const MAX_COLUMNS: usize = 1024;

/// Clips a string to [`MAX_CELL_BYTES`] on a character boundary and removes
/// NUL characters, which Postgres refuses in text and jsonb values.
pub(crate) fn clip(s: &str) -> String {
    let cut = floor_char_boundary(s, MAX_CELL_BYTES);
    let s = &s[..cut];
    if s.contains('\0') {
        s.replace('\0', "")
    } else {
        s.to_string()
    }
}

/// [`clip`] for an owned string, reusing its allocation when nothing changes.
pub(crate) fn clip_owned(mut s: String) -> String {
    if s.len() > MAX_CELL_BYTES {
        let cut = floor_char_boundary(&s, MAX_CELL_BYTES);
        s.truncate(cut);
    }
    if s.contains('\0') {
        s.retain(|c| c != '\0');
    }
    s
}

/// The largest index `<= max` that falls on a character boundary of `s`.
pub(crate) fn floor_char_boundary(s: &str, max: usize) -> usize {
    if s.len() <= max {
        return s.len();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Formats a number the way JavaScript's `String(n)` does, after rounding to
/// the 15 significant digits a spreadsheet actually keeps. Without the
/// rounding, binary noise such as `0.30000000000000004` would reach users
/// who saw `0.3` in Excel.
pub(crate) fn number(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if v == 0.0 {
        // Also turns -0 into "0", as JavaScript does.
        return "0".to_string();
    }
    let v = round_significant(v, 15);
    let a = v.abs();
    if !(1e-6..1e21).contains(&a) {
        // Same switch-over points and shape as JavaScript: 1e+21, 1.5e-7.
        let s = format!("{v:e}");
        return match s.find('e') {
            Some(pos) if !s[pos + 1..].starts_with('-') => {
                format!("{}e+{}", &s[..pos], &s[pos + 1..])
            }
            _ => s,
        };
    }
    // Rust's Display is the shortest string that round-trips and never uses
    // an exponent, which is what we want inside the range above.
    format!("{v}")
}

fn round_significant(v: f64, digits: usize) -> f64 {
    // Printing with a fixed number of significant digits and parsing back is
    // exact, unlike scaling by powers of ten.
    let s = format!("{:.*e}", digits - 1, v);
    s.parse().unwrap_or(v)
}

/// Excel serials at or past this are after 9999-12-31, which no spreadsheet
/// can display as a date.
const MAX_EXCEL_SERIAL: f64 = 2_958_466.0;

/// Renders an Excel date serial (days since the workbook's epoch, the
/// fraction being the time of day) as ISO 8601: `2026-10-29` for a date,
/// `2026-10-29T13:45:00` for a date with a time, and `13:45:00` for a time
/// of day without a date (serial below 1).
pub(crate) fn excel_datetime(serial: f64, is_1904: bool) -> String {
    if !serial.is_finite() || !(0.0..MAX_EXCEL_SERIAL).contains(&serial) {
        return number(serial);
    }
    let mut days = serial.floor() as i64;
    let mut secs = ((serial - days as f64) * 86_400.0).round() as i64;
    if secs >= 86_400 {
        days += 1;
        secs -= 86_400;
    }
    let (h, m, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    if days == 0 {
        return format!("{h:02}:{m:02}:{s:02}");
    }
    let (y, mo, d) = if is_1904 {
        civil_from_days(days_from_civil(1904, 1, 1) + days)
    } else if days == 60 {
        // Excel's 1900 leap-year bug: serial 60 is the 29th of February 1900,
        // a day that never existed but that Excel shows.
        (1900, 2, 29)
    } else if days < 60 {
        civil_from_days(days_from_civil(1899, 12, 31) + days)
    } else {
        civil_from_days(days_from_civil(1899, 12, 30) + days)
    };
    if secs == 0 {
        format!("{y:04}-{mo:02}-{d:02}")
    } else {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}")
    }
}

/// Renders an elapsed-time value (an `[h]:mm:ss` style cell, in days) as an
/// ISO 8601 duration such as `PT36H05M00S`, the shape ODS files use.
pub(crate) fn excel_duration(serial: f64) -> String {
    if !serial.is_finite() || serial.abs() >= MAX_EXCEL_SERIAL {
        return number(serial);
    }
    let total = (serial * 86_400.0).round() as i64;
    let sign = if total < 0 { "-" } else { "" };
    let total = total.abs();
    let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60);
    format!("{sign}PT{h}H{m:02}M{s:02}S")
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The text Excel shows for an error cell, from the BIFF error code.
pub(crate) fn excel_error(code: u8) -> &'static str {
    match code {
        0x00 => "#NULL!",
        0x07 => "#DIV/0!",
        0x0F => "#VALUE!",
        0x17 => "#REF!",
        0x1D => "#NAME?",
        0x24 => "#NUM!",
        0x2A => "#N/A",
        0x2B => "#GETTING_DATA",
        _ => "#ERROR!",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_look_like_javascript() {
        assert_eq!(number(1.0), "1");
        assert_eq!(number(-0.0), "0");
        assert_eq!(number(0.0), "0");
        assert_eq!(number(1.5), "1.5");
        assert_eq!(number(-2.25), "-2.25");
        assert_eq!(number(0.1 + 0.2), "0.3");
        assert_eq!(number(1234.5600000000001), "1234.56");
        assert_eq!(number(1e20), "100000000000000000000");
        assert_eq!(number(1e21), "1e+21");
        assert_eq!(number(1.5e300), "1.5e+300");
        assert_eq!(number(0.000001), "0.000001");
        assert_eq!(number(1.5e-7), "1.5e-7");
        assert_eq!(number(123456789012.0), "123456789012");
        assert_eq!(number(f64::NAN), "NaN");
        assert_eq!(number(f64::INFINITY), "Infinity");
        assert_eq!(number(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn excel_dates_follow_the_1900_system() {
        assert_eq!(excel_datetime(1.0, false), "1900-01-01");
        assert_eq!(excel_datetime(59.0, false), "1900-02-28");
        assert_eq!(excel_datetime(60.0, false), "1900-02-29");
        assert_eq!(excel_datetime(61.0, false), "1900-03-01");
        assert_eq!(excel_datetime(46324.0, false), "2026-10-29");
        assert_eq!(
            excel_datetime(46324.0 + 13.75 / 24.0, false),
            "2026-10-29T13:45:00"
        );
        assert_eq!(excel_datetime(0.5, false), "12:00:00");
        // Rounds to the second and carries into the next day.
        assert_eq!(excel_datetime(46_324.999_999_99, false), "2026-10-30");
    }

    #[test]
    fn excel_dates_follow_the_1904_system() {
        assert_eq!(excel_datetime(1.0, true), "1904-01-02");
        assert_eq!(excel_datetime(44862.0, true), "2026-10-29");
    }

    #[test]
    fn out_of_range_dates_fall_back_to_numbers() {
        assert_eq!(excel_datetime(-1.0, false), "-1");
        assert_eq!(excel_datetime(3_000_000.0, false), "3000000");
        assert_eq!(excel_datetime(f64::NAN, false), "NaN");
        assert_eq!(excel_datetime(2_958_465.0, false), "9999-12-31");
    }

    #[test]
    fn durations_are_iso_8601() {
        assert_eq!(excel_duration(1.5), "PT36H00M00S");
        assert_eq!(excel_duration(1.0 / 24.0 + 5.0 / 1440.0), "PT1H05M00S");
        assert_eq!(excel_duration(-0.5), "-PT12H00M00S");
    }

    #[test]
    fn clip_cuts_on_a_character_boundary_and_drops_nul() {
        let long = "é".repeat(MAX_CELL_BYTES);
        let clipped = clip(&long);
        assert!(clipped.len() <= MAX_CELL_BYTES);
        assert_eq!(clipped.len() % 2, 0);
        assert_eq!(clip("a\0b"), "ab");
        assert_eq!(
            clip_owned("x".repeat(MAX_CELL_BYTES + 5)).len(),
            MAX_CELL_BYTES
        );
        assert_eq!(clip_owned("a\0".to_string()), "a");
    }
}
