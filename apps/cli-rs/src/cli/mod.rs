pub mod auth;
pub mod endpoints;
pub mod listen;
pub mod output;
pub mod replay;
pub mod requests;
pub mod send;
pub mod tunnel;
pub mod usage;
pub mod update;

use clap::{Parser, Subcommand};

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

        /// Mock response body
        #[arg(long)]
        mock_body: Option<String>,

        /// Mock response header (repeatable, format: Key:Value)
        #[arg(long = "mock-header", value_name = "KEY:VALUE")]
        mock_headers: Vec<String>,
    },

    /// List all endpoints
    List,

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

        /// Mock response body
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

        /// Delete endpoint on exit
        #[arg(short, long)]
        ephemeral: bool,

        /// Add custom header to forwarded requests (repeatable)
        #[arg(short = 'H', long = "header", value_name = "KEY:VALUE")]
        headers: Vec<String>,
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

    /// Show usage and quota info
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
