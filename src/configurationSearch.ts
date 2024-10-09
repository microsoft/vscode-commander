/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import MiniSearch from 'minisearch';
import { followReference, IJSONSchema, resolveReferences } from './jsonSchema';

type Configuration = { type: string, key: string, description: string };
type Searchables<T> = { key: string, description: string, id: string, object: T & Configuration };
export type Setting = Configuration & { type: 'setting', defaultValue: any; valueType: string };
export type Command = Configuration & { type: 'command', keybinding?: string, argsSchema?: IJSONSchema, hasArguments?: false };

const settingsSchemaResource = vscode.Uri.parse('vscode://schemas/settings/default');
const keybindingsSchemaResource = vscode.Uri.parse('vscode://schemas/keybindings');
const defaultKeybindingsResource = vscode.Uri.parse('vscode://defaultsettings/keybindings.json');

interface IUserFriendlyKeybinding {
	key: string;
	command: string;
	args?: any;
	when?: string;
}

export class Configurations {

	private readonly miniSearch: MiniSearch<Searchables<Setting | Command>>;

	private initPromise: Promise<void> | undefined;

	constructor(
		context: vscode.ExtensionContext,
		private readonly logger: vscode.LogOutputChannel,
	) {
		this.miniSearch = new MiniSearch<Searchables<Setting | Command>>({
			fields: ['key', 'description'],
			storeFields: ['key', 'object'],
		});
		this.init();
		context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === settingsSchemaResource.toString()
				|| e.document.uri.toString() === defaultKeybindingsResource.toString()
				|| e.document.uri.toString() === keybindingsSchemaResource.toString()) {
				this.initPromise = undefined;
			}
		}));
	}

	private init(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = (async () => {
				this.miniSearch.removeAll();
				const [searchableSettings, searchableCommands] = await Promise.all([
					this.getSearchableSettings(),
					this.getSearchableCommands()
				]);
				this.logger.info(`Found ${searchableSettings.length} searchable settings`);
				this.logger.info(`Found ${searchableCommands.length} searchable commands`);
				this.miniSearch.addAll([...searchableSettings, ...searchableCommands]);
			})();
		}
		return this.initPromise;
	}

	private async getSearchableSettings(): Promise<Searchables<Setting>[]> {
		const defaultSettingsSchemaDocument = await vscode.workspace.openTextDocument(settingsSchemaResource);

		const settings: IJSONSchema = JSON.parse(defaultSettingsSchemaDocument.getText());
		if (!settings.properties) {
			return [];
		}

		const searchableSettings: Searchables<Setting>[] = [];
		for (const key in settings.properties) {
			if (key.startsWith('[')) {
				continue;
			}

			let property: IJSONSchema | undefined = settings.properties[key];

			// If property has a definition reference, retrieve it
			if (property.$ref !== undefined) {
				property = followReference(property.$ref, settings);
			}

			if (!property) {
				continue;
			}

			// Add enum descriptions if applicable
			let description = property.markdownDescription ?? property.description ?? '';
			if (property.type === 'string' && property.enum) {
				description += '\n' + enumsDescription(property.enum, property.enumDescriptions ?? property.markdownEnumDescriptions ?? []);
			}

			searchableSettings.push({
				id: `settings:${key}`,
				key,
				description,
				object: {
					key,
					description,
					defaultValue: property.default,
					valueType: (Array.isArray(property.type) ? property.type[0] : property.type) ?? 'string',
					type: 'setting',
				}
			});
		}

		return searchableSettings;
	}

	private async getSearchableCommands(): Promise<Searchables<Command>[]> {
		const [defaultKeybindingsDocument, keybindingsSchemaResourceDocument] = await Promise.all([
			vscode.workspace.openTextDocument(defaultKeybindingsResource),
			vscode.workspace.openTextDocument(keybindingsSchemaResource),
		]);
		const keybindingsSchema: IJSONSchema = JSON.parse(keybindingsSchemaResourceDocument.getText());
		const defaultKeybindingsDocumennt: IUserFriendlyKeybinding[] = jsonc.parse(defaultKeybindingsDocument.getText());

		// Find all commands with arguments
		const commandsWithArgs = new Map<string, IJSONSchema>();
		for (const p of keybindingsSchema.definitions?.['commandsSchemas']?.allOf ?? []) {

			// Resolve all $ref in the command schema
			resolveReferences(p, keybindingsSchema);

			const commandId = p.if?.properties?.command?.const;
			if (commandId === undefined) {
				continue;
			}

			const commandSchema = p.then;
			if (commandSchema === undefined) {
				continue;
			}

			const argumentsSchema = commandSchema.properties?.args;
			if (!argumentsSchema) {
				this.logger.info(`Skipping command ${commandId}: Does not have a args schema: ${JSON.stringify(commandSchema)}`);
				continue;
			}

			this.logger.trace(`Found command with args: ${commandId}, ${argumentsSchema}`);
			commandsWithArgs.set(commandId, argumentsSchema);
		}

		const searchableCommands: Searchables<Command>[] = [];

		const commandNames = keybindingsSchema.definitions?.['commandNames'];
		if (!commandNames?.enumDescriptions) {
			return searchableCommands;
		}

		for (let index = 0; index < commandNames.enumDescriptions.length; index++) {
			const commandDescription = commandNames.enumDescriptions[index];
			const commandId = commandNames.enum?.[index];
			if (!commandId) {
				continue;
			}
			if (!commandDescription) {
				this.logger.trace(`Skipping command ${commandId}: Does not have a description`);
				continue;
			}

			const argsSchema = commandsWithArgs.get(commandId);
			searchableCommands.push({
				id: `command:${commandId}`,
				key: commandId,
				description: commandDescription,
				object: {
					key: commandId,
					description: commandDescription,
					type: 'command',
					keybinding: defaultKeybindingsDocumennt.find(keybinding => keybinding.command === commandId)?.key,
					argsSchema: argsSchema,
					hasArguments: argsSchema === undefined ? false : undefined,
				}
			});
		}

		return searchableCommands;
	}

	async search(keywords: string, limit: number): Promise<(Setting | Command)[]> {
		await this.init();

		// search for exact match on key
		let results = this.miniSearch.search(keywords, { fields: ['key'], prefix: true, filter: (result => result.key === keywords) });
		if (results.length === 0) {
			// search based on configuration id and description
			results = this.miniSearch.search(keywords, { fields: ['key', 'description'] });
		}

		return results.slice(0, limit).map(result => result.object);
	}
}

function enumsDescription(enumKeys: string[], enumDescriptions: string[]): string {
	if (enumKeys.length === 0) {
		return '';
	}

	const prefix = 'Allowed Enums:\n';
	const enumsDescriptions = enumKeys.map((enumKey, index) => {
		const enumDescription = enumDescriptions[index];
		return enumKey + enumDescription ? `: ${enumDescription}` : '';
	}).join('\n');

	return prefix + enumsDescriptions;
}
