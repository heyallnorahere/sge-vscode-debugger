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

import * as debugadapter from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Socket } from 'net';
import { Subject } from 'await-notify';
import { Stack, Queue } from './utilities';

const encoding = 'utf-8';

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	address: string;
	port: number;
}

class DebuggerMessage {
	public constructor(type: string, body: any) {
		this.type = type;
		this.body = body;
	}

	public type: string;
	public body: any;
}

class DebuggerRequest {
	public constructor(command: string, args: any) {
		this.command = command;
		this.args = args;
	}

	public command: string;
	public args: any;
}

class DebuggerEvent {
	public constructor(type: string, category: string, context: any) {
		this.type = type;
		this.category = category;
		this.context = context;
	}

	public type: string;
	public category: string;
	public context: any;
}

class SocketBuffer {
	public constructor() {
		this.data = '';
	}

	public clear(): void {
		this.data = '';
	}

	public append(data: string) {
		this.data += data;
	}

	public remove(start: number, length: number = 1): boolean {
		const end = start + length;
		if (start < 0 || end > this.data.length) {
			return false;
		}

		let result = '';
		if (start > 0) {
			result += this.data.substring(0, start);
		}

		if (end < this.data.length) {
			result += this.data.substring(end);
		}

		this.data = result;
		return true;
	}

	public get storedData(): string {
		return this.data;
	}

	private data: string;
}

class BufferRemoveRange {
	public constructor(start: number, length: number) {
		this.start = start;
		this.length = length;
	}

	public remove<T>(callback: (start: number, length: number) => T): T {
		return callback(this.start, this.length);
	}

	public start;
	public length;
}

class Scope {
	public constructor(closingCharacter: string, position: number) {
		this.closingCharacter = closingCharacter;
		this.position = position;
	}

	public isCorrectCharacter(closingCharacter: string): boolean {
		return this.closingCharacter === closingCharacter;
	}

	public get startingPosition(): number {
		return this.position;
	}

	private closingCharacter: string;
	private position: number;
}

class ProxySettings {
	public constructor(lineStart: number, useUri: boolean) {
		this.lineStart = lineStart;
		this.useUri = useUri;
	}

	public lineStart: number;
	public useUri: boolean;
}

export class SGEDebuggerFrontend extends debugadapter.LoggingDebugSession {
	public constructor() {
		super('sge-vscode-debugger.log');

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this.proxySettings = new ProxySettings(1, false);
		this.connected = false;
		this.buffer = new SocketBuffer();
		this.responseQueue = new Queue();
		this.terminated = true;
		this.responseReceived = new Subject();
	}

	// requests

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.proxySettings.lineStart = args.linesStartAt1 ? 1 : 0;
		this.proxySettings.useUri = args.pathFormat === 'uri';

		response.body = {};
		response.body.supportsEvaluateForHovers = true; // i suppose

		response.body.supportsConfigurationDoneRequest = false;
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsConditionalBreakpoints = false;
		response.body.exceptionBreakpointFilters = [];


		this.sendResponse(response);
		this.sendEvent(new debugadapter.InitializedEvent());
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request | undefined): void {
		console.log('disconnecting from proxy');

		this.terminated = true;
		this.clientSocket?.end();

		this.sendResponse(response);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request: DebugProtocol.AttachRequest): void {
		this.terminated = false;
		this.clientSocket = new Socket();

		this.clientSocket.on('ready', async () => {
			console.log('connected to debugger');
			this.connected = true;
	
			const request = new DebuggerRequest('setSettings', this.proxySettings);
			await this.sendDebuggerRequest(request);	
		});

		this.clientSocket.on('close', () => {
			console.log('disconnected from debugger');

			this.connected = false;
			if (!this.terminated) {
				this.sendEvent(new debugadapter.TerminatedEvent());
				this.terminated = true;
			}
		});

		this.clientSocket.on('data', data => {
			const receivedData = data.toString(encoding);
			this.buffer.append(receivedData);

			this.processData();
		});

		console.log(`connecting to ${args.address}:${args.port}`);
		this.clientSocket.connect(args.port, args.address);

		this.sendResponse(response);
	}

	// implementation

	// very messy function, this is why i hate javascript
	private processData(): void {
		const data = this.buffer.storedData;
		let removeRanges: BufferRemoveRange[] = [];

		const scopeStack = new Stack<Scope>();
		let lastStartPosition = -1;

		for (let i = 0; i < data.length; i++) {
			const character = data[i];
			switch (character) {
				case '{':
					scopeStack.push(new Scope('}', i));
					break;
				case '[':
					scopeStack.push(new Scope(']', i));
					break;
				default:
					if (character === '}' || character === ']') {
						const topScope = scopeStack.peek();
						if (topScope!.isCorrectCharacter(character)) {
							lastStartPosition = topScope!.startingPosition;
							scopeStack.pop();
						} else {
							console.log('malformed json received');
							this.buffer.clear();
							return;
						}
					}

					break;
			}

			if (scopeStack.size === 0) {
				let shouldBreak = false;
				let range: BufferRemoveRange;

				if (lastStartPosition < 0) {
					range = new BufferRemoveRange(i, 1);
				} else {
					const length = (i - lastStartPosition) + 1;
					range = new BufferRemoveRange(lastStartPosition, length);
					shouldBreak = true;
				}

				removeRanges.push(range);
				if (shouldBreak) {
					break;
				}
			}
		}

		// couldn't figure out how to copy
		const effectiveRanges = removeRanges.slice(0, removeRanges.length);

		for (let i = 0; i < effectiveRanges.length; i++) {
			const range = effectiveRanges[i];
			if (!range.remove((start, length) => this.buffer.remove(start, length))) {
				this.buffer.clear();
				return;
			}

			for (let j = i + 1; j < effectiveRanges.length; j++) {
				// i don't know if it's pass by reference or value, so...
				const laterRange = effectiveRanges[j];
				laterRange.start += range.length;
				effectiveRanges[j] = laterRange;
			}
		}

		if (scopeStack.size === 0 && lastStartPosition >= 0) {
			const lastRange = removeRanges[removeRanges.length - 1];
			const jsonData = data.substring(lastRange.start, lastRange.start + lastRange.length);

			const message: DebuggerMessage = JSON.parse(jsonData);
			if (message) {
				switch (message.type) {
					case 'response':
						this.responseQueue.push(message.body);
						this.responseReceived.notify();
						break;
					case 'event':
						this.relayEvent(message.body);
						break;
					default:
						// nothing, unhandled
				}
			}

			// run again, to make sure nothing was missed
			// very hacky, i know
			this.processData();
		}
	}

	private relayEvent(event: DebuggerEvent): void {
		console.log(`received event: ${event.type}`);
		console.log(`event category: ${event.category}`);
		console.log(`context: ${JSON.stringify(event.context)}`);
		
		// todo: relay to vscode
	}

	private async sendDebuggerRequest(request: DebuggerRequest): Promise<any> {
		console.log(`sending request: ${request.command}`);

		const message = new DebuggerMessage('request', request);
		return await this.sendDebuggerMessage(message, true);
	}

	private async sendDebuggerMessage(message: DebuggerMessage, expectResponse: boolean): Promise<any> {
		if (!this.connected) {
			return undefined;
		}

		const socketMessage = JSON.stringify(message);
		const bytes = Buffer.from(socketMessage, encoding);
		this.clientSocket!.write(bytes);

		if (expectResponse) {
			await this.responseReceived.wait(Infinity);

			const response = this.responseQueue.peek();
			this.responseQueue.pop();

			return response;
		} else {
			return undefined;
		}
	}

	private proxySettings: ProxySettings;
	private clientSocket?: Socket;
	private connected: boolean;
	private buffer: SocketBuffer;
	private responseQueue: Queue<any>;
	private terminated: boolean;
	private responseReceived: Subject;
}