/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BasePromptElementProps, PromptElement, contentType as promptTsxContentType, renderElementJSON, TextChunk } from '@vscode/prompt-tsx';
import { pruneToolResult } from './utils';
import { Configurations } from '../configurationSearch';

type Update = { key: string, oldValue: unknown, newValue: unknown };

interface UpdateSettingsResultSuccessProps extends BasePromptElementProps {
   readonly updates: Update[];
   readonly unchanged: string[];
}

interface UpdateSettingsResultErrorProps extends BasePromptElementProps {
   readonly error: string;
}

type UpdateSettingsResultProps = UpdateSettingsResultSuccessProps | UpdateSettingsResultErrorProps;

function isSuccess(props: UpdateSettingsResultProps): props is UpdateSettingsResultSuccessProps {
   return !!(props as UpdateSettingsResultSuccessProps).updates;
}

class UpdateSettingsResult extends PromptElement<UpdateSettingsResultProps> {

   render() {
      if (!isSuccess(this.props)) {
         return <>{this.props.error}</>;
      } else {
         return <>
            Updated ${this.props.updates.length} settings:<br />
            <TextChunk priority={20}>{this.props.updates.map(s => <>- {s.key}: from {s.oldValue} to {s.newValue}<br /></>)}<br /></TextChunk>
            <TextChunk priority={10}>{this.props.unchanged.length > 0 && `There were no changes to ${this.props.unchanged.length} settings: ${this.props.unchanged.join(', ')}.`}</TextChunk>
         </>;
      }
   }
}

export class UpdateSettings implements vscode.LanguageModelTool<Record<string, any>> {

   static readonly ID = 'updateSettings';

   constructor(
      private readonly updatedSettings: { key: string, oldValue: any, newValue: any }[],
      private readonly configurations: Configurations,
      private readonly logger: vscode.LogOutputChannel,
   ) {
   }

   private validateSettings(settings: Record<string, any>): { key: string, value: any }[] {
      const result: { key: string, value: any }[] = [];
      for (const [key, value] of Object.entries(settings)) {
         result.push({ key, value });
      }
      return result;
   }

   async prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ settings?: Record<string, any> }>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
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

   async invoke(options: vscode.LanguageModelToolInvocationOptions<Record<string, any>>, token: vscode.CancellationToken) {
      return pruneToolResult(options.requestedContentTypes, await this._invoke(options, token));
   }

   private async _invoke(options: vscode.LanguageModelToolInvocationOptions<Record<string, any>>, token: vscode.CancellationToken) {
      const settingsToUpdate = this.validateSettings(options.parameters ?? {});

      if (settingsToUpdate.length === 0) {
         return {
            [promptTsxContentType]: await renderElementJSON(UpdateSettingsResult, { error: 'No settings to update' }, options.tokenOptions),
            'text/plain': 'No settings to update'
         };
      }

      if (token.isCancellationRequested) {
         return {
            [promptTsxContentType]: await renderElementJSON(UpdateSettingsResult, { error: 'Cancelled' }, options.tokenOptions),
            'text/plain': 'Cancelled'
         };
      }

      const updates: { key: string, oldValue: any, newValue: any }[] = [];
      const unchanged: string[] = [];

      for (const { key, value } of settingsToUpdate) {
         const oldValue = vscode.workspace.getConfiguration().get(key);
         if (oldValue !== value) {
            try {
               this.logger.info('Setting', key, 'to', value);
               await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
               updates.push({ key, oldValue, newValue: value });
               this.updatedSettings.push({ key, oldValue, newValue: value });
            } catch (e: any) {
               return {
                  [promptTsxContentType]: await renderElementJSON(UpdateSettingsResult, { error: `Wasn't able to set ${key} to ${value} because of ${e.message}` }, options.tokenOptions),
                  'text/plain': `Wasn't able to set ${key} to ${value} because of ${e.message}`
               };
            }
         } else {
            unchanged.push(key);
         }
      }

      return {
         [promptTsxContentType]: await renderElementJSON(UpdateSettingsResult, { updates, unchanged }, options.tokenOptions),
         'text/plain': `Updated ${updates.length} settings: ${updates.map(s => `${s.key} from ${s.oldValue} to ${s.newValue}`).join(', ')}. ${unchanged.length ? `No changes to ${unchanged.length} settings: ${unchanged.join(', ')}.` : ''}`
      };
   }
}