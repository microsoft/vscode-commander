/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Configurations } from '../configurationSearch';

export class SearchConfigurations implements vscode.LanguageModelTool<{ keywords?: string }> {

   static readonly ID = 'searchConfigurations';

   constructor(
      private readonly configurations: Configurations,
      private readonly logger: vscode.LogOutputChannel
   ) {
   }

   prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ keywords?: string }>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
      return {
         invocationMessage: `Searching for actions`,
      };
   }

   async invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords?: string }>, token: vscode.CancellationToken) {
      if (!options.parameters.keywords) {
         return { 'text/plain': 'Unable to call searchConfigurations without keywords' };
      }

      this.logger.info('Keywords:', options.parameters.keywords);
      const result = await this.configurations.search(options.parameters.keywords, 50);
      this.logger.info('Configurations:', result.map(c => ({ id: c.key, type: c.type })));

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

      const stringifiedResponse = JSON.stringify(resultWithUpdatedValues);

      this.logger.trace('Sending Configurations:', stringifiedResponse);

      return {
         'application/json': stringifiedResponse
      };
   }

}