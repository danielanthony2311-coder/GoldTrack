use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc};

use crate::AppState;

pub type AppResult = Result<Json<Value>, AppError>;

pub struct AppError(pub String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": self.0}))).into_response()
    }
}

impl<E: std::fmt::Display> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.to_string())
    }
}

fn metal_param(m: &Option<String>) -> String {
    match m.as_deref().map(|s| s.to_uppercase()).as_deref() {
        Some("GOLD") | Some("SILVER") => m.as_ref().unwrap().to_uppercase(),
        _ => "GOLD".into(),
    }
}

// ── CME Warehouse & Delivery ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct MetalQuery {
    pub metal: Option<String>,
}

pub async fn cme_latest_stocks(
    State(state): State<Arc<AppState>>,
    Query(q): Query<MetalQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let rows = sqlx::query(
        "SELECT * FROM warehouse_stocks WHERE metal = $1 ORDER BY date ASC",
    )
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let result: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.get::<i64, _>("id"),
        "date": r.get::<String, _>("date"),
        "metal": r.get::<String, _>("metal"),
        "registered_oz": r.get::<i32, _>("registered_oz"),
        "eligible_oz": r.get::<i32, _>("eligible_oz"),
        "total_oz": r.get::<i32, _>("total_oz"),
        "daily_change_registered": r.get::<Option<i32>, _>("daily_change_registered"),
        "daily_change_eligible": r.get::<Option<i32>, _>("daily_change_eligible"),
        "delta_label": r.get::<Option<String>, _>("delta_label"),
    })).collect();

    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct SummaryQuery {
    pub metal: Option<String>,
    #[serde(rename = "type")]
    pub report_type: Option<String>,
}

pub async fn cme_summary(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SummaryQuery>,
) -> AppResult {
    let mut query = String::from("SELECT * FROM metals_summary WHERE 1=1");
    let mut params: Vec<String> = vec![];

    if let Some(ref m) = q.metal {
        params.push(m.clone());
        query.push_str(&format!(" AND metal = ${}", params.len()));
    }
    if let Some(ref t) = q.report_type {
        params.push(t.clone());
        query.push_str(&format!(" AND report_type = ${}", params.len()));
    }
    query.push_str(" ORDER BY date DESC LIMIT 50");

    let mut sql = sqlx::query(&query);
    for p in &params {
        sql = sql.bind(p);
    }
    let rows = sql.fetch_all(&state.pool).await?;

    let result: Vec<Value> = rows.iter().map(|r| {
        let ytd_json: Option<String> = r.get("ytd_json");
        let ytd_by_month: Option<Value> = ytd_json.and_then(|s| serde_json::from_str(&s).ok());
        json!({
            "id": r.get::<i64, _>("id"),
            "date": r.get::<String, _>("date"),
            "metal": r.get::<String, _>("metal"),
            "report_type": r.get::<String, _>("report_type"),
            "mtd": r.get::<Option<i32>, _>("mtd"),
            "settlement": r.get::<Option<f32>, _>("settlement"),
            "daily_issued": r.get::<Option<i32>, _>("daily_issued"),
            "daily_stopped": r.get::<Option<i32>, _>("daily_stopped"),
            "ytd_json": r.get::<Option<String>, _>("ytd_json"),
            "ytd_by_month": ytd_by_month,
        })
    }).collect();

    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct NoticesQuery {
    pub metal: Option<String>,
    pub date: Option<String>,
}

pub async fn cme_latest_notices(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NoticesQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let date = match q.date {
        Some(d) => d,
        None => {
            let row = sqlx::query(
                "SELECT date FROM delivery_notices WHERE metal = $1 ORDER BY date DESC LIMIT 1",
            )
            .bind(&metal)
            .fetch_optional(&state.pool)
            .await?;
            match row {
                Some(r) => r.get("date"),
                None => return Ok(Json(json!([]))),
            }
        }
    };

    let rows = sqlx::query(
        "SELECT * FROM delivery_notices WHERE date = $1 AND metal = $2 ORDER BY stopped DESC, issued DESC",
    )
    .bind(&date)
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let result: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.get::<i64, _>("id"),
        "date": r.get::<String, _>("date"),
        "firm": r.get::<String, _>("firm"),
        "issued": r.get::<i32, _>("issued"),
        "stopped": r.get::<i32, _>("stopped"),
        "metal": r.get::<String, _>("metal"),
        "account_type": r.get::<String, _>("account_type"),
    })).collect();

    Ok(Json(json!(result)))
}

pub async fn cme_vault_breakdown(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NoticesQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let date = match q.date {
        Some(d) => d,
        None => {
            let row = sqlx::query(
                "SELECT date FROM vault_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 1",
            )
            .bind(&metal)
            .fetch_optional(&state.pool)
            .await?;
            match row {
                Some(r) => r.get("date"),
                None => return Ok(Json(json!([]))),
            }
        }
    };

    let rows = sqlx::query(
        "SELECT * FROM vault_stocks WHERE date = $1 AND metal = $2 ORDER BY (registered_oz + eligible_oz) DESC",
    )
    .bind(&date)
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let result: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.get::<i64, _>("id"),
        "date": r.get::<String, _>("date"),
        "vault": r.get::<String, _>("vault"),
        "metal": r.get::<String, _>("metal"),
        "registered_oz": r.get::<i32, _>("registered_oz"),
        "eligible_oz": r.get::<i32, _>("eligible_oz"),
    })).collect();

    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct FirmFlowsQuery {
    pub metal: Option<String>,
    pub days: Option<i32>,
}

pub async fn cme_firm_flows(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FirmFlowsQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let days = q.days.unwrap_or(30).clamp(1, 90);

    let rows = sqlx::query(
        r#"SELECT date, firm, metal,
               SUM(issued) as total_issued,
               SUM(stopped) as total_stopped,
               SUM(stopped) - SUM(issued) as net,
               STRING_AGG(DISTINCT account_type, ',') as account_types
        FROM delivery_notices
        WHERE metal = $1
          AND date >= (CURRENT_DATE - ($2 * INTERVAL '1 day'))::DATE::TEXT
        GROUP BY date, firm, metal
        ORDER BY date ASC, net DESC"#,
    )
    .bind(&metal)
    .bind(days)
    .fetch_all(&state.pool)
    .await?;

    let mut dates: Vec<String> = vec![];
    let mut firm_totals: HashMap<String, (i64, i64, i64, i32)> = HashMap::new();

    let daily_data: Vec<Value> = rows.iter().map(|r| {
        let date: String = r.get("date");
        let firm: String = r.get("firm");
        let total_issued: i64 = r.get("total_issued");
        let total_stopped: i64 = r.get("total_stopped");
        let net: i64 = r.get("net");

        if !dates.contains(&date) { dates.push(date.clone()); }
        let entry = firm_totals.entry(firm.clone()).or_insert((0, 0, 0, 0));
        entry.0 += total_stopped;
        entry.1 += total_issued;
        entry.2 += net;
        entry.3 += 1;

        json!({
            "date": date,
            "firm": firm,
            "metal": r.get::<String, _>("metal"),
            "total_issued": total_issued,
            "total_stopped": total_stopped,
            "net": net,
            "account_types": r.get::<Option<String>, _>("account_types"),
        })
    }).collect();

    let mut top_firms: Vec<Value> = firm_totals.iter().map(|(firm, (stopped, issued, net, days))| {
        json!({
            "firm": firm,
            "totalStopped": stopped,
            "totalIssued": issued,
            "net": net,
            "days": days,
        })
    }).collect();
    top_firms.sort_by(|a, b| {
        let an = a["net"].as_i64().unwrap_or(0).abs();
        let bn = b["net"].as_i64().unwrap_or(0).abs();
        bn.cmp(&an)
    });
    top_firms.truncate(15);

    dates.sort();

    Ok(Json(json!({
        "dates": dates,
        "topFirms": top_firms,
        "dailyData": daily_data,
        "metal": metal,
        "daysRequested": days,
    })))
}

// ── Prices & Signals ────────────────────────────────────────────────────────

pub async fn prices_sync(State(state): State<Arc<AppState>>) -> AppResult {
    let row = sqlx::query(
        r#"SELECT COUNT(*)::int AS n, MAX(date) AS latest
         FROM metals_summary
         WHERE metal = 'GOLD' AND settlement IS NOT NULL"#,
    )
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "ok": true,
        "source": "metals_summary.settlement (CME MTD PDF)",
        "rowCount": row.get::<i32, _>("n"),
        "latestDate": row.get::<Option<String>, _>("latest"),
        "note": "Prices are synced as part of /api/cme/sync — no separate fetch needed.",
    })))
}

pub async fn prices_latest(
    State(state): State<Arc<AppState>>,
    Query(q): Query<MetalQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let rows = sqlx::query(
        r#"SELECT DISTINCT ON (date) date, settlement
         FROM metals_summary
         WHERE metal = $1 AND settlement IS NOT NULL
         ORDER BY date DESC,
           CASE report_type WHEN 'DAILY' THEN 0 WHEN 'MTD' THEN 1 ELSE 2 END
         LIMIT 30"#,
    )
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let chrono: Vec<(String, f64)> = rows.iter().rev().map(|r| {
        (r.get::<String, _>("date"), r.get::<f32, _>("settlement") as f64)
    }).collect();

    let enriched: Vec<Value> = chrono.iter().enumerate().map(|(i, (date, close))| {
        let (change_usd, change_pct) = if i > 0 {
            let prev = chrono[i - 1].1;
            if prev != 0.0 {
                (Some(close - prev), Some(((close - prev) / prev) * 100.0))
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
        json!({
            "date": date,
            "close": close,
            "changeUsd": change_usd,
            "changePct": change_pct.map(|v| (v * 100.0).round() / 100.0),
            "source": "CME settlement",
        })
    }).rev().collect();

    Ok(Json(json!({ "prices": enriched })))
}

pub async fn signal_history(State(state): State<Arc<AppState>>) -> AppResult {
    let price_rows = sqlx::query(
        r#"SELECT DISTINCT ON (date) date, settlement
         FROM metals_summary
         WHERE metal = 'GOLD' AND settlement IS NOT NULL
         ORDER BY date DESC,
           CASE report_type WHEN 'DAILY' THEN 0 WHEN 'MTD' THEN 1 ELSE 2 END
         LIMIT 35"#,
    )
    .fetch_all(&state.pool)
    .await?;

    let stock_rows = sqlx::query(
        r#"SELECT date::TEXT AS date, daily_change_registered
         FROM warehouse_stocks
         WHERE metal = 'GOLD'
         ORDER BY date DESC
         LIMIT 35"#,
    )
    .fetch_all(&state.pool)
    .await?;

    let mut stock_map: HashMap<String, i32> = HashMap::new();
    for r in &stock_rows {
        let d: String = r.get("date");
        let change: Option<i32> = r.get("daily_change_registered");
        stock_map.insert(d, change.unwrap_or(0));
    }

    let chrono: Vec<(String, f64)> = price_rows.iter().rev().map(|r| {
        (r.get::<String, _>("date"), r.get::<f32, _>("settlement") as f64)
    }).collect();

    let mut signals: Vec<Value> = vec![];
    for i in 0..chrono.len() {
        let (ref date, close) = chrono[i];
        let prev = if i > 0 { Some(chrono[i - 1].1) } else { None };
        let price_pct = prev.and_then(|p| if p != 0.0 { Some(((close - p) / p) * 100.0) } else { None });
        let reg_change = *stock_map.get(date).unwrap_or(&0);

        let start = if i >= 2 { i - 2 } else { 0 };
        let window = &chrono[start..=i];
        let avg_pct: f64 = window.iter().enumerate().map(|(wi, (_, c))| {
            let p = if wi > 0 { window[wi - 1].1 } else if start + wi > 0 { chrono[start + wi - 1].1 } else { *c };
            if p != 0.0 { ((*c - p) / p) * 100.0 } else { 0.0 }
        }).sum::<f64>() / window.len() as f64;

        let total_reg: i32 = window.iter().map(|(d, _)| *stock_map.get(d).unwrap_or(&0)).sum();

        let signal = if avg_pct.abs() >= 0.1 || (total_reg.abs() >= 5000) {
            let up = avg_pct > 0.0;
            let s_up = total_reg > 0;
            let s_down = total_reg < 0;
            if up && s_down { "BULLISH" }
            else if !up && s_up { "MIXED" }
            else if up && s_up { "CAUTIOUS" }
            else if !up && s_down { "BEARISH" }
            else { "QUIET" }
        } else {
            "QUIET"
        };

        if i >= 2 {
            signals.push(json!({
                "date": date,
                "close": close,
                "pricePct": price_pct.map(|v| (v * 100.0).round() / 100.0),
                "regChange": reg_change,
                "signal": signal,
            }));
        }
    }

    signals.reverse();
    Ok(Json(json!({ "history": signals })))
}

// ── ETF Holdings ────────────────────────────────────────────────────────────

pub async fn etf_holdings(State(state): State<Arc<AppState>>) -> AppResult {
    let latest = sqlx::query(
        r#"SELECT DISTINCT ON (ticker) ticker, name, date, tonnes, change_tonnes, oz
         FROM etf_holdings
         ORDER BY ticker, date DESC"#,
    )
    .fetch_all(&state.pool)
    .await?;

    let history = sqlx::query(
        r#"SELECT ticker, date, tonnes, change_tonnes
         FROM etf_holdings
         WHERE date >= (to_char(CURRENT_DATE - INTERVAL '12 months', 'YYYY-MM'))
         ORDER BY ticker, date ASC"#,
    )
    .fetch_all(&state.pool)
    .await?;

    let total_tonnes: f64 = latest.iter().map(|r| {
        let v: sqlx::types::BigDecimal = r.get("tonnes");
        v.to_string().parse::<f64>().unwrap_or(0.0)
    }).sum();

    let total_oz: f64 = latest.iter().map(|r| {
        let v: Option<sqlx::types::BigDecimal> = r.get("oz");
        v.map(|d| d.to_string().parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0)
    }).sum();

    let funds: Vec<Value> = latest.iter().map(|r| {
        let tonnes: sqlx::types::BigDecimal = r.get("tonnes");
        let change: Option<sqlx::types::BigDecimal> = r.get("change_tonnes");
        let oz: Option<sqlx::types::BigDecimal> = r.get("oz");
        json!({
            "ticker": r.get::<String, _>("ticker"),
            "name": r.get::<String, _>("name"),
            "date": r.get::<String, _>("date"),
            "tonnes": tonnes.to_string().parse::<f64>().unwrap_or(0.0),
            "changeTonnes": change.map(|d| d.to_string().parse::<f64>().unwrap_or(0.0)),
            "oz": oz.map(|d| d.to_string().parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0),
        })
    }).collect();

    let hist: Vec<Value> = history.iter().map(|r| {
        let tonnes: sqlx::types::BigDecimal = r.get("tonnes");
        let change: Option<sqlx::types::BigDecimal> = r.get("change_tonnes");
        json!({
            "ticker": r.get::<String, _>("ticker"),
            "date": r.get::<String, _>("date"),
            "tonnes": tonnes.to_string().parse::<f64>().unwrap_or(0.0),
            "change": change.map(|d| d.to_string().parse::<f64>().unwrap_or(0.0)),
        })
    }).collect();

    Ok(Json(json!({
        "funds": funds,
        "totalTonnes": (total_tonnes * 10.0).round() / 10.0,
        "totalOz": total_oz.round(),
        "history": hist,
    })))
}

// ── LBMA ────────────────────────────────────────────────────────────────────

pub async fn lbma_latest(State(state): State<Arc<AppState>>) -> AppResult {
    let rows = sqlx::query(
        "SELECT month, gold_oz, gold_tonnes FROM lbma_vault ORDER BY month DESC LIMIT 24",
    )
    .fetch_all(&state.pool)
    .await?;

    let vaults: Vec<Value> = rows.iter().map(|r| {
        let oz: sqlx::types::BigDecimal = r.get("gold_oz");
        let tonnes: sqlx::types::BigDecimal = r.get("gold_tonnes");
        json!({
            "month": r.get::<String, _>("month"),
            "goldOz": oz.to_string().parse::<f64>().unwrap_or(0.0),
            "goldTonnes": tonnes.to_string().parse::<f64>().unwrap_or(0.0),
        })
    }).collect();

    Ok(Json(json!({ "vaults": vaults })))
}

// ── Open Interest ───────────────────────────────────────────────────────────

pub async fn oi_latest(
    State(state): State<Arc<AppState>>,
    Query(q): Query<MetalQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);

    let oi_rows = sqlx::query(
        "SELECT date, oi_contracts, oi_oz FROM open_interest WHERE metal = $1 ORDER BY date DESC LIMIT 90",
    )
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let reg_rows = sqlx::query(
        "SELECT date, registered_oz FROM warehouse_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 90",
    )
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let mut reg_map: HashMap<String, i32> = HashMap::new();
    for r in &reg_rows {
        reg_map.insert(r.get("date"), r.get("registered_oz"));
    }

    let data: Vec<Value> = oi_rows.iter().map(|r| {
        let date: String = r.get("date");
        let oi_contracts: i32 = r.get("oi_contracts");
        let oi_oz: sqlx::types::BigDecimal = r.get("oi_oz");
        let oi_oz_f = oi_oz.to_string().parse::<f64>().unwrap_or(0.0);
        let reg_oz = reg_map.get(&date).copied();
        let coverage = reg_oz.and_then(|reg| {
            if oi_oz_f > 0.0 { Some(((reg as f64 / oi_oz_f) * 100.0 * 100.0).round() / 100.0) } else { None }
        });
        json!({
            "date": date,
            "oiContracts": oi_contracts,
            "oiOz": oi_oz_f,
            "registeredOz": reg_oz,
            "coverageRatio": coverage,
        })
    }).collect();

    Ok(Json(json!({ "data": data })))
}

// ── Central Bank Reserves ───────────────────────────────────────────────────

pub async fn cb_reserves(State(state): State<Arc<AppState>>) -> AppResult {
    let rows = sqlx::query(
        "SELECT country_code, country_name, period, tonnes, change_tonnes FROM cb_gold_reserves ORDER BY period DESC, tonnes DESC",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut periods: HashMap<String, Vec<Value>> = HashMap::new();
    for r in &rows {
        let period: String = r.get("period");
        let tonnes: sqlx::types::BigDecimal = r.get("tonnes");
        let change: sqlx::types::BigDecimal = r.get("change_tonnes");
        let entry = json!({
            "country_code": r.get::<String, _>("country_code"),
            "country_name": r.get::<String, _>("country_name"),
            "period": &period,
            "tonnes": tonnes.to_string().parse::<f64>().unwrap_or(0.0),
            "change_tonnes": change.to_string().parse::<f64>().unwrap_or(0.0),
        });
        periods.entry(period).or_default().push(entry);
    }

    Ok(Json(json!({ "periods": periods, "totalRecords": rows.len() })))
}

// ── DXY ─────────────────────────────────────────────────────────────────────

pub async fn dxy_latest(State(state): State<Arc<AppState>>) -> AppResult {
    let rows = sqlx::query("SELECT date, close FROM dxy_index ORDER BY date DESC LIMIT 90")
        .fetch_all(&state.pool)
        .await?;

    let data: Vec<Value> = rows.iter().map(|r| {
        let close: sqlx::types::BigDecimal = r.get("close");
        json!({
            "date": r.get::<String, _>("date"),
            "close": close.to_string().parse::<f64>().unwrap_or(0.0),
        })
    }).collect();

    Ok(Json(json!({ "data": data })))
}

// ── Institutional ───────────────────────────────────────────────────────────

pub async fn institutional_latest(
    State(state): State<Arc<AppState>>,
    Query(q): Query<MetalQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let date_row = sqlx::query(
        "SELECT report_date FROM institutional_activity WHERE metal = $1 ORDER BY report_date DESC LIMIT 1",
    )
    .bind(&metal)
    .fetch_optional(&state.pool)
    .await?;

    let date: String = match date_row {
        Some(r) => r.get("report_date"),
        None => return Ok(Json(json!({ "data": [], "summary": null }))),
    };

    let activity = sqlx::query(
        "SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2 ORDER BY net_position DESC",
    )
    .bind(&date)
    .bind(&metal)
    .fetch_all(&state.pool)
    .await?;

    let summary = sqlx::query(
        "SELECT * FROM institutional_daily_summary WHERE report_date = $1 AND metal = $2",
    )
    .bind(&date)
    .bind(&metal)
    .fetch_optional(&state.pool)
    .await?;

    let data: Vec<Value> = activity.iter().map(|r| {
        json!({
            "firm_code": r.get::<String, _>("firm_code"),
            "firm_name": r.get::<String, _>("firm_name"),
            "metal": r.get::<String, _>("metal"),
            "customer_issued": r.get::<i32, _>("customer_issued"),
            "house_issued": r.get::<i32, _>("house_issued"),
            "total_issued": r.get::<i32, _>("total_issued"),
            "customer_stopped": r.get::<i32, _>("customer_stopped"),
            "house_stopped": r.get::<i32, _>("house_stopped"),
            "total_stopped": r.get::<i32, _>("total_stopped"),
            "net_position": r.get::<i32, _>("net_position"),
            "is_net_buyer": r.get::<bool, _>("is_net_buyer"),
            "report_date": r.get::<String, _>("report_date"),
        })
    }).collect();

    let sum_val = summary.map(|r| json!({
        "total_contracts": r.get::<i32, _>("total_contracts"),
        "total_issued": r.get::<i32, _>("total_issued"),
        "total_stopped": r.get::<i32, _>("total_stopped"),
        "net_market_position": r.get::<i32, _>("net_market_position"),
        "firms_count": r.get::<i32, _>("firms_count"),
        "net_buyers_count": r.get::<i32, _>("net_buyers_count"),
        "net_sellers_count": r.get::<i32, _>("net_sellers_count"),
        "top_buyers": r.get::<Option<Value>, _>("top_buyers"),
        "top_sellers": r.get::<Option<Value>, _>("top_sellers"),
    }));

    Ok(Json(json!({ "data": data, "summary": sum_val, "date": date })))
}

#[derive(Deserialize)]
pub struct TopTradersQuery {
    pub metal: Option<String>,
    pub date: Option<String>,
    pub limit: Option<i32>,
}

pub async fn institutional_top_traders(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TopTradersQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let limit = q.limit.unwrap_or(10).clamp(1, 50);

    let date = match q.date {
        Some(d) => d,
        None => {
            let row = sqlx::query(
                "SELECT report_date FROM institutional_activity WHERE metal = $1 ORDER BY report_date DESC LIMIT 1",
            )
            .bind(&metal)
            .fetch_optional(&state.pool)
            .await?;
            match row {
                Some(r) => r.get("report_date"),
                None => return Ok(Json(json!({ "buyers": [], "sellers": [], "date": null }))),
            }
        }
    };

    let buyers = sqlx::query(
        "SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2 ORDER BY net_position DESC LIMIT $3",
    )
    .bind(&date).bind(&metal).bind(limit)
    .fetch_all(&state.pool).await?;

    let sellers = sqlx::query(
        "SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2 ORDER BY net_position ASC LIMIT $3",
    )
    .bind(&date).bind(&metal).bind(limit)
    .fetch_all(&state.pool).await?;

    let map_row = |r: &sqlx::postgres::PgRow| json!({
        "firm_code": r.get::<String, _>("firm_code"),
        "firm_name": r.get::<String, _>("firm_name"),
        "net_position": r.get::<i32, _>("net_position"),
        "total_issued": r.get::<i32, _>("total_issued"),
        "total_stopped": r.get::<i32, _>("total_stopped"),
        "is_net_buyer": r.get::<bool, _>("is_net_buyer"),
    });

    Ok(Json(json!({
        "buyers": buyers.iter().map(map_row).collect::<Vec<_>>(),
        "sellers": sellers.iter().map(map_row).collect::<Vec<_>>(),
        "date": date,
    })))
}

#[derive(Deserialize)]
pub struct FirmQuery {
    pub metal: Option<String>,
    pub days: Option<i32>,
}

pub async fn institutional_firm(
    State(state): State<Arc<AppState>>,
    Path(firm_name): Path<String>,
    Query(q): Query<FirmQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let pattern = format!("%{}%", firm_name);

    let rows = sqlx::query(
        r#"SELECT * FROM institutional_activity
         WHERE (firm_name ILIKE $1 OR firm_code = $2) AND metal = $3
           AND report_date >= (CURRENT_DATE - ($4 * INTERVAL '1 day'))::TEXT
         ORDER BY report_date DESC"#,
    )
    .bind(&pattern).bind(&firm_name).bind(&metal).bind(days)
    .fetch_all(&state.pool).await?;

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "report_date": r.get::<String, _>("report_date"),
        "firm_code": r.get::<String, _>("firm_code"),
        "firm_name": r.get::<String, _>("firm_name"),
        "net_position": r.get::<i32, _>("net_position"),
        "total_issued": r.get::<i32, _>("total_issued"),
        "total_stopped": r.get::<i32, _>("total_stopped"),
    })).collect();

    Ok(Json(json!(data)))
}

#[derive(Deserialize)]
pub struct CompareQuery {
    pub date1: Option<String>,
    pub date2: Option<String>,
    pub metal: Option<String>,
}

pub async fn institutional_compare(
    State(state): State<Arc<AppState>>,
    Query(q): Query<CompareQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let (date1, date2) = match (&q.date1, &q.date2) {
        (Some(d1), Some(d2)) => (d1.clone(), d2.clone()),
        _ => return Err(AppError("date1 and date2 are required".into())),
    };

    let r1 = sqlx::query("SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2")
        .bind(&date1).bind(&metal).fetch_all(&state.pool).await?;
    let r2 = sqlx::query("SELECT * FROM institutional_activity WHERE report_date = $1 AND metal = $2")
        .bind(&date2).bind(&metal).fetch_all(&state.pool).await?;

    let mut map1: HashMap<String, (String, i32)> = HashMap::new();
    let mut map2: HashMap<String, (String, i32)> = HashMap::new();
    for r in &r1 {
        let code: String = r.get("firm_code");
        map1.insert(code, (r.get("firm_name"), r.get("net_position")));
    }
    for r in &r2 {
        let code: String = r.get("firm_code");
        map2.insert(code, (r.get("firm_name"), r.get("net_position")));
    }

    let mut all_codes: Vec<String> = map1.keys().chain(map2.keys()).cloned().collect();
    all_codes.sort();
    all_codes.dedup();

    let mut comparison: Vec<Value> = all_codes.iter().map(|code| {
        let pos_a = map1.get(code).map(|v| v.1).unwrap_or(0);
        let pos_b = map2.get(code).map(|v| v.1).unwrap_or(0);
        let name = map1.get(code).map(|v| &v.0).or_else(|| map2.get(code).map(|v| &v.0)).unwrap();
        let trend = if pos_a > pos_b { "increasing_buy" } else if pos_a < pos_b { "increasing_sell" } else { "unchanged" };
        json!({
            "firm_code": code,
            "firm_name": name,
            "date1_net": pos_a,
            "date2_net": pos_b,
            "change": pos_a - pos_b,
            "trend": trend,
            "is_new": !map2.contains_key(code),
            "is_exited": !map1.contains_key(code),
        })
    }).collect();

    comparison.sort_by(|a, b| {
        let ac = a["change"].as_i64().unwrap_or(0).abs();
        let bc = b["change"].as_i64().unwrap_or(0).abs();
        bc.cmp(&ac)
    });

    Ok(Json(json!({ "comparison": comparison, "date1": date1, "date2": date2, "metal": metal })))
}

#[derive(Deserialize)]
pub struct SummaryDateQuery {
    pub metal: Option<String>,
    #[serde(rename = "startDate")]
    pub start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
}

pub async fn institutional_summary(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SummaryDateQuery>,
) -> AppResult {
    let metal = metal_param(&q.metal);
    let mut query = String::from("SELECT * FROM institutional_daily_summary WHERE metal = $1");
    let mut params: Vec<String> = vec![metal];

    if let Some(ref sd) = q.start_date {
        params.push(sd.clone());
        query.push_str(&format!(" AND report_date >= ${}", params.len()));
    }
    if let Some(ref ed) = q.end_date {
        params.push(ed.clone());
        query.push_str(&format!(" AND report_date <= ${}", params.len()));
    }
    query.push_str(" ORDER BY report_date DESC LIMIT 90");

    let mut sql = sqlx::query(&query);
    for p in &params {
        sql = sql.bind(p);
    }
    let rows = sql.fetch_all(&state.pool).await?;

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "report_date": r.get::<String, _>("report_date"),
        "metal": r.get::<String, _>("metal"),
        "total_contracts": r.get::<i32, _>("total_contracts"),
        "total_issued": r.get::<i32, _>("total_issued"),
        "total_stopped": r.get::<i32, _>("total_stopped"),
        "net_market_position": r.get::<i32, _>("net_market_position"),
        "firms_count": r.get::<i32, _>("firms_count"),
        "net_buyers_count": r.get::<i32, _>("net_buyers_count"),
        "net_sellers_count": r.get::<i32, _>("net_sellers_count"),
        "top_buyers": r.get::<Option<Value>, _>("top_buyers"),
        "top_sellers": r.get::<Option<Value>, _>("top_sellers"),
    })).collect();

    Ok(Json(json!(data)))
}

// ── CSV Export ──────────────────────────────────────────────────────────────

pub async fn export_csv(
    State(state): State<Arc<AppState>>,
) -> Result<Response, AppError> {
    let rows = sqlx::query(
        r#"SELECT
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
          dn_issued.total_issued
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
        ORDER BY d.date ASC"#,
    )
    .fetch_all(&state.pool)
    .await?;

    if rows.is_empty() {
        return Ok((StatusCode::NOT_FOUND, Json(json!({"error": "No data to export"}))).into_response());
    }

    let mut csv = String::from("Date,Gold_Price_USD,Registered_Oz,Eligible_Oz,Total_Oz,Daily_Change_Registered,Daily_Change_Eligible,OI_Contracts,OI_Oz,Coverage_Ratio_Pct,DXY_Close,Contracts_Stopped,Contracts_Issued\n");
    for r in &rows {
        let date: String = r.get("date");
        let gold_price: Option<f32> = r.get("gold_price");
        let registered: Option<i32> = r.get("registered_oz");
        let eligible: Option<i32> = r.get("eligible_oz");
        let total: Option<i32> = r.get("total_oz");
        let change_reg: Option<i32> = r.get("daily_change_registered");
        let change_elig: Option<i32> = r.get("daily_change_eligible");
        let oi_contracts: Option<i32> = r.get("oi_contracts");
        let oi_oz: Option<sqlx::types::BigDecimal> = r.get("oi_oz");
        let coverage: Option<sqlx::types::BigDecimal> = r.get("coverage_ratio_pct");
        let dxy: Option<sqlx::types::BigDecimal> = r.get("dxy_close");
        let stopped: Option<i32> = r.get("total_stopped");
        let issued: Option<i32> = r.get("total_issued");

        let opt_f = |v: Option<f32>| v.map(|x| x.to_string()).unwrap_or_default();
        let opt_i32 = |v: Option<i32>| v.map(|x| x.to_string()).unwrap_or_default();
        let opt_bd = |v: Option<sqlx::types::BigDecimal>| v.map(|x| x.to_string()).unwrap_or_default();

        csv.push_str(&format!("{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            date, opt_f(gold_price), opt_i32(registered), opt_i32(eligible), opt_i32(total),
            opt_i32(change_reg), opt_i32(change_elig), opt_i32(oi_contracts),
            opt_bd(oi_oz), opt_bd(coverage), opt_bd(dxy), opt_i32(stopped), opt_i32(issued),
        ));
    }

    let today = chrono::Utc::now().format("%Y-%m-%d");
    let filename = format!("goldtrack-export-{}.csv", today);

    Ok((
        StatusCode::OK,
        [
            ("Content-Type", "text/csv"),
            ("Content-Disposition", &format!("attachment; filename=\"{}\"", filename)),
        ],
        csv,
    ).into_response())
}
