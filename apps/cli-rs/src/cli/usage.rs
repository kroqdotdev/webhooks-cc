use anyhow::Result;

use crate::api::ApiClient;
use crate::cli::output::print_usage;

pub async fn run(client: &ApiClient, json: bool) -> Result<()> {
    let usage = client.get_usage().await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&usage)?);
    } else {
        print_usage(&usage);
    }

    Ok(())
}
