export function safeError(error) {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500)
    : String(error).slice(0, 500);
}
