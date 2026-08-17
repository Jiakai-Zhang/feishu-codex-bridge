import os from "node:os";
import path from "node:path";

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
  for (const name of NETWORK_PROXY_ENVIRONMENT_VARIABLES) delete direct[name];
  return direct;
}

export function launchEnvironment(nodeExecutable) {
  const homeDirectory = os.homedir();
  return {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    PATH: `${path.dirname(nodeExecutable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}
