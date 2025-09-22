import * as amqp from "amqplib";
import { logger } from "../../lib/logger";
import { Logger } from "winston";

export interface RabbitMQConfig {
  url: string;
  exchange: string;
  reconnectInterval?: number;
  prefetch?: number;
}

export interface JobNotification {
  jobId: string;
  status: "completed" | "failed";
  timestamp: Date;
}

export class RabbitMQService {
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private config: RabbitMQConfig;
  private consumers: Map<string, amqp.ConsumeMessage> = new Map();
  private isShuttingDown = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(config: RabbitMQConfig) {
    this.config = {
      reconnectInterval: 5000,
      prefetch: 10,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.isShuttingDown) {
      throw new Error("RabbitMQ service is shutting down");
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    try {
      logger.info("Connecting to RabbitMQ", {
        module: "nuq/rabbitmq",
        url: this.config.url.replace(/:[^:@]*@/, ":***@"), // Hide password in logs
      });

      const connection = await amqp.connect(this.config.url);
      this.connection = connection;

      connection.on("error", err => {
        logger.error("RabbitMQ connection error", {
          module: "nuq/rabbitmq",
          err,
        });
      });

      connection.on("close", () => {
        logger.info("RabbitMQ connection closed", { module: "nuq/rabbitmq" });
        this.connection = null;
        this.channel = null;
        this.scheduleReconnect();
      });

      const channel = await connection.createChannel();
      this.channel = channel;
      await channel.assertExchange(this.config.exchange, "topic", {
        durable: true,
      });
      await channel.prefetch(this.config.prefetch!);

      logger.info("Connected to RabbitMQ", { module: "nuq/rabbitmq" });
    } catch (error) {
      logger.error("Failed to connect to RabbitMQ", {
        module: "nuq/rabbitmq",
        error,
      });
      this.scheduleReconnect();
      throw error;
    }
  }

  private scheduleReconnect() {
    if (this.isShuttingDown || this.reconnectTimeout) {
      return;
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      if (!this.isShuttingDown) {
        try {
          await this.connect();
        } catch (error) {
          logger.error("Failed to reconnect to RabbitMQ", {
            module: "nuq/rabbitmq",
            error,
          });
        }
      }
    }, this.config.reconnectInterval);
  }

  async publish(
    queueName: string,
    jobId: string,
    status: "completed" | "failed",
    _logger: Logger = logger,
  ): Promise<void> {
    const routingKey = `${queueName}.${jobId}`;
    const message: JobNotification = {
      jobId,
      status,
      timestamp: new Date(),
    };

    try {
      if (!this.channel) {
        await this.connect();
      }

      if (!this.channel) {
        throw new Error("No channel available");
      }

      const published = this.channel.publish(
        this.config.exchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        { persistent: true },
      );

      if (!published) {
        throw new Error("Failed to publish message to RabbitMQ");
      }

      _logger.info("Published job notification to RabbitMQ", {
        module: "nuq/rabbitmq",
        jobId,
        status,
        routingKey,
      });
    } catch (error) {
      _logger.error("Failed to publish to RabbitMQ", {
        module: "nuq/rabbitmq",
        error,
        jobId,
        status,
      });
      throw error;
    }
  }

  async subscribe(
    queueName: string,
    jobId: string,
    callback: (status: "completed" | "failed") => void,
    _logger: Logger = logger,
  ): Promise<() => Promise<void>> {
    const routingKey = `${queueName}.${jobId}`;
    const consumerQueueName = `nuq.${queueName}.${jobId}.${Date.now()}`;

    try {
      if (!this.channel) {
        await this.connect();
      }

      if (!this.channel) {
        throw new Error("No channel available");
      }

      const q = await this.channel.assertQueue(consumerQueueName, {
        exclusive: true,
        autoDelete: true,
      });

      await this.channel.bindQueue(
        q.queue,
        this.config.exchange,
        routingKey,
      );

      const { consumerTag } = await this.channel.consume(
        q.queue,
        msg => {
          if (!msg) return;

          try {
            const notification: JobNotification = JSON.parse(
              msg.content.toString(),
            );

            if (notification.jobId === jobId) {
              callback(notification.status);
              if (this.channel) {
                this.channel.ack(msg);
              }
            }
          } catch (error) {
            _logger.error("Error processing RabbitMQ message", {
              module: "nuq/rabbitmq",
              error,
              jobId,
            });
          }
        },
        { noAck: false },
      );

      _logger.info("Subscribed to job notifications", {
        module: "nuq/rabbitmq",
        jobId,
        routingKey,
        consumerTag,
      });

      return async () => {
        try {
          if (this.channel && consumerTag) {
            await this.channel.cancel(consumerTag);
            _logger.info("Unsubscribed from job notifications", {
              module: "nuq/rabbitmq",
              jobId,
              consumerTag,
            });
          }
        } catch (error) {
          _logger.error("Error cancelling subscription", {
            module: "nuq/rabbitmq",
            error,
            jobId,
          });
        }
      };
    } catch (error) {
      _logger.error("Failed to subscribe to RabbitMQ", {
        module: "nuq/rabbitmq",
        error,
        jobId,
      });
      throw error;
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.connection !== null && this.channel !== null;
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      logger.info("RabbitMQ service shut down", { module: "nuq/rabbitmq" });
    } catch (error) {
      logger.error("Error during RabbitMQ shutdown", {
        module: "nuq/rabbitmq",
        error,
      });
    }
  }
}

let rabbitmqService: RabbitMQService | null = null;

export function initializeRabbitMQ(): RabbitMQService | null {
  if (rabbitmqService) {
    return rabbitmqService;
  }

  const rabbitmqUrl = process.env.RABBITMQ_URL;
  if (!rabbitmqUrl) {
    return null;
  }

  rabbitmqService = new RabbitMQService({
    url: rabbitmqUrl,
    exchange: "nuq.notifications",
  });

  return rabbitmqService;
}

export function getRabbitMQService(): RabbitMQService | null {
  return rabbitmqService;
}

export async function shutdownRabbitMQ(): Promise<void> {
  if (rabbitmqService) {
    await rabbitmqService.shutdown();
    rabbitmqService = null;
  }
}