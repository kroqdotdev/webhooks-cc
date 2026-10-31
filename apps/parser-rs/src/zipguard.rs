//! Refuses zip bombs before a spreadsheet library unpacks anything.
//!
//! XLSX and ODS files are zip archives. The central directory declares each
//! entry's sizes, and the zip crate refuses to inflate an entry past its
//! declared size, so checking the declared sizes bounds what any later
//! reader can inflate. Lying headers therefore fail the read instead of
//! filling memory; the process rlimits stay as the second line of defence.

use std::io::Cursor;

use crate::output::{ErrorCode, Failure};

/// Largest total uncompressed size of all entries.
pub(crate) const MAX_TOTAL_UNCOMPRESSED: u64 = 200 * 1024 * 1024;
/// Most entries an archive may have.
pub(crate) const MAX_ENTRIES: usize = 10_000;
/// Highest uncompressed-to-compressed ratio of a single entry.
pub(crate) const MAX_RATIO: u64 = 200;
/// Entries smaller than this skip the ratio check: they cannot exhaust
/// anything, and a small run of identical bytes compresses far beyond any
/// sensible ratio (an empty sheet part is a typical example).
pub(crate) const RATIO_FLOOR: u64 = 1024 * 1024;

const BOMB: Failure = Failure::new(ErrorCode::ZipBomb, "the archive expands too much");

/// Opens the archive's central directory and checks its declared sizes.
pub(crate) fn check(input: &[u8]) -> Result<(), Failure> {
    let mut archive = zip::ZipArchive::new(Cursor::new(input))
        .map_err(|_| Failure::malformed("the file is not a readable zip archive"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(BOMB);
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|_| Failure::malformed("the file is not a readable zip archive"))?;
        let size = entry.size();
        let compressed = entry.compressed_size().max(1);
        total = total.saturating_add(size);
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(BOMB);
        }
        if size > RATIO_FLOOR && size / compressed > MAX_RATIO {
            return Err(BOMB);
        }
    }
    Ok(())
}

/// What a zip archive holds, judged by its entry names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ZipKind {
    Xlsx,
    Ods,
    Other,
}

/// Tells an OpenDocument spreadsheet from an Office Open XML workbook, so a
/// file with the wrong extension still reaches the right reader.
pub(crate) fn kind(input: &[u8]) -> ZipKind {
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(input)) else {
        return ZipKind::Other;
    };
    if archive.index_for_name("content.xml").is_some() {
        if let Ok(mut f) = archive.by_name("mimetype") {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut std::io::Read::take(&mut f, 128), &mut buf);
            if buf.starts_with(b"application/vnd.oasis.opendocument.spreadsheet") {
                return ZipKind::Ods;
            }
            return ZipKind::Other;
        }
        return ZipKind::Ods;
    }
    if archive.index_for_name("xl/workbook.xml").is_some()
        || archive.index_for_name("[Content_Types].xml").is_some()
    {
        return ZipKind::Xlsx;
    }
    ZipKind::Other
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Builds a zip archive from (name, contents) pairs, deflated.
    pub(crate) fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn ordinary_archives_pass() {
        let z = zip_of(&[("a.xml", b"<a/>"), ("b.xml", &[b'x'; 1000])]);
        assert_eq!(check(&z), Ok(()));
    }

    #[test]
    fn highly_compressible_entries_are_bombs() {
        let zeros = vec![0u8; 4 * 1024 * 1024];
        let z = zip_of(&[("xl/worksheets/sheet1.xml", &zeros)]);
        assert!(z.len() < 64 * 1024);
        assert_eq!(check(&z).unwrap_err().code, ErrorCode::ZipBomb);
    }

    #[test]
    fn too_many_entries_is_a_bomb() {
        let names: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("f{i}")).collect();
        let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
        let z = zip_of(&entries);
        assert_eq!(check(&z).unwrap_err().code, ErrorCode::ZipBomb);
    }

    #[test]
    fn declared_sizes_over_the_total_are_a_bomb() {
        // A stored entry whose central directory claims 4 GiB.
        let mut z = zip_of(&[("a.xml", b"hello")]);
        let cd = z
            .windows(4)
            .rposition(|w| w == b"PK\x01\x02")
            .expect("central directory");
        z[cd + 24..cd + 28].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(check(&z).unwrap_err().code, ErrorCode::ZipBomb);
    }

    #[test]
    fn garbage_is_malformed() {
        assert_eq!(
            check(b"PK\x03\x04garbage").unwrap_err().code,
            ErrorCode::Malformed
        );
    }
}
