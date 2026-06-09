# Tally Prime MCP Server

MCP Server that bridges Tally Prime ERP and Odoo with AI assistants (Claude, ChatGPT).

## Quick Start

### Local Mode (Tally on same PC)
```bash
node dist/index.mjs
```

### Remote Mode (Server/Cloud)
```bash
node dist/server.mjs
```

## Claude Desktop Configuration

### Local Mode
Add to Claude Desktop config (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "Tally Prime": {
      "command": "node",
      "args": ["E:\\Tally MCP\\tally-mcp-server\\dist\\index.mjs"]
    }
  }
}
```

### Remote Mode
1. Start the server: `node dist/server.mjs`
2. In Claude Desktop, go to Settings > Connectors > Add custom connector
3. Enter: `http://localhost:3000` (or your server domain)
4. Password: `S6MMXo0d0-XUXb3SSMaR7A`

## Available Tools (24)

### Tally Prime Tools (19)
- `metadata-collection` — List collections
- `metadata-fields` — Get field schema
- `query-option-values` — Country/state dropdowns
- `query-database` — SQL on cached tables
- `query-collection` — Fetch Tally data
- `list-master` — List masters
- `chart-of-accounts` — GL hierarchy
- `trial-balance` — Trial balance
- `profit-loss` — P&L statement
- `balance-sheet` — Balance sheet
- `stock-summary` — Inventory summary
- `ledger-balance` — Single ledger balance
- `stock-item-balance` — Stock item quantity
- `bills-outstanding` — Receivable/payable bills
- `ledger-account` — GL ledger statement
- `stock-item-account` — Stock item movement
- `ledger-create-update` — Create/update ledgers
- `set-company` — Switch Tally company
- `set-period` — Set reporting period

### Odoo Integration Tools (5)
- `sync_ledgers` — Sync customers/vendors from Odoo to Tally
- `push_voucher_draft` — Stage sales/purchase/journal as DRAFT vouchers (ISACCEPTED=No)
- `reconcile_gst` — Compare Odoo GST vs Tally GST for a period
- `fetch_daybook` — Fetch day-book (voucher register) from Tally
- `trial-balance` — Pull trial balance (reuses existing Tally tool)

## Draft Voucher Gate

ALL vouchers are created with `ISACCEPTED=No`. Finance team must accept them in Tally before they appear in reports. Zero auto-acceptance.

## Odoo Configuration

Add to `.env`:
```
ODOO_URL=https://your-odoo-instance.com
ODOO_DB=your_database
ODOO_USERNAME=admin
ODOO_PASSWORD=your_password
```

## Prerequisites

- Tally Prime (Silver/Gold) with XML port enabled on port 9000
- Node.js 18+
- For remote mode: Nginx/Apache reverse proxy with SSL

## Architecture

```
Claude/ChatGPT ──► MCP Server ──► Tally Prime (port 9000)
                      │
                      └──► Odoo API (XML-RPC)
```
