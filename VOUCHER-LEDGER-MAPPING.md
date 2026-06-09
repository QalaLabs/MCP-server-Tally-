# Voucher-to-Ledger Mapping Document

Odoo ERP → Tally Prime mapping rules for the MCP Bridge.

---

## 1. Odoo Invoice Type → Tally Voucher Type

| Odoo `move_type` | Tally Voucher Type | Approval Gate |
|-------------------|-------------------|---------------|
| `out_invoice` | Sales | ISACCEPTED=No |
| `out_refund` | Credit Note | ISACCEPTED=No |
| `in_invoice` | Purchase | ISACCEPTED=No |
| `in_refund` | Credit Note | ISACCEPTED=No |
| `entry` (bank) | Receipt / Payment / Contra | ISACCEPTED=No |
| `entry` (general) | Journal | ISACCEPTED=No |

---

## 2. Voucher Entry Sign Rules

### Sales Voucher (`out_invoice`)
| Ledger | ISDEEMEDPOSITIVE | Amount | Meaning |
|--------|-----------------|--------|---------|
| Party (Customer) | Yes | -total | Debit |
| Sales Account | No | +line_total | Credit |
| IGST/CGST/SGST | No | +tax_amount | Credit |

### Credit Note — Sales Return (`out_refund`)
| Ledger | ISDEEMEDPOSITIVE | Amount | Meaning |
|--------|-----------------|--------|---------|
| Party (Customer) | Yes | +total | Debit (reversed) |
| Sales Account | Yes | -line_total | Debit (reverse) |
| IGST/CGST/SGST | Yes | -tax_amount | Debit (reverse) |

### Purchase Voucher (`in_invoice`)
| Ledger | ISDEEMEDPOSITIVE | Amount | Meaning |
|--------|-----------------|--------|---------|
| Party (Vendor) | Yes | +total | Credit |
| Expense Account | Yes | -line_total | Debit |
| IGST/CGST/SGST | Yes | -tax_amount | Debit |

### Credit Note — Purchase Return (`in_refund`)
| Ledger | ISDEEMEDPOSITIVE | Amount | Meaning |
|--------|-----------------|--------|---------|
| Party (Vendor) | Yes | -total | Debit (reversed) |
| Expense Account | No | +line_total | Credit (reverse) |
| IGST/CGST/SGST | No | +tax_amount | Credit (reverse) |

### Journal Voucher (general entries)
| Ledger | ISDEEMEDPOSITIVE | Amount | Meaning |
|--------|-----------------|--------|---------|
| Debit ledger | Yes | -net_amount | Debit |
| Credit ledger | No | +net_amount | Credit |

### Payment / Receipt / Contra (bank entries)
| Type | Condition | Meaning |
|------|-----------|---------|
| Receipt | Bank ledger debited (net debit > 0) | Money received |
| Payment | Bank ledger credited (net credit > 0) | Money paid |
| Contra | All ledgers are bank/cash | Transfer between accounts |

---

## 3. Ledger Group Classification

The `classifyLedgerGroup()` function in `src/odoo-to-tally.mts` maps Odoo account names to Tally parent groups:

| Keyword Pattern | Tally Parent Group |
|----------------|-------------------|
| bank, hdfc, sbi, icici, axis, yes bank, kotak | Bank Accounts |
| cash | Cash-in-Hand |
| debtor, receivable, customer, trade receivables | Sundry Debtors |
| creditor, payable, vendor, supplier, trade payables | Sundry Creditors |
| sales, revenue, income, service income | Sales Accounts |
| purchase, cost of goods, cogs, stock, inventory, materials | Purchase Accounts |
| salary, wage, employee, staff | Indirect Expenses |
| rent, electricity, telephone, office, admin, misc | Indirect Expenses |
| tax, vat, gst, tds, cess | Duties & Taxes |
| fixed asset, depreciation, equipment, furniture, vehicle, computer, laptop, plant, machinery | Fixed Assets |
| capital, drawing, owner, proprietor | Capital Account |
| loan, overdraft, cc account | Bank OD Accounts |
| discount received, commission received, interest income, rental income, other income, refund | Indirect Incomes |
| round off, rounding | Rounding Off |
| outstanding, accrual, provision | Current Liabilities |
| prepaid, advance, deposit, suspense, clearing | Current Assets |
| cost of, material, consumable, raw material | Direct Expenses |
| *(default)* | Current Liabilities |

---

## 4. GST Tax Component Mapping

| Odoo Tax Name Pattern | Tally Ledger | Tally Parent |
|----------------------|-------------|-------------|
| IGST @X% | IGST @X% | Duties & Taxes |
| CGST @X% | CGST @X% | Duties & Taxes |
| SGST @X% | SGST @X% | Duties & Taxes |
| CESS @X% | CESS @X% | Duties & Taxes |
| TDS @X% | TDS @X% | Duties & Taxes |

**Rule**: Tax ledger name is taken directly from `account_id[1]` in Odoo invoice lines.

---

## 5. Partner Ledger Mapping

| Odoo Field | Tally Ledger | Tally Parent |
|-----------|-------------|-------------|
| `partner_id[1]` (customer) | `{partner_name}` | Sundry Debtors |
| `partner_id[1]` (vendor) | `{partner_name}` | Sundry Creditors |

**Priority**: If both `customer_rank > 0` and `supplier_rank > 0`, defaults to Sundry Debtors.

---

## 6. Draft Voucher Gate (ISACCEPTED=No)

Every voucher pushed by the MCP bridge is created with:
```xml
<ISACCEPTED>No</ISACCEPTED>
```

This ensures:
- Finance team reviews each entry in Tally before it affects reports
- No auto-acceptance of any voucher
- Entries appear in "Unaccepted Vouchers" list in Tally
- Accept/Reject workflow is controlled entirely within Tally

---

## 7. Auto-Balancing Rule

If voucher ledger entries don't balance (running total ≠ 0), the bridge adds:
```xml
<LEDGERNAME>Suspense Account</LEDGERNAME>
<ISDEEMEDPOSITIVE>No/Yes</ISDEEMEDPOSITIVE>
<AMOUNT>±balancing_amount</AMOUNT>
```

This ensures every voucher XML is balanced before sending to Tally.

---

## 8. Master Creation Order

Masters MUST be uploaded before vouchers. The `push_voucher_draft` tool handles this automatically:
1. Fetch Odoo data
2. Check existing ledgers in Tally via `list-master`
3. Create missing ledgers via `master-ledger` template
4. Then push vouchers

---

## 9. Upload Sequence

| Step | Tool | Action |
|------|------|--------|
| 1 | `sync_ledgers` | Create all customer/vendor ledgers |
| 2 | `push_voucher_draft` (sales) | Stage sales + credit notes |
| 3 | `push_voucher_draft` (purchase) | Stage purchase + returns |
| 4 | `push_voucher_draft` (journal) | Stage journal/payment/receipt/contra |
| 5 | `fetch_daybook` | Verify pushed vouchers appear |
| 6 | `reconcile_gst` | Compare Odoo vs Tally GST |
| 7 | Tally UI | Finance team accepts vouchers |
