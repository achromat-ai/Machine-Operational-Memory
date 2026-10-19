#!/usr/bin/env node
/**
 * Source guard for the SPA (ui/src). Fails the build when code appears that would break one of the
 * promises the UI makes:
 *
 *   - the operator key is memory-only: no browser storage API anywhere near the console code
 *   - no persistent-storage request (navigator.storage.persist), which can raise a prompt in Firefox
 *   - nothing that breaks the page's strict CSP or lets text become markup
 *
 * It is a plain text scan, so it is deliberately conservative. Tests (*.test.tsx) are not scanned.
 * Run: node scripts/check-ui-source.mjs   (also part of `npm run check`)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcDir = join(root, "ui", "src");

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

/** Strips comments so a rule can mention a forbidden word without tripping itself. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const everywhere = [
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML turns text into markup"],
  [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/, "assigning HTML strings turns text into markup"],
  [/\beval\s*\(|new\s+Function\s*\(/, "eval and new Function are blocked by the page CSP"],
  [/document\.write\s*\(/, "document.write is not allowed"],
  [/\.storage\??\.persist|storage\.persist\s*\(|navigator\.storage/, "do not request persistent storage (it can raise a permission prompt in Firefox)"],
  [/WebAssembly/, "WebAssembly needs 'wasm-unsafe-eval', which the page CSP does not allow"],
  [/importScripts\s*\(|URL\.createObjectURL|new\s+Blob\s*\(/, "blob and data workers are blocked by the page CSP"],
];

/** Files that handle the operator key or queue data: no browser storage of any kind. */
function isConsoleCode(path) {
  const rel = relative(srcDir, path).split(sep).join("/");
  return rel.startsWith("components/admin/") || ["lib/adminSession.ts", "lib/adminApi.ts", "lib/queue.ts"].includes(rel);
}

const consoleOnly = [
  [/\blocalStorage\b|\bsessionStorage\b/, "the console must not use web storage"],
  [/\bindexedDB\b|idb-keyval|\bcreateStore\b/, "the console must not use IndexedDB"],
  [/document\.cookie|\bcaches\b\./, "the console must not use cookies or the cache API"],
  [/from\s+["'][^"']*keystore["']/, "the console must not import the community keystore"],
];

const problems = [];
let scanned = 0;
for (const path of walk(srcDir)) {
  scanned++;
  const text = code(readFileSync(path, "utf8"));
  const rules = isConsoleCode(path) ? [...everywhere, ...consoleOnly] : everywhere;
  for (const [pattern, reason] of rules) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${relative(root, path)}:${line}  ${match[0].trim()}  (${reason})`);
    }
  }
}

if (problems.length > 0) {
  console.error("check-ui-source: found code that breaks a UI promise:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`check-ui-source: ${scanned} files scanned, no problems.`);
