// Never expose native errors: they can contain credentials, URLs and paths.
export function codexTurnFailureReason(error) {
  const info = error?.codexErrorInfo;
  const code = typeof info === "string" ? info : Object.keys(info || {})[0];
  const httpStatus = typeof info === "object" ? info?.[code]?.httpStatusCode : undefined;
  if ([401, 403].includes(httpStatus)) return "authentication";
  if (httpStatus === 429) return "capacity";
  if (httpStatus >= 400 && httpStatus < 500) return "unknown";
  if (["unauthorized", "authenticationFailed"].includes(code)) return "authentication";
  if (["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"].includes(code)) return "capacity";
  if (code === "contextWindowExceeded") return "context";
  if (["responseStreamDisconnected", "responseStreamConnectionFailed", "httpConnectionFailed"].includes(code)) {
    return "network";
  }
  if (code === "responseTooManyFailedAttempts" && httpStatus >= 500) return "network";
  if (code === "other" && /^stream disconnected before completion: error sending request(?:$|[\s:(])/i.test(
    String(error?.message || ""),
  )) return "network";
  return "unknown";
}
