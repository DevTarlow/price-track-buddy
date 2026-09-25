/**
 * Provider clients for the DeepSeek balance endpoint and the OpenRouter
 * credits endpoint, plus the balance-movement helpers the ledger uses to turn
 * consecutive readings into spend / top-up deltas.
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

function toAmount(v) {
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

    async getBalance() {
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
        const total = toAmount(wanted.total_balance);
        const granted = toAmount(wanted.granted_balance);
        const toppedUp = toAmount(wanted.topped_up_balance);
        if (![total, granted, toppedUp].every(Number.isFinite))
            throw new ProviderError('malformed',
                'DeepSeek returned non-numeric balances', JSON.stringify(wanted));

        return {
            provider: 'deepseek',
            isAvailable: json.is_available !== false,
            currency: wanted.currency || 'USD',
            total,
            granted,
            toppedUp,
            at: Date.now(),
        };
    }
}

export class OpenRouterProvider {
    constructor({ apiKey, baseUrl = 'https://openrouter.ai/api/v1' }) {
        this.apiKey = apiKey ?? '';
        this.baseUrl = (baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    }

    async getCredits() {
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
        const purchased = toAmount(data && data.total_credits);
        const usage = toAmount(data && data.total_usage);
        if (!Number.isFinite(purchased) || !Number.isFinite(usage))
            throw new ProviderError('malformed',
                'OpenRouter credits response is missing total_credits/total_usage',
                JSON.stringify(json).slice(0, 200));

        return {
            provider: 'openrouter',
            currency: 'USD',
            purchased,
            usage,
            remaining: purchased - usage,
            at: Date.now(),
        };
    }
}

/**
 * Balance-delta movements between two readings.
 * DeepSeek: a balance decrease is spend, an increase is a top-up.
 * OpenRouter: usage growth is spend, purchased credit growth is a top-up.
 */
export function deepseekMovement(prev, cur) {
    const delta = cur.total - prev.total;
    return {
        spentDelta: Math.max(0, -delta),
        toppedUpDelta: Math.max(0, delta),
    };
}

export function openrouterMovement(prev, cur) {
    return {
        spentDelta: Math.max(0, cur.usage - prev.usage),
        toppedUpDelta: Math.max(0, cur.purchased - prev.purchased),
    };
}