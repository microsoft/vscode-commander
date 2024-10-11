/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Configurations } from './configurationSearch';
import { SearchConfigurations } from './tools/searchConfigurations';
import { UpdateSettings } from './tools/updateSettings';
import { RunCommands } from './tools/runCommands';

const UNDO_SETTINGS_UPDATES_COMMAND_ID = 'vscode-commander.undo-settings-updates';

const updatedSettings: { key: string, oldValue: any, newValue: any }[] = [];
const ranCommands: { key: string, arguments: any }[] = [];

export function activate(context: vscode.ExtensionContext) {

	const logger = vscode.window.createOutputChannel('VS Code Commander', { log: true });
	const configurations = new Configurations(logger);

	context.subscriptions.push(configurations);

	context.subscriptions.push(vscode.commands.registerCommand(UNDO_SETTINGS_UPDATES_COMMAND_ID, async () => {
		for (const { key, oldValue } of updatedSettings) {
			await vscode.workspace.getConfiguration().update(key, oldValue, vscode.ConfigurationTarget.Global);
		}
	}));

	// Create a chat participant
	context.subscriptions.push(vscode.chat.createChatParticipant('vscode-commader', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {

		updatedSettings.splice(0, updatedSettings.length);
		ranCommands.splice(0, ranCommands.length);

		const model = await getModel('gpt-4o');

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
2. Use the ${SearchConfigurations.ID} tool to find configurations that match with the keywords you found in step 1.
3. Look for the most appropriate setting or command that matches the user's intent. Prefer setting over command if available.
4. Use the ${UpdateSettings.ID} tool to update the setting to the value the user requested.
5. If you are running command with 'vscode.setEditorLayout' id, use step by step reasoning to come up with the arguments explaining to the user.
6. Use the ${RunCommands.ID} tool to run a command found using the ${SearchConfigurations.ID}. 
7. Never ask the user whether they think you should perform the action or suggest actions, YOU JUST DO IT!!!
8. Always inform the user about the setting and the value you updated or the command and the arguments you ran, including its keybinding if applicable.
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
	}));

	context.subscriptions.push(vscode.lm.registerTool(SearchConfigurations.ID, new SearchConfigurations(configurations, logger)));
	context.subscriptions.push(vscode.lm.registerTool(UpdateSettings.ID, new UpdateSettings(updatedSettings, logger)));
	context.subscriptions.push(vscode.lm.registerTool(RunCommands.ID, new RunCommands(ranCommands, logger)));
}

async function getModel(family: string) {
	const [model] = await vscode.lm.selectChatModels({
		family
	});
	return model;
}

interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

async function invokeModelWithTools(initialMessages: vscode.LanguageModelChatMessage[], model: vscode.LanguageModelChat, tools: vscode.LanguageModelChatTool[], request: vscode.ChatRequest, response: vscode.ChatResponseStream, logger: vscode.LogOutputChannel, token: vscode.CancellationToken) {

	const messages = [...initialMessages];
	const toolCalls: IToolCall[] = [];

	logger.trace('sending request to the model');
	const modelResponse = await model.sendRequest(messages, { tools });
	logger.info('model responded.');

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

				logger.info('Invoking tool', tool.id);
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
