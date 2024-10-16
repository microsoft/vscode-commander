/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BasePromptElementProps, PromptElement, contentType as promptTsxContentType, renderElementJSON } from '@vscode/prompt-tsx';
import { pruneToolResult } from './utils';

interface RunCommandResultSuccessProps extends BasePromptElementProps {
   readonly commandId: string;
   readonly result?: unknown;
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
      private readonly ranCommands: { key: string, arguments: any }[],
      private readonly logger: vscode.LogOutputChannel,
   ) {
   }

   prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
      // validate parameters
      if (typeof options.parameters.key !== 'string' || !options.parameters.key.length) {
         return undefined;
      }

      const invocationMessage = `Running \`${options.parameters.key}\``;
      let confirmationMessages: vscode.LanguageModelToolConfirmationMessages | undefined;

      if (options.parameters.key === 'workbench.action.resetViewLocations') {
         confirmationMessages = {
            title: 'Reset View Locations',
            message: `This will reset all views to their default locations. Are you sure you want to do this?`,
         };
      }

      return {
         invocationMessage,
         confirmationMessages
      };
   }

   async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken) {
      return pruneToolResult(options.requestedContentTypes, await this._invoke(options, token));
   }

   private async _invoke(options: vscode.LanguageModelToolInvocationOptions<{ key?: string, argumentsArray?: string }>, token: vscode.CancellationToken) {
      // validate parameters
      if (typeof options.parameters.key !== 'string' || !options.parameters.key.length) {
         return {
            [promptTsxContentType]: await renderElementJSON(RunCommandResult, { error: 'Not able to change because the parameter is missing or invalid' }, options.tokenOptions),
            'text/plain': 'Not able to change because the parameter is missing or invalid'
         };
      }

      let args: any[] = [];
      if (options.parameters.argumentsArray) {
         try {
            args = JSON.parse(options.parameters.argumentsArray);
         } catch (e) {
            this.logger.warn('Failed to parse args as JSON', e);
         }
      }

      this.logger.info(`Running ${options.parameters.key}` + (args ? ` with args ${JSON.stringify(args)}` : ''));

      let result: unknown = undefined;
      try {
         result = await vscode.commands.executeCommand(options.parameters.key, ...args);
         this.ranCommands.push({ key: options.parameters.key, arguments: options.parameters.argumentsArray });
      } catch (e: any) {
         return {
            [promptTsxContentType]: await renderElementJSON(RunCommandResult, { error: `Wasn't able to run ${options.parameters.key} because of ${e.message}` }, options.tokenOptions),
            'text/plain': `Wasn't able to run ${options.parameters.key} because of ${e.message}`
         };
      }

      if (result === undefined) {
         return {
            [promptTsxContentType]: await renderElementJSON(RunCommandResult, { commandId: options.parameters.key }, options.tokenOptions),
            'text/plain': `Command ${options.parameters.key} has been executed`
         };
      } else {
         return {
            [promptTsxContentType]: await renderElementJSON(RunCommandResult, { commandId: options.parameters.key, result: result }, options.tokenOptions),
            'text/plain': `The result of executing the command ${options.parameters.key} is ${JSON.stringify(result)}`
         };
      }
   }

}