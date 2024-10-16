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

export class RunCommands implements vscode.LanguageModelTool<{ key?: string, argumentsArray?: string }> {

   static readonly ID = 'runCommand';

   constructor(
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

      let args: any[] = [];
      if (options.parameters.argumentsArray) {
         try {
            args = JSON.parse(options.parameters.argumentsArray);
         } catch (e) {
            this.logger.warn('Failed to parse args as JSON', e);
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

      return {
         'text/plain': response === undefined
            ? `Command ${options.parameters.key} has been executed`
            : `The result of executing the command ${options.parameters.key} is ${JSON.stringify(response)}`,
      };
   }

}