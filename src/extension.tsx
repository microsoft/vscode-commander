/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command, Configurations, Setting } from './configurationSearch';
import { renderPrompt, PromptElement, UserMessage, AssistantMessage, BasePromptElementProps, PromptPiece, PromptSizing, contentType, renderElementJSON } from '@vscode/prompt-tsx';
import { BaseChatMessage, TextChunk, ToolMessage, ToolResult } from '@vscode/prompt-tsx/dist/base/promptElements';
import { ChatResponsePart } from '@vscode/prompt-tsx/dist/base/vscodeTypes';

interface HistoryProps extends BasePromptElementProps {
	readonly context: vscode.ChatContext;
}

class History extends PromptElement<HistoryProps> {
	render(state: void, sizing: PromptSizing, progress?: vscode.Progress<ChatResponsePart>, token?: vscode.CancellationToken) {
		const result: PromptPiece[] = [];

		for (const history of this.props.context.history) {
			if (history instanceof vscode.ChatRequestTurn) {
				// messages.push(vscode.LanguageModelChatMessage.User(history.prompt));
				result.push(<UserMessage>{history.prompt}</UserMessage>);
			} else if (history instanceof vscode.ChatResponseTurn) {
				for (const response of history.response) {
					if (response instanceof vscode.ChatResponseMarkdownPart) {
						result.push(<AssistantMessage>{response.value.value}</AssistantMessage>);
					}
				}
			}
		}

		return <>{...result}</>;
	}
}

interface CommanderPromptProps extends BasePromptElementProps {
	readonly context: vscode.ChatContext;
	readonly initialPrompt: string;
	readonly extra: PromptPiece[];
}

class CommanderPrompt extends PromptElement<CommanderPromptProps> {
	render(state: void, sizing: PromptSizing, progress?: vscode.Progress<ChatResponsePart>, token?: vscode.CancellationToken) {
		return <>
			<UserMessage>
				You are a VS Code commander and your goal is to perform the action in VS Code by using the provided tools.
				You should search for the setting or command that you want to change or execute.
				Prefer to use the setting when you can, and only use the command when the setting is not available.
				When you are updating a setting make sure the setting exists.Do not update the setting if you won't update the value.
				If the setting relies on other settings to be set, make sure to set those as well.
				Never ask the user whether they think you should perform the action, just do it.
				Tell the user which settings have been updated and what the new value is or which commands have been executed.
			</UserMessage>
			<History context={this.props.context} />
			<UserMessage>{this.props.initialPrompt}</UserMessage>
			{...this.props.extra}
		</>;
	}
}

interface SearchConfigurationsResultProps extends BasePromptElementProps {
	readonly settingOrCommand: Setting | Command;
}

class SearchConfigurationsResult extends PromptElement<SearchConfigurationsResultProps> {
	render() {
		const result: any = { ...this.props.settingOrCommand };

		if (this.props.settingOrCommand.type === 'setting') {
			result['currentValue'] = vscode.workspace.getConfiguration().get(this.props.settingOrCommand.key);
		}

		return <>{JSON.stringify(result)}</>;
	}
}

export function activate(context: vscode.ExtensionContext) {

	const logger = vscode.window.createOutputChannel('VS Code Commander', { log: true });
	const configurations = new Configurations(context, logger);

	// Create a chat participant
	const chatParticipant = vscode.chat.createChatParticipant('vscode-commader', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		const [model] = await vscode.lm.selectChatModels({
			family: 'gpt-4o'
		});

		const tools = vscode.lm.tools
			.filter(t => t.tags.includes('commander'))
			.map<vscode.LanguageModelChatTool>(t => ({
				name: t.id,
				description: t.description,
				parametersSchema: t.parametersSchema
			}));

		const extra: PromptPiece[] = [];
		let didInvokeTool = false;

		do {
			const { messages } = await renderPrompt(
				CommanderPrompt,
				{ context, initialPrompt: request.prompt, extra },
				{ modelMaxPromptTokens: 4096 },
				model
			);

			const modelResponse = await model.sendRequest(messages, { tools });

			for await (const message of modelResponse.stream) {
				if (message instanceof vscode.LanguageModelTextPart) {
					response.markdown(message.value);
					extra.push(<AssistantMessage>{message.value}</AssistantMessage>);
				} else if (message instanceof vscode.LanguageModelToolCallPart) {
					const tool = vscode.lm.tools.find(t => t.id === message.name);

					if (!tool) {
						continue;
					}

					// ???
					// promptElements.push(<AssistantMessage toolCalls={[{ id: tool.id, type: 'function', function:}]}></AssistantMessage>);
					extra.push(<ToolCallTurnPrompt id={tool.id} parameters={JSON.parse(message.parameters)} invocationToken={request.toolInvocationToken} />);
					didInvokeTool = true;
				}
			}

			if (didInvokeTool) {
				messages.push(<UserMessage>
					I have called the tools for you, results are above.
					Please continue with the original request.
				</UserMessage>);
			}

		} while (didInvokeTool);
	});

	context.subscriptions.push(vscode.lm.registerTool('searchConfigurations', {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords?: string }>, token: vscode.CancellationToken) {
			if (!options.parameters.keywords) {
				return { 'text/plain': 'Unable to call searchConfigurations without keywords' };
			}

			logger.info('Keywords:', options.parameters.keywords);
			const result = await configurations.search(options.parameters.keywords, 20);
			logger.info('Configurations:', result.map(c => ({ id: c.key, type: c.type })));

			if (token.isCancellationRequested) {
				return { 'text/plain': 'Cancelled' };
			}

			if (result.length === 0) {
				return { 'text/plain': 'No configuration found' };
			}

			return {
				[contentType]: await renderElementJSON(SearchConfigurationsResult, { settingOrCommand: result[0] }, options.tokenOptions, token)
			};
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool('updateSetting', {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, value?: any }>, token: vscode.CancellationToken) {
			// validate parameters
			if (typeof options.parameters.key !== 'string' || !options.parameters.key.length || options.parameters.value === undefined) {
				return { 'text/plain': 'Not able to change because the parameter is missing or invalid' };
			}

			const oldValue = vscode.workspace.getConfiguration().get(options.parameters.key);
			if (oldValue === options.parameters.value) {
				return { 'text/plain': `${options.parameters.key} is already set to ${options.parameters.value}` };
			}

			logger.info('Setting', options.parameters.key, 'to', options.parameters.value);
			try {
				await vscode.workspace.getConfiguration().update(options.parameters.key, options.parameters.value, vscode.ConfigurationTarget.Global);
			} catch (e: any) {
				return { 'text/plain': `Wasn't able to set ${options.parameters.key} to ${options.parameters.value} because of ${e.message}` };
			}

			return {
				'text/plain': `Set ${options.parameters.key} to ${options.parameters.value}. Previously was ${oldValue}`,
			};
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool('runCommand', {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string }>, token: vscode.CancellationToken) {
			// validate parameters
			if (typeof options.parameters.key !== 'string' || !options.parameters.key.length) {
				return { 'text/plain': 'Not able to change because the parameter is missing or invalid' };
			}

			logger.info(`Running ${options.parameters.key}`);

			try {
				await vscode.commands.executeCommand(options.parameters.key);
			} catch (e: any) {
				return { 'text/plain': `Wasn't able to run ${options.parameters.key} because of ${e.message}` };
			}

			return {
				'text/plain': `Command ${options.parameters.key} is executed`,
			};
		},
	}));

	context.subscriptions.push(chatParticipant);
}

// interface IToolCall {
// 	tool: vscode.LanguageModelToolDescription;
// 	call: vscode.LanguageModelChatResponseToolCallPart;
// 	result: Thenable<vscode.LanguageModelToolResult>;
// }

export interface ToolCallTurnPromptProps extends BasePromptElementProps {
	readonly id: string;
	readonly parameters: unknown;
	readonly invocationToken: vscode.ChatParticipantToolToken;
}

export interface ToolCallTurnPromptState {
	// creationScript: string;
}


class ToolCallTurnPrompt extends PromptElement<ToolCallTurnPromptProps, ToolCallTurnPromptState> {
	async render(state: ToolCallTurnPromptState, sizing: PromptSizing, progress?: vscode.Progress<ChatResponsePart>, token?: vscode.CancellationToken) {
		// FEEDBACK: this should be optional
		token ??= new vscode.CancellationTokenSource().token;

		const result = await vscode.lm.invokeTool(this.props.id, {
			parameters: this.props.parameters,
			tokenOptions: {
				tokenBudget: sizing.tokenBudget,
				countTokens: async (text, token) => await sizing.countTokens(text, token),
			},
			toolInvocationToken: this.props.invocationToken,
			requestedContentTypes: [contentType]
		}, token);

		return <ToolResult data={result} />;
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }
