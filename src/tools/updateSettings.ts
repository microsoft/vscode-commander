/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Configurations } from '../configurationSearch';

type IStringDictionary<V> = Record<string, V>;

export class UpdateSettings implements vscode.LanguageModelTool<IStringDictionary<any>> {

   static readonly ID = 'updateSettings';

   constructor(
      private readonly updatedSettings: { key: string, oldValue: any, newValue: any }[],
      private readonly configurations: Configurations,
      private readonly logger: vscode.LogOutputChannel,
   ) {
   }

   private validateSettings(settings: IStringDictionary<any>): { key: string, value: any }[] {
      const result: { key: string, value: any }[] = [];
      for (const [key, value] of Object.entries(settings)) {
         result.push({ key, value });
      }
      return result;
   }

   async prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ settings?: IStringDictionary<any> }>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
      const settingsToUpdate = this.validateSettings(options.parameters.settings ?? {});

      if (settingsToUpdate.length === 0) {
         return undefined;
      }

      // Check if a settings is restricted. If so, create the confirmation message
      let message = new vscode.MarkdownString('', true);
      message.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };
      for (const { key, value } of settingsToUpdate) {
         const setting = (await this.configurations.search(key, 1))[0];
         if (!setting || setting.type !== 'setting' || !setting.restricted) {
            continue;
         }
         message.value += `Updating \`${key}\` to \`${value}\`.\n\n`;
         message.value += `- **Description:** ${setting.description}\n\n`;
      }

      const confirmationMessages = message.value !== '' ? { title: 'Confirmation required', message } : undefined;

      // One setting to update
      if (settingsToUpdate.length === 1) {
         return {
            confirmationMessages,
            invocationMessage: `Updating \`${settingsToUpdate[0].key}\``,
         };
      }

      // Multiple settings to update
      return {
         confirmationMessages,
         invocationMessage: `Updating ${settingsToUpdate.length} settings`,
      };
   }


   async invoke(options: vscode.LanguageModelToolInvocationOptions<{ settings?: IStringDictionary<any> }>, token: vscode.CancellationToken) {
      const settingsToUpdate = this.validateSettings(options.parameters.settings ?? {});

      if (settingsToUpdate.length === 0) {
         return { 'text/plain': 'No settings to update' };
      }

      if (token.isCancellationRequested) {
         return { 'text/plain': 'Cancelled' };
      }

      const updatedSettings: { key: string, oldValue: any, newValue: any }[] = [];
      const unChangedSettings: string[] = [];

      for (const { key, value } of settingsToUpdate) {
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