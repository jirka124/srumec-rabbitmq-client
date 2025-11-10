import amqp from "amqplib";

export class RabbitClient {
  constructor(url) {
    this.url = url || "amqp://rabbitmq:5672";
    this.connection = null;
    this.channel = null;

    this.exchanges = new Map(); // exchangeName -> [ { type, options } ]
    this.queues = new Map(); // queueName -> [ { options } ]
    this.bindings = new Map(); // queueName -> [ { exchange, routingKey } ]
    this.consumers = new Map(); // queueName -> [ handler ]

    this.offlineQueue = []; // buffer to flush as soon as connection goes up again
    this.isConnectionReady = false;
  }

  async connect(retries = 10) {
    while (retries > 0) {
      try {
        console.log("Connecting to RabbitMQ...");
        this.connection = await amqp.connect(this.url);
        this.channel = await this.connection.createChannel();
        this.isConnectionReady = true;
        this._registerConnectionHandlers();
        console.log("Connected to RabbitMQ");
        return;
      } catch (err) {
        this.isConnectionReady = false;
        console.error("RabbitMQ connection failed:", err.message);
        retries--;
        console.log(`Retrying in 3s... (${retries} attempts left)`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw new Error("Could not connect to RabbitMQ after multiple attempts");
  }

  _registerConnectionHandlers() {
    this.connection.on("error", (err) => {
      console.error("RabbitMQ connection error:", err.message);
    });

    this.connection.on("close", async () => {
      console.warn("RabbitMQ connection closed, attempting reconnect...");
      this.isConnectionReady = false;
      await this._reconnect();
    });
  }

  async _reconnect() {
    let delay = 3000;
    while (true) {
      try {
        await this.connect();
        await this._restoreTopology();
        console.log("RabbitMQ reconnected and topology restored!");
        break;
      } catch (err) {
        console.error("Reconnect failed:", err.message);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async _restoreTopology() {
    console.log("Restoring exchanges...");
    for (const [exchange, list] of this.exchanges) {
      for (const ex of list) {
        await this.channel.assertExchange(exchange, ex.type, ex.options);
      }
    }
    console.log("Restoring queues and bindings...");
    for (const [queue, list] of this.queues) {
      for (const q of list) {
        await this.channel.assertQueue(queue, q.options);
        if (q.exchange && q.routingKey) {
          await this.channel.bindQueue(queue, q.exchange, q.routingKey);
        }
      }
    }

    console.log("Restoring consumers...");
    for (const [queue, handlers] of this.consumers) {
      for (const handler of handlers) {
        await this._consume(queue, handler);
      }
    }

    console.log("Flushing offline messages...");
    while (this.offlineQueue.length > 0) {
      const msg = this.offlineQueue.shift();
      try {
        this.channel.publish(msg.exchange, msg.routingKey, msg.payload, {
          persistent: true,
        });
        console.log(`Flushed message to ${msg.exchange}:${msg.routingKey}`);
      } catch (err) {
        console.error("Failed to flush queued message:", err.message);
        this.offlineQueue.unshift(msg);
        break;
      }
    }

    this.isConnectionReady = true;
    console.log("RabbitMQ client ready and synced!");
  }

  async assertExchange(exchange, type = "topic", options = { durable: true }) {
    await this.channel.assertExchange(exchange, type, options);

    if (!this.exchanges.has(exchange)) this.exchanges.set(exchange, []);
    this.exchanges.get(exchange).push({ type, options });

    console.log(`Exchange asserted: "${exchange}" (${type})`);
  }

  async assertQueue(queue, options = { durable: true }) {
    await this.channel.assertQueue(queue, options);

    if (!this.queues.has(queue)) this.queues.set(queue, []);
    this.queues.get(queue).push({ options });

    console.log(`Queue asserted: "${queue}"`);
  }

  async bindQueue(queue, exchange, routingKey) {
    await this.channel.bindQueue(queue, exchange, routingKey);

    if (!this.bindings.has(queue)) this.bindings.set(queue, []);
    this.bindings.get(queue).push({ exchange, routingKey });

    console.log(
      `Bound queue "${queue}" -> exchange "${exchange}" (${routingKey})`
    );
  }

  publish(exchange, routingKey, message) {
    const payload = Buffer.from(JSON.stringify(message));
    const sendMessage = () => {
      try {
        this.channel.publish(exchange, routingKey, payload, {
          persistent: true,
        });
        console.log(`Sent to exchange "${exchange}" (${routingKey})`);
      } catch (err) {
        console.error("Publish failed:", err.message);
        this.offlineQueue.push({ exchange, routingKey, payload });
      }
    };

    if (this.channel && this.isConnectionReady) {
      sendMessage();
    } else {
      console.warn("Channel not ready — message queued");
      this.offlineQueue.push({ exchange, routingKey, payload });
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

  async consume(queue, handler) {
    if (!this.channel) throw new Error("Channel not initialized");

    if (!this.consumers.has(queue)) this.consumers.set(queue, []);
    this.consumers.get(queue).push(handler);

    this._consume(queue, handler);

    console.log(`Listening on queue "${queue}"`);
  }
}
