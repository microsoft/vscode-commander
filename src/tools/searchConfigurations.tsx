/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command, Configurations, Setting } from '../configurationSearch';
import { BasePromptElementProps, PromptElement, contentType as promptTsxContentType, renderElementJSON } from '@vscode/prompt-tsx';
import { pruneToolResult } from './utils';

type SearchConfigurationsResults = ((Setting & { currentValue: unknown }) | Command)[];

interface SearchConfigurationsResultSuccessProps extends BasePromptElementProps {
	readonly result: SearchConfigurationsResults;
}

interface SearchConfigurationsResultErrorProps extends BasePromptElementProps {
	readonly error: string;
}

type SearchConfigurationsResultProps = SearchConfigurationsResultSuccessProps | SearchConfigurationsResultErrorProps;

function isSuccess(props: SearchConfigurationsResultProps): props is SearchConfigurationsResultSuccessProps {
	return !!(props as SearchConfigurationsResultSuccessProps).result;
}

class SearchConfigurationsResult extends PromptElement<SearchConfigurationsResultProps> {

	render() {
		if (!isSuccess(this.props)) {
			return <>{this.props.error} </>;
		} else {
			return <>{JSON.stringify(this.props.result)}</>;
		}
	}
}

export class SearchConfigurations implements vscode.LanguageModelTool<{ keywords?: string }> {

	static readonly ID = 'searchConfigurations';

	constructor(
		private readonly configurations: Configurations,
		private readonly logger: vscode.LogOutputChannel
	) {
	}

	prepareToolInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `Searching for actions`,
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords?: string }>, token: vscode.CancellationToken) {
		return pruneToolResult(options.requestedContentTypes, await this._invoke(options, token));
	}

	private async _invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords?: string }>, token: vscode.CancellationToken) {
		if (!options.parameters.keywords) {
			return await this.createToolErrorResult('Unable to call searchConfigurations without keywords', options, token);
		}

		this.logger.info('Keywords:', options.parameters.keywords);
		const searchResults = await this.configurations.search(options.parameters.keywords, 50);
		this.logger.info('Configurations:', searchResults.map(c => ({ id: c.key, type: c.type })));

		if (token.isCancellationRequested) {
			return await this.createToolErrorResult('Cancelled', options, token);
		}

		if (searchResults.length === 0) {
			return await this.createToolErrorResult('No configuration found', options, token);
		}

		const result: SearchConfigurationsResults = searchResults.map(c => {
			if (c.type === 'setting') {
				return { ...c, currentValue: vscode.workspace.getConfiguration().get(c.key) };
			}
			return c;
		});

		this.logger.trace('Sending Configurations:', JSON.stringify(result));

		return await this.createToolResult({ result }, options, token);
	}

	private async createToolResult(resultProps: SearchConfigurationsResultSuccessProps, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return {
			[promptTsxContentType]: await renderElementJSON(SearchConfigurationsResult, resultProps, options.tokenOptions, token),
			'text/plain': JSON.stringify(resultProps.result)
		};
	}

	private async createToolErrorResult(errorMessage: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return {
			[promptTsxContentType]: await renderElementJSON(SearchConfigurationsResult, { error: errorMessage }, options.tokenOptions, token),
			'text/plain': errorMessage
		};
	}
}