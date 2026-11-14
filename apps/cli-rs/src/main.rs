use std::process::ExitCode;

use anyhow::Result;
use clap::Parser;

use whk::api::ApiClient;
use whk::cli::{
    self, AccountAction, AgentsAction, AiAction, ApprovalsAction, AuthAction, Cli, Command,
    DomainsAction, FieldsAction, GoogleAction, KeysAction, LayoutsAction, NamesAction,
    RequestsAction, SandboxAction, ShareLinksAction, SharesAction, TeamsAction,
};
use whk::error::{classify, error_json};

#[tokio::main]
async fn main() -> ExitCode {
    let args = match Cli::try_parse() {
        Ok(args) => args,
        Err(error) => return argument_error(error),
    };
    let json = args.json;
    cli::output::set_no_color(args.no_color || std::env::var("NO_COLOR").is_ok());

    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let c = classify(&error);
            if json {
                eprintln!("{}", error_json(&error, &c));
            } else {
                eprintln!("Error: {error:#}");
                // A hint the message already gives is not repeated.
                if let Some(hint) = c.hint.as_deref()
                    && !format!("{error:#}").contains(hint)
                {
                    eprintln!("{hint}");
                }
            }
            ExitCode::from(c.exit as u8)
        }
    }
}

/// A command line clap refused. Help and `--version` print as usual; under
/// `--json` a real mistake comes as the same `{"error": ...}` as any other
/// failure, with exit 2.
fn argument_error(error: clap::Error) -> ExitCode {
    use clap::error::ErrorKind;
    let informational = matches!(
        error.kind(),
        ErrorKind::DisplayHelp
            | ErrorKind::DisplayVersion
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
    );
    let json = std::env::args_os().skip(1).any(|a| a == "--json");
    if informational || !json {
        error.exit();
    }
    // clap's first line says what was wrong ("error: unexpected argument ...").
    // What clap says before its usage line, on one line.
    let text = error.to_string();
    let message = text
        .lines()
        .take_while(|line| !line.starts_with("Usage:"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim_start_matches("error: ")
        .to_string();
    eprintln!(
        "{}",
        serde_json::json!({
            "error": {
                "code": "usage",
                "message": message,
                "exit": 2,
                "hint": "Run the command with --help for its arguments.",
            }
        })
    );
    ExitCode::from(2)
}

async fn run(args: Cli) -> Result<()> {
    // A bare `whk` prints help, before any credentials are read, so a broken
    // token file never hides it. It used to open a full-screen TUI, which
    // hung any agent or script that ran it without a terminal.
    if args.command.is_none() {
        use clap::CommandFactory;
        // A closed pipe (`whk | head`) is not a failure.
        let _ = Cli::command().print_help();
        return Ok(());
    }

    let mut client = ApiClient::new(args.api_url.as_deref(), args.webhook_url.as_deref())?;
    // A command printed for a later run (a search's continue command) names
    // the server this run used, default included: the later run may have
    // other flags or another WHK_API_URL.
    let api_url_flag = Some(client.base_url().to_string());

    match args.command {
        None => unreachable!("handled above"),

        Some(Command::Wait {
            slug,
            timeout,
            count,
            since,
            method,
            kind,
            path,
        }) => {
            cli::wait::run(
                &client,
                cli::wait::WaitOptions {
                    slug,
                    timeout,
                    count,
                    since,
                    method,
                    kind,
                    path,
                },
                args.json,
            )
            .await?;
        }

        Some(Command::Api {
            path,
            method,
            data,
            headers,
            include,
        }) => {
            cli::api::run(
                &client,
                &path,
                method.as_deref(),
                data.as_deref(),
                &headers,
                include,
            )
            .await?;
        }

        Some(Command::Auth { action }) => match action {
            AuthAction::Login { remote, no_browser } => {
                cli::auth::login(&mut client, args.json, remote, no_browser).await?
            }
            AuthAction::Status => cli::auth::status(&client, args.json).await?,
            AuthAction::Logout => cli::auth::logout(&client, args.json).await?,
        },

        Some(Command::Create {
            name,
            ephemeral,
            expires_in,
            mock_status,
            mock_body,
            mock_headers,
            signing_provider,
            signing_secret,
        }) => {
            cli::endpoints::create(
                &client,
                name,
                ephemeral,
                expires_in,
                mock_status,
                mock_body,
                mock_headers,
                signing_provider,
                signing_secret,
                args.json,
            )
            .await?;
        }

        Some(Command::List { team }) => {
            cli::endpoints::list(&client, team.as_deref(), args.json).await?;
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

        Some(Command::Favorite { slug }) => {
            cli::endpoints::set_favorite(&client, &slug, true, args.json).await?;
        }

        Some(Command::Unfavorite { slug }) => {
            cli::endpoints::set_favorite(&client, &slug, false, args.json).await?;
        }

        Some(Command::Delete { slug, force }) => {
            cli::endpoints::delete(&client, &slug, force, args.json).await?;
        }

        Some(Command::Tunnel {
            target,
            endpoint,
            ephemeral,
            headers,
            email_format,
            email_path,
            mailgun_signing_key,
            no_email,
            live,
        }) => {
            let emails =
                cli::tunnel::email_options(email_format, email_path, mailgun_signing_key, no_email);
            cli::tunnel::run(
                &client,
                &target,
                endpoint.as_deref(),
                ephemeral,
                headers,
                emails,
                live,
                args.json,
            )
            .await?;
        }

        Some(Command::Share {
            target,
            name,
            password,
            no_qr,
            until_stdin_closes,
        }) => {
            cli::share::run(
                &client,
                cli::share::ShareOptions {
                    target,
                    name,
                    password,
                    no_qr,
                    until_stdin_closes,
                    json: args.json,
                },
            )
            .await?;
        }

        Some(Command::Shares { action }) => match action {
            SharesAction::Ls { ended } => cli::share::list(&client, ended, args.json).await?,
            SharesAction::Stop { share } => cli::share::stop(&client, &share, args.json).await?,
            SharesAction::Log { share } => cli::share::log(&client, &share, args.json).await?,
        },

        Some(Command::Names { action }) => match action {
            NamesAction::Ls => cli::share::names(&client, args.json).await?,
            NamesAction::Reserve { name, team } => {
                cli::share::reserve(&client, &name, team.as_deref(), args.json).await?
            }
            NamesAction::Release { name } => cli::share::release(&client, &name, args.json).await?,
            NamesAction::Password { name, clear } => {
                cli::share::password(&client, &name, clear, args.json).await?
            }
        },

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
            cli::send::send_to_url(&client, &url, &method, headers, data.as_deref(), args.json)
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
                kind,
                q,
                from,
                to,
                limit,
                offset,
                order,
                cursor,
            } => {
                let filters = whk::api::requests::SearchFilters {
                    slug: slug.as_deref(),
                    method: method.as_deref(),
                    kind: kind.as_deref(),
                    query: q.as_deref(),
                    from: from.as_deref(),
                    to: to.as_deref(),
                };
                cli::requests::search(
                    &client,
                    &filters,
                    limit,
                    offset,
                    &order,
                    cursor.as_deref(),
                    api_url_flag.as_deref(),
                    args.json,
                )
                .await?;
            }
            RequestsAction::Count {
                slug,
                method,
                kind,
                q,
                from,
                to,
                cursor,
            } => {
                let filters = whk::api::requests::SearchFilters {
                    slug: slug.as_deref(),
                    method: method.as_deref(),
                    kind: kind.as_deref(),
                    query: q.as_deref(),
                    from: from.as_deref(),
                    to: to.as_deref(),
                };
                cli::requests::count(
                    &client,
                    &filters,
                    cursor.as_deref(),
                    api_url_flag.as_deref(),
                    args.json,
                )
                .await?;
            }
            RequestsAction::Clear {
                slug,
                before,
                force,
            } => {
                cli::requests::clear(&client, &slug, before.as_deref(), force, args.json).await?;
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

        Some(Command::Billing) => cli::billing::show(&client, args.json).await?,

        Some(Command::Keys { action }) => match action {
            KeysAction::List => cli::keys::list(&client, args.json).await?,
            KeysAction::Create {
                name,
                expires_in_days,
                remote,
                no_browser,
                no_wait,
                timeout,
            } => {
                let opts = cli::keys::CreateOptions {
                    expires_in_days,
                    remote,
                    no_browser,
                    no_wait,
                    timeout,
                };
                cli::keys::create(&client, &name, opts, args.json).await?
            }
            KeysAction::Revoke { id, yes } => {
                cli::keys::revoke(&client, &id, yes, args.json).await?
            }
        },

        Some(Command::Account { action }) => match action {
            AccountAction::Rename {
                name,
                clear: _,
                approval,
            } => cli::account::rename(&client, name.as_deref(), approval.into(), args.json).await?,
        },

        Some(Command::Agents { action }) => match action {
            AgentsAction::List => cli::account::agents_list(&client, args.json).await?,
            AgentsAction::Disconnect { id, yes } => {
                cli::account::agents_disconnect(&client, &id, yes, args.json).await?
            }
        },

        Some(Command::ShareLinks { action }) => match action {
            ShareLinksAction::List { request } => {
                cli::account::share_links_list(&client, request.as_deref(), args.json).await?
            }
            ShareLinksAction::Create {
                request,
                days,
                show_signatures,
                approval,
            } => {
                cli::account::share_links_create(
                    &client,
                    &request,
                    days,
                    show_signatures,
                    approval.into(),
                    args.json,
                )
                .await?
            }
            ShareLinksAction::Revoke { id, yes } => {
                cli::account::share_links_revoke(&client, &id, yes, args.json).await?
            }
        },

        Some(Command::Domains { action }) => match action {
            DomainsAction::List { team } => {
                cli::account::domains_list(&client, team.as_deref(), args.json).await?
            }
            DomainsAction::Add { domain, team } => {
                cli::account::domains_add(&client, &domain, team.as_deref(), args.json).await?
            }
            DomainsAction::Verify { id, team } => {
                cli::account::domains_verify(&client, &id, team.as_deref(), args.json).await?
            }
            DomainsAction::Route {
                id,
                catch_all,
                routes,
                team,
            } => {
                cli::account::domains_route(
                    &client,
                    &id,
                    team.as_deref(),
                    catch_all.as_deref(),
                    &routes,
                    args.json,
                )
                .await?
            }
            DomainsAction::Remove { id, team, approval } => {
                cli::account::domains_remove(
                    &client,
                    &id,
                    team.as_deref(),
                    approval.into(),
                    args.json,
                )
                .await?
            }
        },

        Some(Command::Google { action }) => match action {
            GoogleAction::List => cli::google::list(&client, args.json).await?,
            GoogleAction::Connect { approval } => {
                cli::google::connect(&client, approval.into(), args.json).await?
            }
            GoogleAction::Pick {
                connection,
                approval,
            } => cli::google::pick(&client, &connection, approval.into(), args.json).await?,
            GoogleAction::Tabs {
                connection,
                spreadsheet,
            } => cli::google::tabs(&client, &connection, &spreadsheet, args.json).await?,
            GoogleAction::CreateSheet {
                connection,
                headers,
                title,
                spreadsheet,
                sheet,
            } => {
                let opts = cli::google::SheetOptions {
                    title,
                    spreadsheet_id: spreadsheet,
                    sheet,
                    headers,
                };
                cli::google::create_sheet(&client, &connection, opts, args.json).await?
            }
            GoogleAction::Disconnect { connection, yes } => {
                cli::google::disconnect(&client, &connection, yes, args.json).await?
            }
        },

        Some(Command::Ai { action }) => match action {
            AiAction::Status { slug } => cli::google::ai_status(&client, &slug, args.json).await?,
            AiAction::Setup {
                slug,
                requests,
                field,
                description,
                layout,
                repair,
                approval,
            } => {
                let setup = cli::google::SetupAsk {
                    field,
                    description,
                    layout,
                    repair,
                };
                cli::google::ai_setup(&client, &slug, &requests, setup, approval.into(), args.json)
                    .await?
            }
        },

        Some(Command::Approvals { action }) => match action {
            ApprovalsAction::Wait { id, timeout } => {
                cli::keys::wait(&client, &id, &timeout, args.json).await?
            }
        },

        Some(Command::Teams { action }) => match action {
            TeamsAction::List => cli::teams::list(&client, args.json).await?,
            TeamsAction::Members { team } => cli::teams::members(&client, &team, args.json).await?,
            TeamsAction::Share { slug, team } => {
                cli::teams::share(&client, &slug, &team, args.json).await?
            }
            TeamsAction::Unshare { slug, team } => {
                cli::teams::unshare(&client, &slug, &team, args.json).await?
            }
            TeamsAction::Invite {
                team,
                email,
                approval,
            } => cli::teams::invite(&client, &team, &email, approval.into(), args.json).await?,
            TeamsAction::Invites => cli::teams::invites(&client, args.json).await?,
            TeamsAction::Accept { invite_id } => {
                cli::teams::accept(&client, &invite_id, args.json).await?
            }
            TeamsAction::Decline { invite_id } => {
                cli::teams::decline(&client, &invite_id, args.json).await?
            }
            TeamsAction::Create { name } => cli::teams::create(&client, &name, args.json).await?,
            TeamsAction::Rename { team, name } => {
                cli::teams::rename(&client, &team, &name, args.json).await?
            }
            TeamsAction::Delete { team, approval } => {
                cli::teams::delete(&client, &team, approval.into(), args.json).await?
            }
            TeamsAction::Remove { team, member, yes } => {
                cli::teams::remove(&client, &team, &member, yes, args.json).await?
            }
            TeamsAction::Leave { team, yes } => {
                cli::teams::leave(&client, &team, yes, args.json).await?
            }
            TeamsAction::Withdraw { team, invite, yes } => {
                cli::teams::withdraw(&client, &team, &invite, yes, args.json).await?
            }
            TeamsAction::Quote {
                team,
                seats,
                plan,
                interval,
            } => {
                let ask = match (seats, plan) {
                    (Some(seats), _) => cli::teams::QuoteAsk::Seats(seats),
                    (None, Some(plan)) => cli::teams::QuoteAsk::Plan {
                        plan,
                        interval: interval.unwrap_or_else(|| "month".into()),
                    },
                    (None, None) => unreachable!("clap requires --seats or --plan"),
                };
                cli::teams::quote(&client, &team, ask, args.json).await?
            }
        },

        Some(Command::Layouts { action }) => match action {
            LayoutsAction::Templates { slug } => {
                cli::layouts::templates(&client, &slug, args.json).await?
            }
            LayoutsAction::AddTemplate { slug, template } => {
                cli::layouts::add_template(&client, &slug, &template, args.json).await?
            }
        },

        Some(Command::Fields { action }) => match action {
            FieldsAction::Preview {
                slug,
                request,
                fields,
            } => {
                cli::layouts::preview(
                    &client,
                    &slug,
                    request.as_deref(),
                    fields.as_deref(),
                    args.json,
                )
                .await?
            }
        },

        Some(Command::Sandbox { action }) => match action {
            SandboxAction::Create => cli::sandbox::create(&client, args.json).await?,
            SandboxAction::List => cli::sandbox::list(&client, args.json).await?,
            SandboxAction::Get { slug } => cli::sandbox::get(&client, &slug, args.json).await?,
            SandboxAction::Delete { slug } => {
                cli::sandbox::delete(&client, &slug, args.json).await?
            }
            SandboxAction::Requests { slug, limit, since } => {
                cli::sandbox::requests(&client, &slug, limit, since, args.json).await?
            }
            SandboxAction::Request { id } => cli::sandbox::request(&client, &id, args.json).await?,
            SandboxAction::Wait {
                slug,
                timeout,
                since,
                count,
            } => cli::sandbox::wait(&client, &slug, &timeout, since, count, args.json).await?,
            SandboxAction::Status => cli::sandbox::status(&client, args.json).await?,
            SandboxAction::Connect { email, timeout } => {
                cli::sandbox::connect(&client, &email, timeout.as_deref(), args.json).await?
            }
            SandboxAction::Forget {
                claimed,
                sandbox,
                all,
            } => cli::sandbox::forget(&client, claimed || all, sandbox || all, args.json).await?,
        },

        Some(Command::Usage) => {
            cli::usage::run(&client, args.json).await?;
        }

        Some(Command::Update) => {
            cli::update::run(args.json).await?;
        }

        Some(Command::Completions { shell }) => {
            use clap::CommandFactory;
            clap_complete::generate(shell, &mut Cli::command(), "whk", &mut std::io::stdout());
        }
    }

    Ok(())
}
