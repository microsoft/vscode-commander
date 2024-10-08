import * as vscode from 'vscode';
import { getConfigurationsFromKeywords } from './configurationSearch';

export function activate(context: vscode.ExtensionContext) {

	// Create a chat participant
	const chatParticipant = vscode.chat.createChatParticipant('c', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
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

		const messages = [
			vscode.LanguageModelChatMessage.User('You are a VS Code commander and your goal is to update settings by using the provided tools. Make sure the setting exists. Do not update the setting if you wont update the value. Never ask the user whether they think you should update the setting, just do it.'),
		];

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

		messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

		await invokeModelWithTools(messages, model, tools, request, response, token);
	});

	context.subscriptions.push(vscode.lm.registerTool('searchSettings', {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords?: string }>, token: vscode.CancellationToken) {
			if (!options.parameters.keywords) {
				return { 'text/plain': 'Unable to call searchSettings without keywords' };
			}
			console.log('Keywords:', options.parameters.keywords);
			const configurations = await getConfigurationsFromKeywords(options.parameters.keywords, 7);
			console.log('Configurations:', configurations);

			if (token.isCancellationRequested) {
				return { 'text/plain': 'Cancelled' };
			}

			if (configurations.length === 0) {
				return { 'text/plain': 'No configuration found' };
			}

			return {
				'application/json': JSON.stringify(configurations.map(c => ({
					id: c.key,
					value: vscode.workspace.getConfiguration().get(c.key),
					defaultValue: c.default,
					type: c.type
				}))),
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

			console.log('Setting', options.parameters.key, 'to', options.parameters.value);
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

	context.subscriptions.push(chatParticipant);
}

interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelChatResponseToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

async function invokeModelWithTools(initialMessages: vscode.LanguageModelChatMessage[], model: vscode.LanguageModelChat, tools: vscode.LanguageModelChatTool[], request: vscode.ChatRequest, response: vscode.ChatResponseStream, token: vscode.CancellationToken) {

	const messages = [...initialMessages];
	const toolCalls: IToolCall[] = [];

	const modelResponse = await model.sendRequest(messages, { tools });

	try {
		for await (const message of modelResponse.stream) {

			if (message instanceof vscode.LanguageModelChatResponseTextPart) {
				response.markdown(message.value);
			}

			else if (message instanceof vscode.LanguageModelChatResponseToolCallPart) {
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
							console.warn('Failed to parse parameters for tool', tool.id, message.parameters);
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
		console.error('Error invoking model with tools', e);
		throw e;
	}

	if (toolCalls.length) {
		const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
		assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelChatResponseToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters));
		messages.push(assistantMsg);
		for (const toolCall of toolCalls) {
			// NOTE that the result of calling a function is a special content type of a USER-message
			const message = vscode.LanguageModelChatMessage.User('');

			const toolResult = await toolCall.result;
			message.content2 = [new vscode.LanguageModelChatMessageToolResultPart(toolCall.call.toolCallId, toolResult['application/json'] ?? toolResult['text/plain'])];
			messages.push(message);
		}

		// IMPORTANT The prompt must end with a USER message (with no tool call)
		messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));

		return invokeModelWithTools(messages, model, tools, request, response, token);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }
