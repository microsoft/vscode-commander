import * as vscode from 'vscode';
import MiniSearch from 'minisearch';

type Property = { $ref?: string, id: string, defaultValue: any; type: string; description?: string; markdownDescription?: string; enum?: string[]; enumDescriptions?: string[]; markdownEnumDescription?: string[] };

export type Configuration = { key: string, default: any; type: string; description: string; };

const configurationSearch = Promise.resolve(setupSearch());

async function setupSearch(): Promise<MiniSearch<Configuration>> {
	const defaultSettingsSchemaResource = vscode.Uri.parse('vscode://schemas/settings/default');
	const textDocument = await vscode.workspace.openTextDocument(defaultSettingsSchemaResource);
	const settings = JSON.parse(textDocument.getText()) as { properties: { [key: string]: Property }, '$defs': { [key: string]: Property } };

	const properties = Object.keys(settings.properties).
		filter(key => !key.startsWith('[')).
		map((key, id) => {
			let property = settings.properties[key];

			const reference = property['$ref'];
			if (reference !== undefined && reference.startsWith('#/$defs/')) {
				const referenceNumber = reference.split('/').pop();
				if (referenceNumber === undefined) {
					throw new Error('Reference number is undefined');
				}

				const referencedProperty = settings['$defs'][referenceNumber];
				if (referencedProperty === undefined) {
					throw new Error('Referenced property does not exist');
				}

				property = referencedProperty;
			}

			let description = property.markdownDescription ?? property.description ?? '';
			if (property.type === 'string' && property.enum && (property.enumDescriptions || property.markdownEnumDescription)) {
				description += '\nAllowed Values:\n' + enumsDescription(property.enum, property.enumDescriptions ?? property.markdownEnumDescription ?? []);
			}

			return {
				id,
				key,
				description,
				default: property.defaultValue,
				type: property.type,
			};
		});

	const miniSearch = new MiniSearch<Configuration>({
		fields: ['key', 'description'],
		storeFields: ['key', 'default', 'type', 'description'],
	});

	miniSearch.addAll(properties);
	return miniSearch;
}

async function searchConfiguration(keywords: string): Promise<Configuration[]> {
	// search for exact match on key
	let results = (await configurationSearch).search(keywords, { fields: ['key'], prefix: true, filter: (result => result.key === keywords) });
	if (results.length === 0) {
		// search based on configuration id and description
		results = (await configurationSearch).search(keywords, { fields: ['key', 'description'] });
	}

	return results.
		map(result => ({
			key: result.key,
			default: result.default,
			type: result.type,
			description: result.description
		}));
}

export async function getConfigurationsFromKeywords(keywords: string, limit: number): Promise<Configuration[]> {
	const results = await searchConfiguration(keywords);
	return results.slice(0, limit);
}

function enumsDescription(enumKeys: string[], enumDescriptions: string[]): string {
	return enumKeys.map((enumKey, index) => {
		const enumDescription = enumDescriptions[index];
		return `${enumKey}: ${enumDescription}`;
	}).join('\n');
}