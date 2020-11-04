/// <reference path='../../../src/vs/vscode.d.ts'/>

// TODO get rid of loading inversify and reflect-metadata
require('reflect-metadata');
import psTree = require('ps-tree');
import { GitpodClient, GitpodServer, GitpodServiceImpl } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import { WorkspaceInfoRequest, WorkspaceInfoResponse } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { PortsStatus, PortsStatusRequest, PortsStatusResponse, TasksStatusRequest, TasksStatusResponse, TaskState, TaskStatus } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { TerminalServiceClient } from '@gitpod/supervisor-api-grpc/lib/terminal_grpc_pb';
import { CloseTerminalRequest, CloseTerminalResponse } from '@gitpod/supervisor-api-grpc/lib/terminal_pb';
import { TokenServiceClient } from '@gitpod/supervisor-api-grpc/lib/token_grpc_pb';
import { GetTokenRequest, GetTokenResponse } from '@gitpod/supervisor-api-grpc/lib/token_pb';
import * as grpc from '@grpc/grpc-js';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import * as util from 'util';
import * as vscode from 'vscode';
import { ConsoleLogger, listen as doListen } from 'vscode-ws-jsonrpc';

import WebSocket = require('ws');

const devMode = !!process.env['VSCODE_DEV'];

export function activate(context: vscode.ExtensionContext) {
	const supervisorAddr = process.env.SUPERVISOR_ADDR || 'localhost:22999';

	class GitpodWorkspacePort extends vscode.TreeItem {
		status?: PortsStatus;
		constructor(readonly portNumber: number) {
			super(':' + portNumber);
		}
	}

	class GitpodWorksapcePorts extends vscode.TreeItem {
		readonly ports = new Map<number, GitpodWorkspacePort>();
		constructor() {
			super('Forwarded Ports', vscode.TreeItemCollapsibleState.Expanded);
		}
	}

	type GitpodWorkspaceElement = GitpodWorksapcePorts | GitpodWorkspacePort;

	class GitpodWorkspaceTreeDataProvider implements vscode.TreeDataProvider<GitpodWorkspaceElement> {

		readonly ports = new GitpodWorksapcePorts();

		protected readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GitpodWorkspaceElement | undefined>();
		readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

		constructor() {
		}

		getTreeItem(element: GitpodWorkspaceElement): vscode.TreeItem {
			return element;
		}

		getChildren(element?: GitpodWorkspaceElement): vscode.ProviderResult<GitpodWorkspaceElement[]> {
			if (!element) {
				return [this.ports];
			}
			if (element === this.ports) {
				return [...this.ports.ports.values()];
			}
			return [];
		}

		updatePortsStatus(portsStatus: PortsStatus[]): void {
			const deleted = new Set(this.ports.ports.keys());
			for (const portStatus of portsStatus) {
				const portNumber = portStatus.getLocalPort();
				deleted.delete(portNumber);
				const port = this.ports.ports.get(portNumber) || new GitpodWorkspacePort(portNumber);
				port.status = portStatus;
				port.description = 'served';
				this.ports.ports.set(portNumber, port);
			}
			for (const portNumber of deleted) {
				const port = this.ports.ports.get(portNumber);
				if (port) {
					delete port.status;
					port.description = 'not served';
				}
			}
			this.onDidChangeTreeDataEmitter.fire(this.ports);
		}

	}

	const gitpodWorkspaceTreeDataProvider = new GitpodWorkspaceTreeDataProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('gitpod.workspace', gitpodWorkspaceTreeDataProvider));

	const statusServiceClient = new StatusServiceClient(supervisorAddr, grpc.credentials.createInsecure());
	//#region ports
	function observePortsStatus(): vscode.Disposable {
		let run = true;
		let stopUpdates: Function | undefined;
		(async () => {
			while (run) {
				try {
					const req = new PortsStatusRequest();
					req.setObserve(true);
					const evts = statusServiceClient.portsStatus(req);
					stopUpdates = evts.cancel;

					await new Promise((resolve, reject) => {
						evts.on('close', resolve);
						evts.on('error', reject);
						evts.on('data', (update: PortsStatusResponse) => {
							gitpodWorkspaceTreeDataProvider.updatePortsStatus(update.getPortsList());
						});
					});
				} catch (err) {
					console.error('cannot maintain connection to supervisor', err);
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
		})();
		return new vscode.Disposable(() => {
			run = false;
			if (stopUpdates) {
				stopUpdates();
			}
		});
	}
	context.subscriptions.push(observePortsStatus());
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.resolveExternalPort', (portNumber: number) => {
		return new Promise<number>(resolve => {
			const tryResolve = () => {
				const externalPort = gitpodWorkspaceTreeDataProvider.ports.ports.get(portNumber)?.status?.getGlobalPort();
				if (typeof externalPort === 'number') {
					resolve(externalPort);
					return true;
				}
				return false;
			};
			if (!tryResolve()) {
				const listener = gitpodWorkspaceTreeDataProvider.onDidChangeTreeData(element => {
					if (element === gitpodWorkspaceTreeDataProvider.ports && tryResolve()) {
						listener.dispose();
					}
				});
			}
		});
	}));
	//#endregion

	//#region terminal tasks
	const tasks = new Map<string, TaskStatus>();
	const onDidChangeTasks = new vscode.EventEmitter<TaskStatus[]>();
	context.subscriptions.push(onDidChangeTasks);
	const initialTasks = new Promise<TaskStatus[]>(resolve => {
		const listener = onDidChangeTasks.event(tasks => {
			listener.dispose();
			resolve(tasks);
		});
	});

	function getTaskId(terminal: vscode.Terminal): string | undefined {
		return 'env' in terminal.creationOptions && !!terminal.creationOptions.env && terminal.creationOptions.env['GITPOD_TASK_ID'] || undefined;
	}
	const terminalServiceClient = new TerminalServiceClient(supervisorAddr, grpc.credentials.createInsecure());
	context.subscriptions.push(vscode.window.onDidCloseTerminal(async terminal => {
		const taskId = getTaskId(terminal);
		const task = taskId && tasks.get(taskId);
		if (task && task.getState() === TaskState.RUNNING) {
			const request = new CloseTerminalRequest();
			request.setAlias(task.getTerminal());
			try {
				await util.promisify<CloseTerminalRequest, CloseTerminalResponse>(terminalServiceClient.close.bind(terminalServiceClient))(request);
			} catch (e) {
				console.error(`Failed to close the remote terminal "${task.getTerminal()}" for "${taskId}" task:`, e);
			}
		}
	}));
	const pendingSupervisorBin = (async () => {
		let supervisor = '/.supervisor/supervisor';
		if (devMode) {
			try {
				await util.promisify(fs.stat)(supervisor);
			} catch (e) {
				supervisor = '/theia/supervisor';
				try {
					await util.promisify(fs.stat)(supervisor);
				} catch {
					throw e;
				}
			}
		}
		return supervisor;
	})();
	async function updateTerminals(tasks: TaskStatus[]): Promise<void> {
		for (const task of tasks) {
			try {
				const terminal = vscode.window.terminals.find(terminal => getTaskId(terminal) === task.getId());
				if (!terminal) {
					continue;
				}
				if (task.getState() === TaskState.CLOSED) {
					terminal.dispose();
					continue;
				}
				if (task.getState() !== TaskState.RUNNING) {
					continue;
				}
				const processId = await terminal.processId;
				if (!processId) {
					continue;
				}
				const [supervisorBin, children] = await Promise.all([
					pendingSupervisorBin,
					util.promisify(psTree)(processId)
				]);
				const supervisorCommand = path.basename(supervisorBin);
				if (children.some(child => child.COMMAND === supervisorCommand)) {
					continue;
				}
				terminal.sendText(`${supervisorBin} terminal attach -ir ${task.getTerminal()}`, true);
			} catch (e) {
				console.error('Failed to update Gitpod task terminal:', e);
			}
		}
	}
	initialTasks.then(tasks => {
		for (const task of tasks) {
			try {
				if (task.getState() === TaskState.CLOSED) {
					continue;
				}
				let terminal = vscode.window.terminals.find(terminal => getTaskId(terminal) === task.getId());
				if (!terminal) {
					terminal = vscode.window.createTerminal({
						name: task.getPresentation()?.getName(),
						env: {
							'GITPOD_TASK_ID': task.getId()
						}
					});
					// TODO layout
					terminal.show(false);
				}
			} catch (e) {
				console.error('Failed to initialize the Gitpod task terminal:', e);
			}
		}
		updateTerminals(tasks);
		onDidChangeTasks.event(tasks => updateTerminals(tasks));
	});

	function observeTaskStatus(): vscode.Disposable {
		let run = true;
		let stopUpdates: Function | undefined;
		(async () => {
			while (run) {
				try {
					const req = new TasksStatusRequest();
					req.setObserve(true);
					const evts = statusServiceClient.tasksStatus(req);
					stopUpdates = evts.cancel;

					await new Promise((resolve, reject) => {
						evts.on('close', resolve);
						evts.on('error', reject);
						evts.on('data', (response: TasksStatusResponse) => {
							for (const task of response.getTasksList()) {
								tasks.set(task.getId(), task);
							}
							onDidChangeTasks.fire(response.getTasksList());
						});
					});
				} catch (err) {
					console.error('cannot maintain connection to supervisor', err);
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
		})();
		return new vscode.Disposable(() => {
			run = false;
			if (stopUpdates) {
				stopUpdates();
			}
		});
	}
	context.subscriptions.push(observeTaskStatus());
	//#endregion

	const infoServiceClient = new InfoServiceClient(supervisorAddr, grpc.credentials.createInsecure());
	const tokenServiceClient = new TokenServiceClient(supervisorAddr, grpc.credentials.createInsecure());
	(async () => {
		const workspaceInfoResponse = await util.promisify<WorkspaceInfoRequest, WorkspaceInfoResponse>(infoServiceClient.workspaceInfo.bind(infoServiceClient))(new WorkspaceInfoRequest());
		const gitpodApi = workspaceInfoResponse.getGitpodApi()!;

		const getTokenRequest = new GetTokenRequest();
		getTokenRequest.setHost(gitpodApi.getHost());
		getTokenRequest.addScope('function:stopWorkspace');
		getTokenRequest.addScope('resource:workspace::' + workspaceInfoResponse.getWorkspaceId() + '::get/update');
		const getTokenResponse = await util.promisify<GetTokenRequest, GetTokenResponse>(tokenServiceClient.getToken.bind(tokenServiceClient))(getTokenRequest);
		const serverToken = getTokenResponse.getToken();

		// TODO reconnection ?
		const webSocket = new WebSocket(gitpodApi.getEndpoint(), {
			headers: {
				'Origin': new URL(gitpodApi.getEndpoint()).origin,
				'Authorization': `Bearer ${serverToken}`
			}
		});
		webSocket.onerror = console.error;
		doListen({
			webSocket,
			onConnection: connection => factory.listen(connection),
			logger: new ConsoleLogger()
		});
		const factory = new JsonRpcProxyFactory<GitpodServer>();
		const gitpodService = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy());
		// TODO: manage command enablelement
		context.subscriptions.push(vscode.commands.registerCommand('gitpod.stopWorkspace', () =>
			gitpodService.server.stopWorkspace(workspaceInfoResponse.getWorkspaceId())
		));
	})();
}

export function deactivate() { }
