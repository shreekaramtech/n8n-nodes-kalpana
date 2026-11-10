import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { ApplicationError, NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import { downloadFile } from '../shared/files';
import type { RowBuilder } from '../shared/rows';
import { renderTarget } from '../shared/templates';
import { kalpanaApiRequest, keyWorkspace, nodeError } from '../shared/transport';
import { isVideoFormat, templateFields } from './templateFields';

export const creativeOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['creative'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Fill a template with one item’s data and render it',
				action: 'Create creative',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a creative’s render status and file',
				action: 'Get creative',
			},
		],
		default: 'create',
	},
];

const createShow = { resource: ['creative'], operation: ['create'] };
const getShow = { resource: ['creative'], operation: ['get'] };

export const creativeFields: INodeProperties[] = [
	...templateFields('creative', 'create'),
	{
		displayName: 'Wait for File',
		name: 'waitForFile',
		type: 'boolean',
		default: true,
		description:
			'Whether to wait until the file is ready. When off, the node starts the render and returns the job straight away; use the Kalpana Trigger or Creative > Get to collect the file.',
		displayOptions: { show: createShow },
	},
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		required: true,
		default: '',
		description: 'The jobId that Creative > Create returned',
		displayOptions: { show: getShow },
	},
	{
		displayName: 'Download File',
		name: 'download',
		type: 'boolean',
		default: true,
		description:
			'Whether to add the rendered file to the item as binary data, for nodes that send or store files',
		displayOptions: {
			show: { resource: ['creative'], operation: ['create', 'get'] },
			hide: { waitForFile: [false] },
		},
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryProperty',
		type: 'string',
		default: 'data',
		description: 'The name of the binary field to put the file in',
		displayOptions: {
			show: { resource: ['creative'], operation: ['create', 'get'], download: [true] },
			hide: { waitForFile: [false] },
		},
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: createShow },
		options: [
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				placeholder: 'e.g. order-1042',
				description:
					'Name of the file in Kalpana, without the extension. Without it the file takes the template’s name.',
			},
			{
				displayName: 'Still Time (Seconds)',
				name: 'stillTime',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 600, numberPrecision: 2 },
				default: 0,
				description:
					'For an image of an animated page: the moment of the motion to show. Leave at 0 to use the moment the designer chose, or else the last frame.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				typeOptions: { minValue: 30, maxValue: 3600 },
				default: 600,
				description: 'How long to wait for the file before stopping with the job ID',
			},
		],
	},
];

/** A job as Kalpana's API returns it. */
type JobView = {
	id: string;
	status: 'pending' | 'processing' | 'success' | 'failed' | 'cancelled';
	template: { id: string; name: string } | null;
	page: { id: string; name: string } | null;
	flow: { id: string; name: string } | null;
	batch: string | null;
	/** The values it was made from, by layer. */
	modifications: IDataObject | null;
	output: { format: string; kind: 'image' | 'video' };
	creditCost: number;
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
	createdAt: string;
	updatedAt: string;
};

/** The answer to creating or running jobs. */
type JobRequest = { status: 'processing' | 'pending' | 'done'; jobs: JobView[] };

const RENDERING = new Set(['pending', 'processing']);
/** How long a run call asks Kalpana to hold its answer while the file renders
 * (`Prefer: wait`). Kalpana holds at most 30 seconds, then answers 202. */
const RUN_WAIT_SECONDS = 25;
/** Kalpana's Retry-After for a job still rendering. */
const POLL_SECONDS = 5;
const ATTEMPTS = 3;

const jobItem = (job: JobView): IDataObject => ({
	jobId: job.id,
	status: job.status,
	fileUrl: job.file?.url ?? null,
	fileName: job.file?.fileName ?? null,
	contentType: job.file?.contentType ?? null,
	width: job.file?.width ?? null,
	height: job.file?.height ?? null,
	sizeBytes: job.file?.sizeBytes ?? null,
	creativeId: job.file?.creativeId ?? null,
	format: job.output.format,
	kind: job.output.kind,
	creditCost: job.creditCost,
	templateId: job.template?.id ?? null,
	pageId: job.page?.id ?? null,
	flowId: job.flow?.id ?? null,
	batchId: job.batch,
	modifications: job.modifications,
	error: job.error,
	createdAt: job.createdAt,
});

/** The one job of a request's answer. */
const onlyJob = (request: JobRequest) => {
	const [job] = request.jobs;
	if (!job) throw new ApplicationError('Kalpana answered with no job');
	return job;
};

/** A failure worth another try: no answer, a timeout, or a server error. */
const transient = (error: unknown) => {
	if (!(error instanceof NodeApiError)) return false;
	const code = Number(error.httpCode);
	return !code || code === 408 || code === 429 || code >= 500;
};

/** A call that runs again on a transient failure. Only for calls that are
 * safe to repeat: reading a job, or running one (Kalpana starts a job only
 * while it is pending and refuses a repeat with 409, so it never renders or
 * charges twice). */
const retrying = async <T>(node: INode, call: () => Promise<T>): Promise<T> => {
	for (let attempt = 1; ; attempt++) {
		try {
			return await call();
		} catch (error) {
			if (attempt >= ATTEMPTS || !transient(error)) throw nodeError(node, error);
			await sleep(attempt * 2000);
		}
	}
};

/** An error for a job that exists in Kalpana, naming it so it can be found.
 * The node's own errors already name it and pass through. */
const jobError = (context: IExecuteFunctions, error: unknown, jobId: string, itemIndex: number) => {
	if (error instanceof NodeOperationError) return error;
	const wrapped = nodeError(context.getNode(), error, itemIndex);
	wrapped.description = [wrapped.description, `Job ID: ${jobId}`].filter(Boolean).join('\n');
	return wrapped;
};

const withFile = async (
	context: IExecuteFunctions,
	job: JobView,
	itemIndex: number,
): Promise<INodeExecutionData> => {
	const item: INodeExecutionData = { json: jobItem(job), pairedItem: { item: itemIndex } };
	const download = context.getNodeParameter('download', itemIndex, false) as boolean;
	if (download && job.file) {
		const field = context.getNodeParameter('binaryProperty', itemIndex, 'data') as string;
		item.binary = await downloadFile(
			context,
			job.file.url,
			job.file.fileName,
			job.file.contentType,
			field,
		);
	}
	return item;
};

const finished = (context: IExecuteFunctions, job: JobView, itemIndex: number) => {
	if (job.status === 'failed' || job.status === 'cancelled') {
		throw new NodeOperationError(
			context.getNode(),
			job.status === 'failed'
				? `The render did not finish: ${job.error ?? 'Kalpana gave no reason'}`
				: 'The job was cancelled before it rendered',
			{ itemIndex, description: `Job ID: ${job.id}` },
		);
	}
	return job;
};

export async function createCreative(
	this: IExecuteFunctions,
	itemIndex: number,
	rows: RowBuilder,
): Promise<INodeExecutionData> {
	const target = renderTarget(this, itemIndex);
	const outputFormat = this.getNodeParameter('outputFormat', itemIndex) as string;
	const wait = this.getNodeParameter('waitForFile', itemIndex, true) as boolean;
	const options = this.getNodeParameter('options', itemIndex, {}) as {
		fileName?: string;
		stillTime?: number;
		timeout?: number;
	};
	const video = isVideoFormat(outputFormat);
	if (target.flowId === undefined && this.getNodeParameter('renderAs', itemIndex) === 'flow') {
		throw new NodeOperationError(this.getNode(), 'Choose a flow to render', { itemIndex });
	}
	if (target.flowId && !video) {
		throw new NodeOperationError(this.getNode(), 'A flow renders as a video', {
			itemIndex,
			description: 'Choose MP4 or GIF as the format',
		});
	}

	const workspace = await rows.workspace();
	// A job renders one page: the one chosen, else the template's first.
	const page = target.flowId
		? undefined
		: (target.pageId ?? (await rows.template(target, itemIndex)).pageId ?? undefined);
	const output: IDataObject = { format: outputFormat };
	if (options.fileName) output.fileName = options.fileName;
	if (options.stillTime && !video) output.stillTime = options.stillTime;
	const body: IDataObject = {
		workspace,
		jobs: [
			{
				...(target.flowId ? { flow: target.flowId } : { page }),
				modifications: await rows.row(target, itemIndex),
				output,
			},
		],
	};

	// The job is saved first and run second. Saving spends nothing; once it
	// exists, starting and reading it are safe to repeat, so a dropped
	// connection never renders or charges twice.
	const created = onlyJob(
		await kalpanaApiRequest<JobRequest>(this, 'POST', '/jobs', body, undefined, itemIndex),
	);
	const jobPath = `/jobs/${encodeURIComponent(created.id)}`;
	const read = async () =>
		await kalpanaApiRequest<JobView>(this, 'GET', jobPath, undefined, { workspace }, itemIndex);
	const deadline = Date.now() + (options.timeout ?? 600) * 1000;

	try {
		// Kalpana holds the run call until the file is ready, up to the wait
		// asked for, so most images come back here with their file.
		let job = await retrying(this.getNode(), async () => {
			try {
				return onlyJob(
					await kalpanaApiRequest<JobRequest>(
						this,
						'POST',
						`${jobPath}/run`,
						{ workspace },
						undefined,
						itemIndex,
						{ prefer: `wait=${wait ? RUN_WAIT_SECONDS : 0}` },
					),
				);
			} catch (error) {
				// A retried run whose first call started the job: read it.
				if (error instanceof NodeApiError && Number(error.httpCode) === 409) return await read();
				throw nodeError(this.getNode(), error, itemIndex);
			}
		});
		if (!wait) return { json: jobItem(job), pairedItem: { item: itemIndex } };

		// Longer renders, most videos among them, are read until they finish.
		while (RENDERING.has(job.status)) {
			if (Date.now() > deadline) {
				throw new NodeOperationError(this.getNode(), 'The file is still rendering', {
					itemIndex,
					description: `Collect it later with Creative > Get, or raise the timeout. Job ID: ${job.id}`,
				});
			}
			await sleep(POLL_SECONDS * 1000);
			job = await retrying(this.getNode(), read);
		}
		return await withFile(this, finished(this, job, itemIndex), itemIndex);
	} catch (error) {
		throw jobError(this, error, created.id, itemIndex);
	}
}

export async function getCreative(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const jobId = String(this.getNodeParameter('jobId', itemIndex, '') ?? '').trim();
	if (!jobId) {
		throw new NodeOperationError(this.getNode(), 'Give the job ID to get', {
			itemIndex,
			description: 'Creative > Create returns it as jobId',
		});
	}
	const { id: workspace } = await keyWorkspace(this);
	const job = await kalpanaApiRequest<JobView>(
		this,
		'GET',
		`/jobs/${encodeURIComponent(jobId)}`,
		undefined,
		{ workspace },
		itemIndex,
	);
	return withFile(this, job, itemIndex);
}
