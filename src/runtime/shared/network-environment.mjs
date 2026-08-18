export const NETWORK_PROXY_ENVIRONMENT_VARIABLES = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
]);

export function directNetworkEnvironment(environment = process.env) {
  const direct = { ...environment };
  const proxyNames = new Set(NETWORK_PROXY_ENVIRONMENT_VARIABLES.map((name) => name.toUpperCase()));
  for (const name of Object.keys(direct)) {
    if (proxyNames.has(name.toUpperCase())) delete direct[name];
  }
  return direct;
}
