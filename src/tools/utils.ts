import * as vscode from 'vscode';
import { PromptElementJSON } from '@vscode/prompt-tsx/dist/base/jsonTypes';
import { contentType as promptTsxContentType } from '@vscode/prompt-tsx';

export function createLanguageModelToolResult(tsx: PromptElementJSON, text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelPromptTsxPart(tsx, promptTsxContentType),
		new vscode.LanguageModelTextPart(text)
	]);
}

function isTxsResult(content: vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | unknown): content is vscode.LanguageModelPromptTsxPart {
	try {
		return (content as vscode.LanguageModelPromptTsxPart).mime === promptTsxContentType;
	} catch {
		return false;
	}
}

export function getTsxDataFromToolsResult(result: vscode.LanguageModelToolResult): PromptElementJSON | undefined {
	const tsxContents = result.content.filter(isTxsResult);
	if (tsxContents.length > 0) {
		return tsxContents[0].value as PromptElementJSON;
	}
	// TODO: Handle multiple tsx contents
	return undefined;
}