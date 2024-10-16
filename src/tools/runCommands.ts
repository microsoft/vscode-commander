/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command, Configurations } from '../configurationSearch';

const confirmationSettings: { [key: string]: vscode.LanguageModelToolConfirmationMessages } = {
   'workbench.action.resetViewLocations': {
      title: 'Reset View Locations',
      message: 'This will reset all views to their default locations. Are you sure you want to do this?',
   },
};

const commandsWithComplexArguments = new Set(['vscod.setEditorLayout']);

export class RunCommands implements vscode.LanguageModelTool<{ key?: string, argumentsArray?: string }> {

   static readonly ID = 'runCommand';

   constructor(
      private readonly chatContext: { prompt: string },
      private readonly ranCommands: { key: string, arguments: any }[],
      private readonly configurations: Configurations,
      private readonly logger: vscode.LogOutputChannel,
   ) {
   }

   prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
      // validate parameters
      if (typeof options.parameters.key !== 'string' || !options.parameters.key.length) {
         return undefined;
      }

      return {
         invocationMessage: `Running \`${options.parameters.key}\``,
         confirmationMessages: confirmationSettings[options.parameters.key]
      };
   }

   async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken) {
      // validate parameters
      if (typeof options.parameters.key !== 'string' || !options.parameters.key.length) {
         return { 'text/plain': 'Not able to change because the parameter is missing or invalid' };
      }

      const commands = await this.configurations.search(options.parameters.key, 1) as Command[];
      if (commands.length === 0) {
         return { 'text/plain': `Command ${options.parameters.key} not found` };
      }
      const [command] = commands;

      let args: any[] = [];
      if (options.parameters.argumentsArray) {
         // parse arguments
         try {
            args = JSON.parse(options.parameters.argumentsArray);
         } catch (e) {
            this.logger.warn('Failed to parse args as JSON', e);
         }

         // If arguments are complex, we need to make sure they are valid
         if (commandsWithComplexArguments.has(command.key)) {
            const response = await this.validateComplexArguments(command, args, token);
            if (typeof response === 'string') {
               return { 'text/plain': response };
            }
         }
      }

      this.logger.info(`Running ${options.parameters.key}` + (args ? ` with args ${JSON.stringify(args)}` : ''));

      let response: unknown = undefined;
      try {
         response = await vscode.commands.executeCommand(options.parameters.key, ...args);
         this.ranCommands.push({ key: options.parameters.key, arguments: options.parameters.argumentsArray });
      } catch (e: any) {
         return { 'text/plain': `Wasn't able to run ${options.parameters.key} because of ${e.message}` };
      }

      let responseMessage = response === undefined
         ? `Command ${options.parameters.key} has been executed`
         : `The result of executing the command ${options.parameters.key} is ${JSON.stringify(response)}`;

      return { 'text/plain': responseMessage };
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
      responseMessage += `Run the ${RunCommands.ID} tool again with valid arguments. `;
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