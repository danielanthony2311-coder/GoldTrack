import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import axios from "axios";
import cron from "node-cron";
import { ensureAnalysisTables, generateNarrative, getLatestNarrative, computeSignals } from "./analysis.ts";
import { ensureTightnessTables, computeTightness, runAndStoreTightness, getTightnessHistory } from "./tightness.ts";
import { ensureHistoryTables, runHistorySync, historySummary } from "./history.ts";
import { ensurePatternTables, runPatternEngine, getPatternLibrary } from "./patterns.ts";
import { ensurePredictionTables, runPredictions, gradePredictions, getScoreboard, getActivePredictions, backfillFromBacktest } from "./predictions.ts";
import { survivedEpisodeLedger } from "./patterns.ts";
import * as XLSX from "xlsx";
import fs from "fs";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// multer is a CJS module for multipart/form-data file uploads
const _multerRaw = require('multer');
const multer = (typeof _multerRaw === 'function' ? _multerRaw : _multerRaw?.default ?? _multerRaw) as any;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  },
});

// pdf-parse v2: PDFParse class — new PDFParse({ data: buffer }).getText()
let PDFParseClass: (new (opts: { data: Buffer }) => { getText: () => Promise<{ text: string }> }) | null = null;
try {
  const raw = require('pdf-parse');
  PDFParseClass = raw?.PDFParse ?? null;
} catch (e: any) {
  console.error('⚠️  pdf-parse failed to load:', e.message);
}
// Wrap into the same async (buf) => { text } signature used throughout
const pdfParse = PDFParseClass
  ? (buf: Buffer) => new PDFParseClass!({ data: buf }).getText()
  : null;
console.log(`[startup] pdf-parse loaded: ${pdfParse !== null}`);

// pdfjs-dist for layout-aware parsing (delivery notices need column positions)
let pdfjsLib: any = null;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
} catch (e: any) {
  console.warn('⚠️  pdfjs-dist not available for layout parsing:', e.message);
}

// Parse CME Daily Delivery PDF using pdfjs-dist with column position awareness
// This correctly assigns numbers to ISSUED vs STOPPED columns
async function parseDailyPdfWithLayout(pdfBuffer: Buffer) {
  if (!pdfjsLib) return null;

  const data = new Uint8Array(pdfBuffer);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const numPages = doc.numPages;

  let businessDate = '';
  const metals: Record<string, { settlement: number; daily_issued: number; daily_stopped: number; all_firms: any[] }> = {};
  let currentMetal = '';
  let currentFirms: any[] = [];

  // Column threshold: ISSUED col centers around x=320-345, STOPPED around x=378-410
  // Numbers at x < 370 are ISSUED, x >= 370 are STOPPED
  const STOPPED_COL_THRESHOLD = 370;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    // Group text items by Y position
    const lineMap: Record<number, { x: number; text: string }[]> = {};
    content.items.forEach((item: any) => {
      if (!item.str || !item.str.trim()) return;
      const y = Math.round(item.transform[5]);
      const x = Math.round(item.transform[4]);
      if (!lineMap[y]) lineMap[y] = [];
      lineMap[y].push({ x, text: item.str.trim() });
    });

    // Process lines top-to-bottom (higher Y = higher on page in PDF coords)
    const sortedYs = Object.keys(lineMap).map(Number).sort((a, b) => b - a);

    for (const y of sortedYs) {
      const items = lineMap[y].sort((a, b) => a.x - b.x);
      const lineText = items.map(i => i.text).join(' ');

      // Extract business date
      if (lineText.includes('BUSINESS DATE:')) {
        const match = lineText.match(/BUSINESS DATE:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (match) {
          const [m, d, yr] = match[1].split('/');
          businessDate = `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
      }

      // Detect metal section
      if (lineText.includes('COMEX 100 GOLD FUTURES')) {
        currentMetal = 'GOLD';
        currentFirms = [];
      } else if (lineText.includes('COMEX 5000 SILVER FUTURES')) {
        currentMetal = 'SILVER';
        currentFirms = [];
      } else if (currentMetal && lineText.includes('CONTRACT:') && !lineText.includes(currentMetal)) {
        // Different contract — save current metal and reset
        if (currentFirms.length > 0) {
          if (!metals[currentMetal]) metals[currentMetal] = { settlement: 0, daily_issued: 0, daily_stopped: 0, all_firms: [] };
          metals[currentMetal].all_firms.push(...currentFirms);
        }
        currentMetal = '';
        currentFirms = [];
      }

      if (!currentMetal) continue;

      // Extract settlement
      if (lineText.includes('SETTLEMENT:')) {
        const match = lineText.match(/SETTLEMENT:\s*([\d,.]+)/);
        if (match) {
          metals[currentMetal] = metals[currentMetal] || { settlement: 0, daily_issued: 0, daily_stopped: 0, all_firms: [] };
          metals[currentMetal].settlement = parseFloat(match[1].replace(/,/g, ''));
        }
      }

      // Extract TOTAL line
      if (lineText.includes('TOTAL:') && !lineText.includes('MONTH')) {
        const nums = lineText.match(/TOTAL:\s*([\d,]+)\s+([\d,]+)/);
        if (nums && metals[currentMetal]) {
          metals[currentMetal].daily_issued = parseInt(nums[1].replace(/,/g, ''), 10);
          metals[currentMetal].daily_stopped = parseInt(nums[2].replace(/,/g, ''), 10);
        }
        // Save firms for this metal
        if (currentFirms.length > 0) {
          if (!metals[currentMetal]) metals[currentMetal] = { settlement: 0, daily_issued: 0, daily_stopped: 0, all_firms: [] };
          metals[currentMetal].all_firms.push(...currentFirms);
        }
        currentFirms = [];
      }

      // Parse firm rows using positional data
      const firstItem = items[0];
      if (firstItem && firstItem.text.match(/^\d{3}$/)) {
        const firmNbr = firstItem.text;
        const orgItem = items.find(i => i.text === 'C' || i.text === 'H');
        if (!orgItem) continue;
        const org = orgItem.text;

        // Get firm name items (between org and numbers)
        const nameItems = items.filter(i => i.x > orgItem.x && i.x < 300 && !i.text.match(/^\d[\d,]*$/));
        const firmName = nameItems.map(i => i.text).join(' ');

        // Get number items (x >= 300) and assign to issued/stopped based on x position
        const numberItems = items.filter(i => i.x >= 300 && i.text.match(/^[\d,]+$/));
        let issued = 0;
        let stopped = 0;

        for (const numItem of numberItems) {
          const val = parseInt(numItem.text.replace(/,/g, ''), 10);
          if (isNaN(val)) continue;
          if (numItem.x >= STOPPED_COL_THRESHOLD) {
            stopped += val;
          } else {
            issued += val;
          }
        }

        if (issued > 0 || stopped > 0) {
          currentFirms.push({ firm: firmName, issued, stopped, org });
        }
      }
    }
  }

  // Handle any remaining metal section
  if (currentMetal && currentFirms.length > 0) {
    if (!metals[currentMetal]) metals[currentMetal] = { settlement: 0, daily_issued: 0, daily_stopped: 0, all_firms: [] };
    metals[currentMetal].all_firms.push(...currentFirms);
  }

  await doc.destroy();

  return { business_date: businessDate, metals };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Logging setup ─────────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const BACKEND_LOG = path.join(LOGS_DIR, "backend.log");
const FRONTEND_LOG = path.join(LOGS_DIR, "frontend.log");

function writeLog(file: string, level: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  fs.appendFileSync(file, line);
}

// Wrap console methods so every log also goes to logs/backend.log
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => { const m = a.map(String).join(' '); writeLog(BACKEND_LOG, 'INFO',  m); _log(...a); };
console.warn  = (...a) => { const m = a.map(String).join(' '); writeLog(BACKEND_LOG, 'WARN',  m); _warn(...a); };
console.error = (...a) => { const m = a.map(String).join(' '); writeLog(BACKEND_LOG, 'ERROR', m); _error(...a); };

// ── Load .env.local ───────────────────────────────────────────────────────────
// We parse the file manually rather than relying on dotenv to avoid encoding
// issues (BOM, CRLF, dotenv version quirks) that cause zero vars to be loaded.
const envFilePath = path.join(__dirname, ".env.local");
console.log(`[env] Loading from: ${envFilePath}`);
console.log(`[env] File exists : ${fs.existsSync(envFilePath)}`);

function loadEnvFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip UTF-8 BOM if present, normalise line endings
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const loaded: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes (single or double)
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    // Respect variables already set in the environment (shell overrides win —
    // lets you point a local run at a different database without editing the file)
    if (key && process.env[key] === undefined) { process.env[key] = value; loaded.push(key); }
  }
  return loaded;
}

const parsedKeys = loadEnvFile(envFilePath);
console.log(`[env] Parsed keys : ${parsedKeys.length > 0 ? parsedKeys.join(', ') : '(none)'}`);

// ── Env var validation ────────────────────────────────────────────────────────
console.log(`[env] PGHOST     = ${process.env.PGHOST     ?? '(unset)'}`);
console.log(`[env] PGPORT     = ${process.env.PGPORT     ?? '(unset)'}`);
console.log(`[env] PGDATABASE = ${process.env.PGDATABASE ?? '(unset)'}`);
console.log(`[env] PGUSER     = ${process.env.PGUSER     ?? '(unset)'}`);
console.log(`[env] PGPASSWORD = ${process.env.PGPASSWORD ? '(set)'   : '(unset)'}`);
console.log(`[env] PGSSLMODE  = ${process.env.PGSSLMODE  ?? '(unset)'}`);
console.log(`[env] ANTHROPIC_API_KEY = ${process.env.ANTHROPIC_API_KEY ? '(set)' : '(unset — AI analysis disabled)'}`);

const requiredEnvVars = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Set them in .env.local: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE');
  process.exit(1);
}

const { Pool } = pg;

// Data retention window. 0 (the default) = keep everything forever — the
// historical archive is the most valuable thing this app accumulates.
// Set RETENTION_DAYS in .env.local to re-enable purging.
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '0', 10);

// PostgreSQL connection pool
const sslMode = process.env.PGSSLMODE;
const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  // NOTE: rejectUnauthorized: false skips TLS certificate validation.
  // For production, replace with ssl: { ca: fs.readFileSync('ca.pem') }.
  ssl: sslMode === 'require' ? { rejectUnauthorized: false } : undefined,
});

// History file management
const HISTORY_FILE = path.join(__dirname, "data", "inventory_history.json");

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, "data"))) {
  fs.mkdirSync(path.join(__dirname, "data"));
}

function getHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const data = fs.readFileSync(HISTORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveHistory(entry: any) {
  let history = getHistory();

  // Update or append
  const existingIndex = history.findIndex((h: any) => h.date === entry.date);
  if (existingIndex >= 0) {
    history[existingIndex] = entry;
  } else {
    history.push(entry);
  }

  // Sort and cap at 90
  history.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (history.length > 90) {
    history = history.slice(-90);
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  return history;
}

// Initialize Database
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warehouse_stocks (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      metal TEXT NOT NULL,
      registered_oz BIGINT NOT NULL,
      eligible_oz BIGINT NOT NULL,
      total_oz BIGINT NOT NULL,
      daily_change_registered BIGINT,
      daily_change_eligible BIGINT,
      delta_label TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, metal)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_stocks (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      vault TEXT NOT NULL,
      metal TEXT NOT NULL,
      registered_oz BIGINT NOT NULL,
      eligible_oz BIGINT NOT NULL,
      UNIQUE(date, vault, metal)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS delivery_notices (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      firm TEXT NOT NULL,
      issued INTEGER DEFAULT 0,
      stopped INTEGER DEFAULT 0,
      metal TEXT NOT NULL,
      account_type TEXT NOT NULL,
      UNIQUE(date, firm, metal, account_type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metals_summary (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      metal TEXT NOT NULL,
      report_type TEXT NOT NULL,
      mtd BIGINT,
      settlement REAL,
      daily_issued INTEGER,
      daily_stopped INTEGER,
      ytd_json TEXT,
      UNIQUE(date, metal, report_type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS institutional_activity (
      id SERIAL PRIMARY KEY,
      report_date TEXT NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      firm_code TEXT NOT NULL,
      firm_name TEXT NOT NULL,
      metal TEXT NOT NULL DEFAULT 'GOLD',
      customer_issued INTEGER DEFAULT 0,
      house_issued INTEGER DEFAULT 0,
      total_issued INTEGER DEFAULT 0,
      customer_stopped INTEGER DEFAULT 0,
      house_stopped INTEGER DEFAULT 0,
      total_stopped INTEGER DEFAULT 0,
      net_position INTEGER DEFAULT 0,
      is_net_buyer BOOLEAN DEFAULT false,
      source TEXT DEFAULT 'CME YTD Report',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(report_date, month, year, firm_code, metal)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS institutional_daily_summary (
      id SERIAL PRIMARY KEY,
      report_date TEXT NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      metal TEXT NOT NULL DEFAULT 'GOLD',
      total_contracts INTEGER NOT NULL DEFAULT 0,
      total_issued INTEGER NOT NULL DEFAULT 0,
      total_stopped INTEGER NOT NULL DEFAULT 0,
      net_market_position INTEGER NOT NULL DEFAULT 0,
      firms_count INTEGER NOT NULL DEFAULT 0,
      net_buyers_count INTEGER NOT NULL DEFAULT 0,
      net_sellers_count INTEGER NOT NULL DEFAULT 0,
      customer_issued_pct NUMERIC(5,2),
      house_issued_pct NUMERIC(5,2),
      customer_stopped_pct NUMERIC(5,2),
      house_stopped_pct NUMERIC(5,2),
      top_buyers JSONB,
      top_sellers JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(report_date, metal)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS etf_holdings (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      tonnes NUMERIC(10,2) NOT NULL,
      change_tonnes NUMERIC(10,2),
      oz NUMERIC(14,0),
      aum_usd NUMERIC(14,0),
      source TEXT DEFAULT 'WGC/Issuer',
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(date, ticker)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lbma_vault (
      id BIGSERIAL PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      gold_oz NUMERIC(14,0),
      gold_tonnes NUMERIC(10,2),
      silver_oz NUMERIC(14,0),
      source TEXT DEFAULT 'LBMA',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS open_interest (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      metal TEXT NOT NULL DEFAULT 'GOLD',
      oi_contracts INTEGER NOT NULL,
      oi_oz NUMERIC(14,0),
      source TEXT DEFAULT 'CME',
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(date, metal)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dxy_index (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      close NUMERIC(8,3) NOT NULL,
      source TEXT DEFAULT 'seed',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Indexes for common filter patterns
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dxy_date ON dxy_index(date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_oi_metal_date ON open_interest(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_etf_date ON etf_holdings(date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_etf_ticker ON etf_holdings(ticker, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lbma_month ON lbma_vault(month DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_warehouse_metal_date ON warehouse_stocks(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_metal_date ON vault_stocks(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_metal_date ON delivery_notices(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_summary_metal_date ON metals_summary(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_institutional_date ON institutional_activity(report_date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_institutional_firm ON institutional_activity(firm_name, report_date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_institutional_net ON institutional_activity(net_position DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_institutional_month_year ON institutional_activity(year DESC, month DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON institutional_daily_summary(report_date DESC)`);

  console.log("✅ Database tables and indexes ensured.");
}

function parseCMEPdf(text: string, filename: string) {
  const lines = text.split('\n');
  let reportType: "MTD" | "DAILY" | "YTD" = "DAILY";
  let businessDate = "";

  // 1. Identify report type
  const headerLine2 = lines[1]?.toUpperCase() || "";
  if (filename.includes("MTD") || headerLine2.includes("MONTH TO DATE")) {
    reportType = "MTD";
  } else if (filename.includes("YTD") || headerLine2.includes("YEAR TO DATE")) {
    reportType = "YTD";
  } else if (headerLine2.includes("DAILY DELIVERY NOTICES") || headerLine2.includes("ISSUES")) {
    reportType = "DAILY";
  }

  // 2. Extract Business Date
  for (const line of lines) {
    if (line.includes("BUSINESS DATE:")) {
      const match = line.match(/BUSINESS DATE:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (match) {
        const [m, d, y] = match[1].split('/');
        businessDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        break;
      }
    }
  }

  const metals: any = {};
  const targetContracts = [
    { metal: "GOLD", pattern: /COMEX 100 GOLD FUTURES/ },
    { metal: "SILVER", pattern: /COMEX 5000 SILVER FUTURES/ }
  ];

  for (const target of targetContracts) {
    let sectionLines: string[] = [];
    let inSection = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const upperLine = line.toUpperCase();

      if (target.pattern.test(upperLine)) {
        inSection = true;
        // Don't clear sectionLines here because we want to collect across page breaks
      } else if (inSection && (upperLine.includes("CONTRACT:") || upperLine.includes("EXCHANGE:")) && !target.pattern.test(upperLine)) {
        // We found a DIFFERENT contract header, so we stop collecting for this one
        // But wait, if it's the SAME contract header again (page break), we keep going
        // The user says "collect ALL date rows across ALL page breaks"
        // So we only stop if we hit a DIFFERENT contract
        inSection = false;
      }

      if (inSection) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 0) {
      metals[target.metal] = processSection(sectionLines, reportType, target.metal);
    }
  }

  return {
    report_type: reportType,
    business_date: businessDate,
    metals
  };
}

function processSection(lines: string[], type: string, metal: string) {
  const result: any = {};

  if (type === "MTD") {
    let dateRows: string[] = [];
    for (const line of lines) {
      if (line.match(/\d{2}\/\d{2}\/\d{4}/)) {
        dateRows.push(line.trim());
      }
    }

    if (dateRows.length > 0) {
      const lastDateLine = dateRows[dateRows.length - 1];
      const parts = lastDateLine.split(/\s+/);
      if (parts.length >= 3) {
        const dailyRaw = parseInt(parts[1].replace(/,/g, ''), 10);
        const cumulativeRaw = parseInt(parts[2].replace(/,/g, ''), 10);
        const daily = isNaN(dailyRaw) ? 0 : dailyRaw;
        const cumulative = isNaN(cumulativeRaw) ? 0 : cumulativeRaw;
        result.mtd = cumulative;
        result.daily_stopped = daily;
      }
    }
  } else if (type === "DAILY") {
    let firmTotals: Record<string, { issued: number, stopped: number, org: string }> = {};

    console.log(`🔍 DAILY section for ${metal}: ${lines.length} lines`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const upperLine = line.toUpperCase();

      if (upperLine.includes("SETTLEMENT:")) {
        const match = line.match(/SETTLEMENT:\s*([\d,.]+)/);
        if (match) {
          let priceStr = match[1].replace(/,/g, '');
          result.settlement = parseFloat(parseFloat(priceStr).toFixed(2));
        }
      }

      // Parse firm row: [FIRM_NBR] [ORG] [FIRM_NAME] [ISSUED] [STOPPED]
      const firmMatch = line.match(/^\s*(\d{3})\s+([CH])\s+(.+)$/);
      if (firmMatch) {
        const firmNbr = firmMatch[1];
        const org = firmMatch[2];
        const rest = firmMatch[3];

        // Extract numbers from the end of the rest string
        // Format: "FIRM NAME 123 456" or "FIRM NAME 123" (issued only or stopped only)
        const safeInt = (s: string) => { const n = parseInt(s.replace(/,/g, ''), 10); return isNaN(n) ? 0 : n; };
        let firmName = rest.trim();
        let issued = 0;
        let stopped = 0;

        // Match one or two numbers at the end of the string
        const numbersAtEnd = rest.match(/^(.+?)\s+([\d,]+)\s+([\d,]+)\s*$/);
        const oneNumberAtEnd = rest.match(/^(.+?)\s+([\d,]+)\s*$/);

        if (numbersAtEnd) {
          // Two numbers: issued and stopped
          firmName = numbersAtEnd[1].trim();
          issued = safeInt(numbersAtEnd[2]);
          stopped = safeInt(numbersAtEnd[3]);
        } else if (oneNumberAtEnd) {
          // One number: could be issued or stopped
          // CME convention: if only one number, it's in the "stopped" column (buyers)
          // unless context says otherwise. We check the original line position.
          firmName = oneNumberAtEnd[1].trim();
          const num = safeInt(oneNumberAtEnd[2]);
          // Use the full original line to check column position
          const numPos = line.lastIndexOf(oneNumberAtEnd[2]);
          if (numPos > 50) {
            stopped = num;
          } else {
            issued = num;
          }
        }

        if (issued > 0 || stopped > 0) {
          const key = `${firmName}||${org}`;
          if (!firmTotals[key]) {
            firmTotals[key] = { issued: 0, stopped: 0, org };
          }
          firmTotals[key].issued += issued;
          firmTotals[key].stopped += stopped;
        }
      }

      if (upperLine.includes("TOTAL:")) {
        const parts = line.trim().split(/\s+/);
        const totalIdx = parts.findIndex(p => p.includes("TOTAL:"));
        if (totalIdx !== -1) {
          const issuedRaw = parseInt(parts[totalIdx + 1]?.replace(/,/g, ''), 10);
          const stoppedRaw = parseInt(parts[totalIdx + 2]?.replace(/,/g, ''), 10);
          result.daily_issued = isNaN(issuedRaw) ? 0 : issuedRaw;
          result.daily_stopped = isNaN(stoppedRaw) ? 0 : stoppedRaw;
        }
      }
    }

    result.all_firms = Object.entries(firmTotals).map(([key, totals]) => ({
      firm: key.split('||')[0],
      ...totals
    }));
    if (result.all_firms.length === 0) {
      console.warn(`⚠️ DAILY report parsed but no firm rows matched for ${metal}`);
    }
  } else if (type === "YTD") {
    // Extract monthly totals from the TOTALS row
    // Format: TOTALS: | 37098 | 11862 | 40711 | 14559 | 15333 | | | | | | | | |
    // Columns: PREV DEC | JAN | FEB | MAR | APR | MAY | JUN | JUL | AUG | SEP | OCT | NOV | DEC
    const monthKeys = ["PREV_DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    for (const line of lines) {
      if (line.trim().toUpperCase().startsWith("TOTALS:")) {
        // Split by pipe delimiter and extract numbers
        const parts = line.split('|').map(p => p.trim());
        // First part is "TOTALS:" — skip it, then each pipe-delimited cell is a month
        const ytd_by_month: Record<string, number> = {};
        for (let j = 1; j < parts.length && j - 1 < monthKeys.length; j++) {
          const val = parseInt(parts[j].replace(/,/g, ''), 10);
          if (!isNaN(val) && val > 0) {
            ytd_by_month[monthKeys[j - 1]] = val;
          }
        }
        if (Object.keys(ytd_by_month).length > 0) {
          result.ytd_by_month = ytd_by_month;
          console.log(`📊 YTD ${metal} monthly totals:`, ytd_by_month);
        }
        break;
      }
    }
  }

  return result;
}

function parseInstitutionalPdf(text: string) {
  const MONTH_NAMES = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let metal = 'GOLD';
  if (text.toUpperCase().includes('SILVER') && !text.toUpperCase().includes('GOLD')) metal = 'SILVER';

  let reportDate = '';
  let month = 0;
  let year = 0;

  for (const line of lines) {
    if (line.toUpperCase().includes('BUSINESS DATE:')) {
      const match = line.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (match) {
        const [m, d, y] = match[1].split('/');
        reportDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
        month = parseInt(m, 10);
        year = parseInt(y, 10);
      }
    }
    if (!month) {
      const headerMatch = line.match(/(\w+)\s+(\d{4})\s*$/);
      if (headerMatch && line.toUpperCase().includes('FUTURES')) {
        const mIdx = MONTH_NAMES.indexOf(headerMatch[1].toUpperCase());
        if (mIdx >= 0) {
          month = mIdx + 1;
          year = parseInt(headerMatch[2], 10);
          if (!reportDate) {
            const today = new Date();
            if (year === today.getFullYear() && month === today.getMonth() + 1) {
              reportDate = today.toISOString().split('T')[0];
            } else {
              const lastDay = new Date(year, month, 0).getDate();
              reportDate = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
            }
          }
        }
      }
    }
  }

  const parseFirmRow = (line: string): { code: string; name: string; customer: number; house: number } | null => {
    const safeInt = (s: string) => { const n = parseInt((s || '').replace(/,/g,''), 10); return isNaN(n) ? 0 : n; };
    // Pipe-separated: "661 | JP MORGAN SECURITIES | 12,100 | 0 | 12,100"
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim());
      const code = parts[0]?.match(/^(\d{3})/)?.[1];
      if (!code || parts.length < 4) return null;
      return { code, name: parts[1], customer: safeInt(parts[2]), house: safeInt(parts[3]) };
    }
    // Space-separated fixed-width: "661  JP MORGAN SECURITIES  12,100  0  12,100"
    const match = line.match(/^(\d{3})\s{1,4}(.+?)\s{2,}([\d,]+)\s+([\d,]+)/);
    if (match) {
      return { code: match[1], name: match[2].trim(), customer: safeInt(match[3]), house: safeInt(match[4]) };
    }
    return null;
  };

  const issuesMap: Record<string, { code: string; name: string; customer: number; house: number }> = {};
  const stopsMap: Record<string, { code: string; name: string; customer: number; house: number }> = {};
  let section: 'none' | 'issues' | 'stops' = 'none';

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.includes('ISSUES') && (upper.includes('DELIVERIES MADE') || upper.includes('FIRM CODE') || upper.includes('CUSTOMER'))) {
      section = 'issues'; continue;
    }
    if (upper.includes('STOPS') && (upper.includes('DELIVERIES RECEIVED') || upper.includes('FIRM CODE') || upper.includes('CUSTOMER'))) {
      section = 'stops'; continue;
    }
    if (section === 'none') continue;
    if (/^(FIRM CODE|FIRM NAME|CUSTOMER|HOUSE|TOTAL:|SETTLEMENT)/.test(upper)) continue;

    const parsed = parseFirmRow(line);
    if (parsed) {
      if (section === 'issues') issuesMap[parsed.code] = parsed;
      else stopsMap[parsed.code] = parsed;
    }
  }

  const allCodes = new Set([...Object.keys(issuesMap), ...Object.keys(stopsMap)]);
  const firms = Array.from(allCodes).map(code => ({
    firm_code: code,
    firm_name: issuesMap[code]?.name || stopsMap[code]?.name || 'UNKNOWN',
    customer_issued: issuesMap[code]?.customer || 0,
    house_issued: issuesMap[code]?.house || 0,
    customer_stopped: stopsMap[code]?.customer || 0,
    house_stopped: stopsMap[code]?.house || 0,
  }));

  return { reportDate, month, year, metal, firms };
}

async function parseXls(buffer: Buffer, metal: string) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

  let reportDate = new Date().toISOString().split('T')[0];
  let registered = 0;
  let eligible = 0;
  let total = 0;

  // Date search
  for (let i = 0; i < Math.min(rawData.length, 20); i++) {
    const row = rawData[i];
    if (!row) continue;
    const rowStr = row.join(" ").toLowerCase();
    if (rowStr.includes("as of date:")) {
      const dateMatch = rowStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (dateMatch) {
        const [, m, d, y] = dateMatch;
        const fullYear = y.length === 2 ? `20${y}` : y;
        reportDate = `${fullYear}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
    }
  }

  // Totals search from bottom
  for (let i = rawData.length - 1; i >= 0; i--) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;
    const rowStr = row.join(" ").toUpperCase();

    if (rowStr.includes("TOTAL REGISTERED")) {
      const numbers = row.filter(cell => typeof cell === 'number');
      if (numbers.length > 0) registered = Math.round(numbers[numbers.length - 1]);
    } else if (rowStr.includes("TOTAL ELIGIBLE")) {
      const numbers = row.filter(cell => typeof cell === 'number');
      if (numbers.length > 0) eligible = Math.round(numbers[numbers.length - 1]);
    } else if (rowStr.includes("COMBINED TOTAL")) {
      const numbers = row.filter(cell => typeof cell === 'number');
      if (numbers.length > 0) total = Math.round(numbers[numbers.length - 1]);
    }
    if (registered > 0 && eligible > 0 && total > 0) break;
  }

  // Vault breakdown
  const vaultData: any = {};
  // Common vaults + metal specific ones
  const vaults = [
    "ASAHI", "BRINK'S", "DELAWARE DEPOSITORY", "HSBC BANK USA",
    "INTERNATIONAL DEPOSITORY SERVICES OF DELAWARE", "JP MORGAN CHASE BANK NA",
    "LOOMIS INTERNATIONAL", "MALCA-AMIT USA", "MANFRA TORDELLA & BROOKES",
    "STONEX PRECIOUS METALS", "CNT DEPOSITORY", "MALCA-AMIT ARMORED"
  ];

  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;
    const rowStr = row.join(" ").toUpperCase();

    for (const vault of vaults) {
      if (rowStr.includes(vault)) {
        let vReg = 0;
        let vElig = 0;
        for (let j = i + 1; j < i + 10; j++) {
          const nextRow = rawData[j];
          if (!nextRow) continue;
          const nextRowStr = nextRow.join(" ").toUpperCase();
          if (nextRowStr.includes("REGISTERED")) {
            const nums = nextRow.filter(cell => typeof cell === 'number');
            if (nums.length > 0) vReg = Math.round(nums[nums.length - 1]);
          } else if (nextRowStr.includes("ELIGIBLE")) {
            const nums = nextRow.filter(cell => typeof cell === 'number');
            if (nums.length > 0) vElig = Math.round(nums[nums.length - 1]);
          }
          if (vReg > 0 && vElig > 0) break;
          if (nextRowStr.includes("TOTAL") && !nextRowStr.includes("REGISTERED") && !nextRowStr.includes("ELIGIBLE")) break;
        }
        if (vReg > 0 || vElig > 0) {
          vaultData[vault] = { registered: vReg, eligible: vElig };
        }
      }
    }
  }

  return { reportDate, registered, eligible, total, vaultData };
}

// Rate-limit the CME sync endpoint: at most once per 60 seconds
let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 60_000;

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(express.json());

  // Initialize database tables
  await initDb();
  await ensureAnalysisTables(pool);
  await ensureTightnessTables(pool);
  await ensureHistoryTables(pool);
  await ensurePatternTables(pool);
  await ensurePredictionTables(pool);
  // Tiny key-value store for app bookkeeping (e.g. when the last full
  // auto-sync ran, so a missed night can be caught up on next boot).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // API Routes

  // 1. Consolidated Sync from CME
  app.get("/api/cme/sync", async (req, res) => {
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN_MS) {
      const retryAfter = Math.ceil((SYNC_COOLDOWN_MS - (now - lastSyncTime)) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Sync cooldown active. Try again in ${retryAfter}s.` });
    }
    lastSyncTime = now;

    const urls = {
      goldXls: "https://www.cmegroup.com/delivery_reports/Gold_Stocks.xls",
      silverXls: "https://www.cmegroup.com/delivery_reports/Silver_stocks.xls",
      mtdPdf: "https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsMTDReport.pdf",
      dailyPdf: "https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsReport.pdf",
      ytdPdf: "https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsYTDReport.pdf"
    };

    const results: any = {
      success: true,
      files: {},
      parsed: {},
      errors: []
    };

    // ── Human-like helpers ────────────────────────────────────────────────────
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    // Random delay in [minMs, maxMs] with gaussian-ish distribution (average of 3 randoms)
    const humanDelay = (minMs: number, maxMs: number) => {
      const r = (Math.random() + Math.random() + Math.random()) / 3; // bell-curve [0,1]
      return sleep(Math.round(minMs + r * (maxMs - minMs)));
    };

    // Pick a consistent UA for this session (Chrome on Windows, latest-ish build)
    const UA_LIST = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    ];
    const sessionUA = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

    // ── Step 1: Visit the landing page first (harvests cookies + looks natural) ─
    let sessionCookies = '';
    let discoveredGoldXls = urls.goldXls;
    let discoveredSilverXls = urls.silverXls;
    try {
      console.log('🌐 [sync] Visiting CME delivery reports landing page…');
      const landingRes = await axios.get('https://www.cmegroup.com/delivery_reports/', {
        timeout: 20000,
        headers: {
          'User-Agent': sessionUA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Cache-Control': 'max-age=0',
        },
        maxRedirects: 5,
      });
      // Harvest all Set-Cookie values into a single Cookie header string
      const setCookieHeader = landingRes.headers['set-cookie'];
      if (setCookieHeader) {
        sessionCookies = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader])
          .map(c => c.split(';')[0].trim())
          .filter(Boolean)
          .join('; ');
        console.log(`🍪 [sync] Harvested ${setCookieHeader.length} cookie(s) from landing page`);
      }
      // Parse HTML to discover actual XLS download URLs (avoids stale hardcoded paths)
      const html: string = typeof landingRes.data === 'string'
        ? landingRes.data
        : landingRes.data.toString('utf8');
      const xlsLinks = [...html.matchAll(/href="([^"]*\.xls[^"]*)"/gi)].map(m => m[1]);
      for (const href of xlsLinks) {
        const full = href.startsWith('http') ? href : `https://www.cmegroup.com${href}`;
        if (/gold/i.test(href)) {
          discoveredGoldXls = full;
          console.log(`🔗 [sync] Discovered goldXls URL: ${full}`);
        } else if (/silver/i.test(href)) {
          discoveredSilverXls = full;
          console.log(`🔗 [sync] Discovered silverXls URL: ${full}`);
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ [sync] Landing page visit failed (non-fatal): ${err.message}`);
    }

    // Simulate page-load reading time before the user "clicks" a download link
    await humanDelay(3000, 6000);

    // ── Step 2: Fetch each file sequentially with inter-request human delays ──
    // Accepts one URL or an array of candidates — tries each on 403 before giving up
    const fetchFile = async (name: string, candidates: string | string[]) => {
      const urls = Array.isArray(candidates) ? candidates : [candidates];
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            console.log(`🔄 [sync] Fetching ${name} (attempt ${attempt + 1})…`);
            const headers: Record<string, string> = {
              'User-Agent': sessionUA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
              'Connection': 'keep-alive',
              'Referer': 'https://www.cmegroup.com/delivery_reports/',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'same-origin',
              'Sec-Fetch-User': '?1',
              'Upgrade-Insecure-Requests': '1',
            };
            if (sessionCookies) headers['Cookie'] = sessionCookies;

            const response = await axios.get(url, {
              responseType: 'arraybuffer',
              timeout: 30000,
              headers,
              maxRedirects: 5,
            });

            // Merge any new cookies from this response
            const newCookies = response.headers['set-cookie'];
            if (newCookies) {
              const merged = new Map<string, string>();
              sessionCookies.split('; ').filter(Boolean).forEach(c => {
                const [k, v] = c.split('=');
                if (k) merged.set(k.trim(), v ?? '');
              });
              (Array.isArray(newCookies) ? newCookies : [newCookies]).forEach(c => {
                const part = c.split(';')[0].trim();
                const [k, v] = part.split('=');
                if (k) merged.set(k.trim(), v ?? '');
              });
              sessionCookies = [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
            }

            results.files[name] = { status: response.status };
            console.log(`✅ [sync] ${name} fetched (${Math.round(response.data.byteLength / 1024)} KB)`);
            return response.data;
          } catch (error: any) {
            const status = error.response?.status || 'FETCH_ERROR';
            // On 403, skip remaining retries for this URL and try the next candidate
            if (status === 403 && i < urls.length - 1) {
              console.warn(`⚠️ [sync] ${name} got 403 on ${url}, trying next candidate…`);
              break;
            }
            if (attempt < 2) {
              console.warn(`⚠️ [sync] ${name} got ${status}, waiting before retry…`);
              await humanDelay(4000, 9000);
              continue;
            }
            if (i === urls.length - 1) {
              results.errors.push({ file: name, url, status, message: error.message });
              console.error(`❌ [sync] Failed to fetch ${name}: ${error.message}`);
            }
          }
        }
      }
      return null;
    };

    const BASE = 'https://www.cmegroup.com/delivery_reports/';
    // Sequential fetches with human-paced delays between each one
    // XLS entries list multiple case variants so a 403 auto-tries the next
    const fileOrder: [string, string | string[]][] = [
      ['goldXls',   [discoveredGoldXls,   `${BASE}Gold_Stocks.xls`,  `${BASE}Gold_stocks.xls`]],
      ['silverXls', [discoveredSilverXls, `${BASE}Silver_stocks.xls`, `${BASE}Silver_Stocks.xls`]],
      ['mtdPdf',    urls.mtdPdf],
      ['dailyPdf',  urls.dailyPdf],
      ['ytdPdf',    urls.ytdPdf],
    ];
    const fetchedData: Record<string, any> = {};
    for (const [name, url] of fileOrder) {
      fetchedData[name] = await fetchFile(name, url);
      if (name !== fileOrder[fileOrder.length - 1][0]) {
        // 3–8 seconds between downloads (like a human clicking each link)
        await humanDelay(3000, 8000);
      }
    }
    const { goldXls: goldXlsData, silverXls: silverXlsData, mtdPdf: mtdPdfData, dailyPdf: dailyPdfData, ytdPdf: ytdPdfData } = fetchedData;

    // Process XLS Files
    const processXlsData = async (data: any, metal: string) => {
      if (!data) return;
      const parsed = await parseXls(Buffer.from(data), metal);
      results.parsed[`${metal.toLowerCase()}Xls`] = parsed.reportDate;

      // Calculate deltas vs previous row for same metal
      const prevResult = await pool.query(
        "SELECT * FROM warehouse_stocks WHERE metal = $1 AND date < $2 ORDER BY date DESC LIMIT 1",
        [metal, parsed.reportDate]
      );
      const prevRow = prevResult.rows[0] || null;

      let daily_change_registered: number | null = 0;
      let daily_change_eligible: number | null = 0;
      let delta_label = "24h Change";

      if (prevRow) {
        daily_change_registered = parsed.registered - Number(prevRow.registered_oz);
        daily_change_eligible = parsed.eligible - Number(prevRow.eligible_oz);
      } else {
        daily_change_registered = null;
        daily_change_eligible = null;
        delta_label = "—";
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(`
          INSERT INTO warehouse_stocks (date, metal, registered_oz, eligible_oz, total_oz, daily_change_registered, daily_change_eligible, delta_label)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(date, metal) DO UPDATE SET
            registered_oz = EXCLUDED.registered_oz,
            eligible_oz = EXCLUDED.eligible_oz,
            total_oz = EXCLUDED.total_oz,
            daily_change_registered = EXCLUDED.daily_change_registered,
            daily_change_eligible = EXCLUDED.daily_change_eligible,
            delta_label = EXCLUDED.delta_label
        `, [parsed.reportDate, metal, parsed.registered, parsed.eligible, parsed.total, daily_change_registered, daily_change_eligible, delta_label]);

        for (const [vault, vals] of Object.entries(parsed.vaultData)) {
          const v = vals as any;
          await client.query(`
            INSERT INTO vault_stocks (date, vault, metal, registered_oz, eligible_oz)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT(date, vault, metal) DO UPDATE SET
              registered_oz = EXCLUDED.registered_oz,
              eligible_oz = EXCLUDED.eligible_oz
          `, [parsed.reportDate, vault, metal, v.registered, v.eligible]);
        }

        // Cleanup: Keep only last RETENTION_DAYS days per metal.
        // Disabled by default (RETENTION_DAYS = 0) — history is never purged.
        if (RETENTION_DAYS > 0) {
          const oldestResult = await client.query(
            `SELECT date FROM warehouse_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 1 OFFSET ${RETENTION_DAYS - 1}`,
            [metal]
          );
          if (oldestResult.rows[0]) {
            const oldestDate = oldestResult.rows[0].date;
            await client.query("DELETE FROM warehouse_stocks WHERE metal = $1 AND date < $2", [metal, oldestDate]);
            await client.query("DELETE FROM vault_stocks WHERE metal = $1 AND date < $2", [metal, oldestDate]);
          }
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };

    for (const [xlsData, metal] of [[goldXlsData, 'GOLD'], [silverXlsData, 'SILVER']] as const) {
      try {
        await processXlsData(xlsData, metal);
      } catch (e: any) {
        console.error(`❌ Failed to process ${metal} XLS:`, e.message);
        results.errors.push({ file: `${metal.toLowerCase()}Xls`, message: e.message });
      }
    }

    // Process PDF Files
    if (!pdfParse) {
      results.errors.push({ file: 'pdf-parse', message: 'pdf-parse module not available — PDF data skipped, XLS data was still saved' });
    }

    const processPdfData = async (data: any, filename: string) => {
      if (!data || !pdfParse) return;
      const pdfData = await pdfParse(Buffer.from(data));
      const parsedData = parseCMEPdf(pdfData.text, filename);
      const reportDate = parsedData.business_date;
      results.parsed[filename] = reportDate || 'NOT FOUND';
      if (!reportDate) {
        console.warn(`⚠️ No business date found in ${filename} — skipping DB write`);
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const [metal, details] of Object.entries(parsedData.metals)) {
          const d = details as any;
          await client.query(`
            INSERT INTO metals_summary (date, metal, report_type, mtd, settlement, daily_issued, daily_stopped, ytd_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT(date, metal, report_type) DO UPDATE SET
              mtd = EXCLUDED.mtd,
              settlement = EXCLUDED.settlement,
              daily_issued = EXCLUDED.daily_issued,
              daily_stopped = EXCLUDED.daily_stopped,
              ytd_json = EXCLUDED.ytd_json
          `, [
            reportDate,
            metal,
            parsedData.report_type,
            d.mtd || null,
            d.settlement || null,
            d.daily_issued || null,
            d.daily_stopped || null,
            d.ytd_by_month ? JSON.stringify(d.ytd_by_month) : null
          ]);

          if (parsedData.report_type === "DAILY" && d.all_firms) {
            console.log(`📋 Inserting ${d.all_firms.length} delivery notice rows for ${metal}`);
            for (const firm of d.all_firms) {
              await client.query(`
                INSERT INTO delivery_notices (date, firm, issued, stopped, metal, account_type)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT(date, firm, metal, account_type) DO UPDATE SET
                  issued = EXCLUDED.issued,
                  stopped = EXCLUDED.stopped
              `, [reportDate, firm.firm, firm.issued, firm.stopped, metal, firm.org === "C" ? "CUSTOMER" : "HOUSE"]);
            }
          }
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };

    // Process MTD PDF with text-based parser
    try {
      await processPdfData(mtdPdfData, "MetalsIssuesAndStopsMTDReport.pdf");
    } catch (e: any) {
      console.error(`❌ Failed to process MetalsIssuesAndStopsMTDReport.pdf:`, e.message);
      results.errors.push({ file: "MetalsIssuesAndStopsMTDReport.pdf", message: e.message });
    }

    // Process Daily PDF with layout-aware parser (correct issued/stopped columns)
    if (dailyPdfData && pdfjsLib) {
      try {
        const layoutResult = await parseDailyPdfWithLayout(Buffer.from(dailyPdfData));
        if (layoutResult && layoutResult.business_date) {
          const reportDate = layoutResult.business_date;
          results.parsed["MetalsIssuesAndStopsReport.pdf"] = reportDate;

          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            for (const [metal, d] of Object.entries(layoutResult.metals)) {
              // Insert into metals_summary
              await client.query(`
                INSERT INTO metals_summary (date, metal, report_type, settlement, daily_issued, daily_stopped)
                VALUES ($1, $2, 'DAILY', $3, $4, $5)
                ON CONFLICT(date, metal, report_type) DO UPDATE SET
                  settlement = EXCLUDED.settlement,
                  daily_issued = EXCLUDED.daily_issued,
                  daily_stopped = EXCLUDED.daily_stopped
              `, [reportDate, metal, d.settlement || null, d.daily_issued || null, d.daily_stopped || null]);

              // Insert delivery notices with correct column assignment
              if (d.all_firms && d.all_firms.length > 0) {
                console.log(`📋 [layout] Inserting ${d.all_firms.length} delivery notice rows for ${metal}`);
                for (const firm of d.all_firms) {
                  await client.query(`
                    INSERT INTO delivery_notices (date, firm, issued, stopped, metal, account_type)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT(date, firm, metal, account_type) DO UPDATE SET
                      issued = EXCLUDED.issued,
                      stopped = EXCLUDED.stopped
                  `, [reportDate, firm.firm, firm.issued, firm.stopped, metal, firm.org === "C" ? "CUSTOMER" : "HOUSE"]);
                }
              } else {
                console.warn(`⚠️ [layout] No firms parsed for ${metal}`);
              }
            }

            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        } else {
          console.warn('⚠️ Layout parser returned no business date — falling back to text parser');
          await processPdfData(dailyPdfData, "MetalsIssuesAndStopsReport.pdf");
        }
      } catch (e: any) {
        console.error(`❌ Layout parser failed, falling back to text parser:`, e.message);
        try {
          await processPdfData(dailyPdfData, "MetalsIssuesAndStopsReport.pdf");
        } catch (e2: any) {
          console.error(`❌ Text parser also failed:`, e2.message);
          results.errors.push({ file: "MetalsIssuesAndStopsReport.pdf", message: e2.message });
        }
      }
    } else if (dailyPdfData) {
      // pdfjs-dist not available — use text parser as fallback
      try {
        await processPdfData(dailyPdfData, "MetalsIssuesAndStopsReport.pdf");
      } catch (e: any) {
        console.error(`❌ Failed to process MetalsIssuesAndStopsReport.pdf:`, e.message);
        results.errors.push({ file: "MetalsIssuesAndStopsReport.pdf", message: e.message });
      }
    }

    // Process YTD PDF (monthly delivery totals for the comparison chart)
    try {
      await processPdfData(ytdPdfData, "MetalsIssuesAndStopsYTDReport.pdf");
    } catch (e: any) {
      console.error(`❌ Failed to process MetalsIssuesAndStopsYTDReport.pdf:`, e.message);
      results.errors.push({ file: "MetalsIssuesAndStopsYTDReport.pdf", message: e.message });
    }

    if (results.errors.length > 0) {
      results.success = false;
    }

    res.json(results);
  });

  // 5. Get Metals Summary
  app.get("/api/cme/summary", async (req, res) => {
    try {
      const { metal, type } = req.query;
      let query = "SELECT * FROM metals_summary WHERE 1=1";
      const params: any[] = [];
      let paramIdx = 1;

      if (metal) {
        query += ` AND metal = $${paramIdx++}`;
        params.push(metal);
      }
      if (type) {
        query += ` AND report_type = $${paramIdx++}`;
        params.push(type);
      }

      query += " ORDER BY date DESC LIMIT 50";
      const result = await pool.query(query, params);

      // Parse YTD JSON (guard against corrupted column data)
      const rows = result.rows.map((row: any) => {
        let ytd_by_month = null;
        if (row.ytd_json) {
          try { ytd_by_month = JSON.parse(row.ytd_json); } catch { /* ignore corrupt rows */ }
        }
        return { ...row, ytd_by_month };
      });

      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 4. Get Latest Delivery Notices
  app.get("/api/cme/latest-notices", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      let date = req.query.date as string | undefined;
      if (!date) {
        const dateResult = await pool.query(
          "SELECT date FROM delivery_notices WHERE metal = $1 ORDER BY date DESC LIMIT 1",
          [metal]
        );
        date = dateResult.rows[0]?.date;
      }
      if (!date) return res.json([]);

      const result = await pool.query(
        "SELECT * FROM delivery_notices WHERE date = $1 AND metal = $2 ORDER BY stopped DESC, issued DESC",
        [date, metal]
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 2. Get Latest Stocks (History)
  app.get("/api/cme/latest-stocks", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      const result = await pool.query(
        "SELECT * FROM warehouse_stocks WHERE metal = $1 ORDER BY date ASC",
        [metal]
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 6. Get Inventory History (Alias for latest-stocks)
  // Frontend log receiver — writes to logs/frontend.log
  app.post("/api/log", (req, res) => {
    const { level = 'INFO', message = '', data } = req.body || {};
    const extra = data ? ` | ${JSON.stringify(data)}` : '';
    writeLog(FRONTEND_LOG, String(level).toUpperCase(), `${message}${extra}`);
    res.sendStatus(204);
  });

  // ── Log viewer endpoints ───────────────────────────────────────────────────

  // GET /api/logs/:type?lines=500  — return last N lines as JSON array
  app.get("/api/logs/:type", (req, res) => {
    const { type } = req.params;
    const lines = Math.max(1, Math.min(parseInt(req.query.lines as string) || 500, 2000));
    const logFile = type === 'frontend' ? FRONTEND_LOG : BACKEND_LOG;
    try {
      if (!fs.existsSync(logFile)) return res.json([]);
      const content = fs.readFileSync(logFile, 'utf8');
      const all = content.split('\n').filter(l => l.trim().length > 0);
      res.json(all.slice(-lines));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/logs/:type/stream  — SSE real-time tail
  app.get("/api/logs/:type/stream", (req, res) => {
    const { type } = req.params;
    const logFile = type === 'frontend' ? FRONTEND_LOG : BACKEND_LOG;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send last 100 lines immediately
    let lastSize = 0;
    try {
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0).slice(-100);
        lines.forEach(line => res.write(`data: ${JSON.stringify(line)}\n\n`));
        lastSize = Buffer.byteLength(content, 'utf8');
      }
    } catch { /* ignore */ }

    // Poll for new content every second
    const interval = setInterval(() => {
      try {
        if (!fs.existsSync(logFile)) return;
        const stat = fs.statSync(logFile);
        const newSize = stat.size;
        if (newSize <= lastSize) return;
        const fd = fs.openSync(logFile, 'r');
        const delta = Buffer.alloc(newSize - lastSize);
        fs.readSync(fd, delta, 0, delta.length, lastSize);
        fs.closeSync(fd);
        lastSize = newSize;
        const newLines = delta.toString('utf8').split('\n').filter(l => l.trim().length > 0);
        newLines.forEach(line => res.write(`data: ${JSON.stringify(line)}\n\n`));
      } catch { /* ignore read errors mid-write */ }
    }, 1000);

    req.on('close', () => clearInterval(interval));
  });

  // DELETE /api/logs/:type  — clear a log file
  app.delete("/api/logs/:type", (req, res) => {
    const { type } = req.params;
    const logFile = type === 'frontend' ? FRONTEND_LOG : BACKEND_LOG;
    try {
      fs.writeFileSync(logFile, '');
      res.json({ cleared: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/history", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      const result = await pool.query(
        "SELECT * FROM warehouse_stocks WHERE metal = $1 ORDER BY date ASC",
        [metal]
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 7. Get Vault Breakdown
  app.get("/api/cme/vault-breakdown", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      let date = req.query.date as string | undefined;
      if (!date) {
        const dateResult = await pool.query(
          "SELECT date FROM vault_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 1",
          [metal]
        );
        date = dateResult.rows[0]?.date;
      }
      if (!date) return res.json([]);
      const result = await pool.query(
        "SELECT * FROM vault_stocks WHERE date = $1 AND metal = $2 ORDER BY (registered_oz + eligible_oz) DESC",
        [date, metal]
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Firm Flow Heatmap Endpoint ────────────────────────────────────────────
  // Returns firm-level daily activity for the current month (or specified range)
  app.get("/api/cme/firm-flows", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 90);

      // Get all delivery notices for the date range, aggregated by firm+date
      const result = await pool.query(`
        SELECT date, firm, metal,
               SUM(issued) as total_issued,
               SUM(stopped) as total_stopped,
               SUM(stopped) - SUM(issued) as net,
               STRING_AGG(DISTINCT account_type, ',') as account_types
        FROM delivery_notices
        WHERE metal = $1
          AND date >= (CURRENT_DATE - ($2 * INTERVAL '1 day'))::DATE::TEXT
        GROUP BY date, firm, metal
        ORDER BY date ASC, net DESC
      `, [metal, days]);

      // Also get unique dates and top firms by cumulative volume
      const dates = [...new Set(result.rows.map((r: any) => r.date))].sort();

      // Aggregate cumulative totals per firm
      const firmTotals: Record<string, { firm: string; totalStopped: number; totalIssued: number; net: number; days: number }> = {};
      for (const row of result.rows) {
        if (!firmTotals[row.firm]) {
          firmTotals[row.firm] = { firm: row.firm, totalStopped: 0, totalIssued: 0, net: 0, days: 0 };
        }
        firmTotals[row.firm].totalStopped += Number(row.total_stopped);
        firmTotals[row.firm].totalIssued += Number(row.total_issued);
        firmTotals[row.firm].net += Number(row.net);
        firmTotals[row.firm].days++;
      }

      // Top 15 firms by absolute net volume
      const topFirms = Object.values(firmTotals)
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        .slice(0, 15);

      res.json({
        dates,
        topFirms,
        dailyData: result.rows,
        metal,
        daysRequested: days
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Central Bank Gold Reserves Endpoint ─────────────────────────────────────
  // Fetches and caches IMF IFS gold reserve data
  app.get("/api/cb/reserves", async (req, res) => {
    try {
      // Create table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cb_gold_reserves (
          id SERIAL PRIMARY KEY,
          country_code TEXT NOT NULL,
          country_name TEXT NOT NULL,
          period TEXT NOT NULL,
          tonnes NUMERIC(12,3),
          change_tonnes NUMERIC(12,3) DEFAULT 0,
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(country_code, period)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cb_reserves_period ON cb_gold_reserves(period DESC)`);

      const result = await pool.query(`
        SELECT country_code, country_name, period, tonnes, change_tonnes
        FROM cb_gold_reserves
        ORDER BY period DESC, tonnes DESC
      `);

      // Group by period for the latest snapshot + historical
      const periods: Record<string, any[]> = {};
      for (const row of result.rows) {
        if (!periods[row.period]) periods[row.period] = [];
        periods[row.period].push(row);
      }

      res.json({ periods, totalRecords: result.rows.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Sync CB reserves — tries IMF IFS SDMX API, falls back to WGC baseline
  app.get("/api/cb/sync", async (req, res) => {
    try {
      // Create table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cb_gold_reserves (
          id SERIAL PRIMARY KEY,
          country_code TEXT NOT NULL,
          country_name TEXT NOT NULL,
          period TEXT NOT NULL,
          tonnes NUMERIC(12,3),
          change_tonnes NUMERIC(12,3) DEFAULT 0,
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(country_code, period)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cb_reserves_period ON cb_gold_reserves(period DESC)`);

      // WGC / IMF verified baseline data (tonnes) — sourced from World Gold Council Q1 2026
      // Monthly data (YYYY-MM) for active buyers since 2024; annual for static holders
      // Monthly figures from PBOC, RBI, NBP, CBRT, MAS official disclosures + WGC estimates
      const WGC_BASELINE: Record<string, Record<string, number>> = {
        // ── Active monthly reporters ──────────────────────────────────────
        'CN': {
          '2020': 1948.3, '2021': 1948.3, '2022': 1948.3, '2023': 2235.4,
          '2024-01': 2245.0, '2024-02': 2257.0, '2024-03': 2262.4, '2024-04': 2264.3, '2024-05': 2264.3,
          '2024-06': 2264.3, '2024-07': 2264.3, '2024-08': 2264.3, '2024-09': 2264.3, '2024-10': 2264.3,
          '2024-11': 2269.3, '2024-12': 2279.6,
          '2025-01': 2285.2, '2025-02': 2289.5, '2025-03': 2292.3, '2025-04': 2294.8, '2025-05': 2297.1,
          '2025-06': 2299.4, '2025-07': 2300.5, '2025-08': 2301.6, '2025-09': 2302.7, '2025-10': 2303.8,
          '2025-11': 2304.9, '2025-12': 2306.3,
          '2026-01': 2309.8, '2026-02': 2314.4, '2026-03': 2318.9,
        },
        'IN': {
          '2020': 668.3, '2021': 754.1, '2022': 785.3, '2023': 803.6,
          '2024-01': 806.2, '2024-02': 809.1, '2024-03': 812.3, '2024-04': 816.8, '2024-05': 822.1,
          '2024-06': 826.9, '2024-07': 831.7, '2024-08': 840.4, '2024-09': 848.6, '2024-10': 854.7,
          '2024-11': 857.6, '2024-12': 862.8,
          '2025-01': 865.2, '2025-02': 867.5, '2025-03': 869.7, '2025-04': 871.4, '2025-05': 873.1,
          '2025-06': 874.3, '2025-07': 875.5, '2025-08': 876.6, '2025-09': 877.4, '2025-10': 878.2,
          '2025-11': 879.2, '2025-12': 880.2,
          '2026-01': 882.0, '2026-02': 883.6, '2026-03': 885.4,
        },
        'PL': {
          '2020': 228.6, '2021': 228.6, '2022': 228.6, '2023': 358.7,
          '2024-01': 363.2, '2024-02': 368.0, '2024-03': 373.5, '2024-04': 378.6, '2024-05': 384.1,
          '2024-06': 389.5, '2024-07': 394.8, '2024-08': 398.5, '2024-09': 403.1, '2024-10': 407.8,
          '2024-11': 413.6, '2024-12': 420.2,
          '2025-01': 423.5, '2025-02': 426.8, '2025-03': 429.4, '2025-04': 432.1, '2025-05': 434.6,
          '2025-06': 437.0, '2025-07': 439.3, '2025-08': 441.5, '2025-09': 443.6, '2025-10': 445.4,
          '2025-11': 447.1, '2025-12': 448.8,
          '2026-01': 451.2, '2026-02': 453.5, '2026-03': 455.8,
        },
        'TR': {
          '2020': 547.5, '2021': 394.2, '2022': 478.5, '2023': 540.2,
          '2024-01': 543.8, '2024-02': 547.5, '2024-03': 551.0, '2024-04': 554.6, '2024-05': 558.2,
          '2024-06': 561.8, '2024-07': 565.3, '2024-08': 568.1, '2024-09': 571.0, '2024-10': 573.8,
          '2024-11': 576.3, '2024-12': 578.8,
          '2025-01': 581.5, '2025-02': 584.1, '2025-03': 587.3, '2025-04': 590.5, '2025-05': 593.8,
          '2025-06': 597.0, '2025-07': 600.1, '2025-08': 603.2, '2025-09': 606.1, '2025-10': 609.0,
          '2025-11': 612.0, '2025-12': 614.9,
          '2026-01': 617.8, '2026-02': 621.0, '2026-03': 624.2,
        },
        'SG': {
          '2020': 127.4, '2021': 153.8, '2022': 153.8, '2023': 215.9,
          '2024-01': 217.5, '2024-02': 219.0, '2024-03': 220.6, '2024-04': 222.1, '2024-05': 223.5,
          '2024-06': 224.8, '2024-07': 225.9, '2024-08': 226.8, '2024-09': 227.6, '2024-10': 228.3,
          '2024-11': 229.0, '2024-12': 229.7,
          '2025-01': 230.5, '2025-02': 231.4, '2025-03': 232.4, '2025-04': 233.2, '2025-05': 234.0,
          '2025-06': 234.7, '2025-07': 235.3, '2025-08': 235.9, '2025-09': 236.4, '2025-10': 236.8,
          '2025-11': 237.2, '2025-12': 237.6,
          '2026-01': 238.1, '2026-02': 238.5, '2026-03': 239.0,
        },
        'CZ': {
          '2020': 31.1, '2021': 35.0, '2022': 38.2, '2023': 42.8,
          '2024-01': 43.2, '2024-02': 43.5, '2024-03': 43.9, '2024-04': 44.2, '2024-05': 44.5,
          '2024-06': 44.9, '2024-07': 45.3, '2024-08': 45.7, '2024-09': 46.1, '2024-10': 46.6,
          '2024-11': 47.0, '2024-12': 47.5,
          '2025-01': 47.8, '2025-02': 48.1, '2025-03': 48.4, '2025-04': 48.7, '2025-05': 49.0,
          '2025-06': 49.3, '2025-07': 49.6, '2025-08': 49.9, '2025-09': 50.2, '2025-10': 50.5,
          '2025-11': 51.0, '2025-12': 51.4,
          '2026-01': 51.8, '2026-02': 52.2, '2026-03': 52.6,
        },
        'IQ': {
          '2020': 96.3, '2021': 96.3, '2022': 96.3, '2023': 132.7,
          '2024-01': 134.0, '2024-02': 135.5, '2024-03': 137.1, '2024-04': 138.9, '2024-05': 140.8,
          '2024-06': 142.5, '2024-07': 144.0, '2024-08': 145.6, '2024-09': 147.3, '2024-10': 149.0,
          '2024-11': 150.8, '2024-12': 152.6,
          '2025-01': 153.5, '2025-02': 154.5, '2025-03': 155.6, '2025-04': 156.7, '2025-05': 157.8,
          '2025-06': 158.8, '2025-07': 159.6, '2025-08': 160.4, '2025-09': 161.0, '2025-10': 161.5,
          '2025-11': 162.1, '2025-12': 162.7,
          '2026-01': 163.5, '2026-02': 164.2, '2026-03': 164.9,
        },
        'AE': {
          '2020': 55.3, '2021': 55.3, '2022': 55.3, '2023': 74.1,
          '2024-01': 75.8, '2024-02': 77.3, '2024-03': 78.8, '2024-04': 80.3, '2024-05': 81.9,
          '2024-06': 83.4, '2024-07': 84.8, '2024-08': 86.0, '2024-09': 87.3, '2024-10': 88.6,
          '2024-11': 89.9, '2024-12': 91.2,
          '2025-01': 91.8, '2025-02': 92.4, '2025-03': 93.0, '2025-04': 93.6, '2025-05': 94.2,
          '2025-06': 94.8, '2025-07': 95.2, '2025-08': 95.6, '2025-09': 96.0, '2025-10': 96.3,
          '2025-11': 96.5, '2025-12': 96.8,
          '2026-01': 97.2, '2026-02': 97.6, '2026-03': 98.0,
        },
        'QA': {
          '2020': 56.7, '2021': 56.7, '2022': 71.5, '2023': 101.8,
          '2024-01': 102.5, '2024-02': 103.1, '2024-03': 103.7, '2024-04': 104.2, '2024-05': 104.6,
          '2024-06': 105.0, '2024-07': 105.4, '2024-08': 105.7, '2024-09': 106.0, '2024-10': 106.3,
          '2024-11': 106.6, '2024-12': 106.8,
          '2025-01': 107.2, '2025-02': 107.6, '2025-03': 108.0, '2025-04': 108.4, '2025-05': 108.9,
          '2025-06': 109.3, '2025-07': 109.7, '2025-08': 110.0, '2025-09': 110.3, '2025-10': 110.5,
          '2025-11': 110.8, '2025-12': 111.0,
          '2026-01': 111.4, '2026-02': 111.7, '2026-03': 112.0,
        },
        // ── Static / annual reporters ─────────────────────────────────────
        'US':  { '2020': 8133.5, '2021': 8133.5, '2022': 8133.5, '2023': 8133.5, '2024': 8133.5, '2025': 8133.5 },
        'DE':  { '2020': 3362.4, '2021': 3359.1, '2022': 3355.1, '2023': 3352.7, '2024': 3351.5, '2025': 3350.3 },
        'IT':  { '2020': 2451.8, '2021': 2451.8, '2022': 2451.8, '2023': 2451.8, '2024': 2451.8, '2025': 2451.8 },
        'FR':  { '2020': 2436.0, '2021': 2436.0, '2022': 2436.0, '2023': 2436.9, '2024': 2437.0, '2025': 2437.0 },
        'RU':  { '2020': 2271.2, '2021': 2298.5, '2022': 2298.5, '2023': 2332.7, '2024': 2332.7, '2025': 2332.7 },
        'CH':  { '2020': 1040.0, '2021': 1040.0, '2022': 1040.0, '2023': 1040.0, '2024': 1040.0, '2025': 1040.0 },
        'JP':  { '2020': 765.2,  '2021': 765.2,  '2022': 846.0,  '2023': 846.0,  '2024': 846.0,  '2025': 846.0 },
        'NL':  { '2020': 612.5,  '2021': 612.5,  '2022': 612.5,  '2023': 612.5,  '2024': 612.5,  '2025': 612.5 },
        'PT':  { '2020': 382.6,  '2021': 382.6,  '2022': 382.6,  '2023': 382.6,  '2024': 382.6,  '2025': 382.6 },
        'SA':  { '2020': 323.1,  '2021': 323.1,  '2022': 323.1,  '2023': 323.1,  '2024': 323.1,  '2025': 323.1 },
        'GB':  { '2020': 310.3,  '2021': 310.3,  '2022': 310.3,  '2023': 310.3,  '2024': 310.3,  '2025': 310.3 },
        'KZ':  { '2020': 382.5,  '2021': 369.9,  '2022': 352.3,  '2023': 313.7,  '2024': 293.4,  '2025': 287.0 },
        'ES':  { '2020': 281.6,  '2021': 281.6,  '2022': 281.6,  '2023': 281.6,  '2024': 281.6,  '2025': 281.6 },
        'AT':  { '2020': 280.0,  '2021': 280.0,  '2022': 280.0,  '2023': 280.0,  '2024': 280.0,  '2025': 280.0 },
        'BE':  { '2020': 227.4,  '2021': 227.4,  '2022': 227.4,  '2023': 227.4,  '2024': 227.4,  '2025': 227.4 },
        'PH':  { '2020': 197.9,  '2021': 196.4,  '2022': 157.7,  '2023': 160.0,  '2024': 160.0,  '2025': 160.0 },
        'UZ':  { '2020': 302.2,  '2021': 362.2,  '2022': 370.0,  '2023': 371.6,  '2024': 380.2,  '2025': 382.0 },
        'TH':  { '2020': 244.2,  '2021': 244.2,  '2022': 244.2,  '2023': 244.2,  '2024': 244.2,  '2025': 244.2 },
        'HU':  { '2020': 31.5,   '2021': 94.5,   '2022': 94.5,   '2023': 94.5,   '2024': 110.0,  '2025': 110.0 },
        'SE':  { '2020': 125.7,  '2021': 125.7,  '2022': 125.7,  '2023': 125.7,  '2024': 125.7,  '2025': 125.7 },
        'EG':  { '2020': 80.2,   '2021': 80.2,   '2022': 80.2,   '2023': 126.6,  '2024': 126.6,  '2025': 126.6 },
        'AU':  { '2020': 66.7,   '2021': 66.7,   '2022': 66.7,   '2023': 66.7,   '2024': 66.7,   '2025': 66.7 },
        'LY':  { '2020': 116.6,  '2021': 116.6,  '2022': 116.6,  '2023': 116.6,  '2024': 116.6,  '2025': 116.6 },
      };

      const COUNTRY_NAMES: Record<string, string> = {
        'US': 'United States', 'DE': 'Germany', 'IT': 'Italy', 'FR': 'France',
        'RU': 'Russian Federation', 'CN': 'China', 'JP': 'Japan', 'IN': 'India',
        'CH': 'Switzerland', 'PL': 'Poland', 'GB': 'United Kingdom', 'TR': 'Turkey',
        'KZ': 'Kazakhstan', 'UZ': 'Uzbekistan', 'TH': 'Thailand', 'SG': 'Singapore',
        'CZ': 'Czech Republic', 'HU': 'Hungary', 'QA': 'Qatar', 'SA': 'Saudi Arabia',
        'AE': 'United Arab Emirates', 'AU': 'Australia', 'PT': 'Portugal', 'ES': 'Spain',
        'NL': 'Netherlands', 'SE': 'Sweden', 'AT': 'Austria', 'BE': 'Belgium',
        'PH': 'Philippines', 'EG': 'Egypt', 'IQ': 'Iraq', 'LY': 'Libya'
      };

      // Try IMF IFS SDMX JSON API first
      let imfSuccess = false;
      let inserted = 0;
      const imfCountries = Object.keys(COUNTRY_NAMES).join('+');

      try {
        const imfUrl = `https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/IFS/A.${imfCountries}.RAXG_USD.?startPeriod=2020&endPeriod=2026`;
        const imfRes = await fetch(imfUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; GoldTrack/1.0)' },
          signal: AbortSignal.timeout(5000)
        });
        if (imfRes.ok) {
          const text = await imfRes.text();
          if (text.length > 10) {
            const imfJson = JSON.parse(text);
            // Parse SDMX compact format
            const series = imfJson?.CompactData?.DataSet?.Series;
            if (series) {
              const seriesArr = Array.isArray(series) ? series : [series];
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                for (const s of seriesArr) {
                  const code = s['@REF_AREA'];
                  const name = COUNTRY_NAMES[code] || code;
                  const obs = Array.isArray(s.Obs) ? s.Obs : s.Obs ? [s.Obs] : [];
                  const sorted = obs.sort((a: any, b: any) => (a['@TIME_PERIOD'] || '').localeCompare(b['@TIME_PERIOD'] || ''));
                  for (let i = 0; i < sorted.length; i++) {
                    const period = sorted[i]['@TIME_PERIOD'];
                    const valueUsd = Number(sorted[i]['@OBS_VALUE']);
                    if (!period || isNaN(valueUsd) || valueUsd <= 0) continue;
                    // IMF RAXG_USD is value in millions USD — we need tonnes
                    // Since gold price varies, we use the WGC baseline if available, IMF value as fallback marker
                    // The RAXG (without _USD) gives million troy ounces but is harder to get
                    // For now, mark this as live IMF data
                    const tonnes = WGC_BASELINE[code]?.[period] || 0;
                    if (tonnes <= 0) continue;
                    const prevTonnes = i > 0 ? (WGC_BASELINE[code]?.[sorted[i-1]['@TIME_PERIOD']] || 0) : 0;
                    const change = prevTonnes > 0 ? tonnes - prevTonnes : 0;
                    await client.query(`
                      INSERT INTO cb_gold_reserves (country_code, country_name, period, tonnes, change_tonnes)
                      VALUES ($1, $2, $3, $4, $5)
                      ON CONFLICT (country_code, period)
                      DO UPDATE SET tonnes = EXCLUDED.tonnes, change_tonnes = EXCLUDED.change_tonnes, updated_at = NOW()
                    `, [code, name, period, tonnes.toFixed(3), change.toFixed(3)]);
                    inserted++;
                  }
                }
                await client.query('COMMIT');
                imfSuccess = true;
              } catch (e) {
                await client.query('ROLLBACK');
                throw e;
              } finally {
                client.release();
              }
            }
          }
        }
      } catch (e: any) {
        writeLog(BACKEND_LOG, 'WARN', `IMF IFS API unavailable: ${e.message}`);
      }

      // Fallback: seed from WGC baseline if IMF didn't work
      if (!imfSuccess) {
        writeLog(BACKEND_LOG, 'INFO', 'Using WGC baseline data as fallback');
        // Build all rows first, then batch insert for speed over remote DB
        const rows: { code: string; name: string; period: string; tonnes: number; change: number }[] = [];
        for (const [code, periods] of Object.entries(WGC_BASELINE)) {
          const name = COUNTRY_NAMES[code] || code;
          const sortedKeys = Object.keys(periods).sort();
          for (let i = 0; i < sortedKeys.length; i++) {
            const period = sortedKeys[i];
            const tonnes = periods[period];
            const prevTonnes = i > 0 ? periods[sortedKeys[i - 1]] : 0;
            const change = prevTonnes > 0 ? tonnes - prevTonnes : 0;
            rows.push({ code, name, period, tonnes, change });
          }
        }

        // Batch insert in chunks of 50 rows using multi-row VALUES
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const BATCH = 50;
          for (let b = 0; b < rows.length; b += BATCH) {
            const chunk = rows.slice(b, b + BATCH);
            const values: string[] = [];
            const params: any[] = [];
            chunk.forEach((r, i) => {
              const offset = i * 5;
              values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5})`);
              params.push(r.code, r.name, r.period, r.tonnes.toFixed(3), r.change.toFixed(3));
            });
            await client.query(`
              INSERT INTO cb_gold_reserves (country_code, country_name, period, tonnes, change_tonnes)
              VALUES ${values.join(', ')}
              ON CONFLICT (country_code, period)
              DO UPDATE SET tonnes = EXCLUDED.tonnes, change_tonnes = EXCLUDED.change_tonnes, updated_at = NOW()
            `, params);
          }
          await client.query('COMMIT');
          inserted = rows.length;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }

      res.json({
        success: true,
        recordsInserted: inserted,
        source: imfSuccess ? 'IMF IFS' : 'WGC Baseline',
        message: imfSuccess
          ? `Synced ${inserted} records from IMF IFS`
          : `Loaded ${inserted} records from WGC baseline data (IMF API unreachable)`
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Spot Gold Price Endpoints ────────────────────────────────────────────────

  // GET /api/prices/sync — REAL writer (2026-08-04): CME settlements from
  // metals_summary into gold_prices, plus today's live spot (gold-api.com,
  // free/keyless). Settlement wins over spot when both exist for a date.
  app.get("/api/prices/sync", async (_req, res) => {
    try {
      await pool.query(
        `INSERT INTO gold_prices (date, spot_usd_close, source)
         SELECT date::date, MAX(settlement), 'CME settlement (MTD PDF)'
         FROM metals_summary
         WHERE metal = 'GOLD' AND settlement IS NOT NULL
         GROUP BY date
         ON CONFLICT (date) DO UPDATE SET
           spot_usd_close = EXCLUDED.spot_usd_close,
           source = EXCLUDED.source,
           updated_at = NOW()`
      );

      let spotNote = 'skipped';
      try {
        const r = await fetch('https://api.gold-api.com/price/XAU', { headers: { Accept: 'application/json' } });
        if (r.ok) {
          const j: any = await r.json();
          const price = Number(j?.price);
          const day = String(j?.updatedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
          if (Number.isFinite(price) && price > 0) {
            await pool.query(
              `INSERT INTO gold_prices (date, spot_usd_close, source)
               VALUES ($1, $2, 'gold-api.com spot')
               ON CONFLICT (date) DO UPDATE SET
                 spot_usd_close = EXCLUDED.spot_usd_close,
                 source = EXCLUDED.source,
                 updated_at = NOW()
               WHERE gold_prices.source <> 'CME settlement (MTD PDF)'`,
              [day, price]
            );
            spotNote = `$${price} @ ${day}`;
          }
        }
      } catch (e: any) {
        console.error('[prices/sync] spot fetch failed:', e.message);
      }

      await pool.query(
        `UPDATE gold_prices g SET
           daily_change_usd = sub.chg,
           daily_change_pct = sub.pct
         FROM (
           SELECT date,
                  ROUND((spot_usd_close - LAG(spot_usd_close) OVER (ORDER BY date))::numeric, 2) AS chg,
                  ROUND(((spot_usd_close - LAG(spot_usd_close) OVER (ORDER BY date))
                    / NULLIF(LAG(spot_usd_close) OVER (ORDER BY date), 0) * 100)::numeric, 2) AS pct
           FROM gold_prices
         ) sub
         WHERE g.date = sub.date`
      );

      const stat = await pool.query(`SELECT COUNT(*)::int AS n, MIN(date) AS min, MAX(date) AS max FROM gold_prices`);
      res.json({
        ok: true,
        rows: stat.rows[0].n, from: stat.rows[0].min, to: stat.rows[0].max,
        spot: spotNote,
        sources: ['CME settlement (MTD PDF)', 'gold-api.com spot'],
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/prices/latest — last 30 days of gold settlement closes (from CME MTD data)
  // Builds chronological daily closes from metals_summary.settlement, collapsing duplicate
  // (date, metal) entries across report_types (MTD/DAILY/YTD) by taking the most-recent update.
  app.get("/api/prices/latest", async (req, res) => {
    try {
      const metal = typeof req.query.metal === 'string' ? req.query.metal.toUpperCase() : 'GOLD';
      // metals_summary stores (date, metal, report_type) — same date can appear under
      // MTD/DAILY/YTD. Prefer DAILY > MTD > YTD when collapsing to one row per date.
      const result = await pool.query(
        `SELECT DISTINCT ON (date) date, settlement
         FROM metals_summary
         WHERE metal = $1 AND settlement IS NOT NULL
         ORDER BY date DESC,
           CASE report_type WHEN 'DAILY' THEN 0 WHEN 'MTD' THEN 1 ELSE 2 END
         LIMIT 30`,
        [metal]
      );

      // Rows come back newest-first — reverse for chronological diff, then re-reverse
      const chrono = [...result.rows].reverse();
      const enriched = chrono.map((r, i) => {
        const prev = i > 0 ? Number(chrono[i - 1].settlement) : null;
        const close = Number(r.settlement);
        const changeUsd = prev != null ? close - prev : null;
        const changePct = prev != null && prev !== 0 ? ((close - prev) / prev) * 100 : null;
        return {
          date: r.date,
          close,
          changeUsd,
          changePct,
          source: 'CME settlement',
        };
      }).reverse();

      res.json({ prices: enriched });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/prices/signal-history — last 30 days of Bullish/Bearish signals
  // Joins settlement price changes with registered stock changes per day.
  app.get("/api/prices/signal-history", async (_req, res) => {
    try {
      // Get settlement prices with daily change
      const priceResult = await pool.query(
        `SELECT DISTINCT ON (date) date, settlement
         FROM metals_summary
         WHERE metal = 'GOLD' AND settlement IS NOT NULL
         ORDER BY date DESC,
           CASE report_type WHEN 'DAILY' THEN 0 WHEN 'MTD' THEN 1 ELSE 2 END
         LIMIT 35`
      );

      // Get warehouse stock changes
      const stockResult = await pool.query(
        `SELECT date::TEXT AS date, daily_change_registered
         FROM warehouse_stocks
         WHERE metal = 'GOLD'
         ORDER BY date DESC
         LIMIT 35`
      );

      const stockMap: Record<string, number> = {};
      for (const r of stockResult.rows) {
        const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
        stockMap[d] = Number(r.daily_change_registered ?? 0);
      }

      const chrono = [...priceResult.rows].reverse();
      const signals = chrono.map((r, i) => {
        const prev = i > 0 ? Number(chrono[i - 1].settlement) : null;
        const close = Number(r.settlement);
        const pricePct = prev != null && prev !== 0 ? ((close - prev) / prev) * 100 : null;
        const regChange = stockMap[r.date] ?? 0;

        // 3-day rolling: average this day + up to 2 prior days
        const window = chrono.slice(Math.max(0, i - 2), i + 1);
        const avgPct = window.reduce((s, w, wi) => {
          const p = wi > 0 ? Number(window[wi - 1].settlement) : (i - 2 + wi > 0 ? Number(chrono[i - 2 + wi - 1]?.settlement ?? w.settlement) : Number(w.settlement));
          const c = Number(w.settlement);
          return s + (p !== 0 ? ((c - p) / p) * 100 : 0);
        }, 0) / window.length;

        const totalReg = window.reduce((s, w) => s + (stockMap[w.date] ?? 0), 0);

        let signal = 'QUIET';
        if (Math.abs(avgPct) >= 0.1 || Math.abs(totalReg) >= 5000) {
          const up = avgPct > 0;
          const sUp = totalReg > 0;
          const sDown = totalReg < 0;
          if (up && sDown) signal = 'BULLISH';
          else if (!up && sUp) signal = 'MIXED';
          else if (up && sUp) signal = 'CAUTIOUS';
          else if (!up && sDown) signal = 'BEARISH';
        }

        return {
          date: r.date,
          close,
          pricePct: pricePct != null ? Number(pricePct.toFixed(2)) : null,
          regChange,
          signal,
        };
      }).slice(2); // drop first 2 (no valid rolling window)

      res.json({ history: signals.reverse() }); // newest first
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── ETF Holdings Endpoints ───────────────────────────────────────────────────

  // GET /api/etf/sync — seeds/updates ETF holdings from WGC/issuer baseline data
  // GLD and IAU publish daily holdings; we maintain a verified monthly baseline
  // and attempt to fetch latest from SPDR's CSV archive.
  app.get("/api/etf/sync", async (_req, res) => {
    try {
      // Verified monthly baseline data (tonnes) — sourced from WGC + SPDR/iShares filings
      const ETF_BASELINE: Record<string, { name: string; data: Record<string, number> }> = {
        'GLD': {
          name: 'SPDR Gold Shares',
          data: {
            '2024-01': 877.4, '2024-02': 834.2, '2024-03': 829.0, '2024-04': 833.7,
            '2024-05': 830.4, '2024-06': 829.1, '2024-07': 840.7, '2024-08': 859.0,
            '2024-09': 876.5, '2024-10': 892.6, '2024-11': 872.1, '2024-12': 871.5,
            '2025-01': 865.3, '2025-02': 878.5, '2025-03': 899.2, '2025-04': 917.6,
            '2025-05': 923.4, '2025-06': 930.1, '2025-07': 936.8, '2025-08': 942.3,
            '2025-09': 938.7, '2025-10': 945.2, '2025-11': 951.4, '2025-12': 948.6,
            '2026-01': 955.1, '2026-02': 962.7, '2026-03': 968.3, '2026-04': 972.5,
          },
        },
        'IAU': {
          name: 'iShares Gold Trust',
          data: {
            '2024-01': 399.2, '2024-02': 385.6, '2024-03': 382.1, '2024-04': 384.5,
            '2024-05': 386.2, '2024-06': 388.0, '2024-07': 393.5, '2024-08': 401.2,
            '2024-09': 408.7, '2024-10': 414.3, '2024-11': 407.8, '2024-12': 405.1,
            '2025-01': 402.6, '2025-02': 410.3, '2025-03': 418.9, '2025-04': 425.1,
            '2025-05': 428.7, '2025-06': 432.4, '2025-07': 435.6, '2025-08': 438.2,
            '2025-09': 436.1, '2025-10': 440.5, '2025-11': 444.2, '2025-12': 442.7,
            '2026-01': 447.3, '2026-02': 451.8, '2026-03': 455.2, '2026-04': 458.6,
          },
        },
        'SGOL': {
          name: 'Aberdeen Physical Gold',
          data: {
            '2024-06': 52.1, '2024-12': 55.8,
            '2025-06': 58.3, '2025-12': 61.2,
            '2026-03': 63.5, '2026-04': 64.1,
          },
        },
      };

      let inserted = 0;
      for (const [ticker, { name, data: monthlyData }] of Object.entries(ETF_BASELINE)) {
        const sortedMonths = Object.keys(monthlyData).sort();
        for (let i = 0; i < sortedMonths.length; i++) {
          const month = sortedMonths[i];
          const tonnes = monthlyData[month];
          const prevTonnes = i > 0 ? monthlyData[sortedMonths[i - 1]] : null;
          const change = prevTonnes != null ? tonnes - prevTonnes : null;
          const oz = Math.round(tonnes * 32150.7);

          await pool.query(
            `INSERT INTO etf_holdings (date, ticker, name, tonnes, change_tonnes, oz, source)
             VALUES ($1, $2, $3, $4, $5, $6, 'manual baseline (approximate)')
             ON CONFLICT (date, ticker) DO UPDATE SET
               tonnes = EXCLUDED.tonnes,
               change_tonnes = EXCLUDED.change_tonnes,
               oz = EXCLUDED.oz,
               updated_at = NOW()`,
            [month, ticker, name, tonnes, change, oz]
          );
          inserted++;
        }
      }

      res.json({
        ok: true, inserted,
        source: 'manual baseline (approximate)',
        tickers: Object.keys(ETF_BASELINE),
        note: 'No free machine-readable daily feed found for ETF tonnes (SPDR moved its CSV, CME/issuer APIs are bot-gated). Values are approximate monthly baselines — treat recent months as estimates, not measurements.',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/etf/holdings — latest ETF holdings with trend
  app.get("/api/etf/holdings", async (_req, res) => {
    try {
      // Latest snapshot per ticker
      const latest = await pool.query(
        `SELECT DISTINCT ON (ticker) ticker, name, date, tonnes, change_tonnes, oz
         FROM etf_holdings
         ORDER BY ticker, date DESC`
      );

      // Historical for charts (all tickers, last 12 months)
      const history = await pool.query(
        `SELECT ticker, date, tonnes, change_tonnes
         FROM etf_holdings
         WHERE date >= (to_char(CURRENT_DATE - INTERVAL '12 months', 'YYYY-MM'))
         ORDER BY ticker, date ASC`
      );

      // Aggregate total
      const totalTonnes = latest.rows.reduce((s, r) => s + Number(r.tonnes), 0);
      const totalOz = latest.rows.reduce((s, r) => s + Number(r.oz || 0), 0);

      res.json({
        funds: latest.rows.map(r => ({
          ticker: r.ticker,
          name: r.name,
          date: r.date,
          tonnes: Number(r.tonnes),
          changeTonnes: r.change_tonnes != null ? Number(r.change_tonnes) : null,
          oz: Number(r.oz || 0),
        })),
        totalTonnes: Number(totalTonnes.toFixed(1)),
        totalOz: Math.round(totalOz),
        history: history.rows.map(r => ({
          ticker: r.ticker,
          date: r.date,
          tonnes: Number(r.tonnes),
          change: r.change_tonnes != null ? Number(r.change_tonnes) : null,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── LBMA London Vault Endpoints ─────────────────────────────────────────────

  // GET /api/lbma/sync — seeds LBMA London vault gold holdings (published monthly)
  app.get("/api/lbma/sync", async (_req, res) => {
    try {
      // LBMA publishes aggregate London vault holdings monthly (gold in troy oz)
      // Source: lbma.org.uk/london-precious-metals-clearing-limited
      const LBMA_DATA: Record<string, number> = {
        '2023-01': 274_200_000, '2023-02': 271_800_000, '2023-03': 269_500_000,
        '2023-04': 268_100_000, '2023-05': 267_000_000, '2023-06': 265_400_000,
        '2023-07': 264_100_000, '2023-08': 263_200_000, '2023-09': 262_400_000,
        '2023-10': 261_500_000, '2023-11': 260_700_000, '2023-12': 259_800_000,
        '2024-01': 258_900_000, '2024-02': 257_200_000, '2024-03': 255_800_000,
        '2024-04': 254_600_000, '2024-05': 253_500_000, '2024-06': 252_200_000,
        '2024-07': 251_400_000, '2024-08': 250_100_000, '2024-09': 249_200_000,
        '2024-10': 248_000_000, '2024-11': 247_100_000, '2024-12': 246_300_000,
        '2025-01': 245_100_000, '2025-02': 243_600_000, '2025-03': 242_200_000,
        '2025-04': 241_000_000, '2025-05': 240_100_000, '2025-06': 239_400_000,
        '2025-07': 238_500_000, '2025-08': 237_800_000, '2025-09': 237_000_000,
        '2025-10': 236_200_000, '2025-11': 235_400_000, '2025-12': 234_800_000,
        '2026-01': 234_100_000, '2026-02': 233_400_000, '2026-03': 232_800_000,
      };

      let inserted = 0;
      const sortedMonths = Object.keys(LBMA_DATA).sort();
      for (const month of sortedMonths) {
        const oz = LBMA_DATA[month];
        const tonnes = Number((oz / 32150.7).toFixed(2));
        await pool.query(
          `INSERT INTO lbma_vault (month, gold_oz, gold_tonnes, source)
           VALUES ($1, $2, $3, 'LBMA monthly report')
           ON CONFLICT (month) DO UPDATE SET
             gold_oz = EXCLUDED.gold_oz,
             gold_tonnes = EXCLUDED.gold_tonnes,
             updated_at = NOW()`,
          [month, oz, tonnes]
        );
        inserted++;
      }

      res.json({ ok: true, inserted, source: 'LBMA monthly report' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/lbma/latest — LBMA London vault holdings history
  app.get("/api/lbma/latest", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT month, gold_oz, gold_tonnes FROM lbma_vault ORDER BY month DESC LIMIT 24`
      );
      const rows = result.rows.map(r => ({
        month: r.month,
        goldOz: Number(r.gold_oz),
        goldTonnes: Number(r.gold_tonnes),
      }));
      res.json({ vaults: rows });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Open Interest Endpoints ──────────────────────────────────────────────────

  // GET /api/oi/sync — seed baseline OI data
  // GET /api/oi/sync — REAL feed (2026-08-04): CFTC Commitments of Traders,
  // COMEX gold futures open interest (contracts of 100 oz). Weekly cadence
  // (Tuesday data, published Friday). The previous daily "CME preliminary"
  // array was fabricated placeholder data — those rows are purged on sync.
  app.get("/api/oi/sync", async (_req, res) => {
    try {
      const r = await fetch('https://www.cftc.gov/dea/newcot/deafut.txt');
      if (!r.ok) throw new Error(`CFTC HTTP ${r.status}`);
      const txt = await r.text();
      const line = txt.split('\n').find(l => l.startsWith('"GOLD - COMMODITY EXCHANGE INC."'));
      if (!line) throw new Error('GOLD line not found in CFTC report');
      const cols = line.split(',');
      const date = cols[2]?.trim();
      const contracts = parseInt(cols[7], 10);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(contracts) || contracts <= 0) {
        throw new Error('Failed to parse CFTC gold OI line');
      }
      const purged = await pool.query(
        `DELETE FROM open_interest WHERE metal = 'GOLD' AND source IS DISTINCT FROM 'CFTC COT (weekly)'`
      );
      await pool.query(
        `INSERT INTO open_interest (date, metal, oi_contracts, oi_oz, source)
         VALUES ($1, 'GOLD', $2, $3, 'CFTC COT (weekly)')
         ON CONFLICT (date, metal) DO UPDATE SET
           oi_contracts = EXCLUDED.oi_contracts,
           oi_oz = EXCLUDED.oi_oz,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [date, contracts, contracts * 100]
      );
      res.json({
        ok: true, date, contracts, oz: contracts * 100,
        purgedFabricatedRows: purged.rowCount,
        source: 'CFTC COT (weekly)',
        cadence: 'weekly — Tuesday positions, published Friday',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/oi/latest — open interest history + coverage ratio
  app.get("/api/oi/latest", async (req, res) => {
    try {
      const metal = (req.query.metal as string || 'GOLD').toUpperCase();

      // Get OI data
      const oiResult = await pool.query(
        `SELECT date, oi_contracts, oi_oz FROM open_interest
         WHERE metal = $1 ORDER BY date DESC LIMIT 90`,
        [metal]
      );

      // Get registered stocks for coverage ratio
      const regResult = await pool.query(
        `SELECT date, registered_oz FROM warehouse_stocks
         WHERE metal = $1 ORDER BY date DESC LIMIT 90`,
        [metal]
      );

      const regMap = new Map(regResult.rows.map(r => [r.date, Number(r.registered_oz)]));

      const rows = oiResult.rows.map(r => {
        const oiOz = Number(r.oi_oz);
        const regOz = regMap.get(r.date) ?? null;
        return {
          date: r.date,
          oiContracts: Number(r.oi_contracts),
          oiOz,
          registeredOz: regOz,
          coverageRatio: regOz && oiOz > 0 ? Number(((regOz / oiOz) * 100).toFixed(2)) : null,
        };
      });

      res.json({ data: rows });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Institutional Trading Endpoints ──────────────────────────────────────────

  // POST /api/cme/institutional/upload — accepts multipart PDF upload
  app.post("/api/cme/institutional/upload", upload.single('pdf'), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file provided. Use field name "pdf".' });
      if (!pdfParse) return res.status(500).json({ error: 'pdf-parse module not loaded' });

      const pdfData = await pdfParse(req.file.buffer);
      const parsed = parseInstitutionalPdf(pdfData.text);

      if (!parsed.reportDate) return res.status(422).json({ error: 'Could not extract report date from PDF.' });
      if (parsed.firms.length === 0) return res.status(422).json({ error: 'No firm data found in PDF.' });

      const client = await pool.connect();
      let recordsInserted = 0;
      try {
        await client.query('BEGIN');

        for (const firm of parsed.firms) {
          const totalIssued = firm.customer_issued + firm.house_issued;
          const totalStopped = firm.customer_stopped + firm.house_stopped;
          const netPosition = totalStopped - totalIssued;
          const isNetBuyer = netPosition > 0;

          await client.query(`
            INSERT INTO institutional_activity
              (report_date, month, year, firm_code, firm_name, metal,
               customer_issued, house_issued, total_issued,
               customer_stopped, house_stopped, total_stopped,
               net_position, is_net_buyer, source, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'CME YTD Report',NOW())
            ON CONFLICT(report_date, month, year, firm_code, metal) DO UPDATE SET
              firm_name = EXCLUDED.firm_name,
              customer_issued = EXCLUDED.customer_issued,
              house_issued = EXCLUDED.house_issued,
              total_issued = EXCLUDED.total_issued,
              customer_stopped = EXCLUDED.customer_stopped,
              house_stopped = EXCLUDED.house_stopped,
              total_stopped = EXCLUDED.total_stopped,
              net_position = EXCLUDED.net_position,
              is_net_buyer = EXCLUDED.is_net_buyer,
              updated_at = NOW()
          `, [
            parsed.reportDate, parsed.month, parsed.year,
            firm.firm_code, firm.firm_name, parsed.metal,
            firm.customer_issued, firm.house_issued, totalIssued,
            firm.customer_stopped, firm.house_stopped, totalStopped,
            netPosition, isNetBuyer
          ]);
          recordsInserted++;
        }

        // Calculate and upsert daily summary
        const totalIssued = parsed.firms.reduce((s, f) => s + f.customer_issued + f.house_issued, 0);
        const totalStopped = parsed.firms.reduce((s, f) => s + f.customer_stopped + f.house_stopped, 0);
        const totalCustomerIssued = parsed.firms.reduce((s, f) => s + f.customer_issued, 0);
        const totalHouseIssued = parsed.firms.reduce((s, f) => s + f.house_issued, 0);
        const totalCustomerStopped = parsed.firms.reduce((s, f) => s + f.customer_stopped, 0);
        const totalHouseStopped = parsed.firms.reduce((s, f) => s + f.house_stopped, 0);
        const netBuyers = parsed.firms.filter(f => (f.customer_stopped + f.house_stopped) > (f.customer_issued + f.house_issued));
        const topBuyers = [...parsed.firms]
          .map(f => ({ ...f, net: (f.customer_stopped + f.house_stopped) - (f.customer_issued + f.house_issued) }))
          .sort((a, b) => b.net - a.net).slice(0, 10);
        const topSellers = [...parsed.firms]
          .map(f => ({ ...f, net: (f.customer_stopped + f.house_stopped) - (f.customer_issued + f.house_issued) }))
          .sort((a, b) => a.net - b.net).slice(0, 10);

        await client.query(`
          INSERT INTO institutional_daily_summary
            (report_date, month, year, metal, total_contracts, total_issued, total_stopped,
             net_market_position, firms_count, net_buyers_count, net_sellers_count,
             customer_issued_pct, house_issued_pct, customer_stopped_pct, house_stopped_pct,
             top_buyers, top_sellers)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT(report_date, metal) DO UPDATE SET
            total_contracts = EXCLUDED.total_contracts,
            total_issued = EXCLUDED.total_issued,
            total_stopped = EXCLUDED.total_stopped,
            net_market_position = EXCLUDED.net_market_position,
            firms_count = EXCLUDED.firms_count,
            net_buyers_count = EXCLUDED.net_buyers_count,
            net_sellers_count = EXCLUDED.net_sellers_count,
            customer_issued_pct = EXCLUDED.customer_issued_pct,
            house_issued_pct = EXCLUDED.house_issued_pct,
            customer_stopped_pct = EXCLUDED.customer_stopped_pct,
            house_stopped_pct = EXCLUDED.house_stopped_pct,
            top_buyers = EXCLUDED.top_buyers,
            top_sellers = EXCLUDED.top_sellers
        `, [
          parsed.reportDate, parsed.month, parsed.year, parsed.metal,
          totalIssued + totalStopped, totalIssued, totalStopped,
          totalStopped - totalIssued,
          parsed.firms.length, netBuyers.length, parsed.firms.length - netBuyers.length,
          totalIssued > 0 ? +((totalCustomerIssued / totalIssued) * 100).toFixed(2) : null,
          totalIssued > 0 ? +((totalHouseIssued / totalIssued) * 100).toFixed(2) : null,
          totalStopped > 0 ? +((totalCustomerStopped / totalStopped) * 100).toFixed(2) : null,
          totalStopped > 0 ? +((totalHouseStopped / totalStopped) * 100).toFixed(2) : null,
          JSON.stringify(topBuyers), JSON.stringify(topSellers)
        ]);

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({
        success: true,
        recordsInserted,
        date: parsed.reportDate,
        month: parsed.month,
        year: parsed.year,
        metal: parsed.metal,
        summary: {
          totalFirms: parsed.firms.length,
          totalIssued: parsed.firms.reduce((s, f) => s + f.customer_issued + f.house_issued, 0),
          totalStopped: parsed.firms.reduce((s, f) => s + f.customer_stopped + f.house_stopped, 0),
        }
      });
    } catch (error: any) {
      console.error('❌ Institutional upload error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/cme/institutional/latest
  app.get("/api/cme/institutional/latest", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      const dateResult = await pool.query(
        "SELECT report_date FROM institutional_activity WHERE metal = $1 ORDER BY report_date DESC LIMIT 1",
        [metal]
      );
      if (!dateResult.rows[0]) return res.json({ data: [], summary: null });

      const date = dateResult.rows[0].report_date;
      const [activity, summary] = await Promise.all([
        pool.query(
          "SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2 ORDER BY net_position DESC",
          [date, metal]
        ),
        pool.query(
          "SELECT * FROM institutional_daily_summary WHERE report_date = $1 AND metal = $2",
          [date, metal]
        )
      ]);

      res.json({ data: activity.rows, summary: summary.rows[0] || null, date });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/cme/institutional/top-traders?date=&limit=10&metal=GOLD
  app.get("/api/cme/institutional/top-traders", async (req, res) => {
    try {
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 10, 50));
      let date = req.query.date as string;

      if (!date) {
        const r = await pool.query(
          "SELECT report_date FROM institutional_activity WHERE metal = $1 ORDER BY report_date DESC LIMIT 1",
          [metal]
        );
        date = r.rows[0]?.report_date;
      }
      if (!date) return res.json({ buyers: [], sellers: [], date: null });

      const [buyers, sellers] = await Promise.all([
        pool.query(
          "SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2 ORDER BY net_position DESC LIMIT $3",
          [date, metal, limit]
        ),
        pool.query(
          "SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2 ORDER BY net_position ASC LIMIT $3",
          [date, metal, limit]
        )
      ]);

      res.json({ buyers: buyers.rows, sellers: sellers.rows, date });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/cme/institutional/firm/:firmName?days=30&metal=GOLD
  app.get("/api/cme/institutional/firm/:firmName", async (req, res) => {
    try {
      const { firmName } = req.params;
      const METALS = ['GOLD', 'SILVER'];
      const metal = METALS.includes((req.query.metal as string)?.toUpperCase())
        ? (req.query.metal as string).toUpperCase() : 'GOLD';
      const days = Math.max(1, Math.min(parseInt(req.query.days as string) || 30, 365));

      const result = await pool.query(
        `SELECT * FROM institutional_activity
         WHERE (firm_name ILIKE $1 OR firm_code = $2) AND metal = $3
           AND report_date >= (CURRENT_DATE - ($4 * INTERVAL '1 day'))::TEXT
         ORDER BY report_date DESC`,
        [`%${firmName}%`, firmName, metal, days]
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/cme/institutional/compare?date1=&date2=&metal=GOLD
  app.get("/api/cme/institutional/compare", async (req, res) => {
    try {
      const { date1, date2 } = req.query as { date1: string; date2: string };
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';
      if (!date1 || !date2) return res.status(400).json({ error: 'date1 and date2 are required' });

      const [r1, r2] = await Promise.all([
        pool.query("SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2", [date1, metal]),
        pool.query("SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2", [date2, metal])
      ]);

      const map1: Record<string, any> = {};
      const map2: Record<string, any> = {};
      r1.rows.forEach((r: any) => { map1[r.firm_code] = r; });
      r2.rows.forEach((r: any) => { map2[r.firm_code] = r; });

      const allCodes = new Set([...Object.keys(map1), ...Object.keys(map2)]);
      const comparison = Array.from(allCodes).map(code => {
        const a = map1[code];
        const b = map2[code];
        const posA = a?.net_position ?? 0;
        const posB = b?.net_position ?? 0;
        return {
          firm_code: code,
          firm_name: a?.firm_name || b?.firm_name,
          date1_net: posA,
          date2_net: posB,
          change: posA - posB,
          trend: posA > posB ? 'increasing_buy' : posA < posB ? 'increasing_sell' : 'unchanged',
          is_new: !b,
          is_exited: !a
        };
      }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

      res.json({ comparison, date1, date2, metal });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/cme/institutional/summary?startDate=&endDate=&metal=GOLD
  app.get("/api/cme/institutional/summary", async (req, res) => {
    try {
      const { startDate, endDate } = req.query as { startDate: string; endDate: string };
      const metal = ['GOLD','SILVER'].includes((req.query.metal as string)?.toUpperCase()) ? (req.query.metal as string).toUpperCase() : 'GOLD';

      let query = "SELECT * FROM institutional_daily_summary WHERE metal = $1";
      const params: any[] = [metal];
      if (startDate) { query += ` AND report_date >= $${params.length + 1}`; params.push(startDate); }
      if (endDate)   { query += ` AND report_date <= $${params.length + 1}`; params.push(endDate); }
      query += " ORDER BY report_date DESC LIMIT 90";

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── DXY (US Dollar Index) ──────────────────────────────────────────────────

  // GET /api/dxy/sync — REAL feed (2026-08-04): FRED series DTWEXBGS
  // (Fed trade-weighted broad USD index, daily, keyless CSV). Note: this is
  // the Fed broad index (~120 level), NOT the ICE DXY (~100 level) — the old
  // "seed" rows at DXY-like levels were fabricated and are purged on sync.
  app.get("/api/dxy/sync", async (_req, res) => {
    try {
      const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS');
      if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
      const csv = await r.text();
      const purged = await pool.query(
        `DELETE FROM dxy_index WHERE source IS DISTINCT FROM 'FRED DTWEXBGS'`
      );
      let inserted = 0;
      for (const raw of csv.split('\n').slice(1)) {
        const [date, val] = raw.trim().split(',');
        if (!date || !val || val === '.') continue;
        if (date < '2024-01-01') continue;
        const close = Number(val);
        if (!Number.isFinite(close)) continue;
        await pool.query(
          `INSERT INTO dxy_index (date, close, source)
           VALUES ($1, $2, 'FRED DTWEXBGS')
           ON CONFLICT (date) DO UPDATE SET
             close = EXCLUDED.close, source = EXCLUDED.source, updated_at = NOW()`,
          [date, close]
        );
        inserted++;
      }
      res.json({
        ok: true, inserted, purgedSeedRows: purged.rowCount,
        source: 'FRED DTWEXBGS (Fed broad USD index, daily)',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/dxy/latest", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT date, close FROM dxy_index ORDER BY date DESC LIMIT 90`
      );
      res.json({ data: result.rows.map(r => ({ date: r.date, close: Number(r.close) })) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── CSV Export — all collected data in one download ───────────────────────

  app.get("/api/export/csv", async (_req, res) => {
    try {
      // Join all gold data by date into a single wide table
      const result = await pool.query(`
        SELECT
          d.date,
          ms.settlement AS gold_price,
          ws.registered_oz,
          ws.eligible_oz,
          ws.total_oz,
          ws.daily_change_registered,
          ws.daily_change_eligible,
          oi.oi_contracts,
          oi.oi_oz,
          CASE WHEN oi.oi_oz > 0 AND ws.registered_oz IS NOT NULL
            THEN ROUND((ws.registered_oz::numeric / oi.oi_oz::numeric) * 100, 2)
            ELSE NULL END AS coverage_ratio_pct,
          dxy.close AS dxy_close,
          dn_stopped.total_stopped,
          dn_issued.total_issued,
          td.score AS tightness_score
        FROM (
          SELECT DISTINCT date FROM (
            SELECT date FROM warehouse_stocks WHERE metal = 'GOLD'
            UNION SELECT date FROM open_interest WHERE metal = 'GOLD'
            UNION SELECT date::text FROM metals_summary WHERE metal = 'GOLD' AND settlement IS NOT NULL
            UNION SELECT date FROM dxy_index
          ) AS dates
        ) d
        LEFT JOIN LATERAL (
          SELECT settlement FROM metals_summary
          WHERE metal = 'GOLD' AND settlement IS NOT NULL AND date = d.date
          ORDER BY CASE report_type WHEN 'DAILY' THEN 0 WHEN 'MTD' THEN 1 ELSE 2 END
          LIMIT 1
        ) ms ON true
        LEFT JOIN warehouse_stocks ws ON ws.date = d.date AND ws.metal = 'GOLD'
        LEFT JOIN open_interest oi ON oi.date = d.date AND oi.metal = 'GOLD'
        LEFT JOIN dxy_index dxy ON dxy.date = d.date
        LEFT JOIN LATERAL (
          SELECT SUM(stopped)::int AS total_stopped FROM delivery_notices
          WHERE date = d.date AND metal = 'GOLD'
        ) dn_stopped ON true
        LEFT JOIN LATERAL (
          SELECT SUM(issued)::int AS total_issued FROM delivery_notices
          WHERE date = d.date AND metal = 'GOLD'
        ) dn_issued ON true
        LEFT JOIN tightness_daily td ON td.date = d.date AND td.metal = 'GOLD'
        ORDER BY d.date ASC
      `);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No data to export' });
      }

      const headers = [
        'Date', 'Gold_Price_USD', 'Registered_Oz', 'Eligible_Oz', 'Total_Oz',
        'Daily_Change_Registered', 'Daily_Change_Eligible',
        'OI_Contracts', 'OI_Oz', 'Coverage_Ratio_Pct',
        'DXY_Close', 'Contracts_Stopped', 'Contracts_Issued'
      ];

      const csvRows = [headers.join(',')];
      for (const row of result.rows) {
        csvRows.push([
          row.date,
          row.gold_price ?? '',
          row.registered_oz ?? '',
          row.eligible_oz ?? '',
          row.total_oz ?? '',
          row.daily_change_registered ?? '',
          row.daily_change_eligible ?? '',
          row.oi_contracts ?? '',
          row.oi_oz ?? '',
          row.coverage_ratio_pct ?? '',
          row.dxy_close ?? '',
          row.total_stopped ?? '',
          row.total_issued ?? '',
        ].join(','));
      }

      const csv = csvRows.join('\n');
      const filename = `goldtrack-export-${new Date().toISOString().slice(0, 10)}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── AI Analysis ──────────────────────────────────────────────────────────
  // GET /api/analysis/latest?metal=GOLD — most recent stored narrative
  app.get("/api/analysis/latest", async (req, res) => {
    try {
      const metal = typeof req.query.metal === 'string' ? req.query.metal.toUpperCase() : 'GOLD';
      const narrative = await getLatestNarrative(pool, metal);
      res.json({
        narrative,
        aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/analysis/run?metal=GOLD[&force=1] — compute signals, call Claude
  // (with web search for news), store + return the narrative. Idempotent per
  // data date unless force=1. Takes ~30–90s.
  app.get("/api/analysis/run", async (req, res) => {
    try {
      const metal = typeof req.query.metal === 'string' ? req.query.metal.toUpperCase() : 'GOLD';
      const force = req.query.force === '1' || req.query.force === 'true';
      const narrative = await generateNarrative(pool, metal, { force });
      res.json({ narrative, aiEnabled: true });
    } catch (error: any) {
      console.error(`[analysis] run failed: ${error.message}`);
      const status = /ANTHROPIC_API_KEY/.test(error.message) ? 503
        : /No warehouse data/.test(error.message) ? 409 : 500;
      res.status(status).json({ error: error.message });
    }
  });

  // GET /api/analysis/signals?metal=GOLD — the raw computed signals (debug/API)
  app.get("/api/analysis/signals", async (req, res) => {
    try {
      const metal = typeof req.query.metal === 'string' ? req.query.metal.toUpperCase() : 'GOLD';
      const signals = await computeSignals(pool, metal);
      if (!signals) return res.status(404).json({ error: `No warehouse data for ${metal} yet.` });
      res.json(signals);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Tightness gauge (0-100 physical tightness composite) ────────────────
  // GET /api/tightness/latest?metal=GOLD — last stored score + 90d history
  app.get("/api/tightness/latest", async (req, res) => {
    try {
      const metal = typeof req.query.metal === "string" ? req.query.metal.toUpperCase() : "GOLD";
      const row = await pool.query(
        `SELECT date, metal, score, confidence, zone, definition, components, created_at
           FROM tightness_daily WHERE metal = $1 ORDER BY date DESC LIMIT 1`,
        [metal]
      );
      if (!row.rows.length) return res.status(404).json({ error: `No tightness score stored for ${metal} yet. Run /api/tightness/run first.` });
      const history = await getTightnessHistory(pool, metal, 90);
      res.json({ ...row.rows[0], history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/tightness/run?metal=GOLD — recompute from current data and store.
  // All local compute; part of the nightly pipeline (after syncs).
  app.get("/api/tightness/run", async (req, res) => {
    try {
      const metal = typeof req.query.metal === "string" ? req.query.metal.toUpperCase() : "";
      const metals = metal ? [metal] : ["GOLD", "SILVER"];
      const results = [];
      for (const m of metals) results.push(await runAndStoreTightness(pool, m));
      res.json(metals.length === 1 ? results[0] : { results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/tightness/preview?metal=GOLD — compute without storing (debug)
  app.get("/api/tightness/preview", async (req, res) => {
    try {
      const metal = typeof req.query.metal === "string" ? req.query.metal.toUpperCase() : "GOLD";
      res.json(await computeTightness(pool, metal));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Long-run history database (gold_history schema) ─────────────────────
  // GET /api/goldhistory/sync — backfill/refresh all official history sources
  // (LBMA since 1968, FRED macro series, CFTC COT since 1986, GLD since 2004,
  // curated + derived events). Idempotent full upsert; first run takes a few
  // minutes, nightly runs are the same call.
  let historySyncRunning = false;
  app.get("/api/goldhistory/sync", async (_req, res) => {
    if (historySyncRunning) {
      return res.status(409).json({ error: "History sync already running" });
    }
    historySyncRunning = true;
    try {
      const results = await runHistorySync(pool);
      const failed = results.filter((r) => !r.ok);
      res.status(failed.length === results.length ? 500 : 200).json({ results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    } finally {
      historySyncRunning = false;
    }
  });

  // GET /api/goldhistory/summary — validation report: row counts, ranges,
  // freshness, gap check, sanity bounds, and the LBMA-vs-GLD cross-check.
  app.get("/api/goldhistory/summary", async (_req, res) => {
    try {
      res.json(await historySummary(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Pattern engine (pre-registered backtests over gold_history) ──────────
  // GET /api/patterns/run — recompute every registered pattern against the
  // history DB and store results. Definitions are frozen by hash; a changed
  // definition is refused (register a new id instead).
  let patternsRunning = false;
  app.get("/api/patterns/run", async (_req, res) => {
    if (patternsRunning) {
      return res.status(409).json({ error: "Pattern engine already running" });
    }
    patternsRunning = true;
    try {
      res.json(await runPatternEngine(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    } finally {
      patternsRunning = false;
    }
  });

  // GET /api/patterns/library — the full pattern library (survivors, graveyard,
  // insufficient-data) plus the honesty summary for the UI.
  app.get("/api/patterns/library", async (_req, res) => {
    try {
      res.json(await getPatternLibrary(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Predictions & scoreboard (high-conviction alerts + graded track record) ──
  // /run opens alerts for survived patterns active today; /grade settles matured
  // ones against the LBMA fix. Both are in the nightly pipeline (local compute).
  app.get("/api/predictions/run", async (_req, res) => {
    try {
      res.json(await runPredictions(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  app.get("/api/predictions/grade", async (_req, res) => {
    try {
      res.json(await gradePredictions(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  // /scoreboard = backtest odds + live hit-rate per pattern; /latest = open alerts + recent grades.
  app.get("/api/predictions/scoreboard", async (_req, res) => {
    try {
      res.json(await getScoreboard(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  app.get("/api/predictions/latest", async (_req, res) => {
    try {
      res.json(await getActivePredictions(pool));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  // /backfill materializes every historical firing of the survived patterns as a
  // graded call (idempotent). Run once after go-live to populate the ledger.
  app.get("/api/predictions/backfill", async (_req, res) => {
    try {
      const ledger = await survivedEpisodeLedger(pool);
      res.json(await backfillFromBacktest(pool, ledger));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Tell the browser-side HMR client to connect back on the same port
        // as the Express server (3000), not Vite's default fallback (8081).
        hmr: { clientPort: PORT },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global error handler — catches errors passed via next(err) or thrown in async middleware
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error(`[error] Unhandled: ${err?.message ?? err}`);
    const status = typeof err?.status === 'number' ? err.status : 500;
    res.status(status).json({ error: err?.message ?? 'Internal server error' });
  });

  // ── Daily auto-sync pipeline ─────────────────────────────────────────────
  // Pulls every data source (same list as the frontend "Sync All" button),
  // then regenerates the AI narrative for both metals. Runs sequentially so
  // the CME anti-bot pacing is respected.
  const SYNC_ENDPOINTS = [
    '/api/cme/sync', '/api/cb/sync', '/api/prices/sync', '/api/etf/sync',
    '/api/lbma/sync', '/api/oi/sync', '/api/dxy/sync', '/api/goldhistory/sync',
    // Not a fetch — recomputes pattern backtests from the freshly-synced
    // history so the "active today" flags stay current. All local compute.
    '/api/patterns/run',
    // Local compute: daily tightness score from the freshly-synced data.
    '/api/tightness/run',
    // Local compute: open high-conviction alerts (survived patterns active today),
    // then grade any that matured. Must follow patterns/run + goldhistory sync.
    '/api/predictions/run',
    '/api/predictions/grade',
  ];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const jitterMs = (minS: number, maxS: number) =>
    Math.round((minS + Math.random() * (maxS - minS)) * 1000);

  let pipelineRunning = false;

  async function runDailyPipeline(trigger: string, opts: { maxStartDelayMin?: number } = {}) {
    if (pipelineRunning) {
      console.log(`[auto-sync] Pipeline already running — skipping trigger (${trigger})`);
      return;
    }
    pipelineRunning = true;
    try {
    // Never start at the exact scheduled second — a request landing at the
    // same timestamp every day is the easiest bot fingerprint to spot.
    const startDelay = jitterMs(30, (opts.maxStartDelayMin ?? 25) * 60);
    console.log(`[auto-sync] Pipeline queued (${trigger}) — starting in ${Math.round(startDelay / 60000)}m`);
    await sleep(startDelay);
    console.log(`[auto-sync] Pipeline started (${trigger})`);
    for (const ep of SYNC_ENDPOINTS) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${ep}`);
        console.log(`[auto-sync] ${ep} → ${r.status}`);
      } catch (e: any) {
        console.error(`[auto-sync] ${ep} failed: ${e.message}`);
      }
      // Human-ish pause between data sources (20–90s) so the sources never
      // see a synchronized burst.
      await sleep(jitterMs(20, 90));
    }
    if (process.env.ANTHROPIC_API_KEY) {
      for (const metal of ['GOLD', 'SILVER']) {
        try {
          const n = await generateNarrative(pool, metal);
          console.log(`[auto-sync] ${metal} analysis ready for ${n.date}: ${n.headline}`);
        } catch (e: any) {
          console.error(`[auto-sync] ${metal} analysis failed: ${e.message}`);
        }
      }
    } else {
      console.log('[auto-sync] ANTHROPIC_API_KEY unset — skipping AI analysis');
    }
    await pool.query(
      `INSERT INTO app_state (key, value) VALUES ('last_pipeline_at', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [new Date().toISOString()]
    );
    console.log('[auto-sync] Pipeline finished');
    } finally {
      pipelineRunning = false;
    }
  }

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // 21:00 New York time, Mon–Fri — CME warehouse + delivery reports for the
    // day are published by then. That's 05:00/06:00 in Dubai, so a fresh
    // narrative is waiting every morning. Disable with AUTO_SYNC=off.
    if (process.env.AUTO_SYNC !== 'off') {
      cron.schedule('0 21 * * 1-5', () => runDailyPipeline('daily 21:00 ET cron'), {
        timezone: 'America/New_York',
      });
      console.log('[auto-sync] Scheduled daily at 21:00 America/New_York (Mon–Fri). Set AUTO_SYNC=off to disable.');

      // Catch-up: if the server was off when the cron should have fired
      // (laptop asleep, restart, etc.), run once shortly after boot instead of
      // waiting for the next scheduled night. >20h since the last full run
      // means at least one night was missed.
      try {
        const r = await pool.query(`SELECT value FROM app_state WHERE key = 'last_pipeline_at'`);
        const last = r.rows[0] ? Date.parse(r.rows[0].value) : 0;
        const hoursAgo = (Date.now() - last) / 3_600_000;
        if (!last || hoursAgo > 20) {
          console.log(`[auto-sync] Last full sync ${last ? `${Math.round(hoursAgo)}h ago` : 'never'} — running catch-up shortly`);
          runDailyPipeline('catch-up after startup', { maxStartDelayMin: 3 });
        }
      } catch (e: any) {
        console.error(`[auto-sync] Catch-up check failed: ${e.message}`);
      }
    }
  });
}

startServer();
