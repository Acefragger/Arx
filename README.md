# Arx — Forex/CFD Trading Journal

**Live demo:** [arx-trading.vercel.app](https://arx-trading.vercel.app)

Arx is a full-stack trading journal built to replace scattered spreadsheets and broker exports with a single, structured place to log and review trades. It's built for retail forex/CFD traders who need to track performance across multiple instruments and brokers without doing manual math for every position.

## What it does

- **Trade logging** — records trades across multiple instruments (GBPUSD, USDJPY, NDAQ100, US30, US100M) and brokers (FxPro, JustMarkets, Headway), each with different contract sizes and margin rules.
- **Margin calculator** — computes margin requirements per instrument/broker combination instead of relying on a single hard-coded formula, since pip values, contract sizes, and leverage all vary by broker.
- **Analytics dashboard** — visualizes trade history and performance over time using Recharts, so patterns (win rate, drawdown, exposure by instrument) are visible at a glance instead of buried in a spreadsheet.

## Why

Most retail traders track trades in spreadsheets or rely on whatever export their broker gives them. Neither handles multi-broker, multi-instrument margin math well, and neither gives a real performance view without manual charting. Arx exists to close that gap for personal use, and to enforce good record-keeping discipline around a live trading strategy.

## Stack

- **Frontend:** React + Vite, JavaScript
- **Backend/Data:** Supabase (Postgres, auth)
- **Visualization:** Recharts
- **Styling:** Tailwind CSS

## Status

Actively used as a personal trading journal; core logging, margin calculation, and dashboard views are functional. Deployed on Vercel.
