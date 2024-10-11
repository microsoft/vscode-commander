import * as vscode from 'vscode';
import { Configurations } from "../configurationSearch";

export class MockConfigurations extends Configurations {
    constructor() {
        super(new MockLogOutputChannel());
    }
}

export class MockLogOutputChannel implements vscode.LogOutputChannel {
    logLevel: vscode.LogLevel = vscode.LogLevel.Info;
    readonly name: string = 'MockLogOutputChannel';
    private logLevelEmitter = new vscode.EventEmitter<vscode.LogLevel>();
    readonly onDidChangeLogLevel: vscode.Event<vscode.LogLevel> = this.logLevelEmitter.event;

    trace(): void { }
    debug(): void { }
    info(): void { }
    warn(): void { }
    error(): void { }
    append(): void { }
    appendLine(): void { }
    replace(): void { }
    clear(): void { }
    show(): void { }
    hide(): void { }
    dispose(): void { }
}