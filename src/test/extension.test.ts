/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MockConfigurations } from './mocks';

suite('Configuration Search', () => {

	const configurationSearch = new MockConfigurations();

	test('Exact command id match', async () => {
		const configurations = await configurationSearch.search('vscode.setEditorLayout', 50);
		assert.strictEqual(configurations.length, 1);
		assert.strictEqual(configurations[0].type, 'command');
		assert.strictEqual(configurations[0].key, 'vscode.setEditorLayout');
	});

	test('Exact setting id match', async () => {
		const configurations = await configurationSearch.search('workbench.editor.customLabels.patterns', 50);
		assert.strictEqual(configurations.length, 1);
		assert.strictEqual(configurations[0].type, 'setting');
		assert.strictEqual(configurations[0].key, 'workbench.editor.customLabels.patterns');
	});

	test('Keywords: workbench editor custom labels pattern', async () => {
		const configurations = await configurationSearch.search('workbench editor custom labels pattern', 20);
		assert.strictEqual(configurations.some(c => c.key === 'workbench.editor.customLabels.patterns'), true);
	});

	test('Keywords: editor label', async () => {
		const configurations = await configurationSearch.search('editor label', 20);
		assert.strictEqual(configurations.some(c => c.key === 'workbench.editor.customLabels.patterns'), true);
	});

	test('Keywords: label pattern', async () => {
		const configurations = await configurationSearch.search('label pattern', 20);
		assert.strictEqual(configurations.some(c => c.key === 'workbench.editor.customLabels.patterns'), true);
	});

	teardown(() => {
		configurationSearch.dispose();
	});
});
