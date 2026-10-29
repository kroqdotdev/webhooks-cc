//! Recipient addresses: `{slug}[+tag]@{domain}` at a capture domain, or
//! `{local}[+tag]@{domain}` at a customer's own inbound domain, which the
//! database maps to an endpoint (`resolve_inbound_recipient`, migration 00072).
//!
//! The slug follows the same rule as the HTTP path (`is_valid_slug`, compared
//! in lowercase). The tag is free text the sender chose; it lands on the same
//! endpoint and is recorded so users can tell flows apart. Quoted local parts,
//! whitespace and other exotic forms are refused rather than interpreted.

use crate::handlers::webhook::is_valid_slug;

/// Longest local part SMTP allows (RFC 5321 section 4.5.3.1.1).
const MAX_LOCAL_PART: usize = 64;
/// Longest domain name (RFC 1035).
const MAX_DOMAIN: usize = 253;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAddress {
    /// The endpoint the mail is for.
    pub slug: String,
    /// The local part without its tag, lowercase: the slug at a capture
    /// domain, the address's own name at a custom domain.
    pub local: String,
    pub tag: Option<String>,
    pub domain: String,
}

impl MailAddress {
    /// Canonical form: lowercase local part and domain, tag as sent.
    pub fn normalized(&self) -> String {
        match &self.tag {
            Some(tag) => format!("{}+{}@{}", self.local, tag, self.domain),
            None => format!("{}@{}", self.local, self.domain),
        }
    }
}

/// A recipient at a domain other than the capture domains. It is mail for an
/// endpoint only if a verified customer domain routes it there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAddress {
    pub local: String,
    pub tag: Option<String>,
    pub domain: String,
}

impl CustomAddress {
    /// The address at its endpoint, once the database named the slug.
    pub fn for_slug(self, slug: String) -> MailAddress {
        MailAddress {
            slug,
            local: self.local,
            tag: self.tag,
            domain: self.domain,
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

/// The local part and the lowercase domain of an SMTP recipient (with or
/// without angle brackets), with the local part checked for exotic forms.
fn split(raw: &str) -> Result<(&str, String), AddressError> {
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
    if local.is_empty() || local.len() > MAX_LOCAL_PART {
        return Err(AddressError::Invalid);
    }
    if !local
        .bytes()
        .all(|b| b.is_ascii_graphic() && !b"\"\\<>@(),;:[]".contains(&b))
    {
        return Err(AddressError::Invalid);
    }
    Ok((local, domain))
}

/// The local part's name and tag (after the first `+`, empty is none).
fn name_and_tag(local: &str) -> (String, Option<String>) {
    let (name, tag) = match local.split_once('+') {
        Some((name, tag)) => (name, Some(tag)),
        None => (local, None),
    };
    let tag = tag.filter(|t| !t.is_empty()).map(str::to_string);
    (name.to_ascii_lowercase(), tag)
}

/// Parse an SMTP recipient (with or without angle brackets) for one of
/// `domains` (lowercase, without trailing dots).
pub fn parse_recipient(raw: &str, domains: &[String]) -> Result<MailAddress, AddressError> {
    let (local, domain) = split(raw)?;
    if !domains.iter().any(|d| d == &domain) {
        return Err(AddressError::RelayDenied);
    }
    let (slug, tag) = name_and_tag(local);
    if !is_valid_slug(&slug) {
        return Err(AddressError::Invalid);
    }
    Ok(MailAddress {
        local: slug.clone(),
        slug,
        tag,
        domain,
    })
}

fn is_valid_domain(domain: &str) -> bool {
    if domain.len() > MAX_DOMAIN || !domain.contains('.') {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

fn is_valid_custom_local(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_LOCAL_PART
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(b))
}

/// Parse a recipient at a domain that is not a capture domain: the form a
/// customer's inbound domain accepts (letters, digits, `.`, `_` and `-` in
/// the name, a tag after `+`). Whether the domain receives mail here is the
/// database's answer.
pub fn parse_custom(raw: &str) -> Result<CustomAddress, AddressError> {
    let (local, domain) = split(raw)?;
    if !is_valid_domain(&domain) {
        return Err(AddressError::Invalid);
    }
    let (name, tag) = name_and_tag(local);
    if !is_valid_custom_local(&name) {
        return Err(AddressError::Invalid);
    }
    Ok(CustomAddress {
        local: name,
        tag,
        domain,
    })
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
                local: "abc123".into(),
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

    #[test]
    fn parses_addresses_at_other_domains_for_the_database() {
        let addr = parse_custom("<Orders+Shop-1@Inbound.Acme.Example.>").unwrap();
        assert_eq!(addr.local, "orders");
        assert_eq!(addr.tag.as_deref(), Some("Shop-1"));
        assert_eq!(addr.domain, "inbound.acme.example");
        let at_endpoint = addr.for_slug("abc123".into());
        assert_eq!(at_endpoint.slug, "abc123");
        assert_eq!(
            at_endpoint.normalized(),
            "orders+Shop-1@inbound.acme.example"
        );
        assert_eq!(
            parse_custom("first.last@acme.example").unwrap().local,
            "first.last"
        );
    }

    #[test]
    fn refuses_custom_addresses_it_cannot_route() {
        for raw in [
            "orders@localhost",
            "orders@-acme.example",
            "orders@acme..example",
            "orders@acme_x.example",
            ".orders@acme.example",
            "orders.@acme.example",
            "or ders@acme.example",
            "\"orders\"@acme.example",
            "+tag@acme.example",
        ] {
            assert_eq!(parse_custom(raw), Err(AddressError::Invalid), "{raw:?}");
        }
        let long = format!("orders@{}.example", "a".repeat(250));
        assert_eq!(parse_custom(&long), Err(AddressError::Invalid));
    }
}
