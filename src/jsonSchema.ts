/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';

export interface IJSONSchema {
	id?: string;
	$id?: string;
	$schema?: string;
	type?: JSONSchemaType | JSONSchemaType[];
	title?: string;
	default?: any;
	definitions?: IJSONSchemaMap;
	description?: string;
	properties?: IJSONSchemaMap;
	patternProperties?: IJSONSchemaMap;
	additionalProperties?: boolean | IJSONSchema;
	minProperties?: number;
	maxProperties?: number;
	dependencies?: IJSONSchemaMap | { [prop: string]: string[] };
	items?: IJSONSchema | IJSONSchema[];
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	additionalItems?: boolean | IJSONSchema;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: boolean | number;
	exclusiveMaximum?: boolean | number;
	multipleOf?: number;
	required?: string[];
	$ref?: string;
	anyOf?: IJSONSchema[];
	allOf?: IJSONSchema[];
	oneOf?: IJSONSchema[];
	not?: IJSONSchema;
	enum?: any[];
	format?: string;

	// schema draft 06
	const?: any;
	contains?: IJSONSchema;
	propertyNames?: IJSONSchema;
	examples?: any[];

	// schema draft 07
	$comment?: string;
	if?: IJSONSchema;
	then?: IJSONSchema;
	else?: IJSONSchema;

	// schema 2019-09
	unevaluatedProperties?: boolean | IJSONSchema;
	unevaluatedItems?: boolean | IJSONSchema;
	minContains?: number;
	maxContains?: number;
	deprecated?: boolean;
	dependentRequired?: { [prop: string]: string[] };
	dependentSchemas?: IJSONSchemaMap;
	$defs?: { [name: string]: IJSONSchema };
	$anchor?: string;
	$recursiveRef?: string;
	$recursiveAnchor?: string;
	$vocabulary?: any;

	// schema 2020-12
	prefixItems?: IJSONSchema[];
	$dynamicRef?: string;
	$dynamicAnchor?: string;

	// VSCode extensions

	defaultSnippets?: IJSONSchemaSnippet[];
	errorMessage?: string;
	patternErrorMessage?: string;
	deprecationMessage?: string;
	markdownDeprecationMessage?: string;
	enumDescriptions?: string[];
	markdownEnumDescriptions?: string[];
	markdownDescription?: string;
	doNotSuggest?: boolean;
	suggestSortText?: string;
	allowComments?: boolean;
	allowTrailingCommas?: boolean;
}

export interface IJSONSchemaMap {
	[name: string]: IJSONSchema;
}

export interface IJSONSchemaSnippet {
	label?: string;
	description?: string;
	body?: any; // a object that will be JSON stringified
	bodyText?: string; // an already stringified JSON object that can contain new lines (\n) and tabs (\t)
}

function parseReference($ref: string): string[] | undefined {
	if (!$ref.startsWith('#/')) {
		return undefined;
	}
	return $ref.split('/').slice(1);
}

export function followReference($ref: string, document: IJSONSchema): IJSONSchema | undefined {
	const parsedRef = parseReference($ref);
	if (!parsedRef) {
		return undefined;
	}

	let current: any = document;
	for (const part of parsedRef) {
		if (current.hasOwnProperty(part)) {
			current = current[part];
		} else {
			return undefined;
		}
	}
	return current;
}
export function resolveReferences(partialSchema: any, documentSchema: IJSONSchema): void {
	// Check for nested $ref properties and replace them with their definitions
	// Recursive references are included only once to avoid infinite recursion

	const checkAndReplaceRef = (schema: any, followedReferences: string[]) => {
		if (typeof schema !== 'object' || schema === null) {
			return;
		}

		for (const key in schema) {
			if (key === '$ref' && typeof schema['$ref'] === 'string') {
				// Only resolve a reference once to avoid infinite recursion and very large schemas
				if (followedReferences.includes(schema['$ref'])) {
					continue;
				}

				// Make a copy so a different path can also resolve this reference once
				const newFollowedReferences = [...followedReferences, schema['$ref']];

				// retrieve the referenced definition
				const def = followReference(schema['$ref'], documentSchema);
				delete schema['$ref'];
				if (!def) {
					continue;
				}

				for (const defKey in def) {
					schema[defKey] = (def as any)[defKey];
				}
				// rerun for the same schema again including the resolved reference
				checkAndReplaceRef(schema, newFollowedReferences);
				break;
			} else {
				checkAndReplaceRef(schema[key], followedReferences);
			}
		}
	};

	checkAndReplaceRef(partialSchema, []);
}
