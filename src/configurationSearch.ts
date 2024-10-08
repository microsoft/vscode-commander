/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import MiniSearch from 'minisearch';

// Configuration
type Configuration = { type: string, key: string, description: string };
type Searchables<T> = { key: string, description: string, id: string, object: T & Configuration };

export type Setting = Configuration & { defaultValue: any; valueType: string; };
export type Command = Configuration;

async function setupSearch(logger: vscode.LogOutputChannel): Promise<MiniSearch<Searchables<Setting | Command>>> {
	const defaultSettingsSchemaResource = vscode.Uri.parse('vscode://schemas/settings/default');
	const commandsSchemaResource = vscode.Uri.parse('vscode://schemas/keybindings');

	const [defaultSettingsSchemaDocument, commandsSchemaResourceDocument] = await Promise.all([
		vscode.workspace.openTextDocument(defaultSettingsSchemaResource),
		vscode.workspace.openTextDocument(commandsSchemaResource)
	]);

	const settings = JSON.parse(defaultSettingsSchemaDocument.getText()) as SettingsDefaults;
	const commands = JSON.parse(commandsSchemaResourceDocument.getText()) as CommandsRegistry;

	const searchableSettings = getSearchableSettings(settings);
	logger.info(`Found ${searchableSettings.length} searchable settings`);

	const searchableCommands = getSearchableCommands(commands, logger);
	logger.info(`Found ${searchableCommands.length} searchable commands`);

	const miniSearch = new MiniSearch<Searchables<Setting | Command>>({
		fields: ['key', 'description'],
		storeFields: ['key', 'object'],
	});

	miniSearch.addAll([...searchableSettings, ...searchableCommands]);
	return miniSearch;
}

let setupSearchPromise: Promise<MiniSearch<Searchables<Setting | Command>>>;
async function searchConfiguration(keywords: string, logger: vscode.LogOutputChannel): Promise<(Setting | Command)[]> {
	if (!setupSearchPromise) {
		setupSearchPromise = setupSearch(logger);
	}

	// search for exact match on key
	let results = (await setupSearchPromise).search(keywords, { fields: ['key'], prefix: true, filter: (result => result.key === keywords) });
	if (results.length === 0) {
		// search based on configuration id and description
		results = (await setupSearchPromise).search(keywords, { fields: ['key', 'description'] });
	}

	return results.map(result => result.object);
}

export async function getConfigurationsFromKeywords(keywords: string, limit: number, logger: vscode.LogOutputChannel): Promise<(Setting | Command)[]> {
	const results = (await searchConfiguration(keywords, logger));
	return results.slice(0, limit);
}

// Settings types
interface SettingsDefaults {
	properties: { [key: string]: Property },
	'$defs': { [key: string]: Property }
};
interface Property {
	$ref?: string,
	id: string,
	defaultValue: any;
	type: string;
	description?: string;
	markdownDescription?: string;
	enum?: string[];
	enumDescriptions?: string[];
	markdownEnumDescription?: string[]
};

function getSearchableSettings(settings: SettingsDefaults): Searchables<Setting>[] {
	return Object.keys(settings.properties).
		filter(key => !key.startsWith('[')).
		map((key, id) => {
			let property = settings.properties[key];

			// If property has a definition reference, retrieve it
			const reference = property['$ref'];
			if (reference !== undefined && reference.startsWith('#/$defs/')) {
				property = followReference(reference, settings);
			}

			// Add enum descriptions if applicable
			let description = property.markdownDescription ?? property.description ?? '';
			if (property.type === 'string' && property.enum) {
				description += '\n' + enumsDescription(property.enum, property.enumDescriptions ?? property.markdownEnumDescription ?? []);
			}

			const searchable: Searchables<Setting> = {
				id: `settings:${id}`,
				key,
				description,
				object: {
					key,
					description,
					defaultValue: property.defaultValue,
					valueType: property.type,
					type: 'setting',
				}
			};

			return searchable;
		});
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

function followReference(reference: string, settings: SettingsDefaults): Property {
	const referenceNumber = reference.split('/').pop();
	if (referenceNumber === undefined) {
		throw new Error('Reference number is undefined');
	}

	const referencedProperty = settings['$defs'][referenceNumber];
	if (referencedProperty === undefined) {
		throw new Error(`Referenced property ${reference} does not exist`);
	}

	return referencedProperty;
}


interface CommandsRegistry {
	definitions: CommandsDefinitions;
}

interface CommandsDefinitions {
	commandNames: CommandNames;
}

interface CommandNames {
	enum: string[];
	enumDescriptions: (string | null)[];
}

function getSearchableCommands(commands: CommandsRegistry, logger: vscode.LogOutputChannel): Searchables<Command>[] {
	const commandNames = commands.definitions.commandNames;
	const commandsWithArgs = new Set<string>();
	for (const p of (commands as any).definitions.commandsSchemas.allOf) {
		if (p.if?.properties?.command?.const) {
			commandsWithArgs.add(p.if.properties.command.const);
		}
	}

	return commandNames.enumDescriptions.map((commandDescription, id) => {
		// only allow commands with escription
		if (commandDescription === null) {
			logger.trace(`Skipping command ${commandNames.enum[id]}: Does not have a description`);
			return undefined;
		}

		const commandId = commandNames.enum[id];
		if (commandsWithArgs.has(commandId)) {
			logger.trace(`Skipping command ${commandId}: Has arguments`);
			return undefined;
		}

		const searchable: Searchables<Command> = {
			id: `command:${id}`,
			key: commandId,
			description: commandDescription,
			object: {
				key: commandId,
				description: commandDescription,
				type: 'command',
			}
		};

		return searchable;
	}).filter(c => c !== undefined);
}