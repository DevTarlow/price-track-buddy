/**
 * Provider clients and the balance-movement math the ledger uses to turn
 * consecutive readings into spend / top-up deltas.
 *
 * Every adapter returns the same normalized reading shape:
 *
 *   {
 *     provider, at, currency,
 *     headline,                              // the number the card shows big
 *     usage?, purchased?,                    // optional cumulative counters
 *     extra,                                 // kept in the ledger for the next
 *                                            // movement calculation
 *     detail: [{ label, value }, …],         // the card's sub-line
 *   }
 *
 * DeepSeek:  GET https://api.deepseek.com/user/balance   (Bearer auth)
 *            200 → { is_available, balance_infos: [{ currency, total_balance,
 *                   granted_balance, topped_up_balance }] }  (amounts are strings)
 * OpenRouter: GET https://openrouter.ai/api/v1/credits  (Bearer auth, management key)
 *            200 → { data: { total_credits, total_usage } }
 *
 * Error model mirrors the Harness balance plugin: providers throw ProviderError
 * with a stable `code` the UI turns into user-facing text.
 */

import { httpGet } from './http.js';

export class ProviderError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        this.name = 'ProviderError';
        this.code = code;
        this.detail = detail;
    }
}

export function parseAmount(v) {
    if (typeof v === 'string') {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : NaN;
    }
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : NaN;
    return NaN;
}

export class DeepSeekProvider {
    constructor({ apiKey, baseUrl = 'https://api.deepseek.com', preferredCurrency = '' }) {
        this.apiKey = apiKey ?? '';
        this.baseUrl = (baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
        this.preferredCurrency = preferredCurrency ?? '';
    }

    async read() {
        if (!this.apiKey)
            throw new ProviderError('no-key', 'No DeepSeek API key configured');

        let raw;
        try {
            raw = await httpGet(`${this.baseUrl}/user/balance`, {
                authorization: `Bearer ${this.apiKey}`,
            });
        } catch (e) {
            throw new ProviderError('network',
                `Could not reach DeepSeek: ${e.message || e}`);
        }

        const { status, body } = raw;
        if (status === 401 || status === 403)
            throw new ProviderError('unauthorized', `DeepSeek rejected the API key (HTTP ${status})`);
        if (status !== 200)
            throw new ProviderError('http', `DeepSeek answered HTTP ${status}`);

        let json;
        try {
            json = JSON.parse(body);
        } catch (e) {
            throw new ProviderError('malformed', 'DeepSeek returned invalid JSON', body.slice(0, 200));
        }

        const infos = Array.isArray(json && json.balance_infos) ? json.balance_infos : null;
        if (!infos || infos.length === 0)
            throw new ProviderError('empty', 'DeepSeek returned no balance entries');

        const wanted = this.preferredCurrency
            ? (infos.find((i) => i.currency === this.preferredCurrency) ?? infos[0])
            : infos[0];
        const total = parseAmount(wanted.total_balance);
        const granted = parseAmount(wanted.granted_balance);
        const toppedUp = parseAmount(wanted.topped_up_balance);
        if (![total, granted, toppedUp].every(Number.isFinite))
            throw new ProviderError('malformed',
                'DeepSeek returned non-numeric balances', JSON.stringify(wanted));

        return {
            provider: 'deepseek',
            isAvailable: json.is_available !== false,
            currency: wanted.currency || 'USD',
            headline: total,
            extra: { granted, toppedUp },
            detail: [
                { label: 'granted', value: granted },
                { label: 'topped-up', value: toppedUp },
            ],
            at: Date.now(),
        };
    }
}

export class OpenRouterProvider {
    constructor({ apiKey, baseUrl = 'https://openrouter.ai/api/v1' }) {
        this.apiKey = apiKey ?? '';
        this.baseUrl = (baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    }

    async read() {
        if (!this.apiKey)
            throw new ProviderError('no-key', 'No OpenRouter API key configured');

        let raw;
        try {
            raw = await httpGet(`${this.baseUrl}/credits`, {
                authorization: `Bearer ${this.apiKey}`,
            });
        } catch (e) {
            throw new ProviderError('network',
                `Could not reach OpenRouter: ${e.message || e}`);
        }

        const { status, body } = raw;
        if (status === 401 || status === 403)
            throw new ProviderError('unauthorized', `OpenRouter rejected the API key (HTTP ${status})`);
        if (status !== 200)
            throw new ProviderError('http', `OpenRouter answered HTTP ${status}`);

        let json;
        try {
            json = JSON.parse(body);
        } catch (e) {
            throw new ProviderError('malformed', 'OpenRouter returned invalid JSON', body.slice(0, 200));
        }

        const data = json && typeof json === 'object' ? (json.data ?? json) : null;
        const purchased = parseAmount(data && data.total_credits);
        const usage = parseAmount(data && data.total_usage);
        if (!Number.isFinite(purchased) || !Number.isFinite(usage))
            throw new ProviderError('malformed',
                'OpenRouter credits response is missing total_credits/total_usage',
                JSON.stringify(json).slice(0, 200));

        return {
            provider: 'openrouter',
            currency: 'USD',
            headline: purchased - usage,
            usage,
            purchased,
            extra: { usage, purchased },
            detail: [
                { label: 'purchased', value: purchased },
                { label: 'used', value: usage },
            ],
            at: Date.now(),
        };
    }
}

/**
 * A LiteLLM proxy. One virtual key covers everything routed through the proxy,
 * which is the point: it fronts OpenAI, Anthropic, Gemini and local models.
 *
 * GET {baseUrl}/key/info   (Bearer auth, virtual key)
 *   200 → { info: { spend, max_budget, … } }   (some versions: key_info)
 *
 * `max_budget` is a spending cap, not a purchase, so the movement is always
 * usage-based and top-ups are not inferred from it.
 */
export class LiteLLMProvider {
    constructor({ apiKey, baseUrl = 'http://localhost:4000' }) {
        this.apiKey = apiKey ?? '';
        this.baseUrl = (baseUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
    }

    async read() {
        if (!this.apiKey)
            throw new ProviderError('no-key', 'No LiteLLM key configured');

        let raw;
        try {
            raw = await httpGet(`${this.baseUrl}/key/info`, {
                authorization: `Bearer ${this.apiKey}`,
            });
        } catch (e) {
            throw new ProviderError('network',
                `Could not reach the LiteLLM proxy: ${e.message || e}`);
        }

        const { status, body } = raw;
        if (status === 401 || status === 403)
            throw new ProviderError('unauthorized',
                `LiteLLM proxy rejected the key (HTTP ${status})`);
        if (status !== 200)
            throw new ProviderError('http', `LiteLLM proxy answered HTTP ${status}`);

        return parseLiteLLMReading(body);
    }
}

/** Parse the LiteLLM /key/info body into a normalized reading. */
export function parseLiteLLMReading(body) {
    let json;
    try {
        json = JSON.parse(body);
    } catch (e) {
        throw new ProviderError('malformed',
            'LiteLLM proxy returned invalid JSON', String(body).slice(0, 200));
    }

    const info = json?.info ?? json?.key_info ?? json?.data ?? json;
    const spend = parseAmount(info?.spend);
    if (!Number.isFinite(spend)) {
        throw new ProviderError('malformed',
            'LiteLLM /key/info response is missing a numeric spend',
            String(body).slice(0, 200));
    }

    const maxBudget = parseAmount(info?.max_budget);
    const hasBudget = Number.isFinite(maxBudget) && maxBudget > 0;

    return {
        provider: 'litellm',
        currency: 'USD',
        headline: hasBudget ? maxBudget - spend : spend,
        headlineLabel: hasBudget ? 'remaining' : 'spent',
        movement: 'usage',
        usage: spend,
        extra: { usage: spend },
        detail: hasBudget
            ? [
                { label: 'budget', value: maxBudget },
                { label: 'spent', value: spend },
            ]
            : [],
        at: Date.now(),
    };
}

/**
 * A user-supplied endpoint that speaks the same normalized contract:
 *
 *   { "currency": "USD", "total": 12.34 }
 *
 * `balance` is accepted in place of `total`, and `currency` is optional (the
 * configured fallback wins). Auth is a Bearer token, a single custom header,
 * or none. This is the escape hatch for providers with no built-in adapter.
 */
export class CustomProvider {
    constructor({
        apiKey,
        baseUrl,
        authMode = 'bearer',
        authHeader = 'Authorization',
        preferredCurrency = 'USD',
    }) {
        this.apiKey = apiKey ?? '';
        this.baseUrl = (baseUrl ?? '').trim();
        this.authMode = authMode || 'bearer';
        this.authHeader = authHeader || 'Authorization';
        this.currency = preferredCurrency || 'USD';
    }

    async read() {
        if (!/^https?:\/\//i.test(this.baseUrl))
            throw new ProviderError('no-url',
                'No custom endpoint URL configured (needs http:// or https://)');
        if (this.authMode !== 'none' && !this.apiKey)
            throw new ProviderError('no-key', 'No API key for the custom endpoint');

        let raw;
        try {
            raw = await httpGet(this.baseUrl, this._headers());
        } catch (e) {
            throw new ProviderError('network',
                `Could not reach the custom endpoint: ${e.message || e}`);
        }

        const { status, body } = raw;
        if (status === 401 || status === 403)
            throw new ProviderError('unauthorized',
                `Custom endpoint rejected the credentials (HTTP ${status})`);
        if (status !== 200)
            throw new ProviderError('http', `Custom endpoint answered HTTP ${status}`);

        return parseCustomReading(body, this.currency);
    }

    _headers() {
        if (this.authMode === 'bearer')
            return { authorization: `Bearer ${this.apiKey}` };
        if (this.authMode === 'header')
            return { [this.authHeader]: this.apiKey };
        return {};
    }
}

/** Parse the custom endpoint's JSON body into a normalized reading. */
export function parseCustomReading(body, fallbackCurrency = 'USD') {
    let json;
    try {
        json = JSON.parse(body);
    } catch (e) {
        throw new ProviderError('malformed',
            'Custom endpoint returned invalid JSON', String(body).slice(0, 200));
    }

    const obj = json && typeof json === 'object' ? json : {};
    const currency = typeof obj.currency === 'string' && obj.currency
        ? obj.currency
        : (fallbackCurrency || 'USD');

    // A balance endpoint: total (or balance) is the remaining amount.
    const total = parseAmount(obj.total ?? obj.balance);
    if (Number.isFinite(total)) {
        return {
            provider: 'custom',
            currency,
            headline: total,
            headlineLabel: 'balance',
            extra: {},
            detail: [],
            at: Date.now(),
        };
    }

    // A spend-only endpoint: used (or spent) is cumulative, so the ledger
    // derives today's spend from the delta between readings.
    const spent = parseAmount(obj.used ?? obj.spent);
    if (Number.isFinite(spent)) {
        return {
            provider: 'custom',
            currency,
            headline: spent,
            headlineLabel: 'spent',
            movement: 'usage',
            usage: spent,
            extra: { usage: spent },
            detail: [],
            at: Date.now(),
        };
    }

    throw new ProviderError('malformed',
        'Custom endpoint needs a numeric "total"/"balance", or "used"/"spent"',
        String(body).slice(0, 200));
}

/**
 * Balance-delta movements between two readings.
 *
 * `balance`: the headline is the remaining balance, so a decrease is spend and
 * an increase is a top-up (DeepSeek).
 * `usage`: the headline may be remaining credits, but spend comes from the
 * cumulative usage counter and top-ups from the cumulative purchased counter
 * (OpenRouter).
 */
export function movementFor(kind, prev, cur) {
    if (kind === 'usage') {
        return {
            spentDelta: Math.max(0, (cur.usage ?? 0) - (prev.usage ?? 0)),
            toppedUpDelta: Math.max(0, (cur.purchased ?? 0) - (prev.purchased ?? 0)),
        };
    }

    const delta = (cur.headline ?? 0) - (prev.headline ?? 0);
    return {
        spentDelta: Math.max(0, -delta),
        toppedUpDelta: Math.max(0, delta),
    };
}
