use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WebhookQueueMessage {
    pub webhook_url: String,
    pub payload: WebhookPayload,
    pub headers: HashMap<String, String>,
    pub team_id: String,
    pub job_id: String,
    pub scrape_id: Option<String>,
    pub event: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub retry_count: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WebhookPayload {
    pub success: bool,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(rename = "webhookId")]
    pub webhook_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "jobId", skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub data: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
pub struct WebhookLog {
    pub success: bool,
    pub error: Option<String>,
    pub team_id: String,
    pub crawl_id: String,
    pub scrape_id: Option<String>,
    pub url: String,
    pub status_code: Option<i32>,
    pub event: String,
}
