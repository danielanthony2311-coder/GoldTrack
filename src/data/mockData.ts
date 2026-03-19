import { subDays, format } from 'date-fns';

export const COMEX_METRICS = {
  deliveryRate: 21.4,
  registeredStocks: 17.1, // Millions of ounces
  cbPurchasesYTD: 863, // Tonnes
  spotPrice: 5230.50,
};

export const CME_DAILY_NOTICES = {
  date: "2026-02-27",
  settlement_price: 5230.50,
  total_notices: 130,
  month_to_date: 2407,
  institutional_buyers_house: [
    { firm: "BoFA Securities", stopped: 42 },
    { firm: "HSBC", stopped: 33 },
    { firm: "Scotia Capital", stopped: 24 }
  ],
  institutional_sellers_customer: [
    { firm: "JP Morgan Securities", issued: 78 }
  ]
};

export const GLOBAL_OFFICIAL_HOLDINGS = [
  { country: "United States", tonnes: 8133.46, percent_reserves: 82.5 },
  { country: "Germany", tonnes: 3350.25, percent_reserves: 82.4 },
  { country: "IMF", tonnes: 2814.04, percent_reserves: null },
  { country: "Italy", tonnes: 2451.86, percent_reserves: 79.3 },
  { country: "France", tonnes: 2437.00, percent_reserves: 80.0 },
  { country: "Russian Federation", tonnes: 2326.52, percent_reserves: 43.8 },
  { country: "China, P.R.: Mainland", tonnes: 2306.30, percent_reserves: 8.6 },
  { country: "India", tonnes: 880.18, percent_reserves: 17.4 },
  { country: "Poland, Rep. of", tonnes: 550.21, percent_reserves: 28.4 }
];

export const WHALE_STREAKS = {
  "Poland": { "Q3_Total": 5.7, "Annual_Accumulation": 95.0 },
  "Turkey": { "Q3_Total": 7.2, "Note": "Active accumulation despite early-year sales" },
  "India": { "Q3_Total": 7.9, "Streak": "Consistent monthly buyer" }
};

export const generateStockHistory = (days: number) => {
  const data = [];
  let base = 18.5;
  for (let i = days; i >= 0; i--) {
    base -= (Math.random() - 0.4) * 0.1;
    data.push({
      date: format(subDays(new Date(), i), 'MMM dd'),
      stocks: parseFloat(base.toFixed(2)),
    });
  }
  return data;
};

export const TOP_BUYERS = {
  customer: [
    { name: 'HSBC', amount: 45000 },
    { name: 'JPMorgan', amount: 38000 },
    { name: 'Brinks', amount: 32000 },
    { name: 'Manfra', amount: 28000 },
    { name: 'Scotia', amount: 22000 },
  ],
  house: [
    { name: 'HSBC', amount: 12000 },
    { name: 'JPMorgan', amount: 55000 }, // Spike in house buying
    { name: 'Brinks', amount: 8000 },
    { name: 'Manfra', amount: 15000 },
    { name: 'Scotia', amount: 4000 },
  ]
};

export const DIVERGENCE_INDEX = {
  gold: 21.4,
  silver: 8.2,
  ratio: 2.61, // gold/silver intensity ratio
  status: 'High Divergence'
};

export const DAILY_DELIVERIES = Array.from({ length: 20 }, (_, i) => ({
  date: format(subDays(new Date(), 20 - i), 'yyyy-MM-dd'),
  contracts: Math.floor(Math.random() * 500) + 100,
  weight: (Math.random() * 50 + 10).toFixed(2),
  status: Math.random() > 0.2 ? 'Completed' : 'Pending',
}));

export const CB_PURCHASE_TRENDS = Array.from({ length: 24 }, (_, i) => ({
  month: format(subDays(new Date(), (23 - i) * 30), 'MMM yy'),
  amount: Math.floor(Math.random() * 100) + 40,
}));

export const COUNTRY_BREAKDOWN = [
  { 
    country: 'China', 
    official: 2235, 
    estimated: 3100, 
    change: '+12%',
    lastPurchaseDate: 'Jan 2026',
    history: [
      { month: 'Jan 26', amount: 12 },
      { month: 'Dec 25', amount: 15 },
      { month: 'Nov 25', amount: 21 },
      { month: 'Oct 25', amount: 18 }
    ]
  },
  { 
    country: 'Turkey', 
    official: 540, 
    estimated: 540, 
    change: '+5%',
    lastPurchaseDate: 'Feb 2026',
    history: [
      { month: 'Feb 26', amount: 8 },
      { month: 'Jan 26', amount: 5 },
      { month: 'Dec 25', amount: 12 },
      { month: 'Nov 25', amount: 7 }
    ]
  },
  { 
    country: 'India', 
    official: 803, 
    estimated: 803, 
    change: '+2%',
    lastPurchaseDate: 'Jan 2026',
    history: [
      { month: 'Jan 26', amount: 4 },
      { month: 'Dec 25', amount: 3 },
      { month: 'Nov 25', amount: 5 },
      { month: 'Oct 25', amount: 2 }
    ]
  },
  { 
    country: 'Poland', 
    official: 359, 
    estimated: 359, 
    change: '+15%',
    lastPurchaseDate: 'Feb 2026',
    history: [
      { month: 'Feb 26', amount: 15 },
      { month: 'Jan 26', amount: 12 },
      { month: 'Dec 25', amount: 10 },
      { month: 'Nov 25', amount: 8 }
    ]
  },
  { 
    country: 'Russia', 
    official: 2332, 
    estimated: 2332, 
    change: '0%',
    lastPurchaseDate: 'Sep 2025',
    history: [
      { month: 'Sep 25', amount: 0 },
      { month: 'Aug 25', amount: 0 },
      { month: 'Jul 25', amount: 2 },
      { month: 'Jun 25', amount: 0 }
    ]
  },
];

export const GLOBAL_GOLD_FLOW = [
  { 
    country: 'China', 
    monthlyTonnes: 18.5, 
    multiplier: 11, 
    momentum: 19.2, // 3-month rolling avg
    consecutiveMonths: 15 
  },
  { 
    country: 'Poland', 
    monthlyTonnes: 12.0, 
    multiplier: 1, 
    momentum: 10.5, 
    consecutiveMonths: 8 
  },
  { 
    country: 'Turkey', 
    monthlyTonnes: 8.4, 
    multiplier: 1, 
    momentum: 9.1, 
    consecutiveMonths: 5 
  },
  { 
    country: 'India', 
    monthlyTonnes: 4.2, 
    multiplier: 1, 
    momentum: 3.8, 
    consecutiveMonths: 3 
  },
  { 
    country: 'Czech Rep', 
    monthlyTonnes: 2.1, 
    multiplier: 1, 
    momentum: 1.9, 
    consecutiveMonths: 12 
  },
];

export const MINING_EQUITIES = [
  { 
    name: 'Newmont (NEM)', 
    ticker: 'NEM',
    aisc: 1450, 
    production: 850, // Direct
    ga: 120, 
    sustainingCapEx: 350, 
    exploration: 130 
  },
  { 
    name: 'Barrick (GOLD)', 
    ticker: 'GOLD',
    aisc: 1380, 
    production: 800, 
    ga: 110, 
    sustainingCapEx: 320, 
    exploration: 150 
  },
  { 
    name: 'VanEck Gold Miners (GDX)', 
    ticker: 'GDX',
    price: 38.50,
    history: Array.from({ length: 30 }, (_, i) => ({
      date: format(subDays(new Date(), 30 - i), 'MMM dd'),
      price: 35 + Math.random() * 5,
      houseSurge: Math.random() * 100
    }))
  }
];

export const SUPPLY_GAP_DATA = {
  annualMineSupply: 3600,
  recycling: 1200,
  totalDemand: 5800,
  shadowDemand: 1100, // Eating into warehouse stocks
  deficit: 1000
};
