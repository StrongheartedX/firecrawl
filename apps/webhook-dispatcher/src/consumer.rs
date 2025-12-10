use crate::config::Config;
use crate::dispatcher::{DispatchResult, WebhookDispatcher};
use crate::models::WebhookQueueMessage;
use anyhow::{Context, Result};
use futures_lite::StreamExt;
use lapin::{
    options::*,
    types::{FieldTable, LongString},
    BasicProperties, Connection, ConnectionProperties,
};
use tokio::sync::broadcast;
use tokio::task::JoinSet;

const QUEUE_NAME: &str = "webhooks";
const RETRY_QUEUE_NAME: &str = "webhooks_retry";

pub async fn run(config: Config, mut shutdown_rx: broadcast::Receiver<()>) -> Result<()> {
    loop {
        let mut shutdown_clone = shutdown_rx.resubscribe();
        if let Err(e) = run_inner(&config, &mut shutdown_clone).await {
            if shutdown_rx.try_recv().is_ok() {
                return Ok(());
            }
            tracing::error!(error = %e, "Consumer error, restarting in 5s");
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        } else {
            return Ok(());
        }
    }
}

async fn run_inner(config: &Config, shutdown_rx: &mut broadcast::Receiver<()>) -> Result<()> {
    let conn = Connection::connect(&config.rabbitmq_url, ConnectionProperties::default())
        .await
        .context("RabbitMQ connect failed")?;
    let channel = conn
        .create_channel()
        .await
        .context("Channel create failed")?;

    let mut args = FieldTable::default();
    args.insert("x-queue-type".into(), LongString::from("quorum").into());

    channel
        .queue_declare(
            QUEUE_NAME,
            QueueDeclareOptions {
                durable: true,
                ..Default::default()
            },
            args,
        )
        .await?;

    let mut retry_args = FieldTable::default();
    retry_args.insert("x-dead-letter-exchange".into(), LongString::from("").into());
    retry_args.insert(
        "x-dead-letter-routing-key".into(),
        LongString::from(QUEUE_NAME).into(),
    );
    retry_args.insert(
        "x-message-ttl".into(),
        (config.retry_delay_ms as i64).into(),
    );

    channel
        .queue_declare(
            RETRY_QUEUE_NAME,
            QueueDeclareOptions {
                durable: true,
                ..Default::default()
            },
            retry_args,
        )
        .await?;

    channel
        .basic_qos(config.prefetch_count, BasicQosOptions::default())
        .await?;

    let mut consumer = channel
        .basic_consume(
            QUEUE_NAME,
            "webhook-dispatcher",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    let dispatcher = WebhookDispatcher::new(&config.supabase_url, &config.supabase_service_token);

    let mut tasks = JoinSet::new();
    let max_concurrent = config.prefetch_count as usize;

    tracing::info!(
        queue = QUEUE_NAME,
        prefetch = config.prefetch_count,
        "Consumer started"
    );

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                tracing::info!("Shutting down consumer");
                break;
            }

            Some(res) = tasks.join_next(), if !tasks.is_empty() => {
                handle_result(res).await?;
            }

            delivery = consumer.next(), if tasks.len() < max_concurrent => {
                match delivery {
                    Some(Ok(delivery)) => {
                        let d = dispatcher.clone();
                        let c = channel.clone();
                        let max_retries = config.max_retries;
                        tasks.spawn(async move {
                            let res = process_message(&d, &c, &delivery.data, max_retries).await;
                            (delivery, res)
                        });
                    }
                    Some(Err(e)) => return Err(e.into()),
                    None => break,
                }
            }
        }
    }

    while let Some(res) = tasks.join_next().await {
        handle_result(res).await?;
    }

    Ok(())
}

async fn handle_result(
    res: Result<(lapin::message::Delivery, Result<()>), tokio::task::JoinError>,
) -> Result<()> {
    match res {
        Ok((delivery, Ok(_))) => {
            if let Err(e) = delivery.ack(BasicAckOptions::default()).await {
                tracing::error!(tag = delivery.delivery_tag, error = %e, "Ack failed");
            }
        }
        Ok((delivery, Err(e))) => {
            tracing::error!(tag = delivery.delivery_tag, error = %e, "Processing failed, requeueing");
            let _ = delivery
                .nack(BasicNackOptions {
                    multiple: false,
                    requeue: true,
                })
                .await;
        }
        Err(e) => tracing::error!(error = %e, "Task panicked"),
    }
    Ok(())
}

async fn process_message(
    dispatcher: &WebhookDispatcher,
    channel: &lapin::Channel,
    data: &[u8],
    max_retries: u32,
) -> Result<()> {
    let mut message: WebhookQueueMessage = match serde_json::from_slice(data) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(error = %e, "Malformed message, discarding");
            return Ok(());
        }
    };

    let result = dispatcher.dispatch(&message).await?;

    match result {
        DispatchResult::Success | DispatchResult::FatalError => Ok(()),
        DispatchResult::RetryableError => {
            if message.retry_count < max_retries {
                message.retry_count += 1;
                tracing::info!(
                    job_id = %message.job_id,
                    retry = message.retry_count,
                    max = max_retries,
                    "Scheduling retry"
                );

                let payload = serde_json::to_vec(&message)?;
                channel
                    .basic_publish(
                        "",
                        RETRY_QUEUE_NAME,
                        BasicPublishOptions::default(),
                        &payload,
                        BasicProperties::default(),
                    )
                    .await
                    .context("Failed to publish retry")?;
            } else {
                tracing::warn!(
                    job_id = %message.job_id,
                    attempts = message.retry_count,
                    "Max retries reached, discarding"
                );
            }
            Ok(())
        }
    }
}
