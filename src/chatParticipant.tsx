/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SearchConfigurations } from './tools/searchConfigurations';
import { UpdateSettings } from './tools/updateSettings';
import { RunCommand } from './tools/runCommands';
import { ChatResponsePart } from '@vscode/prompt-tsx/dist/base/vscodeTypes';
import {
	AssistantMessage,
	BasePromptElementProps, PrioritizedList,
	PromptElement,
	PromptPiece,
	PromptSizing,
	UserMessage,
	PromptMetadata,
	ToolCall,
	Chunk,
	ToolMessage,
	renderPrompt
} from '@vscode/prompt-tsx';
import { Configurations } from './configurationSearch';
import { getTsxDataFromToolsResult } from './tools/utils';

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
				{this.props.context.history.slice(0, 6).map((turn) => {
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
			return <ToolMessage toolCallId={this.props.toolCall.callId}>Tool not found</ToolMessage>;
		}

		const tokenizationOptions: vscode.LanguageModelToolInvocationOptions<unknown>['tokenizationOptions'] = {
			tokenBudget: sizing.tokenBudget,
			countTokens: async (content: string) => sizing.countTokens(content),
		};

		const toolResult = this.props.toolCallResult ??
			await vscode.lm.invokeTool(this.props.toolCall.name, { parameters: this.props.toolCall.parameters, toolInvocationToken: this.props.toolInvocationToken, tokenizationOptions }, new vscode.CancellationTokenSource().token);

		const data = getTsxDataFromToolsResult(toolResult);
		if (!data) {
			console.error(`Tool result does not contain a TSX part: ${this.props.toolCall.name}`);
			return <ToolMessage toolCallId={this.props.toolCall.callId}>Tool result does not contain a TSX part</ToolMessage>;
		}

		return <ToolMessage toolCallId={this.props.toolCall.callId}>
			<meta value={new ToolResultMetadata(this.props.toolCall.callId, toolResult)}></meta>
			<elementJSON data={data}></elementJSON>
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
		const assistantToolCalls: ToolCall[] = round.toolCalls.map(tc => ({ type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.parameters) }, id: tc.callId }));
		return <Chunk>
			<AssistantMessage toolCalls={assistantToolCalls}>{round.response}</AssistantMessage>
			{round.toolCalls.map(toolCall =>
				<ToolCallElement toolCall={toolCall} toolInvocationToken={this.props.toolInvocationToken} toolCallResult={this.props.toolCallResults[toolCall.callId]}></ToolCallElement>
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
			<History context={this.props.context} priority={10} />
			<UserMessage>
				You are a VS Code commander, tasked with performing actions in VS Code using the provided tools. You must always execute the following steps:<br />
				0. IMPORTANT: Never guess or rely from history or memory.<br />
				1. Come up with keywords, phrases and synonyms that you think the user might use to describe the action they want to perform.<br />
				2. Use the {SearchConfigurations.ID} tool to find configurations that match with the keywords you found in step 1. Only use the {SearchConfigurations.ID} tool once.<br />
				3. Look for the most appropriate setting or command that matches the user's intent. Prefer setting over command if available.<br />
				4. Use the {UpdateSettings.ID} tool to update the setting to the value the user requested. If there are multiple settings to update, update them in bulk.<br />
				5. Always inform the user of each updated setting, including the setting ID and the new value.<br />
				6. Use the {RunCommand.ID} tool to run a command found using the {SearchConfigurations.ID}. Always tell the user what the keybinding is for the command if applicable.<br />
				7. Never ask the user whether they think you should perform the action or suggest actions, YOU JUST DO IT!!!
			</UserMessage>
			<UserMessage>{this.props.request.prompt}</UserMessage>
			<ToolCalls
				toolCallRounds={this.props.toolCallRounds}
				toolInvocationToken={this.props.request.toolInvocationToken}
				toolCallResults={this.props.toolCallResults}>
			</ToolCalls>
		</>;
	}
}

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
	chatContext: { prompt: string },
	configurations: Configurations,
	logger: vscode.LogOutputChannel
) {
	return async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		updatedSettings.splice(0, updatedSettings.length);
		ranCommands.splice(0, ranCommands.length);
		chatContext.prompt = request.prompt;

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
			const { messages, metadatas } = await renderPrompt(CommanderPrompt, { request, context, toolCallRounds, toolCallResults }, { modelMaxPromptTokens: model.maxInputTokens }, model, undefined, token);
			const toolResultMetadata = metadatas.getAll(ToolResultMetadata);

			if (toolResultMetadata?.length) {
				toolResultMetadata.forEach(meta => toolCallResults[meta.toolCallId] = meta.result);
			}

			logger.trace('sending request to the model');
			const modelResponse = await model.sendRequest(messages, { tools }, token);
			logger.info('model responded.');

			const { textResponse, toolCalls } = await processResponseStream(modelResponse, response, configurations);

			if (toolCalls.length === 0) {
				break;
			}

			toolCallRounds.push({ response: textResponse, toolCalls });
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
	};
}

const backtickPattern = /`([^\s`]+)`/g;
async function processResponseStream(modelResponse: vscode.LanguageModelChatResponse, response: vscode.ChatResponseStream, configurations: Configurations): Promise<{ textResponse: string, toolCalls: vscode.LanguageModelToolCallPart[] }> {
	const toolCalls: vscode.LanguageModelToolCallPart[] = [];
	let textResponse = '';
	let buffer = "";

	for await (const part of modelResponse.stream) {
		// Process the text parts. Search for setting and command ids surrounded by backticks
		// and replace them with links to the settings or keybindings
		if (part instanceof vscode.LanguageModelTextPart) {
			buffer += part.value;

			const markdownString = new vscode.MarkdownString(undefined, true);
			markdownString.isTrusted = { enabledCommands: ['workbench.action.openSettings', 'workbench.action.openGlobalKeybindings'] };

			let lastBacktickIndex = buffer.lastIndexOf('`');
			const match = backtickPattern.exec(buffer);

			// Output the rendering of the configuration id if pattern matches
			if (match !== null) {
				const configurationIdWithBackticks = match[0];
				const configurationId = match[1];
				textResponse += buffer; // Do not annotate the ids in the response string

				const renderedConfigurationId = renderConfigurationId(configurationId, configurations);
				buffer = buffer.replace(configurationIdWithBackticks, renderedConfigurationId);
				markdownString.appendMarkdown(buffer);

				buffer = "";
				backtickPattern.lastIndex = 0;
			}
			// Output everything if no backtick found
			else if (lastBacktickIndex === -1 || buffer.length > 80 /*If buffer is to large, flush it. Commands/Settings are shorter*/) {
				textResponse += buffer;
				markdownString.appendMarkdown(buffer);
				buffer = "";
			}
			// Output everything before the last '`' which might be part of an incomplete match
			else {
				const textBeforeTick = buffer.substring(0, lastBacktickIndex);
				textResponse += textBeforeTick;
				markdownString.appendMarkdown(textBeforeTick);
				buffer = buffer.substring(lastBacktickIndex); // Keep the potential match in the buffer
			}

			response.markdown(markdownString);

		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			const tool = vscode.lm.tools.find(t => t.name === part.name);

			if (!tool) {
				continue;
			}

			toolCalls.push(part);
		}
	}

	return { textResponse, toolCalls };
}

function renderConfigurationId(potentialConfigurationId: string, configurations: Configurations): string {
	const setting = configurations.getSetting(potentialConfigurationId);
	if (setting) {
		return `[\`${setting.key}\`](command:workbench.action.openSettings?%5B%22${setting.key}%22%5D "Open Setting")`;
	}

	const command = configurations.getCommand(potentialConfigurationId);
	if (command) {
		return `[\`${command.key}\`](command:workbench.action.openGlobalKeybindings?%5B%22${command.key}%22%5D "Open Keyboard Shortcuts")`;
	}

	return `\`${potentialConfigurationId}\``;
}