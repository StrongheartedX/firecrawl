use anyhow::{Context, Result};
use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub rabbitmq_url: String,
    pub supabase_url: String,
    pub supabase_service_token: String,
    pub retry_delay_ms: u64,
    pub max_retries: u32,
    pub prefetch_count: u16,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        Ok(Config {
            rabbitmq_url: env::var("NUQ_RABBITMQ_URL").context("NUQ_RABBITMQ_URL must be set")?,
            supabase_url: env::var("SUPABASE_URL").context("SUPABASE_URL must be set")?,
            supabase_service_token: env::var("SUPABASE_SERVICE_TOKEN")
                .context("SUPABASE_SERVICE_TOKEN must be set")?,
            retry_delay_ms: env::var("WEBHOOK_RETRY_DELAY_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60000),
            max_retries: env::var("WEBHOOK_MAX_RETRIES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3),
            prefetch_count: env::var("WEBHOOK_PREFETCH_COUNT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(100),
        })
    }
}
