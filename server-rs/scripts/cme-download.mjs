#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const OUT_DIR = process.argv[2] || "/tmp/cme-downloads";
mkdirSync(OUT_DIR, { recursive: true });

const FILES = [
  { name: "Gold_Stocks.xls", key: "goldXls" },
  { name: "Silver_stocks.xls", key: "silverXls" },
  { name: "MetalsIssuesAndStopsMTDReport.pdf", key: "mtdPdf" },
  { name: "MetalsIssuesAndStopsReport.pdf", key: "dailyPdf" },
  { name: "MetalsIssuesAndStopsYTDReport.pdf", key: "ytdPdf" },
];

const BASE = "https://www.cmegroup.com/delivery_reports/";
const results = {};

function sleep(min, max) {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Hide webdriver property
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // Visit CME homepage to establish cookies/session
  try {
    await page.goto("https://www.cmegroup.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(2000, 4000);
  } catch (_) {
    // Non-fatal
  }

  for (let i = 0; i < FILES.length; i++) {
    const { name, key } = FILES[i];
    const url = BASE + name;

    try {
      // Use page.goto to trigger download — the browser handles it natively
      const downloadPromise = page.waitForEvent("download", { timeout: 45000 });
      await page.evaluate((u) => {
        const a = document.createElement("a");
        a.href = u;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, url);

      const download = await downloadPromise;
      const path = join(OUT_DIR, name);
      await download.saveAs(path);

      const { size } = await import("fs").then((fs) =>
        fs.statSync(path)
      );
      results[key] = { status: 200, path, bytes: size };
    } catch (e) {
      results[key] = { status: 0, error: e.message };
    }

    if (i < FILES.length - 1) {
      await sleep(8000, 20000);
    }
  }

  await browser.close();
  console.log(JSON.stringify(results));
}

run().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
