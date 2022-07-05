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

import { SGEDebuggerFrontend } from './debuggerFrontend';
import * as net from 'net';

let port = 0;
const args = process.argv.slice(2);

args.forEach((val, index, array) => {
    const match = /^--server={\d{4,5})$/.exec(val);
    if (match) {
        port = parseInt(match[1], 10);
    }
});

const session = new SGEDebuggerFrontend("sge-vscode-debugger.log");
if (port > 0) {
    console.log(`listening for vscode on port ${port}`);
    net.createServer(socket => {
        console.log('accepted connection');
        socket.on('end', () => {
            console.log('connection closed');
        });

        session.setRunAsServer(true);
        session.start(socket, socket);
    }).listen(port);
} else {
    process.on('SIGTERM', session.shutdown);
    session.start(process.stdin, process.stdout);
}