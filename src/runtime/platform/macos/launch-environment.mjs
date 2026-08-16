import os from "node:os";
import path from "node:path";

export function launchEnvironment(nodeExecutable) {
  const homeDirectory = os.homedir();
  return {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    PATH: `${path.dirname(nodeExecutable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}
