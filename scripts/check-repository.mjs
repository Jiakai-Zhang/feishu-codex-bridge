import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  return result;
}

function trackedFiles() {
  const result = run("git", ["ls-files", "-z"]);
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to list tracked repository files");
  }
  return result.stdout.split("\0").filter(Boolean);
}

const files = trackedFiles();
const scriptFiles = files.filter((file) => /\.(?:cjs|js|mjs)$/u.test(file));
const jsonFiles = files.filter((file) => /\.json$/u.test(file));
const failures = [];

for (const file of scriptFiles) {
  const result = run(process.execPath, ["--check", file]);
  if (result.status !== 0) {
    failures.push({
      file,
      kind: "JavaScript syntax",
      detail: (result.stderr || result.stdout || "Unknown syntax error").trim(),
    });
  }
}

for (const file of jsonFiles) {
  try {
    const content = readFileSync(file, "utf8").replace(/^\uFEFF/u, "");
    JSON.parse(content);
  } catch (error) {
    failures.push({
      file,
      kind: "JSON parse",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[${failure.kind}] ${failure.file}\n${failure.detail}`);
  }
  console.error(`\nRepository validation failed with ${failures.length} error(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `Repository validation passed: ${scriptFiles.length} JavaScript file(s), ${jsonFiles.length} JSON file(s).`,
  );
}
