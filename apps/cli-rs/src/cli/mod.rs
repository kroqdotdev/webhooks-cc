pub mod account;
pub mod api;
pub mod auth;
pub mod billing;
#[cfg(test)]
mod capabilities;
pub mod confirm;
pub mod deliveries;
pub mod destinations;
pub mod endpoints;
pub mod google;
pub mod keys;
pub mod layouts;
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
  1  any other failure, the server refused the input (bad_request), or a test
     delivery was not accepted by the destination (delivery_failed)
  2  bad arguments (usage)
  3  not logged in, or the credentials were refused (not_logged_in, unauthorized,
     connection_revoked, login_expired, login_denied)
  4  not found (not_found)
  5  not allowed by the plan, a limit or a permission (forbidden)
  6  rate limited; wait and retry (rate_limited)
  7  server or network failure; retry (server_error, network_error, request_timeout)
  8  a wait ran out of time, or an approval expired (timeout, approval_expired)
  9  a destructive command was not confirmed; pass --yes (confirmation_required, cancelled),
     or the account's owner refused an approval (approval_denied)

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

    /// Manage teams: creating, sharing, members, invites and price quotes (deleting one needs the team's owner to approve it)
    Teams {
        #[command(subcommand)]
        action: TeamsAction,
    },

    /// An endpoint's email layouts: the ready-made ones there are to add
    Layouts {
        #[command(subcommand)]
        action: LayoutsAction,
    },

    /// An endpoint's named email fields: try them on a captured email
    Fields {
        #[command(subcommand)]
        action: FieldsAction,
    },

    /// Where an endpoint's captures are forwarded: add, change, order, preview, test and remove destinations (owner only)
    Destinations {
        #[command(subcommand)]
        action: DestinationsAction,
    },

    /// The delivery log of an endpoint's destinations, and sending requests again (owner only)
    Deliveries {
        #[command(subcommand)]
        action: DeliveriesAction,
    },

    /// What the account pays for: the plan, its subscription, add-ons, and every team's (read only)
    Billing,

    /// Manage the account's API keys (a new one needs the account's owner to approve it)
    Keys {
        #[command(subcommand)]
        action: KeysAction,
    },

    /// The account's display name (a rename needs the account's owner to approve it)
    Account {
        #[command(subcommand)]
        action: AccountAction,
    },

    /// List and disconnect the agents connected to the account
    Agents {
        #[command(subcommand)]
        action: AgentsAction,
    },

    /// Public links to a frozen copy of a request (a new one needs the account's owner to approve it)
    #[command(name = "share-links")]
    ShareLinks {
        #[command(subcommand)]
        action: ShareLinksAction,
    },

    /// Custom inbound domains for email capture (Business; removing one needs the account's owner to approve it)
    Domains {
        #[command(subcommand)]
        action: DomainsAction,
    },

    /// Google accounts for Google Sheets destinations (connecting one, or choosing a spreadsheet from Drive, needs the account's owner)
    Google {
        #[command(subcommand)]
        action: GoogleAction,
    },

    /// AI setup: have AI propose email fields from an endpoint's emails (the account's owner approves sending them)
    Ai {
        #[command(subcommand)]
        action: AiAction,
    },

    /// Follow an approval asked for with --no-wait (`whk keys create`, `whk share-links create` and the like)
    Approvals {
        #[command(subcommand)]
        action: ApprovalsAction,
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
    Login {
        /// This machine is not the one with your browser (a server over SSH, a
        /// container): print the link to open elsewhere, never open a browser.
        /// Detected over SSH and on Linux without a display.
        #[arg(long)]
        remote: bool,
        /// Print the link without opening a browser
        #[arg(long)]
        no_browser: bool,
    },
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
pub enum KeysAction {
    /// List the account's API keys (the keys themselves are never shown again)
    List,

    /// Ask for a new API key: prints a link for the account's owner to approve, waits, then prints the key once
    Create {
        /// What the key is for, such as "GitHub Actions"
        name: String,

        /// How many days the key works, 1 to 365 (default 90)
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=365))]
        expires_in_days: Option<u32>,

        /// This machine is not the one with your browser: print the link, never open a browser
        #[arg(long)]
        remote: bool,

        /// Print the link without opening a browser
        #[arg(long)]
        no_browser: bool,

        /// Print the approval and exit; collect the key later with `whk approvals wait <id>`
        #[arg(long)]
        no_wait: bool,

        /// How long to wait for the answer, such as 10m
        #[arg(long, default_value = "16m")]
        timeout: String,
    },

    /// Revoke an API key by its id (from `whk keys list`)
    Revoke {
        /// The key's id
        id: String,

        /// Revoke without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },
}

fn parse_share_days(value: &str) -> Result<u32, String> {
    match value {
        "1" | "7" | "30" => Ok(value.parse().unwrap_or(7)),
        _ => Err("a share link works for 1, 7 or 30 days".into()),
    }
}

/// How whk shows and follows an approval the account's owner answers.
#[derive(clap::Args, Debug)]
pub struct ApprovalArgs {
    /// This machine is not the one with your browser: print the link, never open a browser
    #[arg(long)]
    pub remote: bool,

    /// Print the link without opening a browser
    #[arg(long)]
    pub no_browser: bool,

    /// Print the approval and exit; follow it later with `whk approvals wait <id>`
    #[arg(long)]
    pub no_wait: bool,

    /// How long to wait for the answer, such as 10m
    #[arg(long, default_value = "16m")]
    pub timeout: String,
}

#[derive(Subcommand, Debug)]
pub enum AccountAction {
    /// Set the account's display name: prints a link for the account's owner to approve, then waits
    Rename {
        /// The new display name
        #[arg(required_unless_present = "clear", conflicts_with = "clear")]
        name: Option<String>,

        /// Clear the display name instead
        #[arg(long)]
        clear: bool,

        #[command(flatten)]
        approval: ApprovalArgs,
    },
}

#[derive(Subcommand, Debug)]
pub enum AgentsAction {
    /// List the connected agents (claimed agents and OAuth sign-ins)
    List,

    /// Disconnect an agent by its id: its tokens stop working at once (its endpoints stay)
    Disconnect {
        /// The agent's id, from `whk agents list`
        id: String,

        /// Disconnect without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum ShareLinksAction {
    /// List the account's live share links, or one request's
    List {
        /// Only the links to this request (its id)
        #[arg(long)]
        request: Option<String>,
    },

    /// Ask for a public link to a read-only copy of a request: prints a link for the account's owner to approve, then waits
    Create {
        /// The request's id
        request: String,

        /// How long the link works: 1, 7 or 30 days
        #[arg(long, default_value_t = 7, value_parser = parse_share_days)]
        days: u32,

        /// Keep signature and token headers in the copy (credentials are always left out)
        #[arg(long)]
        show_signatures: bool,

        #[command(flatten)]
        approval: ApprovalArgs,
    },

    /// Revoke a share link by its id: its page answers 404 from then on
    Revoke {
        /// The link's id, from `whk share-links list`
        id: String,

        /// Revoke without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum DomainsAction {
    /// List the custom domains, with the DNS records to publish and their routes
    List {
        /// A Team Business team's id (its owner only)
        #[arg(long)]
        team: Option<String>,
    },

    /// Add a domain, then publish the DNS records it prints
    Add {
        /// The domain, such as mail.example.com
        domain: String,

        /// A Team Business team's id (its owner only)
        #[arg(long)]
        team: Option<String>,
    },

    /// Look a domain's TXT and MX records up now
    Verify {
        /// The domain's id, from `whk domains list`
        id: String,

        /// A Team Business team's id (its owner only)
        #[arg(long)]
        team: Option<String>,
    },

    /// Set where a domain's mail goes; what you leave out stays as it is
    Route {
        /// The domain's id, from `whk domains list`
        id: String,

        /// Endpoint (slug or id) for mail no route matches, or "none" to refuse it
        #[arg(long)]
        catch_all: Option<String>,

        /// local=endpoint, such as billing=my-endpoint; repeat for more (replaces every route)
        #[arg(long = "route")]
        routes: Vec<String>,

        /// A Team Business team's id (its owner only)
        #[arg(long)]
        team: Option<String>,
    },

    /// Ask to remove a domain (mail to it is refused from then on): prints a link for the account's owner to approve, then waits
    Remove {
        /// The domain's id, from `whk domains list`
        id: String,

        /// A Team Business team's id (its owner only)
        #[arg(long)]
        team: Option<String>,

        #[command(flatten)]
        approval: ApprovalArgs,
    },
}

#[derive(Subcommand, Debug)]
pub enum GoogleAction {
    /// List the connected Google accounts
    List,

    /// Ask to connect a Google account: prints a link; approving takes the owner to Google
    Connect {
        #[command(flatten)]
        approval: ApprovalArgs,
    },

    /// Ask the owner to choose an existing spreadsheet from Drive: the approval page opens Google's picker
    Pick {
        /// The Google connection's id, from `whk google list`
        connection: String,

        #[command(flatten)]
        approval: ApprovalArgs,
    },

    /// List a spreadsheet's tabs
    Tabs {
        /// The Google connection's id
        connection: String,

        /// The spreadsheet's id
        spreadsheet: String,
    },

    /// Create a spreadsheet with a header row (or, with --spreadsheet, write the header row of an empty one)
    CreateSheet {
        /// The Google connection's id
        connection: String,

        /// A header, once per column, in order
        #[arg(long = "header", required = true)]
        headers: Vec<String>,

        /// The spreadsheet's title
        #[arg(long)]
        title: Option<String>,

        /// Write the header row of this existing spreadsheet instead (left alone when its first row is not empty)
        #[arg(long)]
        spreadsheet: Option<String>,

        /// The tab (default "Sheet1")
        #[arg(long)]
        sheet: Option<String>,
    },

    /// Disconnect a Google account; Sheets destinations using it fail until another is chosen
    Disconnect {
        /// The Google connection's id
        connection: String,

        /// Disconnect without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum AiAction {
    /// Whether AI setup is offered for an endpoint, and how many assists are left
    Status {
        /// The endpoint's slug
        slug: String,
    },

    /// Ask for AI setup on 1 to 5 of an endpoint's emails: the owner sees which and approves; prints the proposals
    Setup {
        /// The endpoint's slug
        slug: String,

        /// An email's request id; repeat for up to 5
        #[arg(long = "request", required = true)]
        requests: Vec<String>,

        /// Propose a field with this name
        #[arg(long)]
        field: Option<String>,

        /// What the field is (with --field), or what these emails are (with --layout)
        #[arg(long)]
        description: Option<String>,

        /// Propose a layout instead of one field
        #[arg(long)]
        layout: bool,

        /// Repair a field: the field as JSON, {"name", "from", "pattern"}
        #[arg(long)]
        repair: Option<String>,

        #[command(flatten)]
        approval: ApprovalArgs,
    },
}

#[derive(Subcommand, Debug)]
pub enum ApprovalsAction {
    /// Wait for an approval to be answered, then print what it granted (once)
    Wait {
        /// The approval's id
        id: String,

        /// How long to wait, such as 10m
        #[arg(long, default_value = "16m")]
        timeout: String,
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

    /// Invite an email address to a team you own: prints a link for the team's owner to approve (it sends an email), then waits; accepting claims a seat
    Invite {
        /// Team id or name
        team: String,

        /// Email address to invite
        email: String,

        #[command(flatten)]
        approval: ApprovalArgs,
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

    /// Create a team you own (it needs a subscription before endpoints can be shared or members invited)
    Create {
        /// The team's name
        name: String,
    },

    /// Rename a team you own
    Rename {
        /// Team id or name
        team: String,

        /// The new name
        name: String,
    },

    /// Ask to delete a team you own (its subscription ends at once): prints a link for the team's owner to approve, then waits
    Delete {
        /// Team id or name
        team: String,

        #[command(flatten)]
        approval: ApprovalArgs,
    },

    /// Remove a member from a team you own (endpoints they shared with it stop being shared)
    Remove {
        /// Team id or name
        team: String,

        /// The member's user id or email (from `whk teams members`)
        member: String,

        /// Remove without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },

    /// Leave a team you belong to (an owner deletes the team instead)
    Leave {
        /// Team id or name
        team: String,

        /// Leave without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },

    /// Withdraw an invite to a team you own before it is answered
    Withdraw {
        /// Team id or name
        team: String,

        /// The invite's id or the invited email (from `whk teams members`)
        invite: String,

        /// Withdraw without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },

    /// What changing a team's seats or plan would cost (owner only; read only, changes are made in the browser)
    #[command(group(clap::ArgGroup::new("change").required(true).args(["seats", "plan"])))]
    Quote {
        /// Team id or name
        team: String,

        /// Price this seat count
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        seats: Option<u32>,

        /// Price a move to this plan
        #[arg(long, value_parser = ["team", "team_business"])]
        plan: Option<String>,

        /// Billing interval for --plan (default month)
        #[arg(long, value_parser = ["month", "year"], requires = "plan", conflicts_with = "seats")]
        interval: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum LayoutsAction {
    /// List the ready-made email layouts (Shopify, WooCommerce, Etsy orders and more) and the fields each reads
    Templates {
        /// The endpoint's slug
        slug: String,
    },

    /// Add a ready-made layout to the end of an endpoint's layouts (owner only)
    AddTemplate {
        /// The endpoint's slug
        slug: String,

        /// The template's id, from `whk layouts templates`
        template: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum FieldsAction {
    /// Dry run: what the endpoint's named email fields find in a captured email (nothing is saved)
    Preview {
        /// The endpoint's slug
        slug: String,

        /// An email's request id (default: the endpoint's newest email)
        #[arg(long)]
        request: Option<String>,

        /// Try these fields instead of the saved ones: a JSON list, [{"name", "from", "pattern"}], or @file
        #[arg(long)]
        fields: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum DestinationsAction {
    /// List an endpoint's destinations in order, with their last 24 hours
    #[command(alias = "list")]
    Ls {
        /// The endpoint's slug
        slug: String,

        /// With --json, add each one's last 24 hours and what is waiting
        #[arg(long)]
        summary: bool,
    },

    /// Show one destination's settings
    Get {
        /// The endpoint's slug
        slug: String,

        /// The destination's id, from `whk destinations ls`
        id: String,
    },

    /// Add a destination (up to 10 per endpoint); it gets a signing secret of its own
    #[command(after_help = "\
Examples:
  whk destinations add acme --url https://example.com/hooks --header \"Authorization: Bearer $TOKEN\"
  whk destinations add acme --url https://hooks.slack.com/services/... --http false
  whk destinations add acme --url https://example.com/orders --format template \\
    --body-template '{\"order\":\"{{ json.id }}\"}' --filter @filter.json
  WHK_DROP_SECRET=... whk destinations add acme --format file_drop --config @drop.json

A file drop's password, private key or S3 secret key is read from WHK_DROP_SECRET,
or typed at the terminal without being shown; it is never taken from a flag.")]
    Add {
        /// The endpoint's slug
        slug: String,

        #[command(flatten)]
        fields: destinations::DestinationFields,

        #[command(flatten)]
        secrets: destinations::DestinationSecrets,
    },

    /// Change a destination: only the settings you pass change
    Update {
        /// The endpoint's slug
        slug: String,

        /// The destination's id
        id: String,

        #[command(flatten)]
        fields: destinations::DestinationFields,

        #[command(flatten)]
        secrets: destinations::DestinationSecrets,
    },

    /// Remove a destination; what is still waiting for it is marked failed (its log stays)
    #[command(alias = "remove")]
    Rm {
        /// The endpoint's slug
        slug: String,

        /// The destination's id
        id: String,

        /// Remove without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },

    /// Put the destinations in this order (the order captures are queued in)
    Reorder {
        /// The endpoint's slug
        slug: String,

        /// Destination ids, first to last
        #[arg(required = true)]
        ids: Vec<String>,
    },

    /// Dry run: whether the filter lets a captured request through and the exact request a destination would send (nothing is sent)
    Preview {
        /// The endpoint's slug
        slug: String,

        /// A saved destination to start from; the setting flags change it for the preview only
        #[arg(long)]
        destination: Option<String>,

        /// A captured request (default: the newest of the kind the destination takes, or a sample)
        #[arg(long)]
        request: Option<String>,

        #[command(flatten)]
        fields: destinations::DestinationFields,
    },

    /// Send one delivery to a destination now, as a real one would go out, and show the answer (the filter is reported, not applied)
    Test {
        /// The endpoint's slug
        slug: String,

        /// The destination's id
        id: String,

        /// The captured request to send (default: the newest of its kind, or a sample)
        #[arg(long)]
        request: Option<String>,

        /// Send the newest HTTP request or the newest email
        #[arg(long, value_parser = ["http", "email"], conflicts_with = "request")]
        kind: Option<String>,

        /// Send without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },

    /// Print the secret deliveries to a destination are signed with (whsec_...), or replace it
    Secret {
        /// The endpoint's slug
        slug: String,

        /// The destination's id
        id: String,

        /// Replace it: deliveries are signed with the new one at once
        #[arg(long)]
        rotate: bool,

        /// Replace without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum DeliveriesAction {
    /// The endpoint's delivery log, newest first, or every delivery of one request with each try
    #[command(alias = "list")]
    Ls {
        /// The endpoint's slug
        #[arg(required_unless_present = "request")]
        slug: Option<String>,

        /// One captured request's deliveries instead, with each try
        #[arg(long, conflicts_with_all = ["status", "destination", "limit", "before"])]
        request: Option<String>,

        /// Only these: pending (queued or retrying), failed, or skipped (turned down by the filter)
        #[arg(long, value_parser = ["all", "pending", "failed", "skipped"])]
        status: Option<String>,

        /// Only one destination's deliveries (its id)
        #[arg(long)]
        destination: Option<String>,

        /// How many, 1 to 100 (default 5)
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: Option<u32>,

        /// Older rows: the cursor printed under the last page
        #[arg(long)]
        before: Option<String>,
    },

    /// Counts: delivered and failed in the last 24 hours, waiting now, and the totals
    Summary {
        /// The endpoint's slug
        slug: String,
    },

    /// Send a captured request again now with the current settings: to every destination that takes its kind, or to one whatever its filter says
    Redeliver {
        /// The request's id (a delivery's REQUEST in `whk deliveries ls`)
        request: String,

        /// Only this destination (its id); its filter is not applied
        #[arg(long)]
        destination: Option<String>,

        /// Send without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
    },

    /// Send every request whose latest delivery failed again, oldest first (at most what fits under each destination's pending cap)
    RedeliverFailed {
        /// The endpoint's slug
        slug: String,

        /// Only this destination's failed deliveries (its id)
        #[arg(long)]
        destination: Option<String>,

        /// Send without asking (needed without a terminal)
        #[arg(short = 'y', long = "yes", visible_alias = "force", short_alias = 'f')]
        yes: bool,
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

    /// Search retained requests for text in the path, headers, body and email fields
    ///
    /// Reads until it has --limit matches or 25 seconds have passed. When it
    /// stops before the end it says so on stderr, with the --cursor that
    /// continues it.
    Search {
        /// Filter by endpoint slug
        #[arg(long)]
        slug: Option<String>,

        /// Filter by HTTP method (EMAIL for emails)
        #[arg(long)]
        method: Option<String>,

        /// Only HTTP requests or only emails
        #[arg(long, value_parser = ["http", "email"])]
        kind: Option<String>,

        /// Text to find (a substring, at most 1,000 characters)
        #[arg(short, long)]
        q: Option<String>,

        /// Start time (timestamp in ms, or a duration back from now like "1h")
        #[arg(long)]
        from: Option<String>,

        /// End time (timestamp in ms, or a duration back from now like "7d")
        #[arg(long)]
        to: Option<String>,

        /// Max results (more than 200 takes several pages)
        #[arg(long, default_value = "50")]
        limit: u32,

        /// Skip this many matches (prefer --cursor to page)
        #[arg(long, default_value = "0", conflicts_with = "cursor")]
        offset: u32,

        /// Sort order: desc (newest first) or asc
        #[arg(long, default_value = "desc", value_parser = parse_order)]
        order: String,

        /// Continue a search from where it stopped, with the same filters and order
        #[arg(long)]
        cursor: Option<String>,
    },

    /// Count matching requests
    ///
    /// With -q or --method the count reads requests like a search does, for
    /// up to 25 seconds; if that is not all of them it says "at least".
    Count {
        /// Filter by endpoint slug
        #[arg(long)]
        slug: Option<String>,
        /// Filter by HTTP method (EMAIL for emails)
        #[arg(long)]
        method: Option<String>,
        /// Only HTTP requests or only emails
        #[arg(long, value_parser = ["http", "email"])]
        kind: Option<String>,
        /// Text to find (a substring)
        #[arg(short, long)]
        q: Option<String>,
        /// Start time (timestamp or duration like "1h")
        #[arg(long)]
        from: Option<String>,
        /// End time (timestamp or duration like "7d")
        #[arg(long)]
        to: Option<String>,
        /// Count on from where a count stopped: the next stretch only, so add it up
        #[arg(long)]
        cursor: Option<String>,
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

/// `--order`: `asc` or `desc`, in any case.
fn parse_order(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        order @ ("asc" | "desc") => Ok(order.to_string()),
        _ => Err("expected asc or desc".to_string()),
    }
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

    #[test]
    fn teams_quote_takes_seats_or_a_plan() {
        let parse = |args: &[&str]| {
            Cli::try_parse_from(["whk", "teams", "quote", "Acme"].iter().chain(args))
        };
        match parse(&["--seats", "4"]).unwrap().command {
            Some(Command::Teams {
                action: TeamsAction::Quote { seats, plan, .. },
            }) => assert_eq!((seats, plan), (Some(4), None)),
            other => panic!("expected teams quote, got {other:?}"),
        }
        match parse(&["--plan", "team_business", "--interval", "year"])
            .unwrap()
            .command
        {
            Some(Command::Teams {
                action: TeamsAction::Quote { plan, interval, .. },
            }) => {
                assert_eq!(plan.as_deref(), Some("team_business"));
                assert_eq!(interval.as_deref(), Some("year"));
            }
            other => panic!("expected teams quote, got {other:?}"),
        }
        assert!(parse(&[]).is_err(), "seats or a plan is required");
        assert!(parse(&["--seats", "4", "--plan", "team"]).is_err());
        assert!(parse(&["--plan", "pro"]).is_err());
        assert!(parse(&["--seats", "4", "--interval", "year"]).is_err());
        assert!(parse(&["--seats", "0"]).is_err());
    }

    #[test]
    fn teams_delete_takes_approval_flags() {
        let cli = Cli::try_parse_from(["whk", "teams", "delete", "Acme", "--remote", "--no-wait"])
            .unwrap();
        match cli.command {
            Some(Command::Teams {
                action: TeamsAction::Delete { team, approval },
            }) => {
                assert_eq!(team, "Acme");
                assert!(approval.remote && approval.no_wait);
            }
            other => panic!("expected teams delete, got {other:?}"),
        }
    }

    #[test]
    fn layouts_and_fields_have_their_subcommands() {
        let parse = |args: &[&str]| {
            Cli::try_parse_from(["whk"].iter().chain(args))
                .unwrap()
                .command
        };
        match parse(&["layouts", "add-template", "acme", "shopify-order"]) {
            Some(Command::Layouts {
                action: LayoutsAction::AddTemplate { slug, template },
            }) => assert_eq!(
                (slug.as_str(), template.as_str()),
                ("acme", "shopify-order")
            ),
            other => panic!("expected layouts add-template, got {other:?}"),
        }
        match parse(&["fields", "preview", "acme", "--request", "r1"]) {
            Some(Command::Fields {
                action:
                    FieldsAction::Preview {
                        slug,
                        request,
                        fields,
                    },
            }) => {
                assert_eq!(slug, "acme");
                assert_eq!(request.as_deref(), Some("r1"));
                assert!(fields.is_none());
            }
            other => panic!("expected fields preview, got {other:?}"),
        }
    }

    #[test]
    fn destinations_take_their_settings_as_flags() {
        let parse = |args: &[&str]| Cli::try_parse_from(["whk"].iter().chain(args));
        match parse(&[
            "destinations",
            "add",
            "acme",
            "--url",
            "https://example.com/hooks",
            "--http",
            "false",
            "--format",
            "json",
            "--header",
            "X-Token: abc",
            "--header",
            "X-Other:1",
            "--retry-seconds",
            "3600",
            "--delay-seconds",
            "30",
        ])
        .unwrap()
        .command
        {
            Some(Command::Destinations {
                action:
                    DestinationsAction::Add {
                        slug,
                        fields,
                        secrets,
                    },
            }) => {
                assert_eq!(slug, "acme");
                assert_eq!(fields.url.as_deref(), Some("https://example.com/hooks"));
                assert_eq!(fields.http, Some(false));
                assert_eq!(fields.email, None);
                assert_eq!(fields.format.as_deref(), Some("json"));
                assert_eq!(fields.headers.len(), 2);
                assert_eq!(fields.retry_seconds, Some(3600));
                assert_eq!(fields.delay_seconds, Some(30));
                assert!(!secrets.drop_secret && !secrets.mailgun_signing_key);
            }
            other => panic!("expected destinations add, got {other:?}"),
        }
        assert!(parse(&["destinations", "add", "acme", "--format", "xml"]).is_err());
        assert!(parse(&["destinations", "add", "acme", "--retry-seconds", "60"]).is_err());
        assert!(parse(&["destinations", "add", "acme", "--throttle-seconds", "3601"]).is_err());
        assert!(parse(&["destinations", "add", "acme", "--enabled", "yes"]).is_err());
        assert!(
            parse(&[
                "destinations",
                "add",
                "acme",
                "--header",
                "A:b",
                "--clear-headers"
            ])
            .is_err()
        );
        // A secret is never a flag's value.
        assert!(parse(&["destinations", "add", "acme", "--drop-secret", "hunter2"]).is_err());

        match parse(&[
            "destinations",
            "update",
            "acme",
            "d1",
            "--enabled",
            "false",
            "--drop-secret",
        ])
        .unwrap()
        .command
        {
            Some(Command::Destinations {
                action:
                    DestinationsAction::Update {
                        id,
                        fields,
                        secrets,
                        ..
                    },
            }) => {
                assert_eq!(id, "d1");
                assert_eq!(fields.enabled, Some(false));
                assert!(secrets.drop_secret);
            }
            other => panic!("expected destinations update, got {other:?}"),
        }
        match parse(&["destinations", "rm", "acme", "d1", "--yes"])
            .unwrap()
            .command
        {
            Some(Command::Destinations {
                action: DestinationsAction::Rm { yes, .. },
            }) => assert!(yes),
            other => panic!("expected destinations rm, got {other:?}"),
        }
        match parse(&["destinations", "reorder", "acme", "d2", "d1"])
            .unwrap()
            .command
        {
            Some(Command::Destinations {
                action: DestinationsAction::Reorder { ids, .. },
            }) => assert_eq!(ids, ["d2", "d1"]),
            other => panic!("expected destinations reorder, got {other:?}"),
        }
        assert!(parse(&["destinations", "reorder", "acme"]).is_err());
        match parse(&[
            "destinations",
            "preview",
            "acme",
            "--destination",
            "d1",
            "--request",
            "r1",
            "--format",
            "chat",
        ])
        .unwrap()
        .command
        {
            Some(Command::Destinations {
                action:
                    DestinationsAction::Preview {
                        destination,
                        request,
                        fields,
                        ..
                    },
            }) => {
                assert_eq!(destination.as_deref(), Some("d1"));
                assert_eq!(request.as_deref(), Some("r1"));
                assert_eq!(fields.format.as_deref(), Some("chat"));
            }
            other => panic!("expected destinations preview, got {other:?}"),
        }
        assert!(parse(&["destinations", "test", "acme", "d1", "--kind", "sms"]).is_err());
        assert!(
            parse(&[
                "destinations",
                "test",
                "acme",
                "d1",
                "--kind",
                "http",
                "--request",
                "r1"
            ])
            .is_err()
        );
        match parse(&["destinations", "secret", "acme", "d1", "--rotate", "-y"])
            .unwrap()
            .command
        {
            Some(Command::Destinations {
                action: DestinationsAction::Secret { rotate, yes, .. },
            }) => assert!(rotate && yes),
            other => panic!("expected destinations secret, got {other:?}"),
        }
    }

    #[test]
    fn deliveries_list_by_endpoint_or_by_request() {
        let parse = |args: &[&str]| Cli::try_parse_from(["whk", "deliveries"].iter().chain(args));
        match parse(&["ls", "acme", "--status", "failed", "--limit", "20"])
            .unwrap()
            .command
        {
            Some(Command::Deliveries {
                action:
                    DeliveriesAction::Ls {
                        slug,
                        request,
                        status,
                        limit,
                        ..
                    },
            }) => {
                assert_eq!(slug.as_deref(), Some("acme"));
                assert!(request.is_none());
                assert_eq!(status.as_deref(), Some("failed"));
                assert_eq!(limit, Some(20));
            }
            other => panic!("expected deliveries ls, got {other:?}"),
        }
        match parse(&["ls", "--request", "r1"]).unwrap().command {
            Some(Command::Deliveries {
                action: DeliveriesAction::Ls { slug, request, .. },
            }) => {
                assert!(slug.is_none());
                assert_eq!(request.as_deref(), Some("r1"));
            }
            other => panic!("expected deliveries ls --request, got {other:?}"),
        }
        assert!(parse(&["ls"]).is_err(), "a slug or a request is needed");
        assert!(parse(&["ls", "--request", "r1", "--status", "failed"]).is_err());
        assert!(parse(&["ls", "acme", "--limit", "0"]).is_err());
        assert!(parse(&["ls", "acme", "--status", "succeeded"]).is_err());
        match parse(&["redeliver", "r1", "--destination", "d1", "--yes"])
            .unwrap()
            .command
        {
            Some(Command::Deliveries {
                action:
                    DeliveriesAction::Redeliver {
                        request,
                        destination,
                        yes,
                    },
            }) => {
                assert_eq!(request, "r1");
                assert_eq!(destination.as_deref(), Some("d1"));
                assert!(yes);
            }
            other => panic!("expected deliveries redeliver, got {other:?}"),
        }
        assert!(matches!(
            parse(&["redeliver-failed", "acme"]).unwrap().command,
            Some(Command::Deliveries {
                action: DeliveriesAction::RedeliverFailed { yes: false, .. }
            })
        ));
        assert!(matches!(
            parse(&["summary", "acme"]).unwrap().command,
            Some(Command::Deliveries {
                action: DeliveriesAction::Summary { .. }
            })
        ));
    }
}
