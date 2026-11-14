//! An endpoint's destinations (where its captures are forwarded) and the
//! delivery log. Answers are read loosely and kept as the server's JSON, so
//! `--json` prints them as is.

use anyhow::Result;
use serde_json::{Value, json};

use super::ApiClient;
use super::client::Fetched;

fn destinations_path(slug: &str) -> String {
    format!(
        "/api/endpoints/{}/destinations",
        crate::util::url::encode(slug)
    )
}

fn destination_path(slug: &str, id: &str) -> String {
    format!(
        "{}/{}",
        destinations_path(slug),
        crate::util::url::encode(id)
    )
}

fn deliveries_path(slug: &str) -> String {
    format!(
        "/api/endpoints/{}/deliveries",
        crate::util::url::encode(slug)
    )
}

/// Filters for the endpoint's delivery log.
#[derive(Debug, Default, Clone)]
pub struct DeliveryQuery {
    pub limit: Option<u32>,
    pub status: Option<String>,
    pub destination: Option<String>,
    pub before: Option<String>,
}

impl DeliveryQuery {
    fn query_string(&self) -> String {
        let mut parts = Vec::new();
        if let Some(limit) = self.limit {
            parts.push(format!("limit={limit}"));
        }
        for (name, value) in [
            ("status", &self.status),
            ("destination", &self.destination),
            ("before", &self.before),
        ] {
            if let Some(value) = value {
                parts.push(format!("{name}={}", crate::util::url::encode(value)));
            }
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("?{}", parts.join("&"))
        }
    }
}

impl ApiClient {
    /// The endpoint's destinations in order; `summary` adds each one's last
    /// 24 hours and what is waiting.
    pub async fn list_destinations(&self, slug: &str, summary: bool) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let query = if summary { "?summary=true" } else { "" };
        let resp = self
            .get(&format!("{}{query}", destinations_path(slug)))
            .await?;
        resp.parse("destinations")
    }

    pub async fn get_destination(&self, slug: &str, id: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.get(&destination_path(slug, id)).await?;
        resp.parse("destination")
    }

    pub async fn create_destination(&self, slug: &str, body: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.post(&destinations_path(slug), body).await?;
        resp.parse("destination")
    }

    pub async fn update_destination(
        &self,
        slug: &str,
        id: &str,
        body: &Value,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.patch(&destination_path(slug, id), body).await?;
        resp.parse("destination")
    }

    /// `{ deleted: true }`.
    pub async fn delete_destination(&self, slug: &str, id: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.delete(&destination_path(slug, id)).await?;
        resp.parse("removed destination")
    }

    /// Puts the destinations in this order; answers them in it.
    pub async fn reorder_destinations(&self, slug: &str, ids: &[String]) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .put_json(
                &format!("{}/order", destinations_path(slug)),
                &json!({ "ids": ids }),
            )
            .await?;
        resp.parse("destinations")
    }

    /// A dry run: `{ request, takesKind, filterPasses, format, delivery, error }`.
    pub async fn preview_destination(&self, slug: &str, body: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .post(&format!("{}/preview", destinations_path(slug)), body)
            .await?;
        resp.parse("destination preview")
    }

    /// Sends one delivery now and reports the answer.
    pub async fn test_destination(
        &self,
        slug: &str,
        id: &str,
        body: &Value,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .post(&format!("{}/test", destination_path(slug, id)), body)
            .await?;
        resp.parse("test delivery")
    }

    /// `{ secret }`: the current one, or a new one with `rotate`.
    pub async fn destination_secret(
        &self,
        slug: &str,
        id: &str,
        rotate: bool,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let path = format!("{}/secret", destination_path(slug, id));
        let resp = if rotate {
            self.post(&path, &json!({})).await?
        } else {
            self.get(&path).await?
        };
        resp.parse("destination secret")
    }

    /// The endpoint's delivery log, newest first.
    pub async fn list_deliveries(
        &self,
        slug: &str,
        query: &DeliveryQuery,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "{}{}",
                deliveries_path(slug),
                query.query_string()
            ))
            .await?;
        resp.parse("deliveries")
    }

    /// Every delivery of one captured request, with its attempts.
    pub async fn request_deliveries(&self, request_id: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "/api/requests/{}/deliveries",
                crate::util::url::encode(request_id)
            ))
            .await?;
        resp.parse("deliveries")
    }

    /// `{ last24h: { delivered, failed }, pending, failed, total }`.
    pub async fn delivery_summary(&self, slug: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!("{}/summary", deliveries_path(slug)))
            .await?;
        resp.parse("delivery summary")
    }

    /// Queues a request again: to every destination that takes its kind, or
    /// to one (whatever its filter says). `{ id }`.
    pub async fn redeliver_request(
        &self,
        request_id: &str,
        destination: Option<&str>,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let body = match destination {
            Some(id) => json!({ "destinationId": id }),
            None => json!({}),
        };
        let resp = self
            .post(
                &format!(
                    "/api/requests/{}/deliveries",
                    crate::util::url::encode(request_id)
                ),
                &body,
            )
            .await?;
        resp.parse("redelivery")
    }

    /// Queues every request whose latest delivery failed again. `{ queued }`.
    pub async fn redeliver_failed(
        &self,
        slug: &str,
        destination: Option<&str>,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let query = destination
            .map(|id| format!("?destination={}", crate::util::url::encode(id)))
            .unwrap_or_default();
        let resp = self
            .post(
                &format!("{}/redeliver-failed{query}", deliveries_path(slug)),
                &json!({}),
            )
            .await?;
        resp.parse("redelivery")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delivery_query_sends_only_what_was_given() {
        assert_eq!(DeliveryQuery::default().query_string(), "");
        let query = DeliveryQuery {
            limit: Some(20),
            status: Some("failed".into()),
            destination: None,
            before: Some("1700000000000:abc def".into()),
        };
        assert_eq!(
            query.query_string(),
            "?limit=20&status=failed&before=1700000000000%3Aabc%20def"
        );
    }
}
