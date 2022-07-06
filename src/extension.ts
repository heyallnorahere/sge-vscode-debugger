/*
	Copyright 2022 Nora Beda

	Licensed under the Apache License, Version 2.0 (the "License");
	you may not use this file except in compliance with the License.
	You may obtain a copy of the License at

		http://www.apache.org/licenses/LICENSE-2.0

	Unless required by applicable law or agreed to in writing, software
	distributed under the License is distributed on an "AS IS" BASIS,
	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	See the License for the specific language governing permissions and
	limitations under the License.
*/

import * as vscode from 'vscode';
import { SGEDebuggerFrontend } from './debuggerFrontend';
import * as net from 'net';

class ExtensionContext {
	public constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.configuration = vscode.workspace.getConfiguration(this.name);
	}

	public push(...items: { dispose(): any }[]): number {
		this.context.subscriptions.concat(items);
		return items.length;
	}

	public get id(): string {
		return this.context.extension.id;
	}

	public get name(): string {
		return this.context.extension.packageJSON.name;
	}

	public context: vscode.ExtensionContext;
	public configuration: vscode.WorkspaceConfiguration;
}

let extensionContext: ExtensionContext | undefined = undefined;
class SGEConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (!config.type && !config.request && !config.name) {
			config.type = 'sge';
			config.name = '(sge) Attach';
			config.request = 'attach';
		}

		if (!config.address || config.address === 'undefined') {
			config.address = extensionContext!.configuration.get('defaultAddress');
		}

		if (!config.port || config.port < 0) {
			config.port = extensionContext!.configuration.get('defaultPort');
		}

		return config;
	}
}

enum AdapterRunMode {
	external,
	server,
	inline,
}

class SGEDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	public constructor(runMode: AdapterRunMode) {
		this.runMode = runMode;
		this.server = undefined;
	}

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		switch (this.runMode) {
			case AdapterRunMode.external:
				if (!executable) {
					return undefined;
				}

				return executable;
			case AdapterRunMode.server:
				if (!this.server) {
					this.server = net.createServer(socket => {
						const session = new SGEDebuggerFrontend();
						session.setRunAsServer(true);
						session.start(socket, socket);
					}).listen(0); // random port
				}

				const port = (this.server.address() as net.AddressInfo).port;
				return new vscode.DebugAdapterServer(port);
			case AdapterRunMode.inline:
				return new vscode.DebugAdapterInlineImplementation(new SGEDebuggerFrontend());
			default:
				return undefined;
		}
	}

	dispose() {
		this.server?.close();
	}

	private runMode: AdapterRunMode;
	private server?: net.Server;
}

export function activate(context: vscode.ExtensionContext) {
	console.log('extension activated');
	extensionContext = new ExtensionContext(context);

	const configProvider = new SGEConfigurationProvider();
	extensionContext.push(vscode.debug.registerDebugConfigurationProvider('sge', configProvider));

	const factory = new SGEDebugAdapterFactory(AdapterRunMode.inline);
	const factoryHandle = vscode.debug.registerDebugAdapterDescriptorFactory('sge', factory);
	extensionContext.push(factoryHandle, factory);
}

export function deactivate() {
	console.log('extension deactivated');
}
