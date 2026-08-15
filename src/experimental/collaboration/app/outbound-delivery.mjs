import { deliveryIdempotencyKey } from "../../../persistence/delivery-outbox.mjs";

export function createOutboundDelivery({
  channel,
  deliveryOutbox,
  isConnected,
  persistCompleted,
  log,
  safeError,
}) {
  let retryInFlight = false;

  async function deliverPendingRecord(record) {
    const response = await channel.rawClient.im.message.reply({
      data: {
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: "md", text: record.markdown }]] },
        }),
        msg_type: "post",
        reply_in_thread: Boolean(record.threadId),
        uuid: deliveryIdempotencyKey(record.messageId),
      },
      path: { message_id: record.messageId },
    });
    if (response?.code !== undefined && response.code !== 0) {
      throw new Error(`Feishu reply failed with code ${response.code}`);
    }
    return response?.data?.message_id;
  }

  async function retryPendingDeliveries() {
    if (!isConnected() || retryInFlight) return;
    retryInFlight = true;
    try {
      for (const record of deliveryOutbox.list({ dueAt: Date.now() })) {
        try {
          const replyMessageId = await deliverPendingRecord(record);
          await persistCompleted(record.messageId);
          await deliveryOutbox.remove(record.messageId);
          log(`deferred result delivered for ${record.messageId}${replyMessageId ? ` as ${replyMessageId}` : ""}`);
        } catch (error) {
          await deliveryOutbox.markFailure(record.messageId, error);
          log(`deferred result delivery failed for ${record.messageId}: ${safeError(error)}`);
        }
      }
    } finally {
      retryInFlight = false;
    }
  }

  return { deliverPendingRecord, retryPendingDeliveries };
}
