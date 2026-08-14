import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname);
const failures = [];

function fail(message) {
  failures.push(message);
}

function exactPath(relativePath) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (!existsSync(current) || !statSync(current).isDirectory()) return false;
    const names = readdirSync(current);
    if (!names.includes(part)) return false;
    current = join(current, part);
  }
  return existsSync(current);
}

const htmlPath = join(root, "index.html");
if (!existsSync(htmlPath)) fail("index.html is missing from the repository root.");

const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : "";
const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);

for (const reference of references) {
  if (/^(?:#|https?:|mailto:|tel:|data:)/i.test(reference)) continue;
  const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0]).replace(/^\.\//, "");
  if (!pathname) continue;
  const absolute = resolve(root, pathname);
  if (relative(root, absolute).split(sep).includes("..")) {
    fail(`Unsafe path escapes the repository root: ${reference}`);
  } else if (!exactPath(pathname)) {
    fail(`Missing or case-mismatched file: ${reference}`);
  }
}

const carFiles = readdirSync(join(root, "assets")).filter((name) => /^car-\d.*\.webp$/.test(name)).sort();
if (carFiles.length < 9) fail(`Expected at least 9 local car images; found ${carFiles.length}.`);

for (const name of carFiles) {
  const data = readFileSync(join(root, "assets", name));
  const isWebP = data.length > 12 && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isWebP) fail(`Invalid WebP file: assets/${name}`);
}

const wranglerPath = join(root, "wrangler.jsonc");
const wrangler = existsSync(wranglerPath) ? readFileSync(wranglerPath, "utf8") : "";
for (const placeholder of ["REPLACE_WITH", "YOUR_WEBSITE", "YOUR_VERIFIED_DOMAIN"]) {
  if (wrangler.includes(placeholder)) fail(`wrangler.jsonc still contains placeholder: ${placeholder}`);
}

for (const required of ["worker/index.js", "migrations/0001_reviews.sql", "styles.css", "reviews.js"]) {
  if (!exactPath(required)) fail(`Required project file is missing: ${required}`);
}

if (failures.length) {
  console.error("Project verification failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Project verification passed: ${references.length} local-page references checked and ${carFiles.length} WebP car images found.`);

