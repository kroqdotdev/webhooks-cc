mod api;
mod auth;
mod cli;
mod tunnel;
mod tui;
mod types;
mod util;

use anyhow::Result;
use clap::Parser;

use crate::api::ApiClient;
use crate::cli::{AuthAction, Cli, Command, RequestsAction};

#[tokio::main]
async fn main() -> Result<()> {
    let args = Cli::parse();

    cli::output::set_no_color(args.no_color);

    let mut client = ApiClient::new(
        args.api_url.as_deref(),
        args.webhook_url.as_deref(),
    )?;

    match args.command {
        None => {
            if args.nogui {
                // --nogui without subcommand: show help
                use clap::CommandFactory;
                Cli::command().print_help()?;
            } else {
                tui::run(client).await?;
            }
        }

        Some(Command::Auth { action }) => match action {
            AuthAction::Login => cli::auth::login(&mut client, args.json).await?,
            AuthAction::Status => cli::auth::status(args.json).await?,
            AuthAction::Logout => cli::auth::logout(args.json).await?,
        },

        Some(Command::Create {
            name,
            ephemeral,
            expires_in,
            mock_status,
            mock_body,
            mock_headers,
        }) => {
            cli::endpoints::create(
                &client,
                name,
                ephemeral,
                expires_in,
                mock_status,
                mock_body,
                mock_headers,
                args.json,
            )
            .await?;
        }

        Some(Command::List) => {
            cli::endpoints::list(&client, args.json).await?;
        }

        Some(Command::Get { slug }) => {
            cli::endpoints::get(&client, &slug, args.json).await?;
        }

        Some(Command::UpdateEndpoint {
            slug,
            name,
            mock_status,
            mock_body,
            mock_headers,
            clear_mock,
        }) => {
            cli::endpoints::update_endpoint(
                &client,
                &slug,
                name,
                mock_status,
                mock_body,
                mock_headers,
                clear_mock,
                args.json,
            )
            .await?;
        }

        Some(Command::Delete { slug, force }) => {
            cli::endpoints::delete(&client, &slug, force, args.json).await?;
        }

        Some(Command::Tunnel {
            target,
            endpoint,
            ephemeral,
            headers,
        }) => {
            cli::tunnel::run(
                &client,
                &target,
                endpoint.as_deref(),
                ephemeral,
                headers,
                args.json,
            )
            .await?;
        }

        Some(Command::Listen { slug }) => {
            cli::listen::run(&client, &slug, args.json).await?;
        }

        Some(Command::Replay { id, to }) => {
            cli::replay::run(&client, &id, &to, args.json).await?;
        }

        Some(Command::Send {
            slug,
            method,
            headers,
            data,
        }) => {
            cli::send::send_to_endpoint(
                &client,
                &slug,
                &method,
                headers,
                data.as_deref(),
                args.json,
            )
            .await?;
        }

        Some(Command::SendTo {
            url,
            method,
            headers,
            data,
        }) => {
            cli::send::send_to_url(
                &client,
                &url,
                &method,
                headers,
                data.as_deref(),
                args.json,
            )
            .await?;
        }

        Some(Command::Requests { action }) => match action {
            RequestsAction::List {
                slug,
                limit,
                since,
                cursor,
            } => {
                cli::requests::list(&client, &slug, limit, since, cursor, args.json).await?;
            }
            RequestsAction::Get { id } => {
                cli::requests::get(&client, &id, args.json).await?;
            }
            RequestsAction::Search {
                slug,
                method,
                q,
                from,
                to,
                limit,
                offset,
                order,
            } => {
                cli::requests::search(
                    &client,
                    slug.as_deref(),
                    method.as_deref(),
                    q.as_deref(),
                    from.as_deref(),
                    to.as_deref(),
                    limit,
                    offset,
                    &order,
                    args.json,
                )
                .await?;
            }
            RequestsAction::Count {
                slug,
                method,
                q,
                from,
                to,
            } => {
                cli::requests::count(
                    &client,
                    slug.as_deref(),
                    method.as_deref(),
                    q.as_deref(),
                    from.as_deref(),
                    to.as_deref(),
                    args.json,
                )
                .await?;
            }
            RequestsAction::Clear {
                slug,
                before,
                force,
            } => {
                cli::requests::clear(
                    &client,
                    &slug,
                    before.as_deref(),
                    force,
                    args.json,
                )
                .await?;
            }
            RequestsAction::Export {
                slug,
                format,
                limit,
                since,
                output,
            } => {
                cli::requests::export(
                    &client,
                    &slug,
                    &format,
                    limit,
                    since,
                    output.as_deref(),
                    args.json,
                )
                .await?;
            }
        },

        Some(Command::Usage) => {
            cli::usage::run(&client, args.json).await?;
        }

        Some(Command::Update) => {
            cli::update::run(args.json).await?;
        }

        Some(Command::Completions { shell }) => {
            use clap::CommandFactory;
            clap_complete::generate(
                shell,
                &mut Cli::command(),
                "whk",
                &mut std::io::stdout(),
            );
        }
    }

    Ok(())
}
