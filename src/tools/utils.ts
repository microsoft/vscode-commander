import * as vscode from 'vscode';
import { PromptElementJSON } from '@vscode/prompt-tsx/dist/base/jsonTypes';
import { contentType as promptTsxContentType } from '@vscode/prompt-tsx';

export function createLanguageModelToolResult(tsx: PromptElementJSON, text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelPromptTsxPart(tsx, promptTsxContentType),
    new vscode.LanguageModelTextPart(text)
  ]);
}