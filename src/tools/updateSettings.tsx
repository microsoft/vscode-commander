/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BasePromptElementProps, PromptElement, renderElementJSON, TextChunk } from '@vscode/prompt-tsx';
import { createLanguageModelToolResult } from './utils';
import { Configurations } from '../configurationSearch';

type Update = { key: string, oldValue: string, newValue: string };
type Unchanged = { key: string, value: string };

interface UpdateSettingsResultSuccessProps extends BasePromptElementProps {
   readonly updates: Update[];
   readonly unchanged: Unchanged[];
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
      // Error
      if (!isSuccess(this.props)) {
         return <>{this.props.error}</>;
      }
      // 1 setting updated
      else if (this.props.updates.length === 1 && this.props.unchanged.length === 0) {
         const update = this.props.updates[0];
         return <>
            Updated setting {update.key} from {update.oldValue} to {update.newValue}.
         </>;
      }
      // 1 setting unchanged
      else if (this.props.updates.length === 0 && this.props.unchanged.length === 1) {
         const unchanged = this.props.unchanged[0];
         return <>
            The setting {unchanged.key} remains unchanged with value {unchanged.value}.
         </>;
      }
      // Multiple settings updated/unchanged
      else {
         return <>
            Updated {this.props.updates.length} settings:<br />
            <TextChunk priority={20}>{this.props.updates.map(s => <>- {s.key}: from {s.oldValue} to {s.newValue}<br /></>)}<br /></TextChunk>
            <TextChunk priority={10}>{this.props.unchanged.length > 0 && `There were no changes to ${this.props.unchanged.length} settings: ${this.props.unchanged.map(s => s.key).join(', ')}.`}</TextChunk>
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

   async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, any>>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
      const settingsToUpdate = this.validateSettings(options.parameters ?? {});

      if (settingsToUpdate.length === 0) {
         return undefined;
      }

      // Check if a settings is restricted. If so, create the confirmation message
      let message = new vscode.MarkdownString('', true);
      for (const { key, value } of settingsToUpdate) {
         const setting = this.configurations.getSetting(key);
         if (!setting || !setting.restricted) {
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
      const settingsToUpdate = this.validateSettings(options.parameters ?? {});

      if (settingsToUpdate.length === 0) {
         return await this.createToolErrorResult('No settings to update', options, token);
      }

      if (token.isCancellationRequested) {
         return await this.createToolErrorResult(`Cancelled`, options, token);
      }

      const updates: Update[] = [];
      const unchanged: Unchanged[] = [];

      for (const { key, value } of settingsToUpdate) {
         let oldValue = vscode.workspace.getConfiguration().get(key);

         const oldStringified = JSON.stringify(oldValue);
         const newStringified = JSON.stringify(value);
         if (oldStringified === newStringified) {
            unchanged.push({ key, value: oldStringified });
            continue;
         }

         updates.push({ key, oldValue: oldStringified, newValue: newStringified });
         this.updatedSettings.push({ key, oldValue, newValue: value });

         try {
            this.logger.info('Setting', key, 'to', value);
            await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
         } catch (e: any) {
            return await this.createToolErrorResult(`Wasn't able to set ${key} to ${value} because of ${e.message}`, options, token);
         }
      }

      return await this.createToolResult({ updates, unchanged }, options, token);
   }

   private async createToolResult(resultProps: UpdateSettingsResultSuccessProps, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      return createLanguageModelToolResult(
         await renderElementJSON(UpdateSettingsResult, resultProps, options.tokenizationOptions, token),
      );
   }

   private async createToolErrorResult(errorMessage: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
      return createLanguageModelToolResult(
         await renderElementJSON(UpdateSettingsResult, { error: errorMessage }, options.tokenizationOptions, token),
      );
   }
}