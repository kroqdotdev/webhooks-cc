pub mod auth;
pub mod endpoints;
pub mod listen;
pub mod output;
pub mod replay;
pub mod requests;
pub mod sandbox;
pub mod send;
pub mod teams;
pub mod tunnel;
pub mod update;
pub mod usage;

use clap::{Parser, Subcommand};

use crate::types::EmailFormat;

#[derive(Parser, Debug)]
#[command(
    name = "whk",
    about = "webhooks.cc — inspect, forward, and replay webhooks",
    version = env!("WHK_VERSION"),
    arg_required_else_help = false,
)]
pub struct Cli {
    /// Disable TUI and show help
    #[arg(long)]
    pub nogui: bool,

    /// Output as JSON where supported
    #[arg(long, global = true)]
    pub json: bool,

    /// Override API base URL
    #[arg(long, env = "WHK_API_URL", global = true)]
    pub api_url: Option<String>,

    /// Override webhook receiver URL
    #[arg(long, env = "WHK_WEBHOOK_URL", global = true)]
    pub webhook_url: Option<String>,

    /// Disable colored output
    #[arg(long, global = true)]
    pub no_color: bool,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Authenticate with webhooks.cc
    Auth {
        #[command(subcommand)]
        action: AuthAction,
    },

    /// Create a new webhook endpoint
    Create {
        /// Endpoint name (auto-generated if omitted)
        name: Option<String>,

        /// Create as ephemeral (auto-expires)
        #[arg(short, long)]
        ephemeral: bool,

        /// Expiry duration (e.g. "12h", "7d")
        #[arg(long)]
        expires_in: Option<String>,

        /// Mock response status code (100-599)
        #[arg(long)]
        mock_status: Option<u16>,

        /// Mock response body; {{ json.id }}, {{ headers.x-name }}, {{ uuid }} and other placeholders are filled in from each request
        #[arg(long)]
        mock_body: Option<String>,

        /// Mock response header (repeatable, format: Key:Value)
        #[arg(long = "mock-header", value_name = "KEY:VALUE")]
        mock_headers: Vec<String>,

        /// Signing provider for automatic signature verification (e.g. stripe, github)
        #[arg(long)]
        signing_provider: Option<String>,

        /// Signing secret (encrypted server-side). Use env var WHK_SIGNING_SECRET or pass via stdin.
        #[arg(long, env = "WHK_SIGNING_SECRET", hide_env_values = true)]
        signing_secret: Option<String>,
    },

    /// List all endpoints, yours and those shared with you through teams
    List {
        /// Only endpoints tied to this team (id or name): shared with you from it, or yours shared with it
        #[arg(long)]
        team: Option<String>,
    },

    /// Get endpoint details
    Get {
        /// Endpoint slug
        slug: String,
    },

    /// Update endpoint settings
    #[command(name = "update-endpoint")]
    UpdateEndpoint {
        /// Endpoint slug
        slug: String,

        /// New display name
        #[arg(long)]
        name: Option<String>,

        /// Mock response status code
        #[arg(long)]
        mock_status: Option<u16>,

        /// Mock response body; {{ json.id }}, {{ headers.x-name }}, {{ uuid }} and other placeholders are filled in from each request
        #[arg(long)]
        mock_body: Option<String>,

        /// Mock response header (repeatable)
        #[arg(long = "mock-header", value_name = "KEY:VALUE")]
        mock_headers: Vec<String>,

        /// Remove mock response
        #[arg(long)]
        clear_mock: bool,
    },

    /// Delete an endpoint
    Delete {
        /// Endpoint slug
        slug: String,

        /// Skip confirmation prompt
        #[arg(short, long)]
        force: bool,
    },

    /// Forward webhooks to a local server
    Tunnel {
        /// Target port and optional path (e.g. "8080" or "8080/api/webhooks")
        target: String,

        /// Reuse an existing endpoint
        #[arg(long)]
        endpoint: Option<String>,

        /// Create the endpoint as ephemeral and delete it on exit (default: keep it for reuse)
        #[arg(short, long)]
        ephemeral: bool,

        /// Add custom header to forwarded requests and emails (repeatable)
        #[arg(short = 'H', long = "header", value_name = "KEY:VALUE")]
        headers: Vec<String>,

        /// Shape to post captured emails in: webhooks.cc's email JSON or an inbound mail provider's
        #[arg(long, value_enum, value_name = "FORMAT", default_value_t = EmailFormat::Json)]
        email_format: EmailFormat,

        /// Path to post emails to, appended to the target like a webhook's path (default: the target itself)
        #[arg(long, value_name = "PATH")]
        email_path: Option<String>,

        /// Mailgun HTTP webhook signing key, to sign emails posted with --email-format mailgun
        #[arg(
            long,
            env = "WHK_MAILGUN_SIGNING_KEY",
            hide_env_values = true,
            value_name = "KEY"
        )]
        mailgun_signing_key: Option<String>,

        /// Skip captured emails instead of posting them to the target
        #[arg(long, conflicts_with_all = ["email_format", "email_path"])]
        no_email: bool,
    },

    /// Stream incoming requests to terminal
    Listen {
        /// Endpoint slug to listen on
        slug: String,
    },

    /// Replay a captured request
    Replay {
        /// Request ID to replay
        id: String,

        /// Target URL (default: http://localhost:8080)
        #[arg(long, default_value = "http://localhost:8080")]
        to: String,
    },

    /// Send a test webhook to an endpoint
    Send {
        /// Endpoint slug
        slug: String,

        /// HTTP method (default: POST)
        #[arg(long, default_value = "POST")]
        method: String,

        /// Request header (repeatable)
        #[arg(short = 'H', long = "header", value_name = "KEY:VALUE")]
        headers: Vec<String>,

        /// Request body (string or @file)
        #[arg(short = 'd', long = "data")]
        data: Option<String>,
    },

    /// Send a webhook to an arbitrary URL
    #[command(name = "send-to")]
    SendTo {
        /// Target URL
        url: String,

        /// HTTP method (default: POST)
        #[arg(long, default_value = "POST")]
        method: String,

        /// Request header (repeatable)
        #[arg(short = 'H', long = "header", value_name = "KEY:VALUE")]
        headers: Vec<String>,

        /// Request body (string or @file)
        #[arg(short = 'd', long = "data")]
        data: Option<String>,
    },

    /// Manage captured requests
    Requests {
        #[command(subcommand)]
        action: RequestsAction,
    },

    /// Manage teams: sharing, members, and invites
    Teams {
        #[command(subcommand)]
        action: TeamsAction,
    },

    /// Agent sandbox and account connection: capture webhooks without an
    /// account, then connect the agent to a human's account (non-interactive)
    #[command(long_about = SANDBOX_ABOUT)]
    Sandbox {
        #[command(subcommand)]
        action: SandboxAction,
    },

    /// Show usage and quota info, including team pools
    Usage,

    /// Update whk to the latest version
    Update,

    /// Generate shell completions
    Completions {
        /// Shell type
        shell: clap_complete::Shell,
    },
}

#[derive(Subcommand, Debug)]
pub enum AuthAction {
    /// Log in via browser-based device auth
    Login,
    /// Show current login status
    Status,
    /// Log out and clear stored token
    Logout,
}

const SANDBOX_ABOUT: &str = "Agent sandbox and account connection (auth.md v0.6), for agents running whk \
without a human at the keyboard. Every subcommand is non-interactive and supports --json.

Without an account, `whk sandbox create` registers anonymously (a few seconds of proof of work) \
and makes a capture endpoint: up to 3 at a time, 25 captures each and 100 in all, deleted after 24 hours. \
`whk sandbox connect --email <address>` shows a link and a 6-digit code for the human; once they enter it, \
the regular commands (whk list, whk create, whk requests, ...) act for their account whenever no \
`whk auth login` session exists.

Registrations are kept in the agent credential file shared with the MCP server and the SDKs: \
WHK_AGENT_FILE, else agent.json next to token.json (~/.config/whk/agent.json on Linux). \
`whk sandbox status` shows what it holds; tokens are never printed.";

#[derive(Subcommand, Debug)]
pub enum SandboxAction {
    /// Create a sandbox endpoint, registering anonymously first when no sandbox is saved
    Create,

    /// List the sandbox endpoints and what is left of the budget
    List,

    /// Show one sandbox endpoint
    Get {
        /// Endpoint slug
        slug: String,
    },

    /// Delete a sandbox endpoint (frees a slot; captures already counted stay counted)
    Delete {
        /// Endpoint slug
        slug: String,
    },

    /// List the requests a sandbox endpoint captured, newest first
    Requests {
        /// Endpoint slug
        slug: String,

        /// Maximum number of requests to return (1-100)
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: Option<u32>,

        /// Only requests received at or after this timestamp (ms)
        #[arg(long)]
        since: Option<i64>,
    },

    /// Show one captured request
    Request {
        /// Request ID
        id: String,
    },

    /// Wait until requests arrive at a sandbox endpoint, then print them
    Wait {
        /// Endpoint slug
        slug: String,

        /// Give up after this long (e.g. "30s", "5m")
        #[arg(long, default_value = "60s")]
        timeout: String,

        /// Count requests received at or after this timestamp (ms; default: the last 5 minutes)
        #[arg(long)]
        since: Option<i64>,

        /// How many requests to wait for (1-25, what one endpoint can capture); more than 1 prints a list
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=25))]
        count: u32,
    },

    /// Show the saved registrations for this API (never the tokens)
    Status,

    /// Connect this agent to a human's account: they open a link, sign in and enter a code
    Connect {
        /// Email address of the human's account; only they can complete the connection
        #[arg(long)]
        email: String,

        /// Stop waiting after this long (default: until the code expires, 15 minutes)
        #[arg(long)]
        timeout: Option<String>,
    },

    /// Remove saved registrations from the credential file
    #[command(group(clap::ArgGroup::new("which").required(true).args(["claimed", "sandbox", "all"])))]
    Forget {
        /// The account connection
        #[arg(long)]
        claimed: bool,

        /// The anonymous sandbox registration
        #[arg(long)]
        sandbox: bool,

        /// Both
        #[arg(long)]
        all: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum TeamsAction {
    /// List your teams with seats, pooled usage, and status
    List,

    /// List a team's members and pending invites
    Members {
        /// Team id or name
        team: String,
    },

    /// Share an endpoint you own with a team
    Share {
        /// Endpoint slug
        slug: String,

        /// Team id or name
        #[arg(long)]
        team: String,
    },

    /// Stop sharing an endpoint you own with a team
    Unshare {
        /// Endpoint slug
        slug: String,

        /// Team id or name
        #[arg(long)]
        team: String,
    },

    /// Invite an email address to a team you own (sends an email; acceptance claims a seat)
    Invite {
        /// Team id or name
        team: String,

        /// Email address to invite
        email: String,
    },

    /// List invites waiting for you
    Invites,

    /// Accept a team invite
    Accept {
        /// Invite id (from `whk teams invites`)
        invite_id: String,
    },

    /// Decline a team invite
    Decline {
        /// Invite id (from `whk teams invites`)
        invite_id: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum RequestsAction {
    /// List captured requests for an endpoint
    List {
        /// Endpoint slug
        slug: String,

        /// Maximum number of requests to return
        #[arg(long, default_value = "25")]
        limit: u32,

        /// Only return requests after this timestamp (ms)
        #[arg(long)]
        since: Option<i64>,

        /// Cursor for pagination
        #[arg(long)]
        cursor: Option<String>,
    },

    /// Get a single request by ID
    Get {
        /// Request ID
        id: String,
    },

    /// Search across all retained requests
    Search {
        /// Filter by endpoint slug
        #[arg(long)]
        slug: Option<String>,

        /// Filter by HTTP method
        #[arg(long)]
        method: Option<String>,

        /// Search query
        #[arg(short, long)]
        q: Option<String>,

        /// Start time (timestamp or duration like "1h")
        #[arg(long)]
        from: Option<String>,

        /// End time (timestamp or duration like "7d")
        #[arg(long)]
        to: Option<String>,

        /// Max results
        #[arg(long, default_value = "50")]
        limit: u32,

        /// Result offset
        #[arg(long, default_value = "0")]
        offset: u32,

        /// Sort order
        #[arg(long, default_value = "desc")]
        order: String,
    },

    /// Count matching requests
    Count {
        #[arg(long)]
        slug: Option<String>,
        #[arg(long)]
        method: Option<String>,
        #[arg(short, long)]
        q: Option<String>,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
    },

    /// Delete captured requests
    Clear {
        /// Endpoint slug
        slug: String,

        /// Only clear requests before this time (timestamp or duration)
        #[arg(long)]
        before: Option<String>,

        /// Skip confirmation
        #[arg(short, long)]
        force: bool,
    },

    /// Export requests as HAR or cURL
    Export {
        /// Endpoint slug
        slug: String,

        /// Export format
        #[arg(long)]
        format: ExportFormat,

        /// Max requests to export
        #[arg(long, default_value = "100")]
        limit: u32,

        /// Only export requests after this timestamp
        #[arg(long)]
        since: Option<i64>,

        /// Output file (stdout if omitted)
        #[arg(short, long)]
        output: Option<String>,
    },
}

#[derive(Debug, Clone, clap::ValueEnum)]
pub enum ExportFormat {
    Har,
    Curl,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tunnel's email flags, parsed: format, path, key, --no-email.
    fn tunnel_flags(args: &[&str]) -> (EmailFormat, Option<String>, Option<String>, bool) {
        let cli = Cli::try_parse_from(["whk", "tunnel", "3000"].iter().chain(args)).unwrap();
        match cli.command {
            Some(Command::Tunnel {
                email_format,
                email_path,
                mailgun_signing_key,
                no_email,
                ..
            }) => (email_format, email_path, mailgun_signing_key, no_email),
            other => panic!("expected tunnel, got {other:?}"),
        }
    }

    #[test]
    fn tunnel_posts_emails_as_json_by_default() {
        let (format, path, _, no_email) = tunnel_flags(&[]);
        assert_eq!(format, EmailFormat::Json);
        assert_eq!(path, None);
        assert!(!no_email);
    }

    #[test]
    fn tunnel_takes_an_email_format_path_and_mailgun_key() {
        let (format, path, key, _) = tunnel_flags(&[
            "--email-format",
            "mailgun",
            "--email-path",
            "/inbound/mailgun",
            "--mailgun-signing-key",
            "key-acme",
        ]);
        assert_eq!(format, EmailFormat::Mailgun);
        assert_eq!(path.as_deref(), Some("/inbound/mailgun"));
        assert_eq!(key.as_deref(), Some("key-acme"));

        for (value, expected) in [
            ("json", EmailFormat::Json),
            ("postmark", EmailFormat::Postmark),
            ("sendgrid", EmailFormat::Sendgrid),
            ("cloudmailin", EmailFormat::Cloudmailin),
        ] {
            assert_eq!(tunnel_flags(&["--email-format", value]).0, expected);
        }
    }

    #[test]
    fn tunnel_refuses_unknown_formats_and_contradictions() {
        let parse =
            |args: &[&str]| Cli::try_parse_from(["whk", "tunnel", "3000"].iter().chain(args));
        assert!(parse(&["--email-format", "mandrill"]).is_err());
        assert!(parse(&["--no-email", "--email-format", "postmark"]).is_err());
        assert!(parse(&["--no-email", "--email-path", "/inbound"]).is_err());
        assert!(tunnel_flags(&["--no-email"]).3);
    }
}
