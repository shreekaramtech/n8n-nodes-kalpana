import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/** A caught error as n8n shows it: n8n's own errors pass through unchanged. */
export const nodeError = (node: INode, error: unknown, itemIndex?: number) =>
	error instanceof NodeApiError || error instanceof NodeOperationError
		? error
		: new NodeApiError(node, error as JsonObject, { itemIndex });

export type KalpanaContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

const baseUrl = async (context: KalpanaContext) => {
	const credentials = await context.getCredentials<{ baseUrl?: string }>('kalpanaApi');
	return `${(credentials.baseUrl || 'https://app.kalpana.one').replace(/\/+$/, '')}/api`;
};

type RowIssue = { field?: string; message?: string };
type ErrorBody = { message?: string; data?: { issues?: RowIssue[] } };

/** What Kalpana said: its message, and for a row it could not read, the
 * problem with each field. n8n's own wording for the status says less. */
const kalpanaMessage = (error: unknown) => {
	// n8n's request helper has already made a NodeApiError with the response
	// body in its context; a raw request error carries it on the response.
	const raw = error as {
		context?: { data?: unknown };
		cause?: { response?: { data?: unknown } };
		response?: { data?: unknown };
	};
	const body = (raw.context?.data ?? raw.cause?.response?.data ?? raw.response?.data) as
		| ErrorBody
		| undefined;
	const issues = body?.data?.issues;
	if (Array.isArray(issues) && issues.length) {
		const fields = issues
			.map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
			.join('; ');
		return {
			message: `Kalpana could not use this data. ${fields}`,
			description: 'Check the values mapped to these template inputs',
		};
	}
	return typeof body?.message === 'string' && body.message ? { message: body.message } : {};
};

/** One call to Kalpana's API with the node's API key. `path` starts after /api. */
export const kalpanaApiRequest = async <T = IDataObject>(
	context: KalpanaContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
	itemIndex?: number,
	headers?: Record<string, string>,
): Promise<T> => {
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(context)}${path}`,
		json: true,
		headers: { accept: 'application/json', ...headers },
	};
	if (body) options.body = body;
	if (qs) options.qs = qs;
	try {
		return (await context.helpers.httpRequestWithAuthentication.call(
			context,
			'kalpanaApi',
			options,
		)) as T;
	} catch (error) {
		throw new NodeApiError(context.getNode(), error as JsonObject, {
			itemIndex,
			...kalpanaMessage(error),
		});
	}
};

type Workspace = { id: string; name: string; slug: string };

/** The workspace the API key works in. A key is made for one workspace. */
export const keyWorkspace = async (context: KalpanaContext): Promise<Workspace> => {
	const { items } = await kalpanaApiRequest<{ items: Workspace[] }>(
		context,
		'GET',
		'/agent/v1/workspaces',
	);
	const [workspace] = items;
	if (!workspace) {
		throw new NodeApiError(context.getNode(), {} as JsonObject, {
			message: 'This API key has no workspace',
			description: 'Create a key for a workspace in Kalpana under Organization > API keys',
		});
	}
	return workspace;
};
