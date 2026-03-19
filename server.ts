import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import axios from "axios";
import * as XLSX from "xlsx";
import fs from "fs";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

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
    if (key) { process.env[key] = value; loaded.push(key); }
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

const requiredEnvVars = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Set them in .env.local: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE');
  process.exit(1);
}

const { Pool } = pg;

// Data retention window
const RETENTION_DAYS = 90;

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

  // Indexes for common filter patterns
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_warehouse_metal_date ON warehouse_stocks(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_metal_date ON vault_stocks(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_metal_date ON delivery_notices(metal, date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_summary_metal_date ON metals_summary(metal, date DESC)`);

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
    let allFirms: any[] = [];
    let firmTotals: Record<string, { issued: number, stopped: number }> = {};

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

        // The numbers are at the end. Issued is 4th col, Stopped is 5th.
        // Pattern: [FIRM_NAME] [ISSUED] [STOPPED]
        // Some might be blank.
        const parts = rest.trim().split(/\s{2,}/);
        let firmName = parts[0];
        let issued = 0;
        let stopped = 0;

        const safeInt = (s: string) => { const n = parseInt(s.replace(/,/g, ''), 10); return isNaN(n) ? 0 : n; };
        if (parts.length === 3) {
          issued = safeInt(parts[1]);
          stopped = safeInt(parts[2]);
        } else if (parts.length === 2) {
          // Check position to see if it's issued or stopped
          // This is tricky without fixed width. Let's try a different approach.
          const numbersMatch = rest.match(/(\d[\d,]*)\s*(\d[\d,]*)?\s*$/);
          if (numbersMatch) {
            const num1 = numbersMatch[1];
            const num2 = numbersMatch[2];
            const pos1 = rest.lastIndexOf(num1);
            if (num2) {
              issued = safeInt(num1);
              stopped = safeInt(num2);
            } else {
              // If only one number, check its relative position in the line
              if (pos1 > 40) { // Arbitrary threshold for "Stopped" column
                stopped = safeInt(num1);
              } else {
                issued = safeInt(num1);
              }
            }
          }
        }

        // Clean firm name
        firmName = firmName.replace(/[\d,.\s]+$/, '').trim();

        if (issued > 0 || stopped > 0) {
          if (!firmTotals[firmName]) {
            firmTotals[firmName] = { issued: 0, stopped: 0 };
          }
          firmTotals[firmName].issued += issued;
          firmTotals[firmName].stopped += stopped;
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

    result.all_firms = Object.entries(firmTotals).map(([name, totals]) => ({
      firm: name,
      ...totals
    }));
  }

  return result;
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
      const dateMatch = rowStr.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (dateMatch) reportDate = new Date(dateMatch[1]).toISOString().split('T')[0];
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize database tables
  await initDb();

  // API Routes

  // 1. Consolidated Sync from CME
  app.get("/api/cme/sync", async (req, res) => {
    const urls = {
      goldXls: "https://www.cmegroup.com/delivery_reports/Gold_Stocks.xls",
      silverXls: "https://www.cmegroup.com/delivery_reports/Silver_Stocks.xls",
      mtdPdf: "https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsMTDReport.pdf",
      dailyPdf: "https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsReport.pdf"
    };

    const results: any = {
      success: true,
      files: {},
      errors: []
    };

    const fetchFile = async (name: string, url: string, type: 'arraybuffer') => {
      try {
        console.log(`🔄 Fetching ${name} from: ${url}`);
        const response = await axios.get(url, {
          responseType: type,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          }
        });
        results.files[name] = { status: response.status, data: response.data };
        return response.data;
      } catch (error: any) {
        const status = error.response?.status || 'FETCH_ERROR';
        results.errors.push({ file: name, url, status, message: error.message });
        console.error(`❌ Error fetching ${name}: ${error.message}`);
        return null;
      }
    };

    // Fetch all files
    const [goldXlsData, silverXlsData, mtdPdfData, dailyPdfData] = await Promise.all([
      fetchFile('goldXls', urls.goldXls, 'arraybuffer'),
      fetchFile('silverXls', urls.silverXls, 'arraybuffer'),
      fetchFile('mtdPdf', urls.mtdPdf, 'arraybuffer'),
      fetchFile('dailyPdf', urls.dailyPdf, 'arraybuffer')
    ]);

    const pdfParser = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;

    // Process XLS Files
    const processXlsData = async (data: any, metal: string) => {
      if (!data) return;
      const parsed = await parseXls(Buffer.from(data), metal);

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

        // Cleanup: Keep only last RETENTION_DAYS days per metal
        const oldestResult = await client.query(
          `SELECT date FROM warehouse_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 1 OFFSET ${RETENTION_DAYS - 1}`,
          [metal]
        );
        if (oldestResult.rows[0]) {
          const oldestDate = oldestResult.rows[0].date;
          await client.query("DELETE FROM warehouse_stocks WHERE metal = $1 AND date < $2", [metal, oldestDate]);
          await client.query("DELETE FROM vault_stocks WHERE metal = $1 AND date < $2", [metal, oldestDate]);
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
    const processPdfData = async (data: any, filename: string) => {
      if (!data) return;
      const pdfData = await pdfParser(Buffer.from(data));
      const parsedData = parseCMEPdf(pdfData.text, filename);
      const reportDate = parsedData.business_date;
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

    for (const [pdfData, filename] of [[mtdPdfData, "MetalsIssuesAndStopsMTDReport.pdf"], [dailyPdfData, "MetalsIssuesAndStopsReport.pdf"]] as const) {
      try {
        await processPdfData(pdfData, filename);
      } catch (e: any) {
        console.error(`❌ Failed to process ${filename}:`, e.message);
        results.errors.push({ file: filename, message: e.message });
      }
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
      const metal = req.query.metal || 'GOLD';
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
      const metal = req.query.metal || 'GOLD';
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

  app.get("/api/history", async (req, res) => {
    try {
      const metal = req.query.metal || 'GOLD';
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
      const metal = req.query.metal || 'GOLD';
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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // BUG 4: Restore lost March 16 data
    try {
      const existsResult = await pool.query(
        "SELECT 1 FROM warehouse_stocks WHERE date = '2026-03-16' AND metal = 'GOLD'"
      );
      if (existsResult.rows.length === 0) {
        await pool.query(`
          INSERT INTO warehouse_stocks (date, metal, registered_oz, eligible_oz, total_oz, daily_change_registered, daily_change_eligible, created_at)
          VALUES ('2026-03-16', 'GOLD', 16695520, 15856042, 32551562, 0, 0, '2026-03-16 14:28:34')
        `);
        console.log("✅ Restored March 16 data point.");
      }
    } catch (e) {
      console.error("Failed to restore March 16 data:", e);
    }
  });
}

startServer();
