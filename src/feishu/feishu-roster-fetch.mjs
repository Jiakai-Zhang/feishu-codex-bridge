const RETRYABLE_CODES = new Set([
  "rate_limited",
  "send_timeout",
  "unknown",
  "ECONNABORTED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

const PERMISSION_CODES = new Set([
  "permission_denied",
  "99991400",
  "99991401",
  "99991663",
  "99991672",
  "99991679",
]);

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function classifyFeishuRosterError(error) {
  const chain = errorChain(error);
  const codes = chain.flatMap((item) => [
    item?.code,
    item?.response?.data?.code,
    item?.data?.code,
  ]).filter((value) => value !== undefined && value !== null).map(String);
  const status = firstDefined(chain.flatMap((item) => [item?.response?.status, item?.status]));
  const messages = chain.map((item) => String(item?.message || "").toLowerCase());

  if (codes.some((code) => PERMISSION_CODES.has(code)) || status === 401 || status === 403) {
    return Object.freeze({
      category: "permission",
      retryable: false,
      code: codes[0],
      httpStatus: status,
    });
  }

  const retryable = codes.some((code) => RETRYABLE_CODES.has(code))
    || status === 429
    || (Number.isInteger(status) && status >= 500)
    || messages.some((message) => message.includes("timeout") || message.includes("network error"));
  if (retryable) {
    return Object.freeze({
      category: "network",
      retryable: true,
      code: codes[0],
      httpStatus: status,
    });
  }

  return Object.freeze({
    category: "unknown",
    retryable: false,
    code: codes[0],
    httpStatus: status,
  });
}

export class FeishuRosterFetchError extends Error {
  constructor(failures, attempts) {
    super("Feishu roster verification failed");
    this.name = "FeishuRosterFetchError";
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    this.attempts = attempts;
    this.category = failures.some(({ category }) => category === "permission")
      ? "permission"
      : failures.every(({ category }) => category === "network")
        ? "network"
        : "unknown";
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function fetchFeishuChatRoster(channel, chatId, {
  attempts = 2,
  retryDelayMs = 500,
  sleep = wait,
  onRetry,
} = {}) {
  if (!channel || typeof channel !== "object") throw new TypeError("channel is required");
  if (!chatId) throw new TypeError("chatId is required");
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer");

  const probes = new Map([
    ["chat_info", () => channel.getChatInfo(chatId)],
    ["users", () => channel.getChatMembers(chatId, {
      force: true,
      idType: "open_id",
      pageSize: 100,
      maxPages: 2,
    })],
    ["bots", () => channel.getChatBots(chatId, { force: true })],
  ]);
  const values = new Map();
  let pending = [...probes.keys()];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const settled = await Promise.allSettled(pending.map((operation) => probes.get(operation)()));
    const failures = [];
    const retryOperations = [];

    settled.forEach((result, index) => {
      const operation = pending[index];
      if (result.status === "fulfilled") {
        values.set(operation, result.value);
        return;
      }
      const classification = classifyFeishuRosterError(result.reason);
      failures.push(Object.freeze({ operation, ...classification }));
      retryOperations.push(operation);
    });

    if (failures.length === 0) {
      return Object.freeze({
        chatInfo: values.get("chat_info"),
        members: values.get("users"),
        bots: values.get("bots"),
      });
    }

    const canRetry = attempt < attempts && failures.every(({ retryable }) => retryable);
    if (!canRetry) throw new FeishuRosterFetchError(failures, attempt);

    await onRetry?.(Object.freeze({ attempt, failures: Object.freeze(failures) }));
    if (retryDelayMs > 0) await sleep(retryDelayMs);
    pending = retryOperations;
  }

  throw new FeishuRosterFetchError([], attempts);
}

export function summarizeFeishuRosterFailure(error) {
  if (!(error instanceof FeishuRosterFetchError) || error.failures.length === 0) return "unclassified";
  return error.failures.map(({ operation, category, code, httpStatus }) => {
    const details = [operation, category];
    if (code !== undefined) details.push(`code=${String(code).slice(0, 40)}`);
    if (httpStatus !== undefined) details.push(`http=${String(httpStatus).slice(0, 8)}`);
    return details.join(":");
  }).join(",");
}
