use axum::{extract::State, Json};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::AppState;
use crate::routes::AppResult;

const RETENTION_DAYS: i64 = 90;

static SYNC_COOLDOWN: Duration = Duration::from_secs(60);

use std::sync::OnceLock;
static LAST_SYNC: OnceLock<Mutex<Instant>> = OnceLock::new();

fn last_sync() -> &'static Mutex<Instant> {
    LAST_SYNC.get_or_init(|| Mutex::new(Instant::now() - SYNC_COOLDOWN))
}

// ── ETF Baseline Data ──────────────────────────────────────────────────────

struct EtfEntry {
    name: &'static str,
    data: &'static [(&'static str, f64)],
}

const GLD_DATA: &[(&str, f64)] = &[
    ("2024-01", 877.4), ("2024-02", 834.2), ("2024-03", 829.0), ("2024-04", 833.7),
    ("2024-05", 830.4), ("2024-06", 829.1), ("2024-07", 840.7), ("2024-08", 859.0),
    ("2024-09", 876.5), ("2024-10", 892.6), ("2024-11", 872.1), ("2024-12", 871.5),
    ("2025-01", 865.3), ("2025-02", 878.5), ("2025-03", 899.2), ("2025-04", 917.6),
    ("2025-05", 923.4), ("2025-06", 930.1), ("2025-07", 936.8), ("2025-08", 942.3),
    ("2025-09", 938.7), ("2025-10", 945.2), ("2025-11", 951.4), ("2025-12", 948.6),
    ("2026-01", 955.1), ("2026-02", 962.7), ("2026-03", 968.3), ("2026-04", 972.5),
];

const IAU_DATA: &[(&str, f64)] = &[
    ("2024-01", 399.2), ("2024-02", 385.6), ("2024-03", 382.1), ("2024-04", 384.5),
    ("2024-05", 386.2), ("2024-06", 388.0), ("2024-07", 393.5), ("2024-08", 401.2),
    ("2024-09", 408.7), ("2024-10", 414.3), ("2024-11", 407.8), ("2024-12", 405.1),
    ("2025-01", 402.6), ("2025-02", 410.3), ("2025-03", 418.9), ("2025-04", 425.1),
    ("2025-05", 428.7), ("2025-06", 432.4), ("2025-07", 435.6), ("2025-08", 438.2),
    ("2025-09", 436.1), ("2025-10", 440.5), ("2025-11", 444.2), ("2025-12", 442.7),
    ("2026-01", 447.3), ("2026-02", 451.8), ("2026-03", 455.2), ("2026-04", 458.6),
];

const SGOL_DATA: &[(&str, f64)] = &[
    ("2024-06", 52.1), ("2024-12", 55.8),
    ("2025-06", 58.3), ("2025-12", 61.2),
    ("2026-03", 63.5), ("2026-04", 64.1),
];

const ETF_BASELINE: &[(&str, EtfEntry)] = &[
    ("GLD", EtfEntry { name: "SPDR Gold Shares", data: GLD_DATA }),
    ("IAU", EtfEntry { name: "iShares Gold Trust", data: IAU_DATA }),
    ("SGOL", EtfEntry { name: "Aberdeen Physical Gold", data: SGOL_DATA }),
];

// ── LBMA Vault Data (troy oz) ──────────────────────────────────────────────

const LBMA_DATA: &[(&str, i64)] = &[
    ("2023-01", 274_200_000), ("2023-02", 271_800_000), ("2023-03", 269_500_000),
    ("2023-04", 268_100_000), ("2023-05", 267_000_000), ("2023-06", 265_400_000),
    ("2023-07", 264_100_000), ("2023-08", 263_200_000), ("2023-09", 262_400_000),
    ("2023-10", 261_500_000), ("2023-11", 260_700_000), ("2023-12", 259_800_000),
    ("2024-01", 258_900_000), ("2024-02", 257_200_000), ("2024-03", 255_800_000),
    ("2024-04", 254_600_000), ("2024-05", 253_500_000), ("2024-06", 252_200_000),
    ("2024-07", 251_400_000), ("2024-08", 250_100_000), ("2024-09", 249_200_000),
    ("2024-10", 248_000_000), ("2024-11", 247_100_000), ("2024-12", 246_300_000),
    ("2025-01", 245_100_000), ("2025-02", 243_600_000), ("2025-03", 242_200_000),
    ("2025-04", 241_000_000), ("2025-05", 240_100_000), ("2025-06", 239_400_000),
    ("2025-07", 238_500_000), ("2025-08", 237_800_000), ("2025-09", 237_000_000),
    ("2025-10", 236_200_000), ("2025-11", 235_400_000), ("2025-12", 234_800_000),
    ("2026-01", 234_100_000), ("2026-02", 233_400_000), ("2026-03", 232_800_000),
];

// ── Open Interest Data (contracts, 100oz each) ─────────────────────────────

const OI_DATA: &[(&str, i64)] = &[
    ("2026-02-03", 485200), ("2026-02-04", 487100), ("2026-02-05", 489300),
    ("2026-02-06", 491800), ("2026-02-07", 488500), ("2026-02-10", 486700),
    ("2026-02-11", 484200), ("2026-02-12", 482800), ("2026-02-13", 480100),
    ("2026-02-14", 478600), ("2026-02-18", 476200), ("2026-02-19", 473800),
    ("2026-02-20", 471500), ("2026-02-21", 469200), ("2026-02-24", 467800),
    ("2026-02-25", 470100), ("2026-02-26", 472500), ("2026-02-27", 474800),
    ("2026-02-28", 476300), ("2026-03-03", 478900), ("2026-03-04", 481200),
    ("2026-03-05", 483500), ("2026-03-06", 485800), ("2026-03-07", 487300),
    ("2026-03-10", 489100), ("2026-03-11", 491600), ("2026-03-12", 493200),
    ("2026-03-13", 495800), ("2026-03-14", 498100), ("2026-03-17", 500200),
    ("2026-03-18", 502500), ("2026-03-19", 504100), ("2026-03-20", 505800),
    ("2026-03-21", 507200), ("2026-03-24", 508900), ("2026-03-25", 510300),
    ("2026-03-26", 511800), ("2026-03-27", 513200), ("2026-03-28", 514600),
    ("2026-03-31", 515800), ("2026-04-01", 517200), ("2026-04-02", 518900),
    ("2026-04-03", 520100), ("2026-04-04", 521500), ("2026-04-07", 522800),
    ("2026-04-08", 524100), ("2026-04-09", 525300), ("2026-04-10", 526800),
    ("2026-04-11", 527500), ("2026-04-14", 528200), ("2026-04-15", 529100),
    ("2026-04-16", 529800), ("2026-04-17", 530200),
];

// ── DXY Index Data (daily close) ───────────────────────────────────────────

const DXY_DATA: &[(&str, f64)] = &[
    ("2026-02-03", 104.2), ("2026-02-04", 104.0), ("2026-02-05", 103.8),
    ("2026-02-06", 103.5), ("2026-02-07", 103.7), ("2026-02-10", 103.3),
    ("2026-02-11", 103.1), ("2026-02-12", 102.9), ("2026-02-13", 102.6),
    ("2026-02-14", 102.8), ("2026-02-18", 102.4), ("2026-02-19", 102.1),
    ("2026-02-20", 101.9), ("2026-02-21", 102.2), ("2026-02-24", 101.7),
    ("2026-02-25", 101.5), ("2026-02-26", 101.3), ("2026-02-27", 101.0),
    ("2026-02-28", 101.2), ("2026-03-03", 100.8), ("2026-03-04", 100.5),
    ("2026-03-05", 100.3), ("2026-03-06", 100.1), ("2026-03-07", 100.4),
    ("2026-03-10", 99.8), ("2026-03-11", 99.6), ("2026-03-12", 99.3),
    ("2026-03-13", 99.1), ("2026-03-14", 99.4), ("2026-03-17", 98.9),
    ("2026-03-18", 98.7), ("2026-03-19", 98.5), ("2026-03-20", 98.2),
    ("2026-03-21", 98.4), ("2026-03-24", 98.0), ("2026-03-25", 97.8),
    ("2026-03-26", 97.6), ("2026-03-27", 97.3), ("2026-03-28", 97.5),
    ("2026-03-31", 97.1), ("2026-04-01", 96.9), ("2026-04-02", 96.7),
    ("2026-04-03", 96.4), ("2026-04-04", 96.6), ("2026-04-07", 96.2),
    ("2026-04-08", 96.0), ("2026-04-09", 95.8), ("2026-04-10", 95.5),
    ("2026-04-11", 95.7), ("2026-04-14", 95.3), ("2026-04-15", 95.1),
    ("2026-04-16", 94.9), ("2026-04-17", 94.7),
];

// ── Central Bank Reserves (WGC Baseline, tonnes) ───────────────────────────

struct CbCountry {
    code: &'static str,
    name: &'static str,
    data: &'static [(&'static str, f64)],
}

#[allow(dead_code)]
const COUNTRY_NAMES: &[(&str, &str)] = &[
    ("US", "United States"), ("DE", "Germany"), ("IT", "Italy"), ("FR", "France"),
    ("RU", "Russian Federation"), ("CN", "China"), ("JP", "Japan"), ("IN", "India"),
    ("CH", "Switzerland"), ("PL", "Poland"), ("GB", "United Kingdom"), ("TR", "Turkey"),
    ("KZ", "Kazakhstan"), ("UZ", "Uzbekistan"), ("TH", "Thailand"), ("SG", "Singapore"),
    ("CZ", "Czech Republic"), ("HU", "Hungary"), ("QA", "Qatar"), ("SA", "Saudi Arabia"),
    ("AE", "United Arab Emirates"), ("AU", "Australia"), ("PT", "Portugal"), ("ES", "Spain"),
    ("NL", "Netherlands"), ("SE", "Sweden"), ("AT", "Austria"), ("BE", "Belgium"),
    ("PH", "Philippines"), ("EG", "Egypt"), ("IQ", "Iraq"), ("LY", "Libya"),
];

#[allow(dead_code)]
fn country_name(code: &str) -> &'static str {
    COUNTRY_NAMES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n).unwrap_or("Unknown")
}

const CN_DATA: &[(&str, f64)] = &[
    ("2020", 1948.3), ("2021", 1948.3), ("2022", 1948.3), ("2023", 2235.4),
    ("2024-01", 2245.0), ("2024-02", 2257.0), ("2024-03", 2262.4), ("2024-04", 2264.3),
    ("2024-05", 2264.3), ("2024-06", 2264.3), ("2024-07", 2264.3), ("2024-08", 2264.3),
    ("2024-09", 2264.3), ("2024-10", 2264.3), ("2024-11", 2269.3), ("2024-12", 2279.6),
    ("2025-01", 2285.2), ("2025-02", 2289.5), ("2025-03", 2292.3), ("2025-04", 2294.8),
    ("2025-05", 2297.1), ("2025-06", 2299.4), ("2025-07", 2300.5), ("2025-08", 2301.6),
    ("2025-09", 2302.7), ("2025-10", 2303.8), ("2025-11", 2304.9), ("2025-12", 2306.3),
    ("2026-01", 2309.8), ("2026-02", 2314.4), ("2026-03", 2318.9),
];

const IN_DATA: &[(&str, f64)] = &[
    ("2020", 668.3), ("2021", 754.1), ("2022", 785.3), ("2023", 803.6),
    ("2024-01", 806.2), ("2024-02", 809.1), ("2024-03", 812.3), ("2024-04", 816.8),
    ("2024-05", 822.1), ("2024-06", 826.9), ("2024-07", 831.7), ("2024-08", 840.4),
    ("2024-09", 848.6), ("2024-10", 854.7), ("2024-11", 857.6), ("2024-12", 862.8),
    ("2025-01", 865.2), ("2025-02", 867.5), ("2025-03", 869.7), ("2025-04", 871.4),
    ("2025-05", 873.1), ("2025-06", 874.3), ("2025-07", 875.5), ("2025-08", 876.6),
    ("2025-09", 877.4), ("2025-10", 878.2), ("2025-11", 879.2), ("2025-12", 880.2),
    ("2026-01", 882.0), ("2026-02", 883.6), ("2026-03", 885.4),
];

const PL_DATA: &[(&str, f64)] = &[
    ("2020", 228.6), ("2021", 228.6), ("2022", 228.6), ("2023", 358.7),
    ("2024-01", 363.2), ("2024-02", 368.0), ("2024-03", 373.5), ("2024-04", 378.6),
    ("2024-05", 384.1), ("2024-06", 389.5), ("2024-07", 394.8), ("2024-08", 398.5),
    ("2024-09", 403.1), ("2024-10", 407.8), ("2024-11", 413.6), ("2024-12", 420.2),
    ("2025-01", 423.5), ("2025-02", 426.8), ("2025-03", 429.4), ("2025-04", 432.1),
    ("2025-05", 434.6), ("2025-06", 437.0), ("2025-07", 439.3), ("2025-08", 441.5),
    ("2025-09", 443.6), ("2025-10", 445.4), ("2025-11", 447.1), ("2025-12", 448.8),
    ("2026-01", 451.2), ("2026-02", 453.5), ("2026-03", 455.8),
];

const TR_DATA: &[(&str, f64)] = &[
    ("2020", 547.5), ("2021", 394.2), ("2022", 478.5), ("2023", 540.2),
    ("2024-01", 543.8), ("2024-02", 547.5), ("2024-03", 551.0), ("2024-04", 554.6),
    ("2024-05", 558.2), ("2024-06", 561.8), ("2024-07", 565.3), ("2024-08", 568.1),
    ("2024-09", 571.0), ("2024-10", 573.8), ("2024-11", 576.3), ("2024-12", 578.8),
    ("2025-01", 581.5), ("2025-02", 584.1), ("2025-03", 587.3), ("2025-04", 590.5),
    ("2025-05", 593.8), ("2025-06", 597.0), ("2025-07", 600.1), ("2025-08", 603.2),
    ("2025-09", 606.1), ("2025-10", 609.0), ("2025-11", 612.0), ("2025-12", 614.9),
    ("2026-01", 617.8), ("2026-02", 621.0), ("2026-03", 624.2),
];

const SG_DATA: &[(&str, f64)] = &[
    ("2020", 127.4), ("2021", 153.8), ("2022", 153.8), ("2023", 215.9),
    ("2024-01", 217.5), ("2024-02", 219.0), ("2024-03", 220.6), ("2024-04", 222.1),
    ("2024-05", 223.5), ("2024-06", 224.8), ("2024-07", 225.9), ("2024-08", 226.8),
    ("2024-09", 227.6), ("2024-10", 228.3), ("2024-11", 229.0), ("2024-12", 229.7),
    ("2025-01", 230.5), ("2025-02", 231.4), ("2025-03", 232.4), ("2025-04", 233.2),
    ("2025-05", 234.0), ("2025-06", 234.7), ("2025-07", 235.3), ("2025-08", 235.9),
    ("2025-09", 236.4), ("2025-10", 236.8), ("2025-11", 237.2), ("2025-12", 237.6),
    ("2026-01", 238.1), ("2026-02", 238.5), ("2026-03", 239.0),
];

const CZ_DATA: &[(&str, f64)] = &[
    ("2020", 31.1), ("2021", 35.0), ("2022", 38.2), ("2023", 42.8),
    ("2024-01", 43.2), ("2024-02", 43.5), ("2024-03", 43.9), ("2024-04", 44.2),
    ("2024-05", 44.5), ("2024-06", 44.9), ("2024-07", 45.3), ("2024-08", 45.7),
    ("2024-09", 46.1), ("2024-10", 46.6), ("2024-11", 47.0), ("2024-12", 47.5),
    ("2025-01", 47.8), ("2025-02", 48.1), ("2025-03", 48.4), ("2025-04", 48.7),
    ("2025-05", 49.0), ("2025-06", 49.3), ("2025-07", 49.6), ("2025-08", 49.9),
    ("2025-09", 50.2), ("2025-10", 50.5), ("2025-11", 51.0), ("2025-12", 51.4),
    ("2026-01", 51.8), ("2026-02", 52.2), ("2026-03", 52.6),
];

const IQ_DATA: &[(&str, f64)] = &[
    ("2020", 96.3), ("2021", 96.3), ("2022", 96.3), ("2023", 132.7),
    ("2024-01", 134.0), ("2024-02", 135.5), ("2024-03", 137.1), ("2024-04", 138.9),
    ("2024-05", 140.8), ("2024-06", 142.5), ("2024-07", 144.0), ("2024-08", 145.6),
    ("2024-09", 147.3), ("2024-10", 149.0), ("2024-11", 150.8), ("2024-12", 152.6),
    ("2025-01", 153.5), ("2025-02", 154.5), ("2025-03", 155.6), ("2025-04", 156.7),
    ("2025-05", 157.8), ("2025-06", 158.8), ("2025-07", 159.6), ("2025-08", 160.4),
    ("2025-09", 161.0), ("2025-10", 161.5), ("2025-11", 162.1), ("2025-12", 162.7),
    ("2026-01", 163.5), ("2026-02", 164.2), ("2026-03", 164.9),
];

const AE_DATA: &[(&str, f64)] = &[
    ("2020", 55.3), ("2021", 55.3), ("2022", 55.3), ("2023", 74.1),
    ("2024-01", 75.8), ("2024-02", 77.3), ("2024-03", 78.8), ("2024-04", 80.3),
    ("2024-05", 81.9), ("2024-06", 83.4), ("2024-07", 84.8), ("2024-08", 86.0),
    ("2024-09", 87.3), ("2024-10", 88.6), ("2024-11", 89.9), ("2024-12", 91.2),
    ("2025-01", 91.8), ("2025-02", 92.4), ("2025-03", 93.0), ("2025-04", 93.6),
    ("2025-05", 94.2), ("2025-06", 94.8), ("2025-07", 95.2), ("2025-08", 95.6),
    ("2025-09", 96.0), ("2025-10", 96.3), ("2025-11", 96.5), ("2025-12", 96.8),
    ("2026-01", 97.2), ("2026-02", 97.6), ("2026-03", 98.0),
];

const QA_DATA: &[(&str, f64)] = &[
    ("2020", 56.7), ("2021", 56.7), ("2022", 71.5), ("2023", 101.8),
    ("2024-01", 102.5), ("2024-02", 103.1), ("2024-03", 103.7), ("2024-04", 104.2),
    ("2024-05", 104.6), ("2024-06", 105.0), ("2024-07", 105.4), ("2024-08", 105.7),
    ("2024-09", 106.0), ("2024-10", 106.3), ("2024-11", 106.6), ("2024-12", 106.8),
    ("2025-01", 107.2), ("2025-02", 107.6), ("2025-03", 108.0), ("2025-04", 108.4),
    ("2025-05", 108.9), ("2025-06", 109.3), ("2025-07", 109.7), ("2025-08", 110.0),
    ("2025-09", 110.3), ("2025-10", 110.5), ("2025-11", 110.8), ("2025-12", 111.0),
    ("2026-01", 111.4), ("2026-02", 111.7), ("2026-03", 112.0),
];

// Static / annual reporters
const US_DATA: &[(&str, f64)] = &[("2020", 8133.5), ("2021", 8133.5), ("2022", 8133.5), ("2023", 8133.5), ("2024", 8133.5), ("2025", 8133.5)];
const DE_DATA: &[(&str, f64)] = &[("2020", 3362.4), ("2021", 3359.1), ("2022", 3355.1), ("2023", 3352.7), ("2024", 3351.5), ("2025", 3350.3)];
const IT_DATA: &[(&str, f64)] = &[("2020", 2451.8), ("2021", 2451.8), ("2022", 2451.8), ("2023", 2451.8), ("2024", 2451.8), ("2025", 2451.8)];
const FR_DATA: &[(&str, f64)] = &[("2020", 2436.0), ("2021", 2436.0), ("2022", 2436.0), ("2023", 2436.9), ("2024", 2437.0), ("2025", 2437.0)];
const RU_DATA: &[(&str, f64)] = &[("2020", 2271.2), ("2021", 2298.5), ("2022", 2298.5), ("2023", 2332.7), ("2024", 2332.7), ("2025", 2332.7)];
const CH_DATA: &[(&str, f64)] = &[("2020", 1040.0), ("2021", 1040.0), ("2022", 1040.0), ("2023", 1040.0), ("2024", 1040.0), ("2025", 1040.0)];
const JP_DATA: &[(&str, f64)] = &[("2020", 765.2), ("2021", 765.2), ("2022", 846.0), ("2023", 846.0), ("2024", 846.0), ("2025", 846.0)];
const NL_DATA: &[(&str, f64)] = &[("2020", 612.5), ("2021", 612.5), ("2022", 612.5), ("2023", 612.5), ("2024", 612.5), ("2025", 612.5)];
const PT_DATA: &[(&str, f64)] = &[("2020", 382.6), ("2021", 382.6), ("2022", 382.6), ("2023", 382.6), ("2024", 382.6), ("2025", 382.6)];
const SA_DATA: &[(&str, f64)] = &[("2020", 323.1), ("2021", 323.1), ("2022", 323.1), ("2023", 323.1), ("2024", 323.1), ("2025", 323.1)];
const GB_DATA: &[(&str, f64)] = &[("2020", 310.3), ("2021", 310.3), ("2022", 310.3), ("2023", 310.3), ("2024", 310.3), ("2025", 310.3)];
const KZ_DATA: &[(&str, f64)] = &[("2020", 382.5), ("2021", 369.9), ("2022", 352.3), ("2023", 313.7), ("2024", 293.4), ("2025", 287.0)];
const ES_DATA: &[(&str, f64)] = &[("2020", 281.6), ("2021", 281.6), ("2022", 281.6), ("2023", 281.6), ("2024", 281.6), ("2025", 281.6)];
const AT_DATA: &[(&str, f64)] = &[("2020", 280.0), ("2021", 280.0), ("2022", 280.0), ("2023", 280.0), ("2024", 280.0), ("2025", 280.0)];
const BE_DATA: &[(&str, f64)] = &[("2020", 227.4), ("2021", 227.4), ("2022", 227.4), ("2023", 227.4), ("2024", 227.4), ("2025", 227.4)];
const PH_DATA: &[(&str, f64)] = &[("2020", 197.9), ("2021", 196.4), ("2022", 157.7), ("2023", 160.0), ("2024", 160.0), ("2025", 160.0)];
const UZ_DATA: &[(&str, f64)] = &[("2020", 302.2), ("2021", 362.2), ("2022", 370.0), ("2023", 371.6), ("2024", 380.2), ("2025", 382.0)];
const TH_DATA: &[(&str, f64)] = &[("2020", 244.2), ("2021", 244.2), ("2022", 244.2), ("2023", 244.2), ("2024", 244.2), ("2025", 244.2)];
const HU_DATA: &[(&str, f64)] = &[("2020", 31.5), ("2021", 94.5), ("2022", 94.5), ("2023", 94.5), ("2024", 110.0), ("2025", 110.0)];
const SE_DATA: &[(&str, f64)] = &[("2020", 125.7), ("2021", 125.7), ("2022", 125.7), ("2023", 125.7), ("2024", 125.7), ("2025", 125.7)];
const EG_DATA: &[(&str, f64)] = &[("2020", 80.2), ("2021", 80.2), ("2022", 80.2), ("2023", 126.6), ("2024", 126.6), ("2025", 126.6)];
const AU_DATA: &[(&str, f64)] = &[("2020", 66.7), ("2021", 66.7), ("2022", 66.7), ("2023", 66.7), ("2024", 66.7), ("2025", 66.7)];
const LY_DATA: &[(&str, f64)] = &[("2020", 116.6), ("2021", 116.6), ("2022", 116.6), ("2023", 116.6), ("2024", 116.6), ("2025", 116.6)];

fn wgc_baseline() -> Vec<CbCountry> {
    vec![
        CbCountry { code: "CN", name: "China", data: CN_DATA },
        CbCountry { code: "IN", name: "India", data: IN_DATA },
        CbCountry { code: "PL", name: "Poland", data: PL_DATA },
        CbCountry { code: "TR", name: "Turkey", data: TR_DATA },
        CbCountry { code: "SG", name: "Singapore", data: SG_DATA },
        CbCountry { code: "CZ", name: "Czech Republic", data: CZ_DATA },
        CbCountry { code: "IQ", name: "Iraq", data: IQ_DATA },
        CbCountry { code: "AE", name: "United Arab Emirates", data: AE_DATA },
        CbCountry { code: "QA", name: "Qatar", data: QA_DATA },
        CbCountry { code: "US", name: "United States", data: US_DATA },
        CbCountry { code: "DE", name: "Germany", data: DE_DATA },
        CbCountry { code: "IT", name: "Italy", data: IT_DATA },
        CbCountry { code: "FR", name: "France", data: FR_DATA },
        CbCountry { code: "RU", name: "Russian Federation", data: RU_DATA },
        CbCountry { code: "CH", name: "Switzerland", data: CH_DATA },
        CbCountry { code: "JP", name: "Japan", data: JP_DATA },
        CbCountry { code: "NL", name: "Netherlands", data: NL_DATA },
        CbCountry { code: "PT", name: "Portugal", data: PT_DATA },
        CbCountry { code: "SA", name: "Saudi Arabia", data: SA_DATA },
        CbCountry { code: "GB", name: "United Kingdom", data: GB_DATA },
        CbCountry { code: "KZ", name: "Kazakhstan", data: KZ_DATA },
        CbCountry { code: "ES", name: "Spain", data: ES_DATA },
        CbCountry { code: "AT", name: "Austria", data: AT_DATA },
        CbCountry { code: "BE", name: "Belgium", data: BE_DATA },
        CbCountry { code: "PH", name: "Philippines", data: PH_DATA },
        CbCountry { code: "UZ", name: "Uzbekistan", data: UZ_DATA },
        CbCountry { code: "TH", name: "Thailand", data: TH_DATA },
        CbCountry { code: "HU", name: "Hungary", data: HU_DATA },
        CbCountry { code: "SE", name: "Sweden", data: SE_DATA },
        CbCountry { code: "EG", name: "Egypt", data: EG_DATA },
        CbCountry { code: "AU", name: "Australia", data: AU_DATA },
        CbCountry { code: "LY", name: "Libya", data: LY_DATA },
    ]
}

// ── VAULT NAMES for XLS parsing ────────────────────────────────────────────

const VAULT_NAMES: &[&str] = &[
    "ASAHI", "BRINK'S", "BRINKS", "DELAWARE DEPOSITORY", "HSBC BANK USA",
    "INTERNATIONAL DEPOSITORY SERVICES", "JP MORGAN CHASE", "JPMORGAN CHASE",
    "LOOMIS INTERNATIONAL", "MALCA-AMIT USA", "MALCA-AMIT ARMORED",
    "MANFRA TORDELLA", "STONEX PRECIOUS METALS", "CNT DEPOSITORY",
];

// ── UA Rotation ────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// ── SYNC HANDLERS ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── ETF Sync ───────────────────────────────────────────────────────────────

pub async fn etf_sync(State(state): State<Arc<AppState>>) -> AppResult {
    let mut inserted = 0i64;

    for &(ticker, ref entry) in ETF_BASELINE {
        let data = entry.data;
        for i in 0..data.len() {
            let (month, tonnes) = data[i];
            let prev_tonnes = if i > 0 { Some(data[i - 1].1) } else { None };
            let change = prev_tonnes.map(|p| tonnes - p);
            let oz = (tonnes * 32150.7).round() as i64;

            sqlx::query(
                "INSERT INTO etf_holdings (date, ticker, name, tonnes, change_tonnes, oz, source) \
                 VALUES ($1, $2, $3, $4, $5, $6, 'WGC/Issuer baseline') \
                 ON CONFLICT (date, ticker) DO UPDATE SET \
                   tonnes = EXCLUDED.tonnes, change_tonnes = EXCLUDED.change_tonnes, \
                   oz = EXCLUDED.oz, updated_at = NOW()"
            )
            .bind(month)
            .bind(ticker)
            .bind(entry.name)
            .bind(tonnes)
            .bind(change)
            .bind(oz)
            .execute(&state.pool)
            .await?;
            inserted += 1;
        }
    }

    Ok(Json(json!({
        "ok": true,
        "inserted": inserted,
        "source": "WGC/Issuer baseline",
        "tickers": ["GLD", "IAU", "SGOL"]
    })))
}

// ── LBMA Sync ──────────────────────────────────────────────────────────────

pub async fn lbma_sync(State(state): State<Arc<AppState>>) -> AppResult {
    let mut inserted = 0i64;

    for &(month, oz) in LBMA_DATA {
        let tonnes = oz as f64 / 32150.7;
        let tonnes_rounded = (tonnes * 100.0).round() / 100.0;

        sqlx::query(
            "INSERT INTO lbma_vault (month, gold_oz, gold_tonnes, source) \
             VALUES ($1, $2, $3, 'LBMA monthly report') \
             ON CONFLICT (month) DO UPDATE SET \
               gold_oz = EXCLUDED.gold_oz, gold_tonnes = EXCLUDED.gold_tonnes, updated_at = NOW()"
        )
        .bind(month)
        .bind(oz)
        .bind(tonnes_rounded)
        .execute(&state.pool)
        .await?;
        inserted += 1;
    }

    Ok(Json(json!({
        "ok": true,
        "inserted": inserted,
        "source": "LBMA monthly report"
    })))
}

// ── OI Sync ────────────────────────────────────────────────────────────────

pub async fn oi_sync(State(state): State<Arc<AppState>>) -> AppResult {
    let mut inserted = 0i64;

    for &(date, contracts) in OI_DATA {
        let oz = contracts * 100;

        sqlx::query(
            "INSERT INTO open_interest (date, metal, oi_contracts, oi_oz, source) \
             VALUES ($1, 'GOLD', $2, $3, 'CME preliminary') \
             ON CONFLICT (date, metal) DO UPDATE SET \
               oi_contracts = EXCLUDED.oi_contracts, oi_oz = EXCLUDED.oi_oz, updated_at = NOW()"
        )
        .bind(date)
        .bind(contracts as i32)
        .bind(oz)
        .execute(&state.pool)
        .await?;
        inserted += 1;
    }

    Ok(Json(json!({
        "ok": true,
        "inserted": inserted,
        "source": "CME preliminary OI"
    })))
}

// ── DXY Sync ───────────────────────────────────────────────────────────────

pub async fn dxy_sync(State(state): State<Arc<AppState>>) -> AppResult {
    let mut inserted = 0i64;

    for &(date, close) in DXY_DATA {
        sqlx::query(
            "INSERT INTO dxy_index (date, close, source) \
             VALUES ($1, $2, 'seed') \
             ON CONFLICT (date) DO UPDATE SET close = EXCLUDED.close, updated_at = NOW()"
        )
        .bind(date)
        .bind(close)
        .execute(&state.pool)
        .await?;
        inserted += 1;
    }

    Ok(Json(json!({
        "ok": true,
        "inserted": inserted,
        "source": "DXY index"
    })))
}

// ── CB Reserves Sync ───────────────────────────────────────────────────────

pub async fn cb_sync(State(state): State<Arc<AppState>>) -> AppResult {
    let baseline = wgc_baseline();
    let mut inserted = 0i64;

    // Batch rows
    struct CbRow {
        code: &'static str,
        name: &'static str,
        period: &'static str,
        tonnes: f64,
        change: f64,
    }

    let mut rows = Vec::new();
    for country in &baseline {
        for i in 0..country.data.len() {
            let (period, tonnes) = country.data[i];
            let prev_tonnes = if i > 0 { country.data[i - 1].1 } else { 0.0 };
            let change = if i > 0 { tonnes - prev_tonnes } else { 0.0 };
            rows.push(CbRow {
                code: country.code,
                name: country.name,
                period,
                tonnes,
                change,
            });
        }
    }

    for row in &rows {
        sqlx::query(
            "INSERT INTO cb_gold_reserves (country_code, country_name, period, tonnes, change_tonnes) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (country_code, period) \
             DO UPDATE SET tonnes = EXCLUDED.tonnes, change_tonnes = EXCLUDED.change_tonnes, updated_at = NOW()"
        )
        .bind(row.code)
        .bind(row.name)
        .bind(row.period)
        .bind(row.tonnes)
        .bind(row.change)
        .execute(&state.pool)
        .await?;
        inserted += 1;
    }

    Ok(Json(json!({
        "success": true,
        "recordsInserted": inserted,
        "source": "WGC Baseline",
        "message": format!("Loaded {} records from WGC baseline data", inserted)
    })))
}

// ── XLS Parsing ────────────────────────────────────────────────────────────

struct XlsParsed {
    report_date: String,
    registered: i32,
    eligible: i32,
    total: i32,
    vault_data: HashMap<String, (i32, i32)>,
}

fn parse_xls(data: &[u8], _metal: &str) -> Result<XlsParsed, String> {
    let cursor = Cursor::new(data);
    let mut workbook = open_workbook_auto_from_rs(cursor)
        .map_err(|e| format!("Failed to open XLS: {}", e))?;

    let sheet_name = workbook.sheet_names().first()
        .ok_or("No sheets found")?.to_string();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| format!("Failed to read sheet: {}", e))?;

    let rows: Vec<Vec<Data>> = range.rows().map(|r| r.to_vec()).collect();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut report_date = today;
    let mut registered: i32 = 0;
    let mut eligible: i32 = 0;
    let mut total: i32 = 0;

    // Search for date in first 20 rows
    for i in 0..rows.len().min(20) {
        let row_str: String = rows[i].iter().map(|c| cell_to_string(c)).collect::<Vec<_>>().join(" ").to_lowercase();
        if row_str.contains("as of date:") {
            let re = regex::Regex::new(r"(\d{1,2})/(\d{1,2})/(\d{2,4})").unwrap();
            if let Some(caps) = re.captures(&row_str) {
                let m = &caps[1];
                let d = &caps[2];
                let y = &caps[3];
                let full_year = if y.len() == 2 { format!("20{}", y) } else { y.to_string() };
                report_date = format!("{}-{:0>2}-{:0>2}", full_year, m, d);
            }
        }
    }

    // Search from bottom for totals
    for i in (0..rows.len()).rev() {
        let row_str: String = rows[i].iter().map(|c| cell_to_string(c)).collect::<Vec<_>>().join(" ").to_uppercase();

        if row_str.contains("TOTAL REGISTERED") {
            if let Some(n) = last_number_in_row(&rows[i]) {
                registered = n;
            }
        } else if row_str.contains("TOTAL ELIGIBLE") {
            if let Some(n) = last_number_in_row(&rows[i]) {
                eligible = n;
            }
        } else if row_str.contains("COMBINED TOTAL") {
            if let Some(n) = last_number_in_row(&rows[i]) {
                total = n;
            }
        }
        if registered > 0 && eligible > 0 && total > 0 {
            break;
        }
    }

    // Vault breakdown
    let mut vault_data: HashMap<String, (i32, i32)> = HashMap::new();

    for i in 0..rows.len() {
        let row_str: String = rows[i].iter().map(|c| cell_to_string(c)).collect::<Vec<_>>().join(" ").to_uppercase();

        for &vault_pattern in VAULT_NAMES {
            if row_str.contains(vault_pattern) {
                let mut v_reg: i32 = 0;
                let mut v_elig: i32 = 0;

                for j in (i + 1)..rows.len().min(i + 10) {
                    let next_str: String = rows[j].iter().map(|c| cell_to_string(c)).collect::<Vec<_>>().join(" ").to_uppercase();
                    if next_str.contains("REGISTERED") {
                        if let Some(n) = last_number_in_row(&rows[j]) {
                            v_reg = n;
                        }
                    } else if next_str.contains("ELIGIBLE") {
                        if let Some(n) = last_number_in_row(&rows[j]) {
                            v_elig = n;
                        }
                    }
                    if v_reg > 0 && v_elig > 0 {
                        break;
                    }
                    if next_str.contains("TOTAL") && !next_str.contains("REGISTERED") && !next_str.contains("ELIGIBLE") {
                        break;
                    }
                }
                if v_reg > 0 || v_elig > 0 {
                    let canonical = canonicalize_vault(vault_pattern);
                    vault_data.insert(canonical, (v_reg, v_elig));
                }
            }
        }
    }

    Ok(XlsParsed { report_date, registered, eligible, total, vault_data })
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Int(n) => n.to_string(),
        Data::Float(f) => f.to_string(),
        Data::String(s) => s.clone(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{:?}", e),
        Data::Empty => String::new(),
    }
}

fn last_number_in_row(row: &[Data]) -> Option<i32> {
    let mut last = None;
    for cell in row {
        match cell {
            Data::Float(f) => last = Some(f.round() as i32),
            Data::Int(n) => last = Some(*n as i32),
            _ => {}
        }
    }
    last
}

fn canonicalize_vault(pattern: &str) -> String {
    match pattern {
        "BRINKS" => "BRINK'S".to_string(),
        "JPMORGAN CHASE" => "JP MORGAN CHASE BANK NA".to_string(),
        "INTERNATIONAL DEPOSITORY SERVICES" => "INTERNATIONAL DEPOSITORY SERVICES OF DELAWARE".to_string(),
        "MANFRA TORDELLA" => "MANFRA TORDELLA & BROOKES".to_string(),
        other => other.to_string(),
    }
}

// ── PDF Text Parsing (regex-based) ─────────────────────────────────────────

#[allow(dead_code)]
struct PdfParsed {
    report_type: String,
    business_date: String,
    metals: HashMap<String, MetalSection>,
}

#[allow(dead_code)]
struct MetalSection {
    mtd: Option<i32>,
    settlement: Option<f64>,
    daily_issued: Option<i32>,
    daily_stopped: Option<i32>,
    ytd_by_month: Option<HashMap<String, i32>>,
    all_firms: Vec<FirmRow>,
}

#[allow(dead_code)]
struct FirmRow {
    firm: String,
    issued: i32,
    stopped: i32,
    org: String,
}

#[allow(dead_code)]
fn parse_cme_pdf_text(text: &str, filename: &str) -> PdfParsed {
    let lines: Vec<&str> = text.lines().collect();
    let header_line2 = lines.get(1).map(|l| l.to_uppercase()).unwrap_or_default();

    let report_type = if filename.contains("MTD") || header_line2.contains("MONTH TO DATE") {
        "MTD"
    } else if filename.contains("YTD") || header_line2.contains("YEAR TO DATE") {
        "YTD"
    } else {
        "DAILY"
    };

    let mut business_date = String::new();
    let date_re = regex::Regex::new(r"BUSINESS DATE:\s*(\d{1,2})/(\d{1,2})/(\d{4})").unwrap();
    for line in &lines {
        if let Some(caps) = date_re.captures(line) {
            business_date = format!("{}-{:0>2}-{:0>2}", &caps[3], &caps[1], &caps[2]);
            break;
        }
    }

    let mut metals: HashMap<String, MetalSection> = HashMap::new();
    let targets = [
        ("GOLD", regex::Regex::new(r"COMEX 100 GOLD FUTURES").unwrap()),
        ("SILVER", regex::Regex::new(r"COMEX 5000 SILVER FUTURES").unwrap()),
    ];

    for (metal, pattern) in &targets {
        let mut section_lines: Vec<String> = Vec::new();
        let mut in_section = false;

        for line in &lines {
            let upper = line.to_uppercase();
            if pattern.is_match(&upper) {
                in_section = true;
            } else if in_section && (upper.contains("CONTRACT:") || upper.contains("EXCHANGE:")) && !pattern.is_match(&upper) {
                in_section = false;
            }
            if in_section {
                section_lines.push(line.to_string());
            }
        }

        if !section_lines.is_empty() {
            metals.insert(metal.to_string(), process_section(&section_lines, report_type, metal));
        }
    }

    PdfParsed {
        report_type: report_type.to_string(),
        business_date,
        metals,
    }
}

#[allow(dead_code)]
fn process_section(lines: &[String], report_type: &str, _metal: &str) -> MetalSection {
    let mut result = MetalSection {
        mtd: None,
        settlement: None,
        daily_issued: None,
        daily_stopped: None,
        ytd_by_month: None,
        all_firms: Vec::new(),
    };

    match report_type {
        "MTD" => {
            let date_re = regex::Regex::new(r"\d{2}/\d{2}/\d{4}").unwrap();
            let mut date_rows: Vec<String> = Vec::new();
            for line in lines {
                if date_re.is_match(line) {
                    date_rows.push(line.trim().to_string());
                }
            }
            if let Some(last) = date_rows.last() {
                let parts: Vec<&str> = last.split_whitespace().collect();
                if parts.len() >= 3 {
                    let daily: i32 = parts[1].replace(',', "").parse().unwrap_or(0);
                    let cumulative: i32 = parts[2].replace(',', "").parse().unwrap_or(0);
                    result.mtd = Some(cumulative);
                    result.daily_stopped = Some(daily);
                }
            }
        }
        "DAILY" => {
            let settlement_re = regex::Regex::new(r"SETTLEMENT:\s*([\d,.]+)").unwrap();
            let firm_re = regex::Regex::new(r"^\s*(\d{3})\s+([CH])\s+(.+)$").unwrap();
            let two_nums_re = regex::Regex::new(r"^(.+?)\s+([\d,]+)\s+([\d,]+)\s*$").unwrap();
            let one_num_re = regex::Regex::new(r"^(.+?)\s+([\d,]+)\s*$").unwrap();

            let mut firm_totals: HashMap<String, (i32, i32, String)> = HashMap::new();

            for line in lines {
                let upper = line.to_uppercase();

                if let Some(caps) = settlement_re.captures(line) {
                    let price_str = caps[1].replace(',', "");
                    result.settlement = price_str.parse::<f64>().ok();
                }

                if let Some(caps) = firm_re.captures(line) {
                    let org = caps[2].to_string();
                    let rest = caps[3].to_string();
                    let mut firm_name = rest.trim().to_string();
                    let mut issued: i32 = 0;
                    let mut stopped: i32 = 0;

                    if let Some(nc) = two_nums_re.captures(&rest) {
                        firm_name = nc[1].trim().to_string();
                        issued = nc[2].replace(',', "").parse().unwrap_or(0);
                        stopped = nc[3].replace(',', "").parse().unwrap_or(0);
                    } else if let Some(nc) = one_num_re.captures(&rest) {
                        firm_name = nc[1].trim().to_string();
                        let num: i32 = nc[2].replace(',', "").parse().unwrap_or(0);
                        if let Some(pos) = line.rfind(&nc[2]) {
                            if pos > 50 { stopped = num; } else { issued = num; }
                        }
                    }

                    if issued > 0 || stopped > 0 {
                        let key = format!("{}||{}", firm_name, org);
                        let entry = firm_totals.entry(key).or_insert((0, 0, org.clone()));
                        entry.0 += issued;
                        entry.1 += stopped;
                    }
                }

                if upper.contains("TOTAL:") {
                    let parts: Vec<&str> = line.trim().split_whitespace().collect();
                    if let Some(idx) = parts.iter().position(|p| p.contains("TOTAL:")) {
                        let i_raw: i32 = parts.get(idx + 1).and_then(|s| s.replace(',', "").parse().ok()).unwrap_or(0);
                        let s_raw: i32 = parts.get(idx + 2).and_then(|s| s.replace(',', "").parse().ok()).unwrap_or(0);
                        result.daily_issued = Some(i_raw);
                        result.daily_stopped = Some(s_raw);
                    }
                }
            }

            result.all_firms = firm_totals.into_iter().map(|(key, (issued, stopped, org))| {
                let firm = key.split("||").next().unwrap_or("").to_string();
                FirmRow { firm, issued, stopped, org }
            }).collect();
        }
        "YTD" => {
            let month_keys = ["PREV_DEC","JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
            for line in lines {
                if line.trim().to_uppercase().starts_with("TOTALS:") {
                    let parts: Vec<&str> = line.split('|').map(|p| p.trim()).collect();
                    let mut ytd: HashMap<String, i32> = HashMap::new();
                    for j in 1..parts.len() {
                        if j - 1 >= month_keys.len() { break; }
                        if let Ok(val) = parts[j].replace(',', "").parse::<i32>() {
                            if val > 0 {
                                ytd.insert(month_keys[j - 1].to_string(), val);
                            }
                        }
                    }
                    if !ytd.is_empty() {
                        result.ytd_by_month = Some(ytd);
                    }
                    break;
                }
            }
        }
        _ => {}
    }

    result
}

// ── CME Sync (the big one) ─────────────────────────────────────────────────

#[axum::debug_handler]
pub async fn cme_sync(State(state): State<Arc<AppState>>) -> AppResult {
    // Rate limiting
    {
        let mut last = last_sync().lock().await;
        let elapsed = last.elapsed();
        if elapsed < SYNC_COOLDOWN {
            let retry_after = (SYNC_COOLDOWN - elapsed).as_secs();
            return Ok(Json(json!({
                "error": format!("Sync cooldown active. Try again in {}s.", retry_after)
            })));
        }
        *last = Instant::now();
    }

    let mut results = json!({
        "success": true,
        "files": {},
        "parsed": {},
        "errors": []
    });

    // Use Playwright (real Chrome) to download CME files
    let download_dir = "/tmp/cme-downloads";
    let script_path = std::path::Path::new("scripts/cme-download.mjs");

    tracing::info!("[cme_sync] Launching Playwright browser download…");

    let output = tokio::process::Command::new("node")
        .arg(script_path)
        .arg(download_dir)
        .current_dir(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()))
        .output()
        .await
        .map_err(|e| format!("Failed to launch download script: {}", e));

    let mut fetched: HashMap<String, Vec<u8>> = HashMap::new();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !out.status.success() {
                let msg = if stderr.is_empty() { stdout.to_string() } else { stderr.to_string() };
                tracing::error!("[cme_sync] Download script failed: {}", msg);
                results["errors"].as_array_mut().unwrap().push(json!({"file": "all", "message": msg}));
            } else {
                let download_results: serde_json::Value = serde_json::from_str(&stdout)
                    .unwrap_or_else(|_| json!({"error": "Failed to parse script output"}));

                for (key, info) in download_results.as_object().into_iter().flatten() {
                    let status = info["status"].as_u64().unwrap_or(0);
                    if status == 200 {
                        if let Some(path) = info["path"].as_str() {
                            match std::fs::read(path) {
                                Ok(data) => {
                                    tracing::info!("{} fetched ({} KB)", key, data.len() / 1024);
                                    results["files"][key] = json!({"status": 200, "bytes": data.len()});
                                    fetched.insert(key.clone(), data);
                                }
                                Err(e) => {
                                    tracing::error!("Failed to read {}: {}", path, e);
                                    results["errors"].as_array_mut().unwrap().push(json!({"file": key, "message": e.to_string()}));
                                }
                            }
                        }
                    } else {
                        let err = info["error"].as_str().unwrap_or("unknown error");
                        tracing::error!("Failed to fetch {}: {}", key, err);
                        results["errors"].as_array_mut().unwrap().push(json!({"file": key, "message": err}));
                    }
                }
            }
        }
        Err(e) => {
            tracing::error!("[cme_sync] {}", e);
            results["errors"].as_array_mut().unwrap().push(json!({"file": "all", "message": e}));
        }
    }

    // Process XLS files
    for (key, metal) in &[("goldXls", "GOLD"), ("silverXls", "SILVER")] {
        if let Some(data) = fetched.get(*key) {
            match process_xls_data(data, metal, &state.pool).await {
                Ok(date) => {
                    results["parsed"][*key] = json!(date);
                }
                Err(e) => {
                    tracing::error!("Failed to process {} XLS: {}", metal, e);
                    results["errors"].as_array_mut().unwrap().push(json!({
                        "file": format!("{}Xls", metal.to_lowercase()),
                        "message": e
                    }));
                }
            }
        }
    }

    // Process PDF files
    let pdf_files: Vec<(&str, &str)> = vec![
        ("mtdPdf", "MetalsIssuesAndStopsMTDReport.pdf"),
        ("dailyPdf", "MetalsIssuesAndStopsReport.pdf"),
        ("ytdPdf", "MetalsIssuesAndStopsYTDReport.pdf"),
    ];

    for (key, filename) in &pdf_files {
        if let Some(data) = fetched.get(*key) {
            match process_pdf_data(data, filename, &state.pool).await {
                Ok(date) => {
                    results["parsed"][*key] = json!(date);
                }
                Err(e) => {
                    tracing::error!("Failed to process {}: {}", filename, e);
                    results["errors"].as_array_mut().unwrap().push(json!({
                        "file": filename,
                        "message": e
                    }));
                }
            }
        }
    }

    if !results["errors"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        results["success"] = json!(false);
    }

    Ok(Json(results))
}

fn extract_pdf_text(data: &[u8]) -> Result<String, String> {
    pdf_extract::extract_text_from_mem(data).map_err(|e| format!("PDF extraction failed: {}", e))
}

async fn process_pdf_data(data: &[u8], filename: &str, pool: &PgPool) -> Result<String, String> {
    let text = extract_pdf_text(data)?;
    let parsed = parse_cme_pdf_text(&text, filename);

    if parsed.business_date.is_empty() {
        tracing::warn!("No business date found in {} — skipping DB write", filename);
        return Ok("NOT FOUND".to_string());
    }

    let report_date = &parsed.business_date;

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    for (metal, details) in &parsed.metals {
        sqlx::query(
            "INSERT INTO metals_summary (date, metal, report_type, mtd, settlement, daily_issued, daily_stopped, ytd_json) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT(date, metal, report_type) DO UPDATE SET \
               mtd = EXCLUDED.mtd, settlement = EXCLUDED.settlement, \
               daily_issued = EXCLUDED.daily_issued, daily_stopped = EXCLUDED.daily_stopped, \
               ytd_json = EXCLUDED.ytd_json"
        )
        .bind(report_date)
        .bind(metal)
        .bind(&parsed.report_type)
        .bind(details.mtd)
        .bind(details.settlement.map(|s| s as f32))
        .bind(details.daily_issued)
        .bind(details.daily_stopped)
        .bind(details.ytd_by_month.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default()))
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        if parsed.report_type == "DAILY" && !details.all_firms.is_empty() {
            tracing::info!("Inserting {} delivery notice rows for {}", details.all_firms.len(), metal);
            for firm in &details.all_firms {
                let account_type = if firm.org == "C" { "CUSTOMER" } else { "HOUSE" };
                sqlx::query(
                    "INSERT INTO delivery_notices (date, firm, issued, stopped, metal, account_type) \
                     VALUES ($1, $2, $3, $4, $5, $6) \
                     ON CONFLICT(date, firm, metal, account_type) DO UPDATE SET \
                       issued = EXCLUDED.issued, stopped = EXCLUDED.stopped"
                )
                .bind(report_date)
                .bind(&firm.firm)
                .bind(firm.issued)
                .bind(firm.stopped)
                .bind(metal)
                .bind(account_type)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(report_date.clone())
}

async fn process_xls_data(data: &[u8], metal: &str, pool: &PgPool) -> Result<String, String> {
    let parsed = parse_xls(data, metal)?;

    // Calculate deltas vs previous row
    let prev = sqlx::query(
        "SELECT registered_oz, eligible_oz FROM warehouse_stocks WHERE metal = $1 AND date < $2 ORDER BY date DESC LIMIT 1"
    )
    .bind(metal)
    .bind(&parsed.report_date)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let (daily_change_registered, daily_change_eligible, delta_label) = match prev {
        Some(row) => {
            let prev_reg: i32 = row.get("registered_oz");
            let prev_elig: i32 = row.get("eligible_oz");
            (
                Some(parsed.registered - prev_reg),
                Some(parsed.eligible - prev_elig),
                "24h Change".to_string(),
            )
        }
        None => (None, None, "—".to_string()),
    };

    // Transaction: upsert warehouse + vault stocks
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    sqlx::query(
        "INSERT INTO warehouse_stocks (date, metal, registered_oz, eligible_oz, total_oz, daily_change_registered, daily_change_eligible, delta_label) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT(date, metal) DO UPDATE SET \
           registered_oz = EXCLUDED.registered_oz, eligible_oz = EXCLUDED.eligible_oz, \
           total_oz = EXCLUDED.total_oz, daily_change_registered = EXCLUDED.daily_change_registered, \
           daily_change_eligible = EXCLUDED.daily_change_eligible, delta_label = EXCLUDED.delta_label"
    )
    .bind(&parsed.report_date)
    .bind(metal)
    .bind(parsed.registered)
    .bind(parsed.eligible)
    .bind(parsed.total)
    .bind(daily_change_registered)
    .bind(daily_change_eligible)
    .bind(&delta_label)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    for (vault, (v_reg, v_elig)) in &parsed.vault_data {
        sqlx::query(
            "INSERT INTO vault_stocks (date, vault, metal, registered_oz, eligible_oz) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT(date, vault, metal) DO UPDATE SET \
               registered_oz = EXCLUDED.registered_oz, eligible_oz = EXCLUDED.eligible_oz"
        )
        .bind(&parsed.report_date)
        .bind(vault)
        .bind(metal)
        .bind(*v_reg)
        .bind(*v_elig)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    // Retention cleanup
    let oldest = sqlx::query(
        &format!(
            "SELECT date FROM warehouse_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 1 OFFSET {}",
            RETENTION_DAYS - 1
        )
    )
    .bind(metal)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(row) = oldest {
        let oldest_date: String = row.get("date");
        sqlx::query("DELETE FROM warehouse_stocks WHERE metal = $1 AND date < $2")
            .bind(metal)
            .bind(&oldest_date)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM vault_stocks WHERE metal = $1 AND date < $2")
            .bind(metal)
            .bind(&oldest_date)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(parsed.report_date)
}
