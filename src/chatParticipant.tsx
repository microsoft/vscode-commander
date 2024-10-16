/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SearchConfigurations } from './tools/searchConfigurations';
import { UpdateSettings } from './tools/updateSettings';
import { RunCommand } from './tools/runCommands';
import {
	AssistantMessage,
	BasePromptElementProps,
	contentType as promptTsxContentType,
	PrioritizedList,
	PromptElement,
	PromptPiece,
	PromptSizing,
	UserMessage,
	PromptMetadata,
	ToolCall,
	Chunk,
	ToolMessage,
	renderPrompt,
} from '@vscode/prompt-tsx';
import { ChatResponsePart } from '@vscode/prompt-tsx/dist/base/vscodeTypes';

const agentSupportedContentTypes = [promptTsxContentType, 'text/plain'];

export interface TsxToolUserMetadata {
	readonly toolCallsMetadata: ToolCallsMetadata;
}

export interface ToolCallsMetadata {
	readonly toolCallRounds: ToolCallRound[];
	readonly toolCallResults: Record<string, vscode.LanguageModelToolResult>;
}

export function isTsxToolUserMetadata(obj: unknown): obj is TsxToolUserMetadata {
	// If you change the metadata format, you would have to make this stricter or handle old objects in old ChatRequest metadata
	return !!obj &&
		!!(obj as TsxToolUserMetadata).toolCallsMetadata &&
		Array.isArray((obj as TsxToolUserMetadata).toolCallsMetadata.toolCallRounds);
}

interface HistoryProps extends BasePromptElementProps {
	readonly priority: number;
	readonly context: vscode.ChatContext;
}

class History extends PromptElement<HistoryProps, void> {

	render() {
		return (
			<PrioritizedList priority={this.props.priority} descending={false}>
				{this.props.context.history.map((turn) => {
					if (turn instanceof vscode.ChatRequestTurn) {
						return <UserMessage>{turn.prompt}</UserMessage>;
					} else if (turn instanceof vscode.ChatResponseTurn) {
						const metadata = turn.result.metadata;

						if (isTsxToolUserMetadata(metadata) && metadata.toolCallsMetadata.toolCallRounds.length > 0) {
							return <ToolCalls toolCallResults={metadata.toolCallsMetadata.toolCallResults} toolCallRounds={metadata.toolCallsMetadata.toolCallRounds} toolInvocationToken={undefined} />;
						}

						return <AssistantMessage>{
							turn.response.map(response => {
								if (response instanceof vscode.ChatResponseMarkdownPart) {
									return response.value.value;
								}
							}).join('')
						}</AssistantMessage>;
					}
				})}
			</PrioritizedList>
		);
	}
}

interface ToolCallElementProps extends BasePromptElementProps {
	readonly toolCall: vscode.LanguageModelToolCallPart;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	readonly toolCallResult: vscode.LanguageModelToolResult | undefined;
}

class ToolCallElement extends PromptElement<ToolCallElementProps, void> {
	async render(state: void, sizing: PromptSizing): Promise<PromptPiece | undefined> {
		const tool = vscode.lm.tools.find(t => t.name === this.props.toolCall.name);
		if (!tool) {
			console.error(`Tool not found: ${this.props.toolCall.name}`);
			return <ToolMessage toolCallId={this.props.toolCall.toolCallId}>Tool not found</ToolMessage>;
		}

		const contentType = agentSupportedContentTypes.find(type => tool.supportedContentTypes.includes(type));
		if (!contentType) {
			console.error(`Tool does not support any of the agent's content types: ${tool.name}`);
			return <ToolMessage toolCallId={this.props.toolCall.toolCallId}>Tool unsupported</ToolMessage>;
		}

		const tokenOptions: vscode.LanguageModelToolInvocationOptions<unknown>['tokenOptions'] = {
			tokenBudget: sizing.tokenBudget,
			countTokens: async (content: string) => sizing.countTokens(content),
		};

		const toolResult = this.props.toolCallResult ??
			await vscode.lm.invokeTool(this.props.toolCall.name, { parameters: this.props.toolCall.parameters, requestedContentTypes: [contentType], toolInvocationToken: this.props.toolInvocationToken, tokenOptions }, new vscode.CancellationTokenSource().token);

		return <ToolMessage toolCallId={this.props.toolCall.toolCallId}>
			<meta value={new ToolResultMetadata(this.props.toolCall.toolCallId, toolResult)}></meta>
			{contentType === 'text/plain' ?
				toolResult[contentType] :
				<elementJSON data={toolResult[contentType]}></elementJSON>}
		</ToolMessage>;
	}
}

interface ToolCallsProps extends BasePromptElementProps {
	readonly toolCallRounds: ToolCallRound[];
	readonly toolCallResults: Record<string, vscode.LanguageModelToolResult>;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

class ToolCalls extends PromptElement<ToolCallsProps, void> {
	async render(state: void, sizing: PromptSizing) {
		if (!this.props.toolCallRounds.length) {
			return undefined;
		}

		return <>
			{this.props.toolCallRounds.map(round => this.renderOneToolCallRound(round))}
			<UserMessage>Above is the result of calling one or more tools. The user cannot see the results, so you should explain them to the user if referencing them in your answer.</UserMessage>
		</>;
	}

	private renderOneToolCallRound(round: ToolCallRound) {
		const assistantToolCalls: ToolCall[] = round.toolCalls.map(tc => ({ type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.parameters) }, id: tc.toolCallId }));
		return <Chunk>
			<AssistantMessage toolCalls={assistantToolCalls}>{round.response}</AssistantMessage>
			{round.toolCalls.map(toolCall =>
				<ToolCallElement toolCall={toolCall} toolInvocationToken={this.props.toolInvocationToken} toolCallResult={this.props.toolCallResults[toolCall.toolCallId]}></ToolCallElement>
			)}
		</Chunk>;
	}
}

interface ToolCallRound {
	readonly response: string;
	readonly toolCalls: vscode.LanguageModelToolCallPart[];
}

interface CommanderPromptProps extends BasePromptElementProps {
	readonly request: vscode.ChatRequest;
	readonly context: vscode.ChatContext;
	readonly toolCallRounds: ToolCallRound[];
	readonly toolCallResults: Record<string, vscode.LanguageModelToolResult>;
}

class CommanderPrompt extends PromptElement<CommanderPromptProps, void> {

	render(state: void, sizing: PromptSizing, progress?: vscode.Progress<ChatResponsePart>, token?: vscode.CancellationToken) {
		return <>
			<UserMessage>
				You are a VS Code commander, tasked with performing actions in VS Code using the provided tools. You must always execute the following steps:<br />
				0. IMPORTANT: Never guess or rely from history or memory.<br />
				1. Come up with keywords, phrases and synonyms that you think the user might use to describe the action they want to perform.<br />
				2. Use the {SearchConfigurations.ID} tool to find configurations that match with the keywords you found in step 1. Only use the {SearchConfigurations.ID} tool once.<br />
				3. Look for the most appropriate setting or command that matches the user's intent. Prefer setting over command if available.<br />
				4. Use the {UpdateSettings.ID} tool to update the setting to the value the user requested. If there are multiple settings to update, update them in bulk.<br />
				5. If you are running command with 'vscode.setEditorLayout' id, use step by step reasoning to come up with the arguments explaining to the user.<br />
				6. Use the {RunCommand.ID} tool to run a command found using the {SearchConfigurations.ID}.<br />
				7. Never ask the user whether they think you should perform the action or suggest actions, YOU JUST DO IT!!!<br />
				8. Always inform the user about the setting and the value you updated or the command and the arguments you ran, including its keybinding if applicable.
			</UserMessage>
			<History context={this.props.context} priority={10} />
			<UserMessage>{this.props.request.prompt}</UserMessage>
			<ToolCalls
				toolCallRounds={this.props.toolCallRounds}
				toolInvocationToken={this.props.request.toolInvocationToken}
				toolCallResults={this.props.toolCallResults}>
			</ToolCalls>
		</>;
	}
}

// interface IToolCall {
// 	tool: vscode.LanguageModelToolDescription;
// 	call: vscode.LanguageModelToolCallPart;
// 	result: Thenable<vscode.LanguageModelToolResult>;
// }

export class ToolResultMetadata extends PromptMetadata {
	constructor(
		public toolCallId: string,
		public result: vscode.LanguageModelToolResult,
	) {
		super();
	}
}

export default function (
	updatedSettings: { key: string, oldValue: any, newValue: any }[],
	ranCommands: { key: string, arguments: any }[],
	logger: vscode.LogOutputChannel
) {
	return async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		updatedSettings.splice(0, updatedSettings.length);
		ranCommands.splice(0, ranCommands.length);

		const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });

		const tools = vscode.lm.tools
			.filter(t => t.tags.includes('commander'))
			.map<vscode.LanguageModelChatTool>(t => ({
				name: t.name,
				description: t.description,
				parametersSchema: t.parametersSchema
			}));


		const toolCallRounds: ToolCallRound[] = [];
		const toolCallResults: Record<string, vscode.LanguageModelToolResult> = {};

		while (true) {
			const { messages, metadatas } = await renderPrompt(CommanderPrompt, { request, context, toolCallRounds, toolCallResults }, { modelMaxPromptTokens: model.maxInputTokens }, model);
			const toolResultMetadata = metadatas.getAll(ToolResultMetadata);

			if (toolResultMetadata?.length) {
				toolResultMetadata.forEach(meta => toolCallResults[meta.toolCallId] = meta.result);
			}

			logger.trace('sending request to the model');
			const modelResponse = await model.sendRequest(messages, { tools });
			logger.info('model responded.');

			const toolCalls: vscode.LanguageModelToolCallPart[] = [];
			let responseString = '';

			for await (const part of modelResponse.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					response.markdown(part.value);
					responseString += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const tool = vscode.lm.tools.find(t => t.name === part.name);

					if (!tool) {
						continue;
					}

					toolCalls.push(part);
					// logger.info('Invoking tool', tool.name);
					// toolCalls.push({
					// 	call: message,
					// 	result: vscode.lm.invokeTool(tool.name, {
					// 		toolInvocationToken: request.toolInvocationToken,
					// 		requestedContentTypes: ['text/plain', 'application/json'],
					// 		parameters: message.parameters
					// 	}, token),
					// 	tool
					// });
				}
			}

			if (toolCalls.length === 0) {
				break;
			}

			toolCallRounds.push({ response: responseString, toolCalls });
		}

		if (updatedSettings.length && !ranCommands.length) {
			response.button({
				command: 'vscode-commander.undo-settings-updates',
				title: 'Undo',
			});
		}

		return {
			metadata: {
				toolCallsMetadata: {
					toolCallResults,
					toolCallRounds
				}
			}
		};


		// async function invokeModelWithTools(model: vscode.LanguageModelChat, tools: vscode.LanguageModelChatTool[], request: vscode.ChatRequest, response: vscode.ChatResponseStream, logger: vscode.LogOutputChannel, token: vscode.CancellationToken) {

		// 	if (toolCalls.length) {
		// 		for (const toolCall of toolCalls) {
		// 			const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
		// 			assistantMsg.content2 = [new vscode.LanguageModelToolCallPart(toolCall.tool.name, toolCall.call.toolCallId, toolCall.call.parameters)];
		// 			messages.push(assistantMsg);

		// 			// NOTE that the result of calling a function is a special content type of a USER-message
		// 			const message = vscode.LanguageModelChatMessage.User('');
		// 			const toolResult = await toolCall.result;
		// 			message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, toolResult['application/json'] ?? toolResult['text/plain'])];
		// 			messages.push(message);
		// 		}

		// 		// IMPORTANT The prompt must end with a USER message (with no tool call)
		// 		messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.name).join(', ')}. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));

		// 		return invokeModelWithTools(model, tools, request, response, logger, token);
		// 	}
		// }

		// await invokeModelWithTools(model, tools, request, response, logger, token);

	};
}

