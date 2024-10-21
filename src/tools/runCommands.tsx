/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BasePromptElementProps, PromptElement, renderElementJSON } from '@vscode/prompt-tsx';
import { Configurations, Command } from '../configurationSearch';
import { createLanguageModelToolResult } from './utils';

const confirmationSettings: { [key: string]: vscode.LanguageModelToolConfirmationMessages } = {
   'workbench.action.resetViewLocations': {
      title: 'Reset View Locations',
      message: 'This will reset all views to their default locations. Are you sure you want to do this?',
   },
};

const commandsWithComplexArguments = new Set(['vscode.setEditorLayout']);

interface RunCommandResultSuccessProps extends BasePromptElementProps {
   readonly commandId: string;
   readonly result: unknown;
}

interface RunCommandResultErrorProps extends BasePromptElementProps {
   readonly error: string;
}

type RunCommandResultProps = RunCommandResultSuccessProps | RunCommandResultErrorProps;

function isSuccess(props: RunCommandResultProps): props is RunCommandResultSuccessProps {
   return !!(props as RunCommandResultSuccessProps).commandId;
}

class RunCommandResult extends PromptElement<RunCommandResultProps> {

   render() {
      if (!isSuccess(this.props)) {
         return <>{this.props.error}</>;
      } else if (this.props.result) {
         return <>The result of executing the command {this.props.commandId} is {JSON.stringify(this.props.result)}</>;
      } else {
         return <>Command {this.props.commandId} has been executed</>;
      }
   }
}

export class RunCommand implements vscode.LanguageModelTool<{ key?: string, argumentsArray?: string }> {

   static readonly ID = 'runCommand';

   constructor(
      private readonly chatContext: { prompt: string },
      private readonly ranCommands: { key: string, arguments: any }[],
      private readonly configurations: Configurations,
      private readonly logger: vscode.LogOutputChannel,
   ) {
   }

   prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
      // validate parameters
      const commandId = options.parameters.key;
      if (typeof commandId !== 'string' || !commandId.length) {
         return undefined;
      }

      return {
         invocationMessage: `Running \`${commandId}\``,
         confirmationMessages: confirmationSettings[commandId]
      };
   }

   async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      // validate parameters
      const commandId = options.parameters.key;
      if (typeof commandId !== 'string' || !commandId.length) {
         return await this.createToolErrorResult('Not able to change because the parameter is missing or invalid', options, token);
      }

      // Make sure the command exists
      const commands = await this.configurations.search(commandId, 1) as Command[];
      if (commands.length === 0) {
         return await this.createToolErrorResult(`Command ${commandId} not found`, options, token);
      }
      const [command] = commands;

      // Parse arguments
      const parsedArgs = await this.parseArguments(options.parameters.argumentsArray, command, token);
      if (parsedArgs.errorMessage) {
         return await this.createToolErrorResult(parsedArgs.errorMessage, options, token);
      }
      const args = parsedArgs.args ?? [];

      this.logger.info(`Running ${command.key}` + (args.length ? ` with args ${JSON.stringify(args)}` : ''));

      // Run the command
      let result: unknown = undefined;
      try {
         // Some commands require the editor to be focused to work correctly
         if (this.requiresEditorFocus(command.key)) {
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
         }

         result = await vscode.commands.executeCommand(command.key, ...args);
         this.ranCommands.push({ key: command.key, arguments: args });
      } catch (e: any) {
         return await this.createToolErrorResult(`Wasn't able to run ${command.key} because of ${e.message}`, options, token);
      }

      return await this.createToolResult({ commandId: command.key, result }, options, token);
   }

   private async createToolResult(resultProps: RunCommandResultSuccessProps, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      let message = `Command ${resultProps.commandId} has been executed`;
      if (resultProps.result) {
         message += `The result of executing the command ${resultProps.commandId} is ${JSON.stringify(resultProps.result)}`;
      }

      return createLanguageModelToolResult(
         await renderElementJSON(RunCommandResult, resultProps, options.tokenizationOptions, token),
         message
      );
   }

   private async createToolErrorResult(errorMessage: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      return createLanguageModelToolResult(
         await renderElementJSON(RunCommandResult, { error: errorMessage }, options.tokenizationOptions, token),
         errorMessage
      );
   }

   private async parseArguments(argsArray: string | undefined, command: Command, token: vscode.CancellationToken): Promise<{ errorMessage?: string, args?: any[] }> {
      if (!argsArray) {
         return { args: [] };
      }

      let args: any[] = [];
      try {
         args = JSON.parse(argsArray);
      } catch (e) {
         this.logger.warn('Failed to parse args as JSON', e);
      }

      // If arguments are complex, we need to make sure they are valid
      if (commandsWithComplexArguments.has(command.key)) {
         const response = await this.validateComplexArguments(command, args, token);
         if (typeof response === 'string') {
            return { 'errorMessage': response };
         }
      }

      return { args };
   }

   private requiresEditorFocus(commandId: string): boolean {
      return commandId.startsWith('editor.') ||
         (commandId.startsWith('cursor') && !commandId.includes('.')) ||
         (commandId.startsWith('editor') && !commandId.includes('.'));
   }

   private _lastComplexPrompt: string | undefined = undefined;
   /**
    * Processes complex arguments for a given command and validates them against a schema.
    * @returns A promise that resolves to `true` if the arguments are valid, or a string with an error message if invalid.
   */
   private async validateComplexArguments(command: Command, args: any[], token: vscode.CancellationToken): Promise<true | string> {
      if (this._lastComplexPrompt === this.chatContext.prompt) {
         return true;
      }
      this._lastComplexPrompt = this.chatContext.prompt;

      const argsSchema = command.argsSchema && typeof command.argsSchema !== 'string' ? JSON.stringify(command.argsSchema) : command.argsSchema;
      if (!argsSchema) {
         return true;
      }

      // TODO support multiple arguments
      const isValid = await this.validateArguments(command.key, args[0], argsSchema);
      if (token.isCancellationRequested) {
         return 'Cancelled';
      }
      if (isValid) {
         return true;
      }

      const suggestedArguments = await this.suggestArguments(command.key, argsSchema);
      if (token.isCancellationRequested) {
         return 'Cancelled';
      }

      let responseMessage = '';
      responseMessage += `The arguments provided for the ${command.key} command are invalid in regards to the user prompt. `;
      responseMessage += `Run the ${RunCommand.ID} tool again with valid arguments. `;
      responseMessage += `The arguments schema is ${argsSchema}. `;
      responseMessage += `Here is a hint: ${suggestedArguments}`;
      return responseMessage;
   }

   private async validateArguments(key: string, argument: string, argsSchema: string): Promise<boolean> {
      const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });

      let userMessage = '';
      userMessage += `Given the users prompt, are the provided argumnts for the ${key} command valid in regards to the argument schema? `;
      userMessage += `Use step by step reasoning to explain your answer. If the argument is valid retur VALID, if the argument is not valid return INVALID\n\n`;
      userMessage += `User Prompt: ${this.chatContext.prompt}\n\n`;
      userMessage += `Argument Provided: ${JSON.stringify(argument)}\n\n`;
      userMessage += `Arguments Schema: ${argsSchema}`;
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(userMessage)]);

      let responseMessage = '';
      for await (const message of response.stream) {
         if (message instanceof vscode.LanguageModelTextPart) {
            responseMessage += message.value;
         }
      }

      return !responseMessage.includes('INVALID');
   }

   private async suggestArguments(key: string, argsSchema: string): Promise<string> {
      const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });

      let userMessage = '';
      userMessage += `Given the users prompt, generate the correct arguments for the ${key} command. `;
      userMessage += `Use step by step reasoning to generate the arguments based on the arguments schema\n\n`;
      userMessage += `User Prompt: ${this.chatContext.prompt}\n\n`;
      userMessage += `Arguments Schema: ${argsSchema}`;
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(userMessage)]);

      let responseMessage = '';
      for await (const message of response.stream) {
         if (message instanceof vscode.LanguageModelTextPart) {
            responseMessage += message.value;
         }
      }

      return responseMessage;
   }
}