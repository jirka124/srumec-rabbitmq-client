import { RabbitClient } from "../js/index.js";

const RABBIT_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";

const rabbit1 = new RabbitClient(RABBIT_URL);
const rabbit2 = new RabbitClient(RABBIT_URL);

const consumeFunction = async (content, ctx, queue) => {
  if (ctx.properties.correlationId && ctx.properties.replyTo) {
    if (content?.key === "add_numbers") {
      rabbit2.answerRPC(ctx, {
        result: Number(content?.op1) + Number(content?.op2),
      });
    } else {
      rabbit2.answerRPC(ctx, {
        result: "unknown key: " + content?.key,
      });
    }
  } else {
    console.log("Received message:", content, queue, ctx.fields.consumerTag);
  }
};

(async () => {
  await rabbit1.connect();
  await rabbit2.connect();

  const EXCHANGE = "sandbox-exchange";
  const QUEUE_1 = "sandbox-queue";
  const QUEUE_2 = "sandbox-queue-1";
  const QUEUE_3 = "sandbox-queue-2";

  await rabbit1.assertExchange(EXCHANGE, "topic", { durable: true });
  await rabbit2.assertExchange(EXCHANGE, "topic", { durable: true });

  await rabbit1.assertQueue(QUEUE_1, { durable: false });
  await rabbit1.assertQueue(QUEUE_2, { durable: false });
  await rabbit2.assertQueue(QUEUE_1, { durable: false });
  await rabbit2.assertQueue(QUEUE_3, { durable: false });

  await rabbit1.bindQueue(QUEUE_1, EXCHANGE, "sandbox"); // load-balance any sandbox
  await rabbit1.bindQueue(QUEUE_2, EXCHANGE, "sandbox.1"); // unique direct queue
  await rabbit1.bindQueue(QUEUE_2, EXCHANGE, "orange.*"); // subscribe to any event interested
  await rabbit2.bindQueue(QUEUE_1, EXCHANGE, "sandbox"); // load-balance any sandbox
  await rabbit2.bindQueue(QUEUE_3, EXCHANGE, "sandbox.2"); // unique direct queue
  await rabbit2.bindQueue(QUEUE_3, EXCHANGE, "apple.*"); // subscribe to any event interested

  await rabbit1.consume(QUEUE_1, consumeFunction);
  await rabbit1.consume(QUEUE_2, consumeFunction);
  await rabbit2.consume(QUEUE_1, consumeFunction);
  await rabbit2.consume(QUEUE_3, consumeFunction);

  console.log("Sandbox ready! Sending test messages...");
  rabbit1.publish(EXCHANGE, "sandbox.2", {
    message: "From sandbox-1 to sandbox-2",
  });
  for (let i = 0; i < 10; i++) {
    rabbit1.publish(EXCHANGE, "sandbox", {
      message: "From sandbox-1 to any sandbox",
    });
  }
  rabbit1.publish(EXCHANGE, "orange.update", {
    message: "From sandbox-1 to subscribers of orange (sandbox-1)",
  });
  rabbit1.publish(EXCHANGE, "apple.delete", {
    message: "From sandbox-1 to subscribers of apple (sandbox-2)",
  });
  const reqParams = {
    key: "add_numbers",
    op1: 45,
    op2: 56,
  };
  const res1 = await rabbit1.publishRPC(EXCHANGE, "sandbox.2", reqParams);
  console.log(
    `RPC returned (${reqParams.op1} + ${reqParams.op2}) = ${res1.result}`
  );
})();
