use crate::models::{WebhookLog, WebhookQueueMessage};
use crate::signature::sign_payload;
use anyhow::{Context, Result};
use postgrest::Postgrest;
use reqwest::{header, Client};
use std::net::IpAddr;
use std::time::Duration;
use url::Url;

#[derive(Clone)]
pub struct WebhookDispatcher {
    postgrest: Postgrest,
}

pub enum DispatchResult {
    Success,
    FatalError,
    RetryableError,
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_documentation()
        }
        IpAddr::V6(ip) => {
            ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_multicast()
        }
    }
}

impl WebhookDispatcher {
    pub fn new(supabase_url: &str, supabase_service_token: &str) -> Self {
        Self {
            postgrest: Postgrest::new(format!("{}/rest/v1", supabase_url))
                .insert_header("apikey", supabase_service_token)
                .insert_header(
                    "Authorization",
                    format!("Bearer {}", supabase_service_token),
                ),
        }
    }

    async fn fetch_hmac_secret(&self, team_id: &str) -> Result<Option<String>> {
        let response = self
            .postgrest
            .from("teams")
            .select("hmac_secret")
            .eq("id", team_id)
            .limit(1)
            .single()
            .execute()
            .await
            .context("Failed to fetch HMAC secret")?;

        if !response.status().is_success() {
            tracing::warn!(
                team_id = %team_id,
                status = response.status().as_u16(),
                "Failed to fetch HMAC secret from database"
            );
            return Ok(None);
        }

        let data: serde_json::Value = serde_json::from_str(&response.text().await?)?;
        Ok(data
            .get("hmac_secret")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    #[tracing::instrument(skip(self, message), fields(job_id = %message.job_id))]
    pub async fn dispatch(&self, message: &WebhookQueueMessage) -> Result<DispatchResult> {
        let hmac_secret = self.fetch_hmac_secret(&message.team_id).await?;

        let url = match Url::parse(&message.webhook_url) {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(error = %e, url = %message.webhook_url, "Invalid webhook URL");
                self.log_failure(message, None, format!("Invalid URL: {}", e))
                    .await?;
                return Ok(DispatchResult::FatalError);
            }
        };

        let host = match url.host_str() {
            Some(h) => h,
            None => {
                tracing::warn!(url = %message.webhook_url, "URL missing host");
                self.log_failure(message, None, "URL missing host".into())
                    .await?;
                return Ok(DispatchResult::FatalError);
            }
        };

        let addrs = match tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(80)))
            .await
        {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(error = %e, host = %host, "DNS lookup failed");
                self.log_failure(message, None, format!("DNS failed: {}", e))
                    .await?;
                return Ok(DispatchResult::FatalError);
            }
        };

        let target_addr = match addrs.into_iter().find(|addr| !is_private_ip(addr.ip())) {
            Some(addr) => addr,
            None => {
                tracing::warn!(host = %host, "Webhook URL resolved to private/blocked IP");
                self.log_failure(message, None, "Resolved to private/blocked IP".into())
                    .await?;
                return Ok(DispatchResult::FatalError);
            }
        };

        let client = Client::builder()
            .timeout(Duration::from_millis(message.timeout_ms))
            .resolve(host, target_addr)
            .build()
            .map_err(|e| anyhow::anyhow!("Client build failed: {}", e))?;

        let payload_json = serde_json::to_string(&message.payload)?;
        let mut headers = header::HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());

        for (k, v) in &message.headers {
            if let (Ok(n), Ok(val)) = (
                header::HeaderName::try_from(k.as_str()),
                header::HeaderValue::try_from(v.as_str()),
            ) {
                headers.insert(n, val);
            }
        }

        if let Some(secret) = hmac_secret {
            if let Ok(sig) = header::HeaderValue::from_str(&sign_payload(&secret, &payload_json)) {
                headers.insert("X-Firecrawl-Signature", sig);
            }
        }

        tracing::info!(url = %url, "Sending webhook");

        match client
            .post(url.as_str())
            .headers(headers)
            .body(payload_json)
            .send()
            .await
        {
            Ok(res) => {
                let status = res.status();
                if status.is_success() {
                    tracing::info!(status = status.as_u16(), "Webhook delivered");
                    self.log_webhook(
                        message,
                        status.is_success(),
                        Some(status.as_u16() as i32),
                        None,
                    )
                    .await?;
                    Ok(DispatchResult::Success)
                } else {
                    tracing::warn!(status = status.as_u16(), "Webhook server returned error");
                    self.log_webhook(
                        message,
                        false,
                        Some(status.as_u16() as i32),
                        Some(format!("HTTP Status {}", status)),
                    )
                    .await?;

                    // rate limits (429), timeouts (408), and server errors (5xx) are retryable
                    match status.as_u16() {
                        429 | 408 | 500..=599 => Ok(DispatchResult::RetryableError),
                        _ => Ok(DispatchResult::FatalError),
                    }
                }
            }
            Err(e) => {
                let code = e.status().map(|s| s.as_u16() as i32);
                tracing::error!(error = ?e, "Webhook delivery failed");
                self.log_webhook(message, false, code, Some(format!("{:#}", e)))
                    .await?;
                Ok(DispatchResult::RetryableError)
            }
        }
    }

    async fn log_failure(
        &self,
        message: &WebhookQueueMessage,
        code: Option<i32>,
        error: String,
    ) -> Result<()> {
        self.log_webhook(message, false, code, Some(error)).await
    }

    async fn log_webhook(
        &self,
        message: &WebhookQueueMessage,
        success: bool,
        status_code: Option<i32>,
        error: Option<String>,
    ) -> Result<()> {
        let log = WebhookLog {
            success,
            error,
            team_id: message.team_id.clone(),
            crawl_id: message.job_id.clone(),
            scrape_id: message.scrape_id.clone(),
            url: message.webhook_url.clone(),
            status_code,
            event: message.event.clone(),
        };

        let res = self
            .postgrest
            .from("webhook_logs")
            .insert(serde_json::to_string(&log)?)
            .execute()
            .await?;

        if !res.status().is_success() {
            let status_code = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();

            tracing::error!(
                status = status_code,
                body = %body,
                "Failed to log webhook"
            );
        }

        Ok(())
    }
}
