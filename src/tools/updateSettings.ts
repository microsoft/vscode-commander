/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

type IStringDictionary<V> = Record<string, V>;

export class UpdateSettings implements vscode.LanguageModelTool<IStringDictionary<any>> {

   static readonly ID = 'updateSettings';

   constructor(
      private readonly updatedSettings: { key: string, oldValue: any, newValue: any }[],
      private readonly logger: vscode.LogOutputChannel,
   ) {
   }

   private validateSettings(settings: IStringDictionary<any>): [string, any][] {
      const result: [string, any][] = [];
      for (const [key, value] of Object.entries(settings)) {
         result.push([key, value]);
      }
      return result;
   }

   prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IStringDictionary<any>>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
      const settingsToUpdate = this.validateSettings(options.parameters);

      if (settingsToUpdate.length === 0) {
         return undefined;
      }

      if (settingsToUpdate.length === 1) {
         return {
            invocationMessage: `Updating setting \`${settingsToUpdate[0][0]}\``,
         };
      }

      return {
         invocationMessage: `Updating ${settingsToUpdate.length} settings`,
      };
   }


   async invoke(options: vscode.LanguageModelToolInvocationOptions<IStringDictionary<any>>, token: vscode.CancellationToken) {
      const settingsToUpdate = this.validateSettings(options.parameters);

      if (settingsToUpdate.length === 0) {
         return { 'text/plain': 'No settings to update' };
      }

      if (token.isCancellationRequested) {
         return { 'text/plain': 'Cancelled' };
      }

      const updatedSettings: { key: string, oldValue: any, newValue: any }[] = [];
      const unChangedSettings: string[] = [];

      for (const [key, value] of settingsToUpdate) {
         const oldValue = vscode.workspace.getConfiguration().get(key);
         if (oldValue !== value) {
            try {
               this.logger.info('Setting', key, 'to', value);
               await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
               updatedSettings.push({ key, oldValue, newValue: value });
               this.updatedSettings.push({ key, oldValue, newValue: value });
            } catch (e: any) {
               return { 'text/plain': `Wasn't able to set ${key} to ${value} because of ${e.message}` };
            }
         } else {
            unChangedSettings.push(key);
         }
      }

      return {
         'text/plain': `Updated ${updatedSettings.length} settings: ${updatedSettings.map(s => `${s.key} from ${s.oldValue} to ${s.newValue}`).join(', ')}. ${unChangedSettings.length ? `No changes to ${unChangedSettings.length} settings: ${unChangedSettings.join(', ')}.` : ''}`
      };
   }

}