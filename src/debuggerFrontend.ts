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
import { Stack, Queue, Dictionary } from './utilities';

const encoding = 'utf-8';

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	address: string;
	port: number;
}

interface DebuggerScope {
	name: string;
	variableSetId: number;
	expensive: boolean;
}

interface DebuggerVariable {
	name: string;
	value: string;
	type: string;
	childrenSetId: number;
}

class DebuggerMessage {
	public constructor(type: string, body: any, id: number | undefined) {
		this.type = type;
		this.body = body;
		this.id = id;
	}

	public type: string;
	public body: any;
	public id?: number;
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

class PendingResponse {
	public constructor() {
		this.event = new Subject();
		this.isSet = false;
	}

	public set(value: any): boolean {
		if (this.isSet) {
			return false;
		}

		this.value = value;
		this.isSet = true;
		this.event.notify();

		return true;
	}

	public async wait(): Promise<any> {
		if (!this.isSet) {
			await this.event.wait(Infinity);
		}
		
		return this.value;
	}

	public get isFinished(): boolean {
		return this.isSet;
	}

	private value: any;
	private event: Subject;
	private isSet: boolean;
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

	public start: number;
	public length: number;
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

export class SGEDebuggerFrontend extends debugadapter.DebugSession {
	public constructor() {
		super();

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this.proxySettings = new ProxySettings(1, false);
		this.connected = false;
		this.buffer = new SocketBuffer();
		this.terminated = true;
		this.pendingResponses = new Dictionary();
		this.currentId = 0;
	}

	// requests

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.proxySettings.lineStart = args.linesStartAt1 ? 1 : 0;
		this.proxySettings.useUri = args.pathFormat === 'uri';

		response.body = {};

		// freaks out over namespaces and classes
		response.body.supportsEvaluateForHovers = false;

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

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request: DebugProtocol.Request | undefined): void {
		this.terminated = false;
		this.clientSocket = new Socket();

		this.clientSocket.on('ready', async () => {
			console.log('connected to debugger');

			this.connected = true;
			await this.sendDebuggerRequest('setSettings', this.proxySettings);
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

	protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
		await this.sendDebuggerRequest('next', null);
		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
		await this.sendDebuggerRequest('continue', null);
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
		await this.sendDebuggerRequest('stepIn', null);
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse): Promise<void> {
		await this.sendDebuggerRequest('stepOut', null);
		this.sendResponse(response);
	}

	protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
		await this.sendDebuggerRequest('pause', null);
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		const trace = await this.sendDebuggerRequest('stackTrace', args);
		if (!trace) {
			this.sendErrorResponse(response, 1104, 'Failed to get stack trace');
			return;
		}

		response.body = trace;
		this.sendResponse(response);
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse): void {
		this.sendErrorResponse(response, 1020, 'No source available');
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
		const scopes = await this.sendDebuggerRequest('scopes', args);
		if (!scopes) {
			this.sendErrorResponse(response, 1104, 'Failed to get scopes');
			return;
		}

		response.body = {
			scopes: this.convertScopes(scopes)
		};
		
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		const commandArgs = {
			variableSetId: args.variablesReference,
			expandName: '[Expand]'
		};

		const variables = await this.sendDebuggerRequest('variables', commandArgs);
		if (!variables) {
			this.sendErrorResponse(response, 1104, 'Failed to get children');
		}

		response.body = {
			variables: this.convertVariables(variables)
		};

		this.sendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
		const threads = await this.sendDebuggerRequest('threads', null);
		if (!threads) {
			this.sendErrorResponse(response, 1104, 'Failed to get threads!');
			return;
		}

		response.body = {
			threads: threads
		};

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		const breakpointsSet = await this.sendDebuggerRequest('setBreakpoints', args);
		if (!breakpointsSet) {
			this.sendErrorResponse(response, 1104, 'Failed to set breakpoints!');
			return;
		}

		response.body = {
			breakpoints: breakpointsSet
		};

		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		const result = await this.sendDebuggerRequest('evaluate', args);
		if (!result) {
			this.sendErrorResponse(response, 1104, 'Failed to evaluate expression!');
			return;
		}

		if (result.error) {
			this.sendErrorResponse(response, 3014, `Failed to evaluate expression: ${result.error}`);
			return;
		}

		response.body = {
			result: result.value,
			variablesReference: result.childrenSetId
		};

		this.sendResponse(response);
	}

	// implementation

	private convertScopes(response: DebuggerScope[]): DebugProtocol.Scope[] {
		const result: DebugProtocol.Scope[] = [];
		response.forEach((value, index, array) => {
			result.push({
				name: value.name,
				variablesReference: value.variableSetId,
				expensive: value.expensive
			});
		});

		return result;
	}

	private convertVariables(response: DebuggerVariable[]): DebugProtocol.Variable[] {
		const result: DebugProtocol.Variable[] = [];
		response.forEach((value, index, array) => {
			result.push({
				name: value.name,
				value: value.value,
				type: value.type,
				variablesReference: value.childrenSetId
			});
		});

		return result;
	}

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
						const id = message.id!;
						if (this.pendingResponses.exists(id)) {
							this.pendingResponses.get(id)?.set(message.body);
						} else {
							console.error('mismatched response');
						}

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

		let reason: string;
		switch (event.type) {
			case 'debuggerStep':
				reason = 'step';
				break;
			case 'breakpointHit':
				reason = 'breakpoint';
				break;
			case 'handledExceptionThrown':
			case 'unhandledExceptionThrown':
				reason = 'exception';
				break;
			case 'threadStarted':
				reason = 'started';
				break;
			case 'threadExited':
				reason = 'exited';
				break;
			default:
				reason = event.type;
				break;
		}
		
		const context = event.context;
		let sentEvent: DebugProtocol.Event;
		switch (event.category) {
			case 'stopped':
				sentEvent = new debugadapter.StoppedEvent(reason, context.thread, context.message);
				break;
			case 'thread':
				sentEvent = new debugadapter.ThreadEvent(reason, context.id);
				break;
			case 'output':
				if (reason === 'debuggerOutput') {
					const category = context.stderr ? 'stderr' : 'stdout';
					sentEvent = new debugadapter.OutputEvent(context.text + '\n', category);

					break;
				}

				// debuggee output isn't handled (yet)
			default:
				return; // not handled
		}

		this.sendEvent(sentEvent);
	}

	private async sendDebuggerRequest(command: string, args: any): Promise<any> {
		console.log(`sending request: ${command}`);

		const request = new DebuggerRequest(command, args);
		const message = new DebuggerMessage('request', request, this.currentId++);

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
			const id = message.id!;

			this.pendingResponses.set(id, new PendingResponse());
			const response = await this.pendingResponses.get(id)?.wait();

			let finishedCount = 0;
			let totalCount = 0;

			this.pendingResponses.iterate((key, value) => {
				totalCount++;
				if (value.isFinished) {
					finishedCount++;
				}
			});

			if (finishedCount === totalCount) {
				this.pendingResponses = new Dictionary();
			}

			return response;
		} else {
			return undefined;
		}
	}

	private proxySettings: ProxySettings;
	private clientSocket?: Socket;
	private connected: boolean;
	private buffer: SocketBuffer;
	private terminated: boolean;
	private pendingResponses: Dictionary<number, PendingResponse>;
	private currentId: number;
}