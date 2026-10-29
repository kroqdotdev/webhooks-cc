//! The JSON document the binary prints. The web app parses it, so the field
//! names and the "every key is always present" rule are a contract.

use serde::Serialize;

use crate::Format;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub format: Format,
    /// Billable pages actually parsed, never more than the page cap.
    pub pages: u64,
    /// True when parsing stopped at the page cap or an output cap.
    pub truncated: bool,
    pub sheets: Vec<Sheet>,
    pub text: Option<String>,
    pub page_texts: Option<Vec<String>>,
    pub error: Option<ParseError>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub name: Option<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParseError {
    pub code: ErrorCode,
    /// Short and generic: it never quotes the file, because the file belongs
    /// to whoever sent the email and the message may end up in logs.
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Malformed,
    Encrypted,
    Unsupported,
    TooLarge,
    ZipBomb,
    Empty,
}

/// Why a format module gave up. Messages are static strings so no file
/// content can leak into them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Failure {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl Failure {
    pub(crate) const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub(crate) const fn malformed(message: &'static str) -> Self {
        Self::new(ErrorCode::Malformed, message)
    }
}

impl Output {
    pub fn failed(format: Format, code: ErrorCode, message: &str) -> Self {
        Self {
            format,
            pages: 0,
            truncated: false,
            sheets: Vec::new(),
            text: None,
            page_texts: None,
            error: Some(ParseError {
                code,
                message: message.to_string(),
            }),
        }
    }

    pub(crate) fn from_failure(format: Format, failure: Failure) -> Self {
        Self::failed(format, failure.code, failure.message)
    }

    pub(crate) fn sheets(format: Format, sheets: Vec<Sheet>, pages: u64, truncated: bool) -> Self {
        Self {
            format,
            pages,
            truncated,
            sheets,
            text: None,
            page_texts: None,
            error: None,
        }
    }

    pub fn error_code(&self) -> Option<ErrorCode> {
        self.error.as_ref().map(|e| e.code)
    }

    pub fn to_json(&self) -> String {
        // Serialising plain strings, numbers and vectors cannot fail.
        serde_json::to_string(self).unwrap_or_else(|_| {
            String::from(
                r#"{"format":"text","pages":0,"truncated":false,"sheets":[],"text":null,"pageTexts":null,"error":{"code":"malformed","message":"output could not be serialised"}}"#,
            )
        })
    }
}
