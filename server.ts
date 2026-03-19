import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import axios from "axios";
import * as XLSX from "xlsx";
import fs from "fs";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("gold_data.db");

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
db.exec(`
  CREATE TABLE IF NOT EXISTS warehouse_stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    metal TEXT NOT NULL,
    registered_oz INTEGER NOT NULL,
    eligible_oz INTEGER NOT NULL,
    total_oz INTEGER NOT NULL,
    daily_change_registered INTEGER,
    daily_change_eligible INTEGER,
    delta_label TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, metal)
  );

  CREATE TABLE IF NOT EXISTS vault_stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    vault TEXT NOT NULL,
    metal TEXT NOT NULL,
    registered_oz INTEGER NOT NULL,
    eligible_oz INTEGER NOT NULL,
    UNIQUE(date, vault, metal)
  );

  CREATE TABLE IF NOT EXISTS delivery_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    firm TEXT NOT NULL,
    issued INTEGER DEFAULT 0,
    stopped INTEGER DEFAULT 0,
    metal TEXT NOT NULL,
    account_type TEXT NOT NULL,
    UNIQUE(date, firm, metal, account_type)
  );

  CREATE TABLE IF NOT EXISTS metals_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    metal TEXT NOT NULL,
    report_type TEXT NOT NULL,
    mtd INTEGER,
    settlement REAL,
    daily_issued INTEGER,
    daily_stopped INTEGER,
    ytd_json TEXT,
    UNIQUE(date, metal, report_type)
  );
`);

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
        const daily = parseInt(parts[1].replace(/,/g, '')) || 0;
        const cumulative = parseInt(parts[2].replace(/,/g, '')) || 0;
        result.mtd = cumulative;
        result.daily_stopped = daily;
        console.log(`[DEBUG] MTD ${metal}: daily=${daily}, cumulative=${cumulative} from line: ${lastDateLine}`);
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

        if (parts.length === 3) {
          issued = parseInt(parts[1].replace(/,/g, '')) || 0;
          stopped = parseInt(parts[2].replace(/,/g, '')) || 0;
        } else if (parts.length === 2) {
          // Check position to see if it's issued or stopped
          // This is tricky without fixed width. Let's try a different approach.
          const numbersMatch = rest.match(/(\d[\d,]*)\s*(\d[\d,]*)?\s*$/);
          if (numbersMatch) {
            const num1 = numbersMatch[1];
            const num2 = numbersMatch[2];
            const pos1 = rest.lastIndexOf(num1);
            if (num2) {
              issued = parseInt(num1.replace(/,/g, '')) || 0;
              stopped = parseInt(num2.replace(/,/g, '')) || 0;
            } else {
              // If only one number, check its relative position in the line
              if (pos1 > 40) { // Arbitrary threshold for "Stopped" column
                stopped = parseInt(num1.replace(/,/g, '')) || 0;
              } else {
                issued = parseInt(num1.replace(/,/g, '')) || 0;
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
          result.daily_issued = parseInt(parts[totalIdx + 1]?.replace(/,/g, '')) || 0;
          result.daily_stopped = parseInt(parts[totalIdx + 2]?.replace(/,/g, '')) || 0;
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
      
      // Calculate deltas
      const prevRow = db.prepare("SELECT * FROM warehouse_stocks WHERE metal = ? AND date < ? ORDER BY date DESC LIMIT 1").get(metal, parsed.reportDate);
      let daily_change_registered = 0;
      let daily_change_eligible = 0;
      let delta_label = "24h Change";

      if (prevRow) {
        daily_change_registered = parsed.registered - prevRow.registered_oz;
        daily_change_eligible = parsed.eligible - prevRow.eligible_oz;
      } else {
        daily_change_registered = null;
        daily_change_eligible = null;
        delta_label = "—";
      }

      db.transaction(() => {
        db.prepare(`
          INSERT INTO warehouse_stocks (date, metal, registered_oz, eligible_oz, total_oz, daily_change_registered, daily_change_eligible, delta_label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(date, metal) DO UPDATE SET
            registered_oz = excluded.registered_oz,
            eligible_oz = excluded.eligible_oz,
            total_oz = excluded.total_oz,
            daily_change_registered = excluded.daily_change_registered,
            daily_change_eligible = excluded.daily_change_eligible,
            delta_label = excluded.delta_label
        `).run(parsed.reportDate, metal, parsed.registered, parsed.eligible, parsed.total, daily_change_registered, daily_change_eligible, delta_label);

        const insertVault = db.prepare(`
          INSERT OR REPLACE INTO vault_stocks (date, vault, metal, registered_oz, eligible_oz)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const [vault, vals] of Object.entries(parsed.vaultData)) {
          const v = vals as any;
          insertVault.run(parsed.reportDate, vault, metal, v.registered, v.eligible);
        }

        // Cleanup: Keep only last 90 days per metal
        const oldestDate = db.prepare("SELECT date FROM warehouse_stocks WHERE metal = ? ORDER BY date DESC LIMIT 1 OFFSET 89").get(metal);
        if (oldestDate) {
          db.prepare("DELETE FROM warehouse_stocks WHERE metal = ? AND date < ?").run(metal, oldestDate.date);
          db.prepare("DELETE FROM vault_stocks WHERE metal = ? AND date < ?").run(metal, oldestDate.date);
        }
      })();
    };

    await processXlsData(goldXlsData, 'GOLD');
    await processXlsData(silverXlsData, 'SILVER');

    // Process PDF Files
    const processPdfData = async (data: any, filename: string) => {
      if (!data) return;
      const pdfData = await pdfParser(Buffer.from(data));
      const parsedData = parseCMEPdf(pdfData.text, filename);
      const reportDate = parsedData.business_date;
      if (!reportDate) return;

      db.transaction(() => {
        const upsertSummary = db.prepare(`
          INSERT INTO metals_summary (date, metal, report_type, mtd, settlement, daily_issued, daily_stopped, ytd_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(date, metal, report_type) DO UPDATE SET
            mtd = excluded.mtd,
            settlement = excluded.settlement,
            daily_issued = excluded.daily_issued,
            daily_stopped = excluded.daily_stopped,
            ytd_json = excluded.ytd_json
        `);

        const upsertFirm = db.prepare(`
          INSERT INTO delivery_notices (date, firm, issued, stopped, metal, account_type)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(date, firm, metal, account_type) DO UPDATE SET
            issued = excluded.issued,
            stopped = excluded.stopped
        `);

        for (const [metal, details] of Object.entries(parsedData.metals)) {
          const d = details as any;
          upsertSummary.run(
            reportDate, 
            metal, 
            parsedData.report_type, 
            d.mtd || null, 
            d.settlement || null, 
            d.daily_issued || null, 
            d.daily_stopped || null, 
            d.ytd_by_month ? JSON.stringify(d.ytd_by_month) : null
          );

          if (parsedData.report_type === "DAILY" && d.all_firms) {
            for (const firm of d.all_firms) {
              upsertFirm.run(reportDate, firm.firm, firm.issued, firm.stopped, metal, firm.org === "C" ? "CUSTOMER" : "HOUSE");
            }
          }
        }
      })();
    };

    await processPdfData(mtdPdfData, "MetalsIssuesAndStopsMTDReport.pdf");
    await processPdfData(dailyPdfData, "MetalsIssuesAndStopsReport.pdf");

    if (results.errors.length > 0) {
      results.success = false;
    }

    res.json(results);
  });

  // 5. Get Metals Summary
  app.get("/api/cme/summary", (req, res) => {
    try {
      const { metal, type } = req.query;
      let query = "SELECT * FROM metals_summary WHERE 1=1";
      const params: any[] = [];
      
      if (metal) {
        query += " AND metal = ?";
        params.push(metal);
      }
      if (type) {
        query += " AND report_type = ?";
        params.push(type);
      }
      
      query += " ORDER BY date DESC LIMIT 50";
      const rows = db.prepare(query).all(...params);
      
      // Parse YTD JSON
      const result = rows.map(row => ({
        ...row,
        ytd_by_month: row.ytd_json ? JSON.parse(row.ytd_json) : null
      }));
      
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 4. Get Latest Delivery Notices
  app.get("/api/cme/latest-notices", (req, res) => {
    try {
      const metal = req.query.metal || 'GOLD';
      const date = req.query.date || db.prepare("SELECT date FROM delivery_notices WHERE metal = ? ORDER BY date DESC LIMIT 1").get(metal)?.date;
      if (!date) return res.json([]);
      
      const rows = db.prepare("SELECT * FROM delivery_notices WHERE date = ? AND metal = ? ORDER BY stopped DESC, issued DESC").all(date, metal);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 2. Get Latest Stocks (History)
  app.get("/api/cme/latest-stocks", (req, res) => {
    try {
      const metal = req.query.metal || 'GOLD';
      const rows = db.prepare("SELECT * FROM warehouse_stocks WHERE metal = ? ORDER BY date ASC").all(metal);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 6. Get Inventory History (Alias for latest-stocks)
  app.get("/api/history", (req, res) => {
    try {
      const metal = req.query.metal || 'GOLD';
      const rows = db.prepare("SELECT * FROM warehouse_stocks WHERE metal = ? ORDER BY date ASC").all(metal);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 7. Get Vault Breakdown
  app.get("/api/cme/vault-breakdown", (req, res) => {
    try {
      const metal = req.query.metal || 'GOLD';
      const date = req.query.date || db.prepare("SELECT date FROM vault_stocks WHERE metal = ? ORDER BY date DESC LIMIT 1").get(metal)?.date;
      if (!date) return res.json([]);
      const rows = db.prepare("SELECT * FROM vault_stocks WHERE date = ? AND metal = ? ORDER BY (registered_oz + eligible_oz) DESC").all(date, metal);
      res.json(rows);
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // BUG 4: Restore lost March 16 data
    try {
      const exists = db.prepare("SELECT * FROM warehouse_stocks WHERE date = '2026-03-16' AND metal = 'GOLD'").get();
      if (!exists) {
        db.prepare(`
          INSERT INTO warehouse_stocks (date, metal, registered_oz, eligible_oz, total_oz, daily_change_registered, daily_change_eligible, created_at)
          VALUES ('2026-03-16', 'GOLD', 16695520, 15856042, 32551562, 0, 0, '2026-03-16 14:28:34')
        `).run();
        console.log("✅ Restored March 16 data point.");
      }
    } catch (e) {
      console.error("Failed to restore March 16 data:", e);
    }
  });
}

startServer();
