import * as vscode from 'vscode';
import MiniSearch from 'minisearch';

// Configuration
type Configuration = { type: string };

export type Setting = Configuration & { key: string, description: string; defaultValue: any; valueType: string; };

// Command types
export type Command = Configuration & { key: string, description: string };

export function isCommand(object: any): object is Command {
	return (
		typeof object === 'object' &&
		object !== null &&
		typeof object.key === 'string' &&
		typeof object.description === 'string'
	);
}

// Searching types
type Searchables<T> = { key: string, description: string, id: string, object: T & Configuration };

const configurationSearch = Promise.resolve(setupSearch());

async function setupSearch(): Promise<MiniSearch<Searchables<Setting | Command>>> {
	const defaultSettingsSchemaResource = vscode.Uri.parse('vscode://schemas/settings/default');
	const commandsSchemaResource = vscode.Uri.parse('vscode://schemas/keybindings');
	const [defaultSettingsSchemaDocument, commandsSchemaResourceDocument] = await Promise.all([
		vscode.workspace.openTextDocument(defaultSettingsSchemaResource),
		vscode.workspace.openTextDocument(commandsSchemaResource)
	]);

	const settings = JSON.parse(defaultSettingsSchemaDocument.getText()) as SettingsDefaults;
	const commands = JSON.parse(commandsSchemaResourceDocument.getText()) as CommandsRegistry;

	const searchableSettings = getSearchableSettings(settings);
	const searchableCommands = getSearchableCommands(commands);

	const miniSearch = new MiniSearch<Searchables<Setting | Command>>({
		fields: ['key', 'description'],
		storeFields: ['key', 'object'],
	});

	miniSearch.addAll([...searchableSettings, ...searchableCommands]);
	return miniSearch;
}

async function searchConfiguration(keywords: string): Promise<(Setting | Command)[]> {
	// search for exact match on key
	let results = (await configurationSearch).search(keywords, { fields: ['key'], prefix: true, filter: (result => result.key === keywords) });
	if (results.length === 0) {
		// search based on configuration id and description
		results = (await configurationSearch).search(keywords, { fields: ['key', 'description'] });
	}

	return results.map(result => result.object);
}

export async function getConfigurationsFromKeywords(keywords: string, limit: number): Promise<(Setting | Command)[]> {
	const results = (await searchConfiguration(keywords)).slice(0, limit);
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

			const reference = property['$ref'];
			if (reference !== undefined && reference.startsWith('#/$defs/')) {
				property = followReference(reference, settings);
			}

			let description = property.markdownDescription ?? property.description ?? '';
			if (property.type === 'string' && property.enum && (property.enumDescriptions || property.markdownEnumDescription)) {
				description += '\nAllowed Values:\n' + enumsDescription(property.enum, property.enumDescriptions ?? property.markdownEnumDescription ?? []);
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
	return enumKeys.map((enumKey, index) => {
		const enumDescription = enumDescriptions[index];
		return `${enumKey}: ${enumDescription}`;
	}).join('\n');
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

function getSearchableCommands(commands: CommandsRegistry): Searchables<Command>[] {
	const commandNames = commands.definitions.commandNames;
	const commandsSchemas = (commands as any).definitions.commandsSchemas;
	const allOf = commandsSchemas.allOf;
	const commandsWithArgs = new Set<string>();
	for (const schema of allOf) {
		const schemaIf = schema.if;
		if (schemaIf) {
			const schemaIfProperties = schemaIf.properties;
			if (schemaIfProperties) {
				const schemaIfPropertiesCommand = schemaIfProperties.command;
				if (schemaIfPropertiesCommand) {
					const schemaIfPropertiesCommandConst = schemaIfPropertiesCommand.const;
					if (schemaIfPropertiesCommandConst) {
						commandsWithArgs.add(schemaIfPropertiesCommandConst);
					}
				}
			}
		}
	}

	return commandNames.enumDescriptions.map((commandDescription, id) => {
		// only allow commands with escription
		if (commandDescription === null) {
			return undefined;
		}

		const commandId = commandNames.enum[id];
		if (commandsWithArgs.has(commandId)) {
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