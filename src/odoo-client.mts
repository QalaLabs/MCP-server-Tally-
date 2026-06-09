import xmlrpc from 'xmlrpc';
import dotenv from 'dotenv';

dotenv.config({ override: true, quiet: true });

const ODOO_URL = process.env.ODOO_URL || '';
const ODOO_DB = process.env.ODOO_DB || '';
const ODOO_USERNAME = process.env.ODOO_USERNAME || '';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD || '';

let uid: number | null = null;

function createClient(path: string): xmlrpc.Client {
    const url = new URL(ODOO_URL);
    const options: any = {
        host: url.hostname,
        port: 443,
        path: path,
    };
    // Only add rejectUnauthorized if using HTTPS
    if (url.protocol === 'https:') {
        options.rejectUnauthorized = true;
    }
    return xmlrpc.createSecureClient(options);
}

function xmlrpcCall(client: xmlrpc.Client, method: string, args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
        client.methodCall(method, args, (err: any, value: any) => {
            if (err) reject(err);
            else resolve(value);
        });
    });
}

export async function authenticate(): Promise<number> {
    if (uid) return uid;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_PASSWORD) {
        throw new Error('Missing Odoo configuration. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD in .env');
    }

    const common = createClient('/xmlrpc/2/common');
    uid = await xmlrpcCall(common, 'authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}]);
    if (!uid) throw new Error('Odoo authentication failed. Check credentials.');
    return uid;
}

export async function searchRead(
    model: string,
    domain: any[],
    fields: string[],
    kwargs: { offset?: number; limit?: number; order?: string } = {}
): Promise<any[]> {
    const userId = await authenticate();
    const object = createClient('/xmlrpc/2/object');

    const args = [
        ODOO_DB,
        userId,
        ODOO_PASSWORD,
        model,
        'search_read',
        [domain],
        { fields, ...kwargs },
    ];

    return xmlrpcCall(object, 'execute_kw', args);
}

export async function searchCount(model: string, domain: any[]): Promise<number> {
    const userId = await authenticate();
    const object = createClient('/xmlrpc/2/object');

    const args = [
        ODOO_DB,
        userId,
        ODOO_PASSWORD,
        model,
        'search_count',
        [domain],
    ];

    return xmlrpcCall(object, 'execute_kw', args);
}

export async function searchIds(model: string, domain: any[]): Promise<number[]> {
    const userId = await authenticate();
    const object = createClient('/xmlrpc/2/object');

    const args = [
        ODOO_DB,
        userId,
        ODOO_PASSWORD,
        model,
        'search',
        [domain],
    ];

    return xmlrpcCall(object, 'execute_kw', args);
}

export async function readRecords(
    model: string,
    ids: number[],
    fields: string[]
): Promise<any[]> {
    const userId = await authenticate();
    const object = createClient('/xmlrpc/2/object');

    const args = [
        ODOO_DB,
        userId,
        ODOO_PASSWORD,
        model,
        'read',
        [ids],
        { fields },
    ];

    return xmlrpcCall(object, 'execute_kw', args);
}

export interface OdooPartner {
    id: number;
    name: string;
    is_company: boolean;
    customer_rank: number;
    supplier_rank: number;
    vat: string;
    street: string;
    city: string;
    state_id: [number, string] | false;
    country_id: [number, string] | false;
    zip: string;
    phone: string;
    email: string;
}

export interface OdooAccount {
    id: number;
    name: string;
    code: string;
    account_type: string;
}

export interface OdooInvoice {
    id: number;
    name: string;
    invoice_date: string;
    move_type: string;
    state: string;
    partner_id: [number, string];
    invoice_line_ids: number[];
    amount_untaxed: number;
    amount_tax: number;
    amount_total: number;
    ref: string;
    payment_state: string;
}

export interface OdooInvoiceLine {
    id: number;
    name: string;
    account_id: [number, string];
    price_unit: number;
    price_total: number;
    quantity: number;
    tax_ids: number[];
}

export interface OdooJournalEntry {
    id: number;
    name: string;
    date: string;
    move_type: string;
    state: string;
    ref: string;
    line_ids: number[];
}

export interface OdooJournalItem {
    id: number;
    name: string;
    account_id: [number, string];
    partner_id: [number, string] | false;
    debit: number;
    credit: number;
    amount: number;
}

export async function fetchPartners(
    domain: any[] = [],
    offset = 0,
    limit = 500
): Promise<OdooPartner[]> {
    const defaultDomain = [
        '|',
        ['customer_rank', '>', 0],
        ['supplier_rank', '>', 0],
    ];
    const combinedDomain = [...defaultDomain, ...domain];

    return searchRead('res.partner', combinedDomain, [
        'name', 'is_company', 'customer_rank', 'supplier_rank',
        'vat', 'street', 'city', 'state_id', 'country_id', 'zip',
        'phone', 'email',
    ], { offset, limit, order: 'name asc' });
}

export async function fetchAccounts(
    domain: any[] = [],
    offset = 0,
    limit = 500
): Promise<OdooAccount[]> {
    const defaultDomain = [['deprecated', '=', false]];
    const combinedDomain = [...defaultDomain, ...domain];

    return searchRead('account.account', combinedDomain, [
        'name', 'code', 'account_type',
    ], { offset, limit, order: 'code asc' });
}

export async function fetchInvoices(
    moveTypes: string[],
    fromDate?: string,
    toDate?: string,
    offset = 0,
    limit = 500
): Promise<OdooInvoice[]> {
    const domain: any[] = [
        ['move_type', 'in', moveTypes],
        ['state', '=', 'posted'],
    ];
    if (fromDate) domain.push(['invoice_date', '>=', fromDate]);
    if (toDate) domain.push(['invoice_date', '<=', toDate]);

    return searchRead('account.move', domain, [
        'name', 'invoice_date', 'move_type', 'state',
        'partner_id', 'invoice_line_ids', 'amount_untaxed',
        'amount_tax', 'amount_total', 'ref', 'payment_state',
    ], { offset, limit, order: 'invoice_date asc, name asc' });
}

export async function fetchInvoiceLines(ids: number[]): Promise<OdooInvoiceLine[]> {
    if (ids.length === 0) return [];
    return readRecords('account.invoice.line', ids, [
        'name', 'account_id', 'price_unit', 'price_total',
        'quantity', 'tax_ids',
    ]);
}

export async function fetchJournalEntries(
    fromDate?: string,
    toDate?: string,
    offset = 0,
    limit = 500
): Promise<OdooJournalEntry[]> {
    const domain: any[] = [
        ['move_type', '=', 'entry'],
        ['state', '=', 'posted'],
    ];
    if (fromDate) domain.push(['date', '>=', fromDate]);
    if (toDate) domain.push(['date', '<=', toDate]);

    return searchRead('account.move', domain, [
        'name', 'date', 'move_type', 'state', 'ref', 'line_ids',
    ], { offset, limit, order: 'date asc, name asc' });
}

export async function fetchJournalItems(ids: number[]): Promise<OdooJournalItem[]> {
    if (ids.length === 0) return [];
    return readRecords('account.move.line', ids, [
        'name', 'account_id', 'partner_id', 'debit', 'credit', 'amount',
    ]);
}
