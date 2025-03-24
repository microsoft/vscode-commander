/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BasePromptElementProps, PromptElement, renderElementJSON } from '@vscode/prompt-tsx';
import { Configurations, Command } from '../configurationSearch';
import { createLanguageModelToolResult } from './utils';

const commandsRequiringConfirmation: { [key: string]: vscode.LanguageModelToolConfirmationMessages } = {
   'workbench.action.resetViewLocations': {
      title: 'Reset View Locations',
      message: 'This will reset all views to their default locations. Are you sure you want to do this?',
   },
};

const commandsWithComplexArguments = new Set(['vscode.setEditorLayout']);

const complexArgumentSetterTool: vscode.LanguageModelChatTool = {
   name: 'SetArgument',
   description: 'Use this tool to set the argument for the command',
   inputSchema: {
      type: "object",
      properties: {
         argument: {
            type: "string",
            description: "Argument to pass to the command",
         }
      }
   }
};

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
      const commandId = options.input.key;
      if (typeof commandId !== 'string' || !commandId.length) {
         return undefined;
      }

      return {
         invocationMessage: `Running \`${commandId}\``,
         confirmationMessages: commandsRequiringConfirmation[commandId]
      };
   }

   async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      console.log('RunCommand invoked with options:', options);
      // validate parameters
      const commandId = options.input.key;
      console.log('Command ID:', commandId);
      if (typeof commandId !== 'string' || !commandId.length) {
         return await this.createToolErrorResult('Not able to change because the parameter is missing or invalid', options, token);
      }

      // Make sure the command exists
      const command = await this.configurations.getCommand(commandId);
      console.log('command : ', command);
      if (!command) {
         return await this.createToolErrorResult(`Command ${commandId} not found`, options, token);
      }

      console.log('options.input.argumentsArray : ', options.input.argumentsArray);
      // Parse arguments
      const parsedArgs = await this.parseArguments(options.input.argumentsArray, command, token);
      if (parsedArgs.errorMessage) {
         return await this.createToolErrorResult(parsedArgs.errorMessage, options, token);
      }
      const args = parsedArgs.args ?? [];
      console.log('Parsed arguments:', args);

      this.logger.info(`Running ${command.key}` + (args.length ? ` with args ${JSON.stringify(args)}` : ''));

      // Run the command
      let result: unknown = undefined;
      try {
         // Some commands require the editor to be focused to work correctly
         if (this.requiresEditorFocus(command.key)) {
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
         }

         result = await vscode.commands.executeCommand(command.key, ...args);
         console.log('Command result:', result);
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
      );
   }

   private async createToolErrorResult(errorMessage: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      return createLanguageModelToolResult(
         await renderElementJSON(RunCommandResult, { error: errorMessage }, options.tokenizationOptions, token),
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
         await this.validateComplexArguments(command, args, token);
         if (token.isCancellationRequested) {
            return { errorMessage: 'Cancelled' };
         }
      }

      return { args };
   }

   private requiresEditorFocus(commandId: string): boolean {
      return commandId.startsWith('editor.') ||
         (commandId.startsWith('cursor') && !commandId.includes('.')) ||
         (commandId.startsWith('editor') && !commandId.includes('.'));
   }

   /**
    * Processes complex arguments for a given command and validates them against a schema.
    * @returns A promise that resolves to `true` if the arguments are valid, or a string with an error message if invalid.
   */
   private async validateComplexArguments(command: Command, args: any[], token: vscode.CancellationToken): Promise<void> {
      const argsSchema = command.argsSchema && typeof command.argsSchema !== 'string' ? JSON.stringify(command.argsSchema) : command.argsSchema;
      if (!argsSchema) {
         return;
      }

      // TODO support multiple arguments
      args[0] = await this.validateArguments(command.key, args[0], argsSchema, token);
   }

   private async validateArguments(key: string, argument: any, argsSchema: string, token: vscode.CancellationToken): Promise<any> {
      const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });

      let userMessage = '';
      userMessage += `Given the users prompt, provide the arguments for the ${key} command in regards to the argument schema.`;
      userMessage += `Use step by step reasoning to explain your answer. When done, set the argument using the ${complexArgumentSetterTool.name} command.\n\n`;
      userMessage += `User Prompt: ${this.chatContext.prompt}\n\n`;
      userMessage += `Arguments Schema: ${argsSchema}`;

      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(userMessage)], { tools: [complexArgumentSetterTool], toolMode: vscode.LanguageModelChatToolMode.Required }, token);

      for await (const message of response.stream) {
         if (!(message instanceof vscode.LanguageModelToolCallPart)) {
            continue;
         }

         if ('argument' in message.input && typeof message.input.argument === 'string') {
            argument = JSON.parse(message.input.argument);
            break;
         }
      }

      return argument;
   }
}