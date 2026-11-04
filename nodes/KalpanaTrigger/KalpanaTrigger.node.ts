import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import { downloadFile } from '../Kalpana/shared/files';
import { getTemplates } from '../Kalpana/shared/templates';
import { kalpanaApiRequest, keyWorkspace, nodeError } from '../Kalpana/shared/transport';

type WebhookData = { webhookId?: string; signingSecret?: string; workspaceId?: string };

/** Deliveries signed longer ago than this are refused as replays. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

const validSignature = (header: string, rawBody: string, secret: string) => {
	const parts = Object.fromEntries(
		header.split(',').map((part) => {
			const at = part.indexOf('=');
			return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
		}),
	) as { t?: string; v1?: string };
	if (!parts.t || !parts.v1) return false;
	const age = Math.abs(Date.now() / 1000 - Number(parts.t));
	if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;
	const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
	const given = Buffer.from(parts.v1, 'hex');
	const wanted = Buffer.from(expected, 'hex');
	return given.length === wanted.length && timingSafeEqual(given, wanted);
};

const isNotFound = (error: unknown) =>
	error instanceof NodeApiError && String(error.httpCode) === '404';

export class KalpanaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Kalpana Trigger',
		name: 'kalpanaTrigger',
		icon: { light: 'file:../Kalpana/kalpana.svg', dark: 'file:../Kalpana/kalpana.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when Kalpana finishes a creative or a batch',
		defaults: { name: 'Kalpana Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'kalpanaApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Kalpana sends events only to workspaces on a paid plan. The API key needs Webhooks: Write access.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['job.completed'],
				options: [
					{
						name: 'Batch Finished',
						value: 'batch.completed',
						description: 'Every row of a batch run has rendered, failed or been cancelled',
					},
					{
						name: 'Creative Rendered',
						value: 'job.completed',
						description: 'One creative has rendered, from a batch or on its own',
					},
				],
			},
			{
				displayName: 'Template Names or IDs',
				name: 'templateIds',
				type: 'multiOptions',
				default: [],
				description:
					'Only events from these templates. Leave empty for every template. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'getTemplates' },
			},
			{
				displayName: 'Download File',
				name: 'download',
				type: 'boolean',
				default: false,
				description:
					'Whether to add a rendered creative’s file to the item as binary data, for nodes that send or store files',
				displayOptions: { show: { events: ['job.completed'] } },
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				description: 'The name of the binary field to put the file in',
				displayOptions: { show: { events: ['job.completed'], download: [true] } },
			},
		],
	};

	methods = { loadOptions: { getTemplates } };

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as WebhookData;
				if (!data.webhookId || !data.signingSecret || !data.workspaceId) return false;
				try {
					const endpoint = await kalpanaApiRequest<{ url: string; enabled: boolean }>(
						this,
						'GET',
						`/webhooks/${encodeURIComponent(data.webhookId)}`,
						undefined,
						{ workspace: data.workspaceId },
					);
					return endpoint.url === this.getNodeWebhookUrl('default') && endpoint.enabled;
				} catch (error) {
					if (!isNotFound(error)) throw nodeError(this.getNode(), error);
					delete data.webhookId;
					delete data.signingSecret;
					return false;
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as WebhookData;
				const workspace = await keyWorkspace(this);
				const events = this.getNodeParameter('events') as string[];
				const templateIds = this.getNodeParameter('templateIds', []) as string[];
				const workflowName = this.getWorkflow().name ?? 'workflow';
				const body: IDataObject = {
					workspace: workspace.id,
					name: `n8n: ${workflowName}`.slice(0, 100),
					url: this.getNodeWebhookUrl('default'),
					events,
					format: 'json',
					// Lets any member's workflow subscribe, with no test delivery.
					source: 'n8n',
				};
				if (templateIds.length) body.filters = { templateIds };
				const endpoint = await kalpanaApiRequest<{ id: string; signingSecret?: string }>(
					this,
					'POST',
					'/webhooks',
					body,
				);
				if (!endpoint.signingSecret) {
					throw new NodeApiError(this.getNode(), endpoint as unknown as JsonObject, {
						message: 'Kalpana did not return the webhook’s signing secret',
					});
				}
				data.webhookId = endpoint.id;
				data.signingSecret = endpoint.signingSecret;
				data.workspaceId = workspace.id;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as WebhookData;
				if (data.webhookId && data.workspaceId) {
					try {
						await kalpanaApiRequest(
							this,
							'DELETE',
							`/webhooks/${encodeURIComponent(data.webhookId)}`,
							{ workspace: data.workspaceId },
						);
					} catch (error) {
						// Already gone in Kalpana is what deleting wants.
						if (!isNotFound(error)) throw nodeError(this.getNode(), error);
					}
				}
				delete data.webhookId;
				delete data.signingSecret;
				delete data.workspaceId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const data = this.getWorkflowStaticData('node') as WebhookData;
		const request = this.getRequestObject() as unknown as { rawBody?: Buffer };
		const body = this.getBodyData() as IDataObject;
		const rawBody = request.rawBody ? request.rawBody.toString('utf8') : JSON.stringify(body);
		const signature = this.getHeaderData()['kalpana-signature'];

		if (
			!data.signingSecret ||
			typeof signature !== 'string' ||
			!validSignature(signature, rawBody, data.signingSecret)
		) {
			const response = this.getResponseObject();
			response.status(401).send('Invalid Kalpana-Signature');
			return { noWebhookResponse: true };
		}

		// Kalpana sends a test event when the webhook is added; it starts nothing.
		if (body.type === 'webhook.test') return { webhookResponse: 'ok' };

		const item: INodeExecutionData = {
			json: {
				event: body.type,
				eventId: body.id,
				createdAt: body.created_at,
				workspaceId: body.workspace_id,
				...((body.data as IDataObject) ?? {}),
			},
		};
		const creative = (body.data as IDataObject | undefined)?.creative as IDataObject | undefined;
		const download =
			body.type === 'job.completed' && (this.getNodeParameter('download', false) as boolean);
		if (download && typeof creative?.url === 'string') {
			item.binary = await downloadFile(
				this,
				creative.url,
				String(creative.name ?? 'creative'),
				String(creative.content_type ?? ''),
				this.getNodeParameter('binaryProperty', 'data') as string,
			);
		}
		return { workflowData: [[item]] };
	}
}
