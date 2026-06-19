/**
 * TUI config selector for `summon config` command
 */

import { ProcessTerminal, TUI } from "@summon/tui";
import type { ResolvedPaths } from "../core/package-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI (honor a SUMMON_THEME / --theme override over the settings default)
	initTheme(options.settingsManager.getEffectiveTheme(), true);

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
