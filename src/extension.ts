/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Configurations } from './configurationSearch';

const SEARCH_TOOL_ID = 'searchConfigurations';

const UPDATE_SETTING_TOOL_ID = 'updateSetting';
const RUN_COMMAND_TOOL_ID = 'runCommand';
const UNDO_SETTINGS_UPDATES_COMMAND_ID = 'vscode-commander.undo-settings-updates';

const updatedSettings: { key: string, oldValue: any, newValue: any }[] = [];
const ranCommands: { key: string, arguments: any }[] = [];

export function activate(context: vscode.ExtensionContext) {

	const logger = vscode.window.createOutputChannel('VS Code Commander', { log: true });
	const configurations = new Configurations(context, logger);

	context.subscriptions.push(vscode.commands.registerCommand(UNDO_SETTINGS_UPDATES_COMMAND_ID, async () => {
		for (const { key, oldValue } of updatedSettings) {
			await vscode.workspace.getConfiguration().update(key, oldValue, vscode.ConfigurationTarget.Global);
		}
	}));

	// Create a chat participant
	const chatParticipant = vscode.chat.createChatParticipant('vscode-commader', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {

		updatedSettings.splice(0, updatedSettings.length);
		ranCommands.splice(0, ranCommands.length);

		const [model] = await vscode.lm.selectChatModels({
			family: 'gpt-4o',
		});

		const tools = vscode.lm.tools
			.filter(t => t.tags.includes('commander'))
			.map<vscode.LanguageModelChatTool>(t => ({
				name: t.id,
				description: t.description,
				parametersSchema: t.parametersSchema
			}));

		const messages = [];

		for (const history of context.history) {
			if (history instanceof vscode.ChatRequestTurn) {
				messages.push(vscode.LanguageModelChatMessage.User(history.prompt));
			}

			if (history instanceof vscode.ChatResponseTurn) {
				for (const response of history.response) {
					if (response instanceof vscode.ChatResponseMarkdownPart) {
						messages.push(vscode.LanguageModelChatMessage.Assistant(response.value.value));
					}
				}
			}
		}

		messages.push(
			vscode.LanguageModelChatMessage.User(
				`You are a VS Code commander, tasked with performing actions in VS Code using the provided tools. Always you should execute the following steps:
0. IMPORTANT: Never guess or rely from history or memory.
1. Come up with keywords, phrases and synonyms that you think the user might use to describe the action they want to perform.
2. Use the ${SEARCH_TOOL_ID} tool to find configurations that match with the keywords you found in step 1.
3. Look for the most appropriate setting or command that matches the user's intent. Prefer setting over command if available.
4. Use the ${UPDATE_SETTING_TOOL_ID} tool to update the setting to the value the user requested. If a setting depends on other settings, ensure they are configured properly as well. If you aren’t updating the value of a setting, don’t change it.
5. Use the ${RUN_COMMAND_TOOL_ID} tool to run the command. 
6. Never ask the user whether they think you should perform the action or suggest actions, YOU JUST DO IT!!!
7. Always inform the user about the setting and value you updated or the command you ran, including its keybinding if applicable.
`
			));

		messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

		await invokeModelWithTools(messages, model, tools, request, response, logger, token);

		if (updatedSettings.length && !ranCommands.length) {
			response.button({
				command: UNDO_SETTINGS_UPDATES_COMMAND_ID,
				title: 'Undo',
			});
		}
	});

	context.subscriptions.push(vscode.lm.registerTool(SEARCH_TOOL_ID, {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords?: string }>, token: vscode.CancellationToken) {
			if (!options.parameters.keywords) {
				return { 'text/plain': 'Unable to call searchConfigurations without keywords' };
			}

			logger.info('Keywords:', options.parameters.keywords);
			const result = await configurations.search(options.parameters.keywords, 50);
			logger.info('Configurations:', result.map(c => ({ id: c.key, type: c.type })));

			if (token.isCancellationRequested) {
				return { 'text/plain': 'Cancelled' };
			}

			if (result.length === 0) {
				return { 'text/plain': 'No configuration found' };
			}

			const resultWithUpdatedValues = result.map(c => {
				if (c.type === 'setting') {
					return { ...c, currentValue: vscode.workspace.getConfiguration().get(c.key) };
				}
				return c;
			});

			logger.trace('Sending Configurations:', resultWithUpdatedValues);

			return {
				'application/json': JSON.stringify(resultWithUpdatedValues)
			};
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool(UPDATE_SETTING_TOOL_ID, {
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
				const oldValue = vscode.workspace.getConfiguration().get(options.parameters.key);
				await vscode.workspace.getConfiguration().update(options.parameters.key, options.parameters.value, vscode.ConfigurationTarget.Global);
				updatedSettings.push({ key: options.parameters.key, oldValue, newValue: options.parameters.value });
			} catch (e: any) {
				return { 'text/plain': `Wasn't able to set ${options.parameters.key} to ${options.parameters.value} because of ${e.message}` };
			}

			return {
				'text/plain': `Set ${options.parameters.key} to ${options.parameters.value}. Previously was ${oldValue}`,
			};
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool(RUN_COMMAND_TOOL_ID, {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken) {
			// validate parameters
			if (typeof options.parameters.key !== 'string' || !options.parameters.key.length) {
				return { 'text/plain': 'Not able to change because the parameter is missing or invalid' };
			}

			let args: any[] = [];
			if (options.parameters.argumentsArray) {
				try {
					args = JSON.parse(options.parameters.argumentsArray);
				} catch (e) {
					logger.warn('Failed to parse args as JSON', e);
				}
			}

			logger.info(`Running ${options.parameters.key}` + (args ? ` with args ${JSON.stringify(args)}` : ''));

			try {
				await vscode.commands.executeCommand(options.parameters.key, ...args);
				ranCommands.push({ key: options.parameters.key, arguments: options.parameters.argumentsArray });
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

interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

async function invokeModelWithTools(initialMessages: vscode.LanguageModelChatMessage[], model: vscode.LanguageModelChat, tools: vscode.LanguageModelChatTool[], request: vscode.ChatRequest, response: vscode.ChatResponseStream, logger: vscode.LogOutputChannel, token: vscode.CancellationToken) {

	const messages = [...initialMessages];
	const toolCalls: IToolCall[] = [];

	const modelResponse = await model.sendRequest(messages, { tools });

	try {
		for await (const message of modelResponse.stream) {

			if (message instanceof vscode.LanguageModelTextPart) {
				response.markdown(message.value);
			}

			else if (message instanceof vscode.LanguageModelToolCallPart) {
				const tool = vscode.lm.tools.find(t => t.id === message.name);
				if (!tool) {
					continue;
				}

				let parameters = undefined;
				if (tool.parametersSchema) {
					if (message.parameters) {
						try {
							parameters = JSON.parse(message.parameters);
						} catch (e) {
							logger.warn('Failed to parse parameters for tool', tool.id, message.parameters);
							continue;
						}
					}
				}

				toolCalls.push({
					call: message,
					result: vscode.lm.invokeTool(tool.id, {
						toolInvocationToken: request.toolInvocationToken,
						requestedContentTypes: ['text/plain', 'application/json'],
						parameters
					}, token),
					tool
				});
			}
		}
	} catch (e) {
		logger.error('Error invoking model with tools', e);
		throw e;
	}

	if (toolCalls.length) {
		const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
		assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters));
		messages.push(assistantMsg);
		for (const toolCall of toolCalls) {
			// NOTE that the result of calling a function is a special content type of a USER-message
			const message = vscode.LanguageModelChatMessage.User('');

			const toolResult = await toolCall.result;
			message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, toolResult['application/json'] ?? toolResult['text/plain'])];
			messages.push(message);
		}

		// IMPORTANT The prompt must end with a USER message (with no tool call)
		messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));

		return invokeModelWithTools(messages, model, tools, request, response, logger, token);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }
