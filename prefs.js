/**
 * Preferences dialog for Price Track Buddy — the place where the user plugs
 * in their DeepSeek / OpenRouter API keys.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/*
 * The extension-preferences base class lives at different resource URLs
 * depending on the Shell version:
 *
 *   Shell 50+  resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js
 *   Shell ≤49  resource:///org/gnome/shell/extensions/prefs.js
 *
 * Shell 50 moved the class into the Extensions service bundle (capitalized
 * `Shell`), and that bundle no longer carries the old lowercase path. Try the
 * new URL first and fall back to the old one for older Shells. Only a missing
 * resource (ImportError) triggers the fallback, so real errors still surface.
 */
const PREFS_BASE_URLS = [
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js',
    'resource:///org/gnome/shell/extensions/prefs.js',
];

let ExtensionPreferences = null;
let prefsBaseError = null;
for (const url of PREFS_BASE_URLS) {
    try {
        ({ ExtensionPreferences } = await import(url));
        break;
    } catch (e) {
        if (e?.name !== 'ImportError')
            throw e;
        prefsBaseError = e;
    }
}
if (!ExtensionPreferences)
    throw prefsBaseError ?? new Error('Could not load the preferences base class');

export default class PriceTrackBuddyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        /* ------------------------- Providers page ------------------------- */

        const providersPage = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'system-run-symbolic',
        });

        // DeepSeek.
        const dsGroup = new Adw.PreferencesGroup({
            title: 'DeepSeek',
            description:
                'Balance from the /user/balance endpoint. Leave Base URL empty for ' +
                'https://api.deepseek.com. Preferred currency picks one of the entries ' +
                'the API reports (empty = first entry).',
        });
        const dsEnabled = new Adw.SwitchRow({ title: 'Track DeepSeek' });
        settings.bind('deepseek-enabled', dsEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        dsGroup.add(dsEnabled);

        const dsKey = new Adw.PasswordEntryRow({ title: 'API key' });
        dsKey.set_show_apply_button(true);
        settings.bind('deepseek-api-key', dsKey, 'text', Gio.SettingsBindFlags.DEFAULT);
        dsGroup.add(dsKey);

        // Adw.EntryRow has no placeholder-text API (only Adw.Sidebar does), so the
        // defaults live in the group description above instead.
        const dsUrl = new Adw.EntryRow({ title: 'Base URL' });
        settings.bind('deepseek-base-url', dsUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
        dsGroup.add(dsUrl);

        const dsCurrency = new Adw.EntryRow({ title: 'Preferred currency' });
        settings.bind('deepseek-currency', dsCurrency, 'text', Gio.SettingsBindFlags.DEFAULT);
        dsGroup.add(dsCurrency);

        // OpenRouter.
        const orGroup = new Adw.PreferencesGroup({
            title: 'OpenRouter',
            description:
                'Credits from the /credits endpoint. Requires a management key — a ' +
                'publishable key will be rejected (HTTP 401). Leave Base URL empty for ' +
                'https://openrouter.ai/api/v1.',
        });
        const orEnabled = new Adw.SwitchRow({ title: 'Track OpenRouter' });
        settings.bind('openrouter-enabled', orEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        orGroup.add(orEnabled);

        const orKey = new Adw.PasswordEntryRow({ title: 'API key' });
        orKey.set_show_apply_button(true);
        settings.bind('openrouter-api-key', orKey, 'text', Gio.SettingsBindFlags.DEFAULT);
        orGroup.add(orKey);

        const orUrl = new Adw.EntryRow({ title: 'Base URL' });
        settings.bind('openrouter-base-url', orUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
        orGroup.add(orUrl);

        providersPage.add(dsGroup);
        providersPage.add(orGroup);

        /* ------------------------- General page --------------------------- */

        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const pollGroup = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'How often the panel re-reads both providers.',
        });
        const refreshSpin = Adw.SpinRow.new(
            new Gtk.Adjustment({ lower: 20, upper: 3600, step_increment: 10, page_increment: 60 }),
            1.0, 0);
        refreshSpin.set_title('Refresh interval (seconds)');
        settings.bind('refresh-interval', refreshSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(refreshSpin);
        generalPage.add(pollGroup);

        const widgetGroup = new Adw.PreferencesGroup({
            title: 'Widget',
            description: 'The floating panel and its top-bar control.',
        });
        const visibleSwitch = new Adw.SwitchRow({ title: 'Show floating widget' });
        settings.bind('visible', visibleSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetGroup.add(visibleSwitch);

        const indicatorSwitch = new Adw.SwitchRow({ title: 'Show top panel indicator' });
        settings.bind('show-indicator', indicatorSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetGroup.add(indicatorSwitch);

        const resetRow = new Adw.ActionRow({
            title: 'Widget position',
            subtitle: 'Reset to the bottom-right corner of the primary monitor.',
        });
        const resetBtn = new Gtk.Button({ label: 'Reset', valign: Gtk.Align.CENTER });
        resetBtn.add_css_class('flat');
        resetBtn.connect('clicked', () => {
            settings.set_int('position-x', -1);
            settings.set_int('position-y', -1);
        });
        resetRow.add_suffix(resetBtn);
        widgetGroup.add(resetRow);
        generalPage.add(widgetGroup);

        const aboutGroup = new Adw.PreferencesGroup({
            title: 'About this data',
            description:
                'Spend is derived from balance deltas between readings, so totals cover ' +
                'only the time since tracking began. An expiring granted balance lowers ' +
                'the reported balance without any API call being made and is counted as ' +
                'spend — compare "granted" with "topped-up" before attributing a large ' +
                'day to usage. API keys are stored as plaintext in dconf. Ledger files: ' +
                `${GLib.get_user_data_dir()}/price-track-buddy`,
        });
        generalPage.add(aboutGroup);

        window.add(providersPage);
        window.add(generalPage);
    }
}