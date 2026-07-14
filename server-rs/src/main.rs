mod db;
mod routes;
mod sync;

use axum::{Router, routing::get};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub pool: sqlx::PgPool,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    dotenvy::from_filename("../.env.local").ok();

    let host = std::env::var("PGHOST").expect("PGHOST required");
    let port = std::env::var("PGPORT").unwrap_or_else(|_| "5432".into());
    let database = std::env::var("PGDATABASE").expect("PGDATABASE required");
    let user = std::env::var("PGUSER").expect("PGUSER required");
    let password = std::env::var("PGPASSWORD").expect("PGPASSWORD required");
    let ssl_mode = std::env::var("PGSSLMODE").unwrap_or_default();

    let ssl_str = if ssl_mode == "require" { "?sslmode=require" } else { "" };
    let db_url = format!("postgres://{}:{}@{}:{}/{}{}", user, password, host, port, database, ssl_str);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&db_url)
        .await
        .expect("Failed to connect to database");

    db::init_db(&pool).await;
    tracing::info!("✅ Database tables and indexes ensured.");

    let state = Arc::new(AppState { pool });

    let api = Router::new()
        // CME warehouse & delivery
        .route("/cme/latest-stocks", get(routes::cme_latest_stocks))
        .route("/cme/summary", get(routes::cme_summary))
        .route("/cme/latest-notices", get(routes::cme_latest_notices))
        .route("/cme/vault-breakdown", get(routes::cme_vault_breakdown))
        .route("/cme/firm-flows", get(routes::cme_firm_flows))
        .route("/history", get(routes::cme_latest_stocks))
        // Prices & signals
        .route("/prices/sync", get(routes::prices_sync))
        .route("/prices/latest", get(routes::prices_latest))
        .route("/prices/signal-history", get(routes::signal_history))
        // ETF
        .route("/etf/sync", get(sync::etf_sync))
        .route("/etf/holdings", get(routes::etf_holdings))
        // LBMA
        .route("/lbma/sync", get(sync::lbma_sync))
        .route("/lbma/latest", get(routes::lbma_latest))
        // Open interest
        .route("/oi/sync", get(sync::oi_sync))
        .route("/oi/latest", get(routes::oi_latest))
        // Central bank reserves
        .route("/cb/reserves", get(routes::cb_reserves))
        .route("/cb/sync", get(sync::cb_sync))
        // DXY
        .route("/dxy/sync", get(sync::dxy_sync))
        .route("/dxy/latest", get(routes::dxy_latest))
        // Institutional
        .route("/cme/institutional/latest", get(routes::institutional_latest))
        .route("/cme/institutional/top-traders", get(routes::institutional_top_traders))
        .route("/cme/institutional/firm/{firmName}", get(routes::institutional_firm))
        .route("/cme/institutional/compare", get(routes::institutional_compare))
        .route("/cme/institutional/summary", get(routes::institutional_summary))
        // Export
        .route("/export/csv", get(routes::export_csv))
        // CME sync (the big one — fetches XLS/PDF from CME)
        .route("/cme/sync", get(sync::cme_sync))
        .with_state(state.clone());

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new("../dist").append_index_html_on_directories(true))
        .layer(CorsLayer::permissive());

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".into());
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("Server running on http://localhost:{}", port);
    axum::serve(listener, app).await.unwrap();
}
