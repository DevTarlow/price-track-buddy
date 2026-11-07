/**
 * The provider registry.
 *
 * Everything that used to hardcode DeepSeek and OpenRouter iterates this list
 * instead: the extension's polling loops, the widget's cards and dots, and the
 * preferences groups. Adding a built-in provider is one descriptor here plus
 * its GSettings keys, not a change in five files.
 *
 * Descriptor fields:
 *   id, name, badge, accent      identity and UI colour
 *   defaultCurrency              used when a reading has no currency
 *   ledgerCurrency               forces the ledger currency (OpenRouter is USD)
 *   description                  preferences-group blurb
 *   settings                     GSettings key names for enabled/apiKey/baseUrl/currency
 *   create(config)               builds the adapter (must expose read())
 *   movement                     'balance' (headline delta) or 'usage'
 *   peak                         whether the billing-window banner applies
 *   spark                        RGB colours for the mini chart
 */

import { DeepSeekProvider, OpenRouterProvider } from './providers.js';

export const PROVIDERS = [
    {
        id: 'deepseek',
        name: 'DeepSeek',
        badge: 'DS',
        accent: '#4d9fff',
        defaultCurrency: 'CNY',
        description:
            'Balance from the /user/balance endpoint. Leave Base URL empty for ' +
            'https://api.deepseek.com. Preferred currency picks one of the entries ' +
            'the API reports (empty = first entry).',
        settings: {
            enabled: 'deepseek-enabled',
            apiKey: 'deepseek-api-key',
            baseUrl: 'deepseek-base-url',
            currency: 'deepseek-currency',
        },
        create: (config) => new DeepSeekProvider(config),
        movement: 'balance',
        peak: true,
        spark: { line: [0.30, 0.62, 1.0], fill: [0.30, 0.62, 1.0, 0.15] },
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        badge: 'OR',
        accent: '#ff8a3d',
        defaultCurrency: 'USD',
        ledgerCurrency: 'USD',
        description:
            'Credits from the /credits endpoint. Requires a management key; a ' +
            'publishable key will be rejected (HTTP 401). Leave Base URL empty for ' +
            'https://openrouter.ai/api/v1.',
        settings: {
            enabled: 'openrouter-enabled',
            apiKey: 'openrouter-api-key',
            baseUrl: 'openrouter-base-url',
        },
        create: (config) => new OpenRouterProvider(config),
        movement: 'usage',
        peak: false,
        spark: { line: [1.0, 0.54, 0.24], fill: [1.0, 0.54, 0.24, 0.15] },
    },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function providerById(id) {
    return PROVIDERS.find((p) => p.id === id) ?? null;
}
