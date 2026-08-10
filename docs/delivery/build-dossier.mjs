#!/usr/bin/env node
// Reproducible local generator for the PKCERT technical dossier.
//
// Markdown -> HTML (lib/render_html.py, markdown-it-py) -> PDF (Chrome headless, driven
// directly over the DevTools Protocol with Node's built-in fetch+WebSocket -- no puppeteer
// dependency, because Node 22+ ships both natively and this is the only way to reach
// Page.printToPDF's displayHeaderFooter/footerTemplate option, which plain
// `chrome --print-to-pdf` on the command line does not expose) -> PDF bookmarks
// (lib/add_bookmarks.py, pypdf, already installed -- Chrome's print pipeline does not
// generate a PDF outline from HTML headings on its own).
//
// This script is documentation tooling only. It is not part of the ThreatNeXus application,
// adds no dependency to backend/ or frontend/, and is never imported by product code.
//
// Usage: node build-dossier.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MD = path.join(DIR, "ThreatNeXus-PKCERT-Technical-Dossier.md");
const HTML = path.join(DIR, ".build", "dossier.html");
const RAW_PDF = path.join(DIR, ".build", "dossier-raw.pdf");
const FINAL_PDF = path.join(DIR, "ThreatNeXus-PKCERT-Technical-Dossier.pdf");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9333;
const USER_DATA_DIR = path.join(DIR, ".build", "chrome-profile");

function run(cmd, args) {
  console.log("+", cmd, args.join(" "));
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

function step1_renderHtml() {
  mkdirSync(path.dirname(HTML), { recursive: true });
  run("python", [path.join(DIR, "lib", "render_html.py"), MD, HTML]);
}

async function step2_printToPdf() {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const proc = spawnSync("cmd", ["/c", "start", "", CHROME,
    "--headless=new", "--disable-gpu",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run", "--no-default-browser-check",
  ], { stdio: "ignore" });
  if (proc.error) throw proc.error;

  // Wait for the DevTools HTTP endpoint to come up.
  let versionInfo;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) { versionInfo = await res.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!versionInfo) throw new Error("Chrome DevTools endpoint never came up");

  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const thisId = ++id;
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }

  await send("Page.enable");
  const fileUrl = "file:///" + HTML.replace(/\\/g, "/");
  await send("Page.navigate", { url: fileUrl });
  await new Promise((resolve) => {
    const check = setInterval(async () => {
      const { result } = await send("Runtime.evaluate", { expression: "document.readyState" });
      if (result && result.value === "complete") { clearInterval(check); resolve(); }
    }, 150);
  });
  // Let web fonts / layout settle.
  await new Promise((r) => setTimeout(r, 400));

  const footer = `<div style="font-size:8px;width:100%;color:#46564D;
    font-family:'IBM Plex Sans',Arial,sans-serif;padding:0 18mm;
    display:flex;justify-content:space-between;">
    <span>ThreatNeXus — Technical Delivery, Deployment and Operations Dossier · v1.0</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;

  const { data } = await send("Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: footer,
    marginTop: 0.4, marginBottom: 0.55, marginLeft: 0, marginRight: 0,
  });

  const buf = Buffer.from(data, "base64");
  mkdirSync(path.dirname(RAW_PDF), { recursive: true });
  await import("node:fs/promises").then((fs) => fs.writeFile(RAW_PDF, buf));
  ws.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`).catch(() => {});
  spawnSync("taskkill", ["/IM", "chrome.exe", "/F", "/FI", `WINDOWTITLE eq*`], { stdio: "ignore" });
  // Best-effort: kill only the instance we launched, identified by its debug port profile dir.
  console.log(`Wrote ${RAW_PDF} (${buf.length} bytes)`);
}

function step3_addBookmarks() {
  run("python", [path.join(DIR, "lib", "add_bookmarks.py"), MD, RAW_PDF, FINAL_PDF]);
}

async function main() {
  step1_renderHtml();
  await step2_printToPdf();
  step3_addBookmarks();
  console.log(`\nDone: ${FINAL_PDF}`);
  console.log("Next: render every page to PNG for visual QA (see lib/render_qa_pages.py).");
}

main().catch((err) => { console.error(err); process.exit(1); });
