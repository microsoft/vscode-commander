/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Configurations } from './configurationSearch';
import { SearchConfigurations } from './tools/searchConfigurations';
import { UpdateSettings } from './tools/updateSettings';
import { RunCommand } from './tools/runCommands';
import createChatParticipant from './chatParticipant';

const UNDO_SETTINGS_UPDATES_COMMAND_ID = 'vscode-commander.undo-settings-updates';

export function activate(context: vscode.ExtensionContext) {
	const updatedSettings: { key: string, oldValue: any, newValue: any }[] = [];
	const ranCommands: { key: string, arguments: any }[] = [];

	const logger = vscode.window.createOutputChannel('VS Code Commander', { log: true });
	const configurations = new Configurations(logger);

	context.subscriptions.push(configurations);

	context.subscriptions.push(vscode.commands.registerCommand(UNDO_SETTINGS_UPDATES_COMMAND_ID, async () => {
		for (const { key, oldValue } of updatedSettings) {
			await vscode.workspace.getConfiguration().update(key, oldValue, vscode.ConfigurationTarget.Global);
		}
	}));

	context.subscriptions.push(vscode.chat.createChatParticipant('vscode-commader', createChatParticipant(updatedSettings, ranCommands, logger)));
	context.subscriptions.push(vscode.lm.registerTool(SearchConfigurations.ID, new SearchConfigurations(configurations, logger)));
	context.subscriptions.push(vscode.lm.registerTool(UpdateSettings.ID, new UpdateSettings(updatedSettings, logger)));
	context.subscriptions.push(vscode.lm.registerTool(RunCommand.ID, new RunCommand(ranCommands, logger)));
}

export function deactivate() { }
