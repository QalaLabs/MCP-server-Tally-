import * as odoo from './odoo-client.mjs';
import { utility } from './utility.mjs';

// META columns to skip when building ledger entries
const META_COLUMNS = new Set([
    'Invoice NO', 'Invoice Date', 'LR Number', 'Salesperson', 'Customer',
    'GST NO', 'Untaxed Amt', 'Tax Amount', 'Total Amt',
    'Bill NO', 'Bill Reference', 'Accounting Date', 'Bill Date',
    'Purchase Representative', 'Vendor', 'Local Sales',
    'Analytic', 'Stock delivered but not invoiced', 'COGS',
    'Stock received but not billed', 'Purchase Expense',
    'Accounts Receivable', 'Accounts Payable',
]);

// Ledgers that are credits (positive amount) in purchase context
const PURCHASE_CREDIT_LEDGERS = new Set([
    'Accounts Payable', 'Round off', 'Discount', 'Discount receivable',
    'Duty Reimbursement', 'Rate Difference',
]);

// GST rate extraction pattern
const GST_RATE_PATTERN = /(\d+(?:\.\d+)?)\s*%/;

function matchesAny(name: string, keywords: string[]): boolean {
    const lower = name.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
}

export function classifyLedgerGroup(name: string): string {
    const n = name.toLowerCase();
    if (matchesAny(n, ['bank', 'hdfc', 'sbi', 'icici', 'axis', 'yes bank', 'kotak', 'idbi', 'pnb', 'canara', 'hsbc'])) return 'Bank Accounts';
    if (matchesAny(n, ['cash'])) return 'Cash-in-Hand';
    if (matchesAny(n, ['debtor', 'receivable', 'customer', 'trade receivables'])) return 'Sundry Debtors';
    if (matchesAny(n, ['creditor', 'payable', 'vendor', 'supplier', 'trade payables'])) return 'Sundry Creditors';
    if (matchesAny(n, ['sales', 'revenue', 'income', 'service income'])) return 'Sales Accounts';
    if (matchesAny(n, ['purchase', 'cost of goods', 'cogs', 'stock', 'inventory', 'materials'])) return 'Purchase Accounts';
    if (matchesAny(n, ['salary', 'wage', 'employee', 'staff'])) return 'Indirect Expenses';
    if (matchesAny(n, ['rent', 'electricity', 'telephone', 'office', 'admin', 'misc'])) return 'Indirect Expenses';
    if (matchesAny(n, ['tax', 'vat', 'gst', 'tds', 'cess'])) return 'Duties & Taxes';
    if (matchesAny(n, ['fixed asset', 'depreciation', 'equipment', 'furniture', 'vehicle', 'computer', 'laptop', 'plant', 'machinery'])) return 'Fixed Assets';
    if (matchesAny(n, ['capital', 'drawing', 'owner', 'proprietor'])) return 'Capital Account';
    if (matchesAny(n, ['loan', 'overdraft', 'cc account'])) return 'Bank OD Accounts';
    if (matchesAny(n, ['discount received', 'commission received', 'interest income', 'rental income', 'other income', 'refund'])) return 'Indirect Incomes';
    if (matchesAny(n, ['round off', 'rounding'])) return 'Rounding Off';
    if (matchesAny(n, ['outstanding', 'accrual', 'provision'])) return 'Current Liabilities';
    if (matchesAny(n, ['prepaid', 'advance', 'deposit', 'suspense', 'clearing'])) return 'Current Assets';
    if (matchesAny(n, ['cost of', 'material', 'consumable', 'raw material'])) return 'Direct Expenses';
    return 'Current Liabilities';
}

function formatDate(dateStr: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function esc(text: string | null | undefined): string {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildLedgerEntry(ledgerName: string, amount: number, isDebit: boolean): string {
    const sign = isDebit ? '-' : '+';
    const deemed = isDebit ? 'Yes' : 'No';
    return `          <LEDGERENTRY>
            <LEDGERNAME>${esc(ledgerName)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
            <AMOUNT>${sign}${Math.abs(amount).toFixed(2)}</AMOUNT>
          </LEDGERENTRY>`;
}

function buildLedgerMaster(name: string, parent: string): string {
    return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${esc(name)}" ACTION="Create">
            <NAME>${esc(name)}</NAME>
            <PARENT>${esc(parent)}</PARENT>
          </LEDGER>
        </TALLYMESSAGE>`;
}

function buildVoucherMaster(name: string): string {
    return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHERTYPE NAME="${esc(name)}" ACTION="Create">
            <NAME>${esc(name)}</NAME>
          </VOUCHERTYPE>
        </TALLYMESSAGE>`;
}

export interface SyncResult {
    mastersCreated: number;
    vouchersCreated: number;
    skippedExisting: number;
    errors: string[];
}

export interface LedgerInfo {
    name: string;
    parent: string;
}

// ── Collect unique ledgers from Odoo invoices ──
export async function collectInvoiceLedgers(
    invoices: odoo.OdooInvoice[],
    invoiceLines: odoo.OdooInvoiceLine[]
): Promise<Map<string, LedgerInfo>> {
    const ledgers = new Map<string, LedgerInfo>();

    // Partner ledgers
    for (const inv of invoices) {
        const partnerName = inv.partner_id[1];
        if (partnerName) {
            const isCustomer = inv.move_type.startsWith('out');
            ledgers.set(partnerName, {
                name: partnerName,
                parent: isCustomer ? 'Sundry Debtors' : 'Sundry Creditors',
            });
        }
    }

    // Account ledgers from invoice lines
    for (const line of invoiceLines) {
        const accountName = line.account_id[1];
        if (accountName) {
            ledgers.set(accountName, {
                name: accountName,
                parent: classifyLedgerGroup(accountName),
            });
        }
    }

    // Tax ledgers from invoice lines
    // Taxes are fetched separately, but we classify by name
    for (const line of invoiceLines) {
        const accountName = line.account_id[1];
        if (accountName && matchesAny(accountName, ['igst', 'cgst', 'sgst', 'gst', 'tax'])) {
            ledgers.set(accountName, {
                name: accountName,
                parent: 'Duties & Taxes',
            });
        }
    }

    return ledgers;
}

// ── Collect unique ledgers from Odoo journal entries ──
export async function collectJournalLedgers(
    items: odoo.OdooJournalItem[]
): Promise<Map<string, LedgerInfo>> {
    const ledgers = new Map<string, LedgerInfo>();

    for (const item of items) {
        const accountName = item.account_id[1];
        if (accountName) {
            ledgers.set(accountName, {
                name: accountName,
                parent: classifyLedgerGroup(accountName),
            });
        }

        if (item.partner_id) {
            const partnerName = item.partner_id[1];
            if (partnerName) {
                ledgers.set(partnerName, {
                    name: partnerName,
                    parent: 'Current Liabilities',
                });
            }
        }
    }

    return ledgers;
}

// ── Build sales voucher XML ──
export function buildSalesVoucher(invoice: odoo.OdooInvoice, lines: odoo.OdooInvoiceLine[]): string {
    const date = formatDate(invoice.invoice_date);
    const partnerName = invoice.partner_id[1];
    const ref = invoice.name || invoice.ref || '';
    const isCreditNote = invoice.move_type === 'out_refund';
    const voucherType = isCreditNote ? 'Credit Note' : 'Sales';

    let entriesXml = '';

    // Party entry
    if (isCreditNote) {
        // Credit Note: Party positive (debit), ISDEEMEDPOSITIVE=Yes
        entriesXml += buildLedgerEntry(partnerName, invoice.amount_total, false) + '\n';
    } else {
        // Sales: Party negative (debit side but ISDEEMEDPOSITIVE=Yes with negative amount)
        entriesXml += buildLedgerEntry(partnerName, invoice.amount_total, true) + '\n';
    }

    // Line entries (sales account + tax accounts)
    for (const line of lines) {
        const accountName = line.account_id[1];
        const amount = line.price_total;
        if (!accountName || amount === 0) continue;

        if (isCreditNote) {
            // Credit Note: Sales/Tax negative (credit back)
            entriesXml += buildLedgerEntry(accountName, amount, true) + '\n';
        } else {
            // Sales: Sales/Tax positive (credit)
            entriesXml += buildLedgerEntry(accountName, amount, false) + '\n';
        }
    }

    const narration = `Sales invoice ${ref} - ${partnerName}`;

    return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${esc(voucherType)}" ACTION="Create" OBJTYPE="Voucher">
            <DATE>${date}</DATE>
            <VOUCHERNUMBER>${esc(ref)}</VOUCHERNUMBER>
            <VOUCHERTYPENAME>${esc(voucherType)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${esc(partnerName)}</PARTYLEDGERNAME>
            <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
            <NARRATION>${esc(narration)}</NARRATION>
            <ALLLEDGERENTRIES.LIST>
${entriesXml}            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>`;
}

// ── Build purchase voucher XML ──
export function buildPurchaseVoucher(invoice: odoo.OdooInvoice, lines: odoo.OdooInvoiceLine[]): string {
    const date = formatDate(invoice.invoice_date);
    const partnerName = invoice.partner_id[1];
    const ref = invoice.name || invoice.ref || '';
    const isCreditNote = invoice.move_type === 'in_refund';
    const voucherType = isCreditNote ? 'Credit Note' : 'Purchase';

    let entriesXml = '';

    // Vendor entry
    if (isCreditNote) {
        // Purchase Return: Vendor debit (-)
        entriesXml += buildLedgerEntry(partnerName, invoice.amount_total, true) + '\n';
    } else {
        // Purchase: Vendor credit (+) ISDEEMEDPOSITIVE=Yes
        entriesXml += buildLedgerEntry(partnerName, invoice.amount_total, false) + '\n';
    }

    // Line entries (expense/tax accounts)
    for (const line of lines) {
        const accountName = line.account_id[1];
        const amount = line.price_total;
        if (!accountName || amount === 0) continue;

        if (isCreditNote) {
            // Purchase Return: Expense/Tax credit (+)
            entriesXml += buildLedgerEntry(accountName, amount, false) + '\n';
        } else {
            // Purchase: Expense/Tax debit (-)
            entriesXml += buildLedgerEntry(accountName, amount, true) + '\n';
        }
    }

    const narration = ref;

    return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${esc(voucherType)}" ACTION="Create">
            <DATE>${date}</DATE>
            <NARRATION>${esc(narration)}</NARRATION>
            <VOUCHERTYPENAME>${esc(voucherType)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${esc(partnerName)}</PARTYLEDGERNAME>
            <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
            <DIFFACTUALQTY>No</DIFFACTUALQTY>
            <ISDELETED>No</ISDELETED>
            <ASORIGINALVCH>No</ASORIGINALVCH>
            <ALLLEDGERENTRIES.LIST>
${entriesXml}            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>`;
}

// ── Determine bank voucher type ──
function determineBankVoucherType(items: odoo.OdooJournalItem[]): string {
    const BANK_KEYWORDS = ['bank', 'cash', 'hdfc', 'sbi', 'icici', 'axis'];

    const isBankLedger = (name: string): boolean => {
        const n = name.toLowerCase();
        return BANK_KEYWORDS.some(kw => n.includes(kw));
    };

    const allLedgers = new Set<string>();
    for (const item of items) {
        allLedgers.add(item.account_id[1]);
        if (item.partner_id) allLedgers.add(item.partner_id[1]);
    }

    const bankCount = [...allLedgers].filter(l => isBankLedger(l)).length;

    // Contra: all ledgers are bank/cash
    if (bankCount >= 2 && bankCount === allLedgers.size) return 'Contra';

    // Check if any bank ledger has debit (positive Total Signed)
    let totalDebit = 0;
    let totalCredit = 0;
    for (const item of items) {
        totalDebit += item.debit;
        totalCredit += item.credit;
    }

    const netSigned = totalDebit - totalCredit;

    if (netSigned > 0) return 'Receipt';
    if (netSigned < 0) return 'Payment';
    return 'Contra';
}

// ── Build journal entry voucher XML ──
export function buildJournalVoucher(entry: odoo.OdooJournalEntry, items: odoo.OdooJournalItem[]): string {
    const date = formatDate(entry.date);
    const ref = entry.name || entry.ref || '';

    // Determine if this is a bank/cash journal
    const bankVoucherType = determineBankVoucherType(items);
    const isBankType = ['Payment', 'Receipt', 'Contra'].includes(bankVoucherType);
    const voucherType = isBankType ? bankVoucherType : 'Journal';

    let entriesXml = '';
    let runningTotal = 0;

    for (const item of items) {
        const accountName = item.account_id[1];
        if (!accountName) continue;

        const netAmount = item.debit - item.credit;
        if (netAmount === 0) continue;

        // Debit: negative amount, ISDEEMEDPOSITIVE=Yes
        // Credit: positive amount, ISDEEMEDPOSITIVE=No
        const isDebit = netAmount > 0;
        entriesXml += buildLedgerEntry(accountName, Math.abs(netAmount), isDebit) + '\n';
        runningTotal += netAmount;
    }

    // Auto-balance if needed
    if (Math.abs(runningTotal) > 0.001) {
        let counterName = 'Suspense Account';
        if (items.length === 1 && items[0].partner_id) {
            counterName = items[0].partner_id[1] || 'Suspense Account';
        }

        const balancingAmount = -runningTotal;
        const isDebit = balancingAmount > 0;
        entriesXml += buildLedgerEntry(counterName, Math.abs(balancingAmount), isDebit) + '\n';
    }

    const narration = entry.ref || ref;

    return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${esc(voucherType)}" ACTION="Create">
            <VOUCHERTYPENAME>${esc(voucherType)}</VOUCHERTYPENAME>
            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
            <VOUCHERNUMBER>${esc(ref)}</VOUCHERNUMBER>
            <DATE>${date}</DATE>
            <NARRATION>${esc(narration)}</NARRATION>
            <ALLLEDGERENTRIES.LIST>
${entriesXml}            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>`;
}

// ── Build full envelope XML ──
export function buildEnvelope(reportName: string, company: string, tallyMessages: string[]): string {
    const messages = tallyMessages.join('\n');
    return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${esc(reportName)}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${messages}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ── Build masters envelope ──
export function buildMastersEnvelope(company: string, ledgers: LedgerInfo[]): string {
    const messages = ledgers.map(l => buildLedgerMaster(l.name, l.parent));
    return buildEnvelope('All Masters', company, messages);
}

// ── Build vouchers envelope ──
export function buildVouchersEnvelope(company: string, voucherXmls: string[]): string {
    return buildEnvelope('Vouchers', company, voucherXmls);
}
