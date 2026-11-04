import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { downloadFile } from '../shared/files';
import type { RowBuilder } from '../shared/rows';
import { renderTarget } from '../shared/templates';
import { kalpanaApiRequest } from '../shared/transport';
import { isVideoFormat, templateFields } from './templateFields';

/** Kalpana takes at most this many rows in one batch. */
const MAX_ROWS = 500;
/** Kalpana lists at most this many outputs per page. */
const OUTPUTS_PAGE = 20;

export const batchOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['batch'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Make one batch with a row for every input item',
				action: 'Create batch',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a batch’s progress',
				action: 'Get batch',
			},
			{
				name: 'Get Files',
				value: 'getFiles',
				description: 'Get the files a batch rendered, one item per file',
				action: 'Get batch files',
			},
			{
				name: 'Render',
				value: 'render',
				description: 'Start rendering a draft batch, spending credits',
				action: 'Render batch',
			},
		],
		default: 'create',
	},
];

const show = (operation: string[]) => ({ resource: ['batch'], operation });

export const batchFields: INodeProperties[] = [
	{
		displayName: 'Batch Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Diwali sale',
		description: 'Shown in Kalpana and used in the files’ names',
		displayOptions: { show: show(['create']) },
	},
	...templateFields('batch', 'create'),
	{
		displayName: 'Start Rendering',
		name: 'render',
		type: 'boolean',
		default: true,
		description:
			'Whether to start rendering straight away, spending the workspace’s credits. When off, the batch stays a draft to check in Kalpana first.',
		displayOptions: { show: show(['create']) },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: show(['create']) },
		options: [
			{
				displayName: 'Still Time (Seconds)',
				name: 'stillTime',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 2 },
				default: 0,
				description:
					'For images of an animated page: the moment of the motion to show. Leave at 0 to use the moment the designer chose, or else the last frame.',
			},
		],
	},
	{
		displayName: 'Batch ID',
		name: 'batchId',
		type: 'string',
		required: true,
		default: '',
		description: 'The batchId that Batch > Create or the Kalpana Trigger returned',
		displayOptions: { show: show(['get', 'getFiles', 'render']) },
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: show(['getFiles']) },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { ...show(['getFiles']), returnAll: [false] } },
	},
	{
		displayName: 'Download Files',
		name: 'download',
		type: 'boolean',
		default: false,
		description:
			'Whether to add each file to its item as binary data, for nodes that send or store files',
		displayOptions: { show: show(['getFiles']) },
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryProperty',
		type: 'string',
		default: 'data',
		description: 'The name of the binary field to put each file in',
		displayOptions: { show: { ...show(['getFiles']), download: [true] } },
	},
];

type BatchStatus = {
	id: string;
	name: string;
	createdAt: string;
	total: number;
	completed: number;
	failed: number;
	processing: number;
	status: string;
};

type BatchOutput = {
	id: string;
	status: string;
	outputKind: string;
	outputFormat: string;
	contentType: string | null;
	downloadUrl: string | null;
};

/** All input items become rows of one batch, or several of 500 rows each. */
export async function createBatches(
	this: IExecuteFunctions,
	rows: RowBuilder,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const target = renderTarget(this, 0);
	const name = this.getNodeParameter('name', 0) as string;
	const outputFormat = this.getNodeParameter('outputFormat', 0) as string;
	const render = this.getNodeParameter('render', 0, true) as boolean;
	const { stillTime } = this.getNodeParameter('options', 0, {}) as { stillTime?: number };
	const video = isVideoFormat(outputFormat);
	if (this.getNodeParameter('renderAs', 0) === 'flow') {
		if (!target.flowId) {
			throw new NodeOperationError(this.getNode(), 'Choose a flow to render');
		}
		if (!video) {
			throw new NodeOperationError(this.getNode(), 'A flow renders as a video', {
				description: 'Choose MP4, GIF, WebM or MOV as the format',
			});
		}
	}

	const allRows: IDataObject[] = [];
	for (let i = 0; i < items.length; i++) allRows.push(await rows.row(target, i));

	const parts = Math.ceil(allRows.length / MAX_ROWS);
	const results: INodeExecutionData[] = [];
	for (let part = 0; part < parts; part++) {
		const start = part * MAX_ROWS;
		const chunk = allRows.slice(start, start + MAX_ROWS);
		const body: IDataObject = {
			templateId: target.templateId,
			name: parts > 1 ? `${name} (${part + 1} of ${parts})` : name,
			rows: chunk,
			outputFormat,
		};
		if (target.pageId) body.pageIds = [target.pageId];
		if (target.flowId) body.flowIds = [target.flowId];
		if (stillTime && !video) body.stillTime = stillTime;
		const batch = await kalpanaApiRequest<IDataObject & { id: string }>(
			this,
			'POST',
			'/agent/v1/batches',
			body,
		);
		if (render) {
			await kalpanaApiRequest(
				this,
				'POST',
				`/agent/v1/batches/${encodeURIComponent(batch.id)}/run`,
				{},
			);
		}
		results.push({
			json: {
				batchId: batch.id,
				name: body.name,
				rows: chunk.length,
				jobs: batch.jobCount ?? chunk.length,
				creditCost: batch.creditCost ?? null,
				status: render ? 'rendering' : 'draft',
				warnings: batch.warnings ?? [],
			},
			pairedItem: chunk.map((_, index) => ({ item: start + index })),
		});
	}
	return results;
}

const batchPath = (context: IExecuteFunctions, itemIndex: number) =>
	`/agent/v1/batches/${encodeURIComponent((context.getNodeParameter('batchId', itemIndex) as string).trim())}`;

export async function getBatch(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const batch = await kalpanaApiRequest<BatchStatus>(
		this,
		'GET',
		batchPath(this, itemIndex),
		undefined,
		undefined,
		itemIndex,
	);
	return [
		{
			json: {
				batchId: batch.id,
				name: batch.name,
				status: batch.status,
				total: batch.total,
				completed: batch.completed,
				failed: batch.failed,
				processing: batch.processing,
				finished: batch.processing === 0 && batch.completed + batch.failed >= batch.total,
				createdAt: batch.createdAt,
			},
			pairedItem: { item: itemIndex },
		},
	];
}

export async function renderBatch(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const path = batchPath(this, itemIndex);
	const result = await kalpanaApiRequest(this, 'POST', `${path}/run`, {}, undefined, itemIndex);
	return [
		{
			json: { batchId: path.split('/').pop(), status: 'rendering', ...result },
			pairedItem: { item: itemIndex },
		},
	];
}

export async function getBatchFiles(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const path = `${batchPath(this, itemIndex)}/outputs`;
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const download = this.getNodeParameter('download', itemIndex, false) as boolean;
	const field = download
		? (this.getNodeParameter('binaryProperty', itemIndex, 'data') as string)
		: 'data';

	const outputs: BatchOutput[] = [];
	for (let page = 1; outputs.length < limit; page++) {
		const { items } = await kalpanaApiRequest<{ items: BatchOutput[] }>(
			this,
			'GET',
			path,
			undefined,
			{ page, limit: OUTPUTS_PAGE },
			itemIndex,
		);
		outputs.push(...items);
		if (items.length < OUTPUTS_PAGE) break;
	}

	const results: INodeExecutionData[] = [];
	for (const output of outputs.slice(0, limit)) {
		const item: INodeExecutionData = {
			json: {
				jobId: output.id,
				status: output.status,
				fileUrl: output.downloadUrl,
				contentType: output.contentType,
				format: output.outputFormat,
				kind: output.outputKind,
			},
			pairedItem: { item: itemIndex },
		};
		if (download && output.downloadUrl) {
			item.binary = await downloadFile(
				this,
				output.downloadUrl,
				`${output.id}.${output.outputFormat}`,
				output.contentType ?? '',
				field,
			);
		}
		results.push(item);
	}
	return results;
}
