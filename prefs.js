/**
 * Preferences dialog for Price Track Buddy — the place where the user plugs
 * in their DeepSeek / OpenRouter API keys.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { PROVIDERS } from './lib/registry.js';

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

        for (const provider of PROVIDERS) {
            const group = new Adw.PreferencesGroup({
                title: provider.name,
                description: provider.description,
            });

            const enabled = new Adw.SwitchRow({ title: `Track ${provider.name}` });
            settings.bind(provider.settings.enabled, enabled, 'active',
                Gio.SettingsBindFlags.DEFAULT);
            group.add(enabled);

            const apiKey = new Adw.PasswordEntryRow({ title: 'API key' });
            apiKey.set_show_apply_button(true);
            settings.bind(provider.settings.apiKey, apiKey, 'text',
                Gio.SettingsBindFlags.DEFAULT);
            group.add(apiKey);

            if (provider.settings.baseUrl) {
                // Adw.EntryRow has no placeholder-text API (only Adw.Sidebar
                // does), so the defaults live in the group description.
                const baseUrl = new Adw.EntryRow({ title: 'Base URL' });
                settings.bind(provider.settings.baseUrl, baseUrl, 'text',
                    Gio.SettingsBindFlags.DEFAULT);
                group.add(baseUrl);
            }

            if (provider.settings.currency) {
                const currency = new Adw.EntryRow({ title: 'Preferred currency' });
                settings.bind(provider.settings.currency, currency, 'text',
                    Gio.SettingsBindFlags.DEFAULT);
                group.add(currency);
            }

            providersPage.add(group);
        }

        /* ------------------------- General page --------------------------- */

        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const pollGroup = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'How often the panel re-reads all enabled providers.',
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

        const onTopSwitch = new Adw.SwitchRow({
            title: 'Always on top',
            subtitle: 'Keep the widget visible above fullscreen windows.',
        });
        settings.bind('always-on-top', onTopSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetGroup.add(onTopSwitch);

        const opacityRow = new Adw.ActionRow({
            title: 'Widget opacity',
            subtitle: 'How translucent the floating panel is.',
        });
        const opacityScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 0.2,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
            }),
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 180,
            valign: Gtk.Align.CENTER,
        });
        opacityScale.add_mark(0.2, Gtk.PositionType.BOTTOM, null);
        opacityScale.add_mark(1.0, Gtk.PositionType.BOTTOM, null);
        settings.bind('opacity', opacityScale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        opacityRow.add_suffix(opacityScale);
        widgetGroup.add(opacityRow);

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