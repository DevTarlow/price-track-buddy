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
 *   baseUrlLabel                 label for the URL row (custom uses "Endpoint URL")
 *   settings                     GSettings key names: enabled/apiKey/baseUrl
 *                                plus optional currency/name/authMode/authHeader
 *   create(config)               builds the adapter (must expose read())
 *   movement                     'balance' (headline delta) or 'usage'
 *   peak                         whether the billing-window banner applies
 *   isVisible(settings)          optional; hidden until configured/eligible
 *   requiresKey(settings)        optional; false when the endpoint needs no key
 *   spark                        RGB colours for the mini chart
 */

import { CustomProvider, DeepSeekProvider, LiteLLMProvider, OpenRouterProvider } from './providers.js';

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
    {
        id: 'litellm',
        name: 'LiteLLM proxy',
        badge: 'LL',
        accent: '#a78bfa',
        defaultCurrency: 'USD',
        description:
            'Spend and budget from a LiteLLM proxy. Base URL is the proxy root ' +
            '(default http://localhost:4000); use a virtual key. It reads /key/info, ' +
            'so OneAPI/NewAPI need the custom endpoint instead.',
        settings: {
            enabled: 'litellm-enabled',
            apiKey: 'litellm-api-key',
            baseUrl: 'litellm-base-url',
        },
        create: (config) => new LiteLLMProvider(config),
        movement: 'usage',
        peak: false,
        isVisible: (settings) => settings.get_boolean('litellm-enabled'),
        spark: { line: [0.65, 0.55, 0.98], fill: [0.65, 0.55, 0.98, 0.15] },
    },
    {
        id: 'custom',
        name: 'Custom endpoint',
        badge: 'CU',
        accent: '#4dd4c6',
        defaultCurrency: 'USD',
        baseUrlLabel: 'Endpoint URL',
        description:
            'Any endpoint that returns JSON with a numeric total, for example ' +
            '{"currency": "USD", "total": 12.34}. "balance" works in place of ' +
            '"total". The URL is the full endpoint, not a base URL.',
        settings: {
            enabled: 'custom-enabled',
            apiKey: 'custom-api-key',
            baseUrl: 'custom-url',
            currency: 'custom-currency',
            name: 'custom-name',
            authMode: 'custom-auth-mode',
            authHeader: 'custom-auth-header',
        },
        create: (config) => new CustomProvider(config),
        movement: 'balance',
        peak: false,
        isVisible: (settings) =>
            settings.get_boolean('custom-enabled') &&
            !!settings.get_string('custom-url'),
        requiresKey: (settings) =>
            settings.get_string('custom-auth-mode') !== 'none',
        spark: { line: [0.30, 0.85, 0.78], fill: [0.30, 0.85, 0.78, 0.15] },
    },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function providerById(id) {
    return PROVIDERS.find((p) => p.id === id) ?? null;
}
