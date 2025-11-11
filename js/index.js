import amqp from "amqplib";
import { randomUUID } from "crypto";

export class RabbitClient {
  #CONNECTION_RETRY_COUNT = 20;
  #CONNECTION_RETRY_DELAY = 3000;
  #OFFLINE_FLUSH_INTERVAL = 10000;
  #offlineQueue = []; // buffer to flush as soon as connection goes up again
  #recoveryExchanges = new Map(); // exchangeName -> [ { type, options } ]
  #recoveryQueues = new Map(); // queueName -> [ { options } ]
  #recoveryBindings = new Map(); // queueName -> [ { exchange, routingKey } ]
  #recoveryConsumers = new Map(); // queueName -> [ handler ]
  #pendingRPC = new Map(); // correlationId -> { resolve, reject, timer }
  #isConnectionReady = false;
  #replyQueueName;
  #flusherTimer;

  constructor(url, replyQueueName) {
    this.url = url || "amqp://rabbitmq:5672";
    this.connection = null;
    this.channel = null;

    this.#replyQueueName = replyQueueName || `rpc_reply_${randomUUID()}`;
  }

  async connect(retries = this.#CONNECTION_RETRY_COUNT, options = {}) {
    const opt = { isFirstTimeInit: true, ...options };

    while (retries > 0) {
      try {
        this.connection = await amqp.connect(this.url);
        this.channel = await this.connection.createChannel();
        this._registerConnectionHandlers();
        if (opt.isFirstTimeInit) {
          this.#isConnectionReady = true; // connection ready is fired later for reconnect
          await this._registerReplyQueue(); // reply queue will recover from topology recovery
          this._startAutoFlusher();
        }
        return;
      } catch (err) {
        this.#isConnectionReady = false;
        console.error(
          `(${--retries} attempts left) RabbitMQ connection failed:`,
          err.message
        );
        await this._sleep(this.#CONNECTION_RETRY_DELAY);
      }
    }
    throw new Error("Could not connect to RabbitMQ after multiple attempts");
  }

  publish(exchange, routingKey, message, options) {
    const payload = Buffer.from(JSON.stringify(message));
    const mergedOptions = {
      persistent: true,
      ...options,
    };

    const sendMessage = () => {
      try {
        this.channel.publish(exchange, routingKey, payload, mergedOptions);
      } catch (err) {
        console.error("Publish failed:", err.message);
        this.#offlineQueue.push({
          exchange,
          routingKey,
          payload,
          options: mergedOptions,
        });
      }
    };

    if (this.#isConnectionReady) sendMessage();
    else {
      this.#offlineQueue.push({
        exchange,
        routingKey,
        payload,
        options: mergedOptions,
      });
    }
  }

  publishRPC(exchange, routingKey, message, options, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const correlationId = randomUUID();
      const payload = Buffer.from(JSON.stringify(message));

      const mergedOptions = {
        persistent: true,
        ...options,
        correlationId,
        replyTo: this.#replyQueueName,
      };

      const timer = setTimeout(() => {
        this.#pendingRPC.delete(correlationId);
        reject(new Error("RPC timeout"));
      }, timeout);

      this.#pendingRPC.set(correlationId, { resolve, reject, timer });

      const sendMessage = () => {
        try {
          this.channel.publish(exchange, routingKey, payload, mergedOptions);
        } catch (err) {
          this.#offlineQueue.push({
            type: "rpc-request",
            exchange,
            routingKey,
            payload,
            options: mergedOptions,
          });
        }
      };

      if (this.#isConnectionReady) sendMessage();
      else {
        this.#offlineQueue.push({
          type: "rpc-request",
          exchange,
          routingKey,
          payload,
          options: mergedOptions,
        });
      }
    });
  }

  async answerRPC(ctx, data, options) {
    try {
      const replyTo = ctx?.properties?.replyTo;
      const correlationId = ctx?.properties?.correlationId;

      if (!replyTo || !correlationId) {
        console.warn("RPC reply skipped: missing replyTo or correlationId");
        return;
      }

      const payload = Buffer.from(JSON.stringify(data));
      const mergedOptions = {
        persistent: true,
        ...options,
        correlationId,
      };

      if (!this.#isConnectionReady) {
        this.#offlineQueue.push({
          type: "rpc-response",
          replyTo,
          payload,
          options: mergedOptions,
        });
        return;
      }

      this.channel.sendToQueue(replyTo, payload, mergedOptions);
    } catch (err) {
      console.error("RPC response error:", err.message);
    }
  }

  async consume(queue, handler) {
    if (!this.channel) throw new Error("Channel not initialized");

    if (!this.#recoveryConsumers.has(queue))
      this.#recoveryConsumers.set(queue, []);
    this.#recoveryConsumers.get(queue).push(handler);

    this._consume(queue, handler);
  }

  async assertExchange(exchange, type = "topic", options = { durable: true }) {
    await this.channel.assertExchange(exchange, type, options);

    if (!this.#recoveryExchanges.has(exchange))
      this.#recoveryExchanges.set(exchange, []);
    this.#recoveryExchanges.get(exchange).push({ type, options });
  }

  async assertQueue(queue, options = { durable: true }) {
    await this.channel.assertQueue(queue, options);

    if (!this.#recoveryQueues.has(queue)) this.#recoveryQueues.set(queue, []);
    this.#recoveryQueues.get(queue).push({ options });
  }

  async bindQueue(queue, exchange, routingKey) {
    await this.channel.bindQueue(queue, exchange, routingKey);

    if (!this.#recoveryBindings.has(queue))
      this.#recoveryBindings.set(queue, []);
    this.#recoveryBindings.get(queue).push({ exchange, routingKey });
  }

  _startAutoFlusher(intervalMs = this.#OFFLINE_FLUSH_INTERVAL) {
    if (this.#flusherTimer) clearInterval(this.#flusherTimer);
    this.#flusherTimer = setInterval(async () => {
      if (this.#isConnectionReady && this.#offlineQueue.length > 0) {
        try {
          await this._flushOfflineQueue();
        } catch (err) {
          console.warn("Auto flush failed:", err.message);
        }
      }
    }, intervalMs);
  }

  _registerConnectionHandlers() {
    this.connection.on("error", (err) => {
      console.error("RabbitMQ connection error:", err.message);
    });

    this.connection.on("close", async () => {
      console.warn("RabbitMQ connection closed, attempting reconnect...");
      this.#isConnectionReady = false;
      await this._reconnect();
    });
  }

  async _registerReplyQueue() {
    await this.assertQueue(this.#replyQueueName, {
      durable: false,
      exclusive: true,
    });

    await this.consume(this.#replyQueueName, async (content, ctx) => {
      const corrId = ctx.properties.correlationId;
      if (corrId && this.#pendingRPC.has(corrId)) {
        const { resolve, timer } = this.#pendingRPC.get(corrId);
        clearTimeout(timer);
        this.#pendingRPC.delete(corrId);
        resolve(content);
      }
    });
  }

  async _reconnect() {
    while (!this.#isConnectionReady) {
      try {
        await this.connect(undefined, { isFirstTimeInit: false });
        await this._restoreTopology();
        await this._flushOfflineQueue();

        this.#isConnectionReady = true;
      } catch (err) {
        await this._sleep(this.#CONNECTION_RETRY_DELAY);
      }
    }
  }

  async _restoreTopology() {
    await this._restoreTopologyExchanges();
    await this._restoreTopologyQueues();
    await this._restoreTopologyConsumers();
  }

  async _restoreTopologyExchanges() {
    for (const [exchange, list] of this.#recoveryExchanges) {
      for (const ex of list) {
        await this.channel.assertExchange(exchange, ex.type, ex.options);
      }
    }
  }

  async _restoreTopologyQueues() {
    for (const [queue, list] of this.#recoveryQueues) {
      for (const q of list) {
        await this.channel.assertQueue(queue, q.options);
      }
    }

    for (const [queue, binds] of this.#recoveryBindings) {
      for (const b of binds) {
        await this.channel.bindQueue(queue, b.exchange, b.routingKey);
      }
    }
  }

  async _restoreTopologyConsumers() {
    for (const [queue, handlers] of this.#recoveryConsumers) {
      for (const handler of handlers) {
        await this._consume(queue, handler);
      }
    }
  }

  async _flushOfflineQueue() {
    while (this.#offlineQueue.length > 0) {
      const msg = this.#offlineQueue.shift();
      try {
        if (msg.type === "rpc-response") {
          this.channel.sendToQueue(msg.replyTo, msg.payload, msg.options);
        } else {
          this.channel.publish(
            msg.exchange,
            msg.routingKey,
            msg.payload,
            msg.options
          );
        }
      } catch (err) {
        console.error("Failed to flush queued message:", err.message);
        this.#offlineQueue.unshift(msg);
        break;
      }
    }
  }

  async _consume(queue, handler) {
    await this.channel.consume(
      queue,
      async (msg) => {
        if (!msg) return;
        try {
          const content = JSON.parse(msg.content.toString());
          await handler(content, msg, queue);

          this.channel.ack(msg);
        } catch (err) {
          console.error("Message handler error:", err);
          this.channel.nack(msg, false, true);
        }
      },
      { noAck: false }
    );
  }

  async _sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }
}
