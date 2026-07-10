const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "src");

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

const files = [
  path.join(root, "cli.js"),
  ...listJavaScriptFiles(sourceRoot),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax checked ${files.length} JavaScript files.`);
