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
import { kalpanaApiRequest, keyWorkspace } from '../shared/transport';
import { isVideoFormat, templateFields } from './templateFields';

/** Kalpana takes at most this many rows in one batch. */
const MAX_ROWS = 1000;
/** A batch's jobs read per call. Kalpana allows up to 100. */
const JOBS_PAGE = 100;

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

/** Get a batch, cut to what the node reads. */
type BatchStatus = {
	id: string;
	name: string;
	createdAt: string;
	status: string;
	jobs: {
		total: number;
		succeeded: number;
		failed: number;
		processing: number;
		cancelled: number;
		pending: number;
	};
};

/** One of a batch's jobs, as List a batch's jobs gives it. */
type BatchJob = {
	id: string;
	status: string;
	page: { id: string; name: string } | null;
	flow: { id: string; name: string } | null;
	modifications: IDataObject | null;
	output: { format: string; kind: string };
	error: string | null;
	file: {
		creativeId: string;
		url: string;
		fileName: string;
		contentType: string;
		sizeBytes: number;
		width: number | null;
		height: number | null;
	} | null;
};

/** Batch statuses that still change. */
const UNSETTLED = new Set(['pending', 'processing']);

/** All input items become rows of one batch, or several of 1,000 rows each. */
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

	const workspace = await rows.workspace();
	// What every row renders on: the flow, else the page chosen, else the
	// template's first page, as before.
	const page = target.pageId ?? (await rows.template(target, 0)).pageId;
	const renders: IDataObject = target.flowId ? { flow: target.flowId } : { pages: [page] };
	const output: IDataObject = { format: outputFormat };
	if (stillTime && !video) output.stillTime = stillTime;
	const allRows: IDataObject[] = [];
	for (let i = 0; i < items.length; i++)
		allRows.push({ modifications: await rows.row(target, i), output });

	const parts = Math.ceil(allRows.length / MAX_ROWS);
	const results: INodeExecutionData[] = [];
	for (let part = 0; part < parts; part++) {
		const start = part * MAX_ROWS;
		const chunk = allRows.slice(start, start + MAX_ROWS);
		const body: IDataObject = {
			workspace,
			name: parts > 1 ? `${name} (${part + 1} of ${parts})` : name,
			...renders,
			rows: chunk,
		};
		const batch = await kalpanaApiRequest<IDataObject & { id: string }>(
			this,
			'POST',
			'/batches',
			body,
		);
		if (render) {
			await kalpanaApiRequest(this, 'POST', `/batches/${encodeURIComponent(batch.id)}/run`, {
				workspace,
			});
		}
		results.push({
			json: {
				batchId: batch.id,
				name: body.name,
				rows: chunk.length,
				jobs: batch.jobCount ?? chunk.length,
				creditCost: batch.creditCost ?? null,
				status: render ? 'rendering' : 'draft',
			},
			pairedItem: chunk.map((_, index) => ({ item: start + index })),
		});
	}
	return results;
}

const batchPath = (context: IExecuteFunctions, itemIndex: number) => {
	const batchId = String(context.getNodeParameter('batchId', itemIndex, '') ?? '').trim();
	if (!batchId) {
		throw new NodeOperationError(context.getNode(), 'Give the batch ID', {
			itemIndex,
			description: 'Batch > Create and the Kalpana Trigger return it',
		});
	}
	return { batchId, path: `/batches/${encodeURIComponent(batchId)}` };
};

export async function getBatch(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const { path } = batchPath(this, itemIndex);
	const { id: workspace } = await keyWorkspace(this);
	const batch = await kalpanaApiRequest<BatchStatus>(
		this,
		'GET',
		path,
		undefined,
		{ workspace },
		itemIndex,
	);
	return [
		{
			json: {
				batchId: batch.id,
				name: batch.name,
				status: batch.status,
				total: batch.jobs.total,
				succeeded: batch.jobs.succeeded,
				failed: batch.jobs.failed,
				processing: batch.jobs.processing,
				pending: batch.jobs.pending,
				cancelled: batch.jobs.cancelled,
				finished: !UNSETTLED.has(batch.status),
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
	const { batchId, path } = batchPath(this, itemIndex);
	const { id: workspace } = await keyWorkspace(this);
	const result = await kalpanaApiRequest(
		this,
		'POST',
		`${path}/run`,
		{ workspace },
		undefined,
		itemIndex,
	);
	return [
		{
			json: { batchId, status: 'rendering', ...result },
			pairedItem: { item: itemIndex },
		},
	];
}

/** The batch's rendered files, one item each, in job order. */
export async function getBatchFiles(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const { batchId, path } = batchPath(this, itemIndex);
	const { id: workspace } = await keyWorkspace(this);
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const download = this.getNodeParameter('download', itemIndex, false) as boolean;
	const field = download
		? (this.getNodeParameter('binaryProperty', itemIndex, 'data') as string)
		: 'data';

	const files: BatchJob[] = [];
	for (let page = 1; files.length < limit; page++) {
		const { jobs, total } = await kalpanaApiRequest<{ jobs: BatchJob[]; total: number }>(
			this,
			'GET',
			`${path}/jobs`,
			undefined,
			{ workspace, page, limit: JOBS_PAGE },
			itemIndex,
		);
		files.push(...jobs.filter((job) => job.file));
		if (jobs.length < JOBS_PAGE || page * JOBS_PAGE >= total) break;
	}

	const results: INodeExecutionData[] = [];
	for (const job of files.slice(0, limit)) {
		const file = job.file!;
		const item: INodeExecutionData = {
			json: {
				batchId,
				jobId: job.id,
				status: job.status,
				fileUrl: file.url,
				fileName: file.fileName,
				contentType: file.contentType,
				width: file.width,
				height: file.height,
				sizeBytes: file.sizeBytes,
				creativeId: file.creativeId,
				format: job.output.format,
				kind: job.output.kind,
				pageId: job.page?.id ?? null,
				pageName: job.page?.name ?? null,
				modifications: job.modifications,
			},
			pairedItem: { item: itemIndex },
		};
		if (download) {
			item.binary = await downloadFile(this, file.url, file.fileName, file.contentType, field);
		}
		results.push(item);
	}
	return results;
}
