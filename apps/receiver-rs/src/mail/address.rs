//! Recipient addresses: `{slug}[+tag]@{domain}`.
//!
//! The slug follows the same rule as the HTTP path (`is_valid_slug`, compared
//! in lowercase). The tag is free text the sender chose; it lands on the same
//! endpoint and is recorded so users can tell flows apart. Quoted local parts,
//! whitespace and other exotic forms are refused rather than interpreted.

use crate::handlers::webhook::is_valid_slug;

/// Longest local part SMTP allows (RFC 5321 section 4.5.3.1.1).
const MAX_LOCAL_PART: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAddress {
    pub slug: String,
    pub tag: Option<String>,
    pub domain: String,
}

impl MailAddress {
    /// Canonical form: lowercase slug and domain, tag as sent.
    pub fn normalized(&self) -> String {
        match &self.tag {
            Some(tag) => format!("{}+{}@{}", self.slug, tag, self.domain),
            None => format!("{}@{}", self.slug, self.domain),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressError {
    /// Not a form we accept: no `@`, bad slug, quoted local part, and so on.
    Invalid,
    /// A domain this service does not receive mail for.
    RelayDenied,
}

impl AddressError {
    pub fn as_status(self) -> &'static str {
        match self {
            AddressError::Invalid => "invalid",
            AddressError::RelayDenied => "relay_denied",
        }
    }
}

/// Parse an SMTP recipient (with or without angle brackets) for one of
/// `domains` (lowercase, without trailing dots).
pub fn parse_recipient(raw: &str, domains: &[String]) -> Result<MailAddress, AddressError> {
    let trimmed = raw.trim();
    let addr = trimmed
        .strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(trimmed);

    let (local, domain) = addr.rsplit_once('@').ok_or(AddressError::Invalid)?;
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty() {
        return Err(AddressError::Invalid);
    }
    if !domains.iter().any(|d| d == &domain) {
        return Err(AddressError::RelayDenied);
    }

    if local.is_empty() || local.len() > MAX_LOCAL_PART {
        return Err(AddressError::Invalid);
    }
    if !local
        .bytes()
        .all(|b| b.is_ascii_graphic() && !b"\"\\<>@(),;:[]".contains(&b))
    {
        return Err(AddressError::Invalid);
    }

    let (slug, tag) = match local.split_once('+') {
        Some((slug, tag)) => (slug, Some(tag)),
        None => (local, None),
    };
    let slug = slug.to_ascii_lowercase();
    if !is_valid_slug(&slug) {
        return Err(AddressError::Invalid);
    }
    let tag = tag.filter(|t| !t.is_empty()).map(str::to_string);

    Ok(MailAddress { slug, tag, domain })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn domains() -> Vec<String> {
        vec!["mailhooks.cc".to_string(), "dev.mailhooks.cc".to_string()]
    }

    #[test]
    fn parses_plain_and_tagged_addresses() {
        assert_eq!(
            parse_recipient("abc123@mailhooks.cc", &domains()),
            Ok(MailAddress {
                slug: "abc123".into(),
                tag: None,
                domain: "mailhooks.cc".into()
            })
        );
        let tagged = parse_recipient("<ABC123+Signup.Flow@MailHooks.CC.>", &domains()).unwrap();
        assert_eq!(tagged.slug, "abc123");
        assert_eq!(tagged.tag.as_deref(), Some("Signup.Flow"));
        assert_eq!(tagged.domain, "mailhooks.cc");
        assert_eq!(tagged.normalized(), "abc123+Signup.Flow@mailhooks.cc");
    }

    #[test]
    fn treats_an_empty_tag_as_none() {
        let addr = parse_recipient("abc+@mailhooks.cc", &domains()).unwrap();
        assert_eq!(addr.tag, None);
        assert_eq!(addr.normalized(), "abc@mailhooks.cc");
    }

    #[test]
    fn keeps_further_plus_signs_in_the_tag() {
        let addr = parse_recipient("abc+a+b@mailhooks.cc", &domains()).unwrap();
        assert_eq!(addr.slug, "abc");
        assert_eq!(addr.tag.as_deref(), Some("a+b"));
    }

    #[test]
    fn accepts_every_configured_domain() {
        let addr = parse_recipient("abc@dev.mailhooks.cc", &domains()).unwrap();
        assert_eq!(addr.domain, "dev.mailhooks.cc");
    }

    #[test]
    fn denies_other_domains() {
        assert_eq!(
            parse_recipient("abc@example.com", &domains()),
            Err(AddressError::RelayDenied)
        );
        assert_eq!(
            parse_recipient("abc@sub.mailhooks.cc", &domains()),
            Err(AddressError::RelayDenied)
        );
    }

    #[test]
    fn refuses_malformed_addresses() {
        for raw in [
            "",
            "abc",
            "@mailhooks.cc",
            "abc@",
            "\"quoted\"@mailhooks.cc",
            "a b@mailhooks.cc",
            "abc.def@mailhooks.cc",
            "+tag@mailhooks.cc",
            "abc\u{e9}@mailhooks.cc",
        ] {
            assert_eq!(
                parse_recipient(raw, &domains()),
                Err(AddressError::Invalid),
                "{raw:?}"
            );
        }
        let long = format!("{}@mailhooks.cc", "a".repeat(65));
        assert_eq!(
            parse_recipient(&long, &domains()),
            Err(AddressError::Invalid)
        );
    }
}
