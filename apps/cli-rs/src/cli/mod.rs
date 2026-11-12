pub mod api;
pub mod auth;
pub mod confirm;
pub mod endpoints;
pub mod listen;
pub mod output;
pub mod replay;
pub mod requests;
pub mod sandbox;
pub mod send;
pub mod share;
pub mod teams;
pub mod tunnel;
pub mod update;
pub mod usage;
pub mod wait;

use clap::{Parser, Subcommand};

use crate::types::EmailFormat;

#[derive(Parser, Debug)]
#[command(
    name = "whk",
    about = "webhooks.cc: capture, inspect, forward and replay webhooks and email, and share localhost",
    version = env!("WHK_VERSION"),
    arg_required_else_help = false,
    after_help = AFTER_HELP,
)]
pub struct Cli {
    /// Accepted for scripts written for older versions, which had a TUI; does nothing
    #[arg(long, hide = true)]
    pub nogui: bool,

    /// Print JSON: the API's own answers on stdout, NDJSON for streams, and failures as {"error":{...}} on stderr
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

/// Printed under `whk --help`.
pub const AFTER_HELP: &str = "\
Exit status:
  0  success
  1  any other failure, or the server refused the input (bad_request)
  2  bad arguments (usage)
  3  not logged in, or the credentials were refused (not_logged_in, unauthorized,
     connection_revoked)
  4  not found (not_found)
  5  not allowed by the plan, a limit or a permission (forbidden)
  6  rate limited; wait and retry (rate_limited)
  7  server or network failure; retry (server_error, network_error, request_timeout)
  8  a wait ran out of time (timeout)
  9  a destructive command was not confirmed; pass --yes (confirmation_required, cancelled)

With --json, a failure is written to stderr as
  {\"error\":{\"code\":\"not_found\",\"message\":\"...\",\"exit\":4,\"status\":404,\"hint\":\"...\"}}

Agents: `whk wait <slug>` blocks until a request arrives and prints it, and
`whk api <path>` calls any API route with your credentials.
Docs: https://webhooks.cc/docs/cli";

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

    /// Mark an endpoint as a favourite: `whk list` and the dashboard show favourites first
    #[command(alias = "favourite")]
    Favorite {
        /// Endpoint slug (yours, or one shared with you through a team)
        slug: String,
    },

    /// Remove an endpoint from your favourites
    #[command(alias = "unfavourite")]
    Unfavorite {
        /// Endpoint slug
        slug: String,
    },

    /// Delete an endpoint
    Delete {
        /// Endpoint slug
        slug: String,

        /// Delete without asking (needed when no terminal is attached)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        force: bool,
    },

    /// Forward webhooks to a local server
    Tunnel {
        /// Local target: a port and optional path ("8080", "8080/api/webhooks", "localhost:8080", "127.0.0.1:8080/api"); plain HTTP only
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

        /// Relay each webhook to the local server while the sender waits, so it gets your app's answer (the capture is kept either way; 502 when whk is not connected, 504 when your app takes over 25 s)
        #[arg(long)]
        live: bool,
    },

    /// Share a local port at a link anyone can open (https://<name>.sharehooks.cc)
    Share {
        /// Local port to share (e.g. "3000" or "localhost:3000")
        target: String,

        /// Share under a name you reserved (`whk names reserve`); a random one otherwise
        #[arg(long)]
        name: Option<String>,

        /// Ask visitors for a password (prompted, or from WHK_SHARE_PASSWORD)
        #[arg(long)]
        password: bool,

        /// Do not draw the link as a QR code
        #[arg(long)]
        no_qr: bool,

        /// Stop when stdin closes (for the SDK and MCP server)
        #[arg(long, hide = true)]
        until_stdin_closes: bool,
    },

    /// See and stop your shares
    Shares {
        #[command(subcommand)]
        action: SharesAction,
    },

    /// Names to share under: reserve, release, and put a password on them
    Names {
        #[command(subcommand)]
        action: NamesAction,
    },

    /// Stream requests and emails as they arrive: one line each, or NDJSON with --json
    Listen {
        /// Endpoint slug to listen on
        slug: String,
    },

    /// Wait for the next request or email at an endpoint, print it and exit
    #[command(after_help = "\
Run it in the background before triggering the sender, or after: requests from
the last 5 minutes count unless --since says otherwise. Exits 8 (timeout) when
nothing matching arrived in time.")]
    Wait {
        /// Endpoint slug
        slug: String,

        /// How long to wait (e.g. "30s", "5m", "1h")
        #[arg(long, default_value = "30s")]
        timeout: String,

        /// How many matching requests to wait for; more than one prints a JSON array with --json
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=100))]
        count: u32,

        /// Only requests received after this: "now", a duration back ("2m"), or a timestamp in milliseconds
        #[arg(long)]
        since: Option<String>,

        /// Only this HTTP method (e.g. POST)
        #[arg(long)]
        method: Option<String>,

        /// Only HTTP requests or only emails
        #[arg(long, value_enum)]
        kind: Option<wait::Kind>,

        /// Only requests whose path contains this text (for an email, the recipient address)
        #[arg(long)]
        path: Option<String>,
    },

    /// Call any webhooks.cc API route with your credentials and print the answer
    #[command(after_help = "\
Examples:
  whk api /api/endpoints
  whk api endpoints/acme-orders/destinations
  whk api -X PATCH endpoints/acme-orders -d '{\"retentionDays\":7}'
  whk api -X POST endpoints/acme-orders/destinations -d @destination.json

The path is relative to /api when it does not start with it. Data given with
-d is sent as JSON (POST unless -X says otherwise); @file reads a file and @-
reads stdin. The body is printed as received; a failing status exits as
described in `whk --help`. Routes that need a browser session (billing, account
deletion) refuse API keys.")]
    Api {
        /// API path, e.g. "endpoints" or "/api/usage"
        path: String,

        /// HTTP method (default GET, or POST when -d is given)
        #[arg(short = 'X', long)]
        method: Option<String>,

        /// Request body: JSON text, @file, or @- for stdin
        #[arg(short = 'd', long)]
        data: Option<String>,

        /// Extra header (repeatable, format: Key:Value)
        #[arg(short = 'H', long = "header")]
        headers: Vec<String>,

        /// Print the status line and headers before the body (to stderr)
        #[arg(short = 'i', long)]
        include: bool,
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
pub enum SharesAction {
    /// List live shares (or, with --ended, earlier ones) and this month's data
    #[command(alias = "list")]
    Ls {
        /// Earlier shares instead of live ones
        #[arg(long)]
        ended: bool,
    },
    /// Stop a live share (yours, or a teammate's under a team name)
    Stop {
        /// Share id or name
        share: String,
    },
    /// The last requests visitors made to a live share (newest first)
    #[command(alias = "requests")]
    Log {
        /// Share id or name
        share: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum NamesAction {
    /// List the names you can share under
    #[command(alias = "list")]
    Ls,
    /// Keep a name to share under (paid plans)
    Reserve {
        /// The name: lowercase letters, digits and dashes
        name: String,
        /// Keep it inside a team (id or name), so every member may share under it
        #[arg(long)]
        team: Option<String>,
    },
    /// Let a name go
    Release {
        /// The name
        name: String,
    },
    /// Set the password visitors need for every share under a name (prompted, or from WHK_SHARE_PASSWORD)
    Password {
        /// The name
        name: String,
        /// Take the password off instead
        #[arg(long)]
        clear: bool,
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

        /// Clear without asking (needed when no terminal is attached)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
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
    fn share_takes_a_port_and_its_flags() {
        let cli = Cli::try_parse_from([
            "whk",
            "share",
            "3000",
            "--name",
            "acme",
            "--password",
            "--no-qr",
            "--json",
        ])
        .unwrap();
        assert!(cli.json);
        match cli.command {
            Some(Command::Share {
                target,
                name,
                password,
                no_qr,
                until_stdin_closes,
            }) => {
                assert_eq!(target, "3000");
                assert_eq!(name.as_deref(), Some("acme"));
                assert!(password && no_qr && !until_stdin_closes);
            }
            other => panic!("expected share, got {other:?}"),
        }
        let hidden = Cli::try_parse_from(["whk", "share", "5173", "--until-stdin-closes"]).unwrap();
        assert!(matches!(
            hidden.command,
            Some(Command::Share {
                until_stdin_closes: true,
                ..
            })
        ));
        assert!(
            Cli::try_parse_from(["whk", "share"]).is_err(),
            "a port is required"
        );
    }

    #[test]
    fn shares_and_names_have_their_subcommands() {
        let parse = |args: &[&str]| {
            Cli::try_parse_from(["whk"].iter().chain(args))
                .unwrap()
                .command
        };
        assert!(matches!(
            parse(&["shares", "ls", "--ended"]),
            Some(Command::Shares {
                action: SharesAction::Ls { ended: true }
            })
        ));
        assert!(matches!(
            parse(&["shares", "list"]),
            Some(Command::Shares {
                action: SharesAction::Ls { ended: false }
            })
        ));
        match parse(&["shares", "stop", "acme"]) {
            Some(Command::Shares {
                action: SharesAction::Stop { share },
            }) => assert_eq!(share, "acme"),
            other => panic!("expected shares stop, got {other:?}"),
        }
        assert!(matches!(
            parse(&["names", "ls"]),
            Some(Command::Names {
                action: NamesAction::Ls
            })
        ));
        match parse(&["names", "reserve", "acme"]) {
            Some(Command::Names {
                action: NamesAction::Reserve { name, team: None },
            }) => assert_eq!(name, "acme"),
            other => panic!("expected names reserve, got {other:?}"),
        }
        match parse(&["names", "reserve", "acme", "--team", "Acme Inc"]) {
            Some(Command::Names {
                action: NamesAction::Reserve { team, .. },
            }) => assert_eq!(team.as_deref(), Some("Acme Inc")),
            other => panic!("expected names reserve --team, got {other:?}"),
        }
        match parse(&["shares", "log", "acme"]) {
            Some(Command::Shares {
                action: SharesAction::Log { share },
            }) => assert_eq!(share, "acme"),
            other => panic!("expected shares log, got {other:?}"),
        }
        match parse(&["names", "release", "acme"]) {
            Some(Command::Names {
                action: NamesAction::Release { name },
            }) => assert_eq!(name, "acme"),
            other => panic!("expected names release, got {other:?}"),
        }
        assert!(matches!(
            parse(&["names", "password", "acme", "--clear"]),
            Some(Command::Names {
                action: NamesAction::Password { clear: true, .. }
            })
        ));
    }

    #[test]
    fn tunnel_takes_live() {
        let cli = Cli::try_parse_from(["whk", "tunnel", "3000", "--live"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Tunnel { live: true, .. })
        ));
        let cli = Cli::try_parse_from(["whk", "tunnel", "3000"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Tunnel { live: false, .. })
        ));
    }

    #[test]
    fn favorite_and_unfavorite_take_a_slug() {
        let parse =
            |args: &[&str]| Cli::try_parse_from(["whk"].iter().chain(args)).map(|c| c.command);
        for name in ["favorite", "favourite"] {
            match parse(&[name, "acme-hooks"]).unwrap() {
                Some(Command::Favorite { slug }) => assert_eq!(slug, "acme-hooks"),
                other => panic!("expected favorite, got {other:?}"),
            }
        }
        for name in ["unfavorite", "unfavourite"] {
            match parse(&[name, "acme-hooks"]).unwrap() {
                Some(Command::Unfavorite { slug }) => assert_eq!(slug, "acme-hooks"),
                other => panic!("expected unfavorite, got {other:?}"),
            }
        }
        assert!(parse(&["favorite"]).is_err());
        assert!(parse(&["unfavorite"]).is_err());
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
