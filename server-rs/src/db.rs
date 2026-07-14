use sqlx::PgPool;

pub async fn init_db(pool: &PgPool) {
    let statements = [
        r#"CREATE TABLE IF NOT EXISTS warehouse_stocks (
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
        )"#,
        r#"CREATE TABLE IF NOT EXISTS vault_stocks (
            id BIGSERIAL PRIMARY KEY,
            date TEXT NOT NULL,
            vault TEXT NOT NULL,
            metal TEXT NOT NULL,
            registered_oz BIGINT NOT NULL,
            eligible_oz BIGINT NOT NULL,
            UNIQUE(date, vault, metal)
        )"#,
        r#"CREATE TABLE IF NOT EXISTS delivery_notices (
            id BIGSERIAL PRIMARY KEY,
            date TEXT NOT NULL,
            firm TEXT NOT NULL,
            issued INTEGER DEFAULT 0,
            stopped INTEGER DEFAULT 0,
            metal TEXT NOT NULL,
            account_type TEXT NOT NULL,
            UNIQUE(date, firm, metal, account_type)
        )"#,
        r#"CREATE TABLE IF NOT EXISTS metals_summary (
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
        )"#,
        r#"CREATE TABLE IF NOT EXISTS institutional_activity (
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
        )"#,
        r#"CREATE TABLE IF NOT EXISTS institutional_daily_summary (
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
        )"#,
        r#"CREATE TABLE IF NOT EXISTS etf_holdings (
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
        )"#,
        r#"CREATE TABLE IF NOT EXISTS lbma_vault (
            id BIGSERIAL PRIMARY KEY,
            month TEXT NOT NULL UNIQUE,
            gold_oz NUMERIC(14,0),
            gold_tonnes NUMERIC(10,2),
            silver_oz NUMERIC(14,0),
            source TEXT DEFAULT 'LBMA',
            updated_at TIMESTAMP DEFAULT NOW()
        )"#,
        r#"CREATE TABLE IF NOT EXISTS open_interest (
            id BIGSERIAL PRIMARY KEY,
            date TEXT NOT NULL,
            metal TEXT NOT NULL DEFAULT 'GOLD',
            oi_contracts INTEGER NOT NULL,
            oi_oz NUMERIC(14,0),
            source TEXT DEFAULT 'CME',
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(date, metal)
        )"#,
        r#"CREATE TABLE IF NOT EXISTS dxy_index (
            id BIGSERIAL PRIMARY KEY,
            date TEXT NOT NULL UNIQUE,
            close NUMERIC(8,3) NOT NULL,
            source TEXT DEFAULT 'seed',
            updated_at TIMESTAMP DEFAULT NOW()
        )"#,
        r#"CREATE TABLE IF NOT EXISTS cb_gold_reserves (
            id SERIAL PRIMARY KEY,
            country_code TEXT NOT NULL,
            country_name TEXT NOT NULL,
            period TEXT NOT NULL,
            tonnes NUMERIC(12,3),
            change_tonnes NUMERIC(12,3) DEFAULT 0,
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(country_code, period)
        )"#,
    ];

    for sql in &statements {
        sqlx::query(sql).execute(pool).await.expect("Failed to create table");
    }

    let indexes = [
        "CREATE INDEX IF NOT EXISTS idx_dxy_date ON dxy_index(date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_oi_metal_date ON open_interest(metal, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_etf_date ON etf_holdings(date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_etf_ticker ON etf_holdings(ticker, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_lbma_month ON lbma_vault(month DESC)",
        "CREATE INDEX IF NOT EXISTS idx_warehouse_metal_date ON warehouse_stocks(metal, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_vault_metal_date ON vault_stocks(metal, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_notices_metal_date ON delivery_notices(metal, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_summary_metal_date ON metals_summary(metal, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_institutional_date ON institutional_activity(report_date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_institutional_firm ON institutional_activity(firm_name, report_date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_institutional_net ON institutional_activity(net_position DESC)",
        "CREATE INDEX IF NOT EXISTS idx_institutional_month_year ON institutional_activity(year DESC, month DESC)",
        "CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON institutional_daily_summary(report_date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_cb_reserves_period ON cb_gold_reserves(period DESC)",
    ];

    for sql in &indexes {
        sqlx::query(sql).execute(pool).await.expect("Failed to create index");
    }
}
