import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { kalpanaApiRequest, type KalpanaContext } from './transport';

export type TemplateInput = {
	id: string;
	key: string;
	label: string;
	type: 'text' | 'image';
	required: boolean;
	description: string | null;
	dimensions?: { width: number; height: number };
};

export type TemplateInputs = {
	id: string;
	name: string;
	isAnimated: boolean;
	duration?: number;
	stillTime?: number;
	pageId: string | null;
	flowId?: string;
	pages: { id: string; name: string; width: number | null; height: number | null }[];
	flows?: { id: string; name: string; duration: number; pageIds: string[] }[];
	inputs: TemplateInput[];
};

type TemplateSummary = {
	id: string;
	name: string;
	width: number | null;
	height: number | null;
	isAnimated: boolean;
	openUrl: string | null;
};

export type RenderTarget = { templateId: string; pageId?: string; flowId?: string };

/** The template's pages, flows and the inputs rows fill on one page or flow. */
export const templateInputs = (
	context: KalpanaContext,
	target: RenderTarget,
	itemIndex?: number,
) => {
	const qs: IDataObject = {};
	if (target.flowId) qs.flowId = target.flowId;
	else if (target.pageId) qs.pageId = target.pageId;
	return kalpanaApiRequest<TemplateInputs>(
		context,
		'GET',
		`/agent/v1/templates/${encodeURIComponent(target.templateId)}/inputs`,
		undefined,
		qs,
		itemIndex,
	);
};

/** The template, page or flow chosen in the node's fields. */
export const renderTarget = (
	context: IExecuteFunctions | ILoadOptionsFunctions,
	itemIndex = 0,
): RenderTarget => {
	const read = (name: string) =>
		(context.getNodeParameter(name, itemIndex, '', { extractValue: true }) as string) || '';
	const templateId = read('template');
	const renderAs = read('renderAs') || 'page';
	return renderAs === 'flow'
		? { templateId, flowId: read('flow') || undefined }
		: { templateId, pageId: read('page') || undefined };
};

const sizeLabel = (width: number | null, height: number | null) =>
	width && height ? ` (${width}×${height})` : '';

export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = paginationToken ? Number(paginationToken) : 1;
	const limit = 50;
	const qs: IDataObject = { page, limit };
	if (filter) qs.query = filter;
	const { items, total } = await kalpanaApiRequest<{ items: TemplateSummary[]; total: number }>(
		this,
		'GET',
		'/agent/v1/templates',
		undefined,
		qs,
	);
	return {
		results: items.map((template) => ({
			name: `${template.name}${sizeLabel(template.width, template.height)}`,
			value: template.id,
			url: template.openUrl ?? undefined,
		})),
		paginationToken: page * limit < total ? String(page + 1) : undefined,
	};
}

const chosenTemplate = (context: ILoadOptionsFunctions) =>
	(context.getNodeParameter('template', '', { extractValue: true }) as string) || '';

export async function getPages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const templateId = chosenTemplate(this);
	if (!templateId) return [];
	const { pages } = await templateInputs(this, { templateId });
	return pages.map((page, index) => ({
		name: `${page.name || `Page ${index + 1}`}${sizeLabel(page.width, page.height)}`,
		value: page.id,
	}));
}

export async function getFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const templateId = chosenTemplate(this);
	if (!templateId) return [];
	const { flows = [] } = await templateInputs(this, { templateId });
	return flows.map((flow) => ({
		name: `${flow.name} (${flow.duration} s)`,
		value: flow.id,
	}));
}

export async function getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const { items } = await kalpanaApiRequest<{ items: TemplateSummary[] }>(
		this,
		'GET',
		'/agent/v1/templates',
		undefined,
		{ page: 1, limit: 100 },
	);
	return items.map((template) => ({
		name: `${template.name}${sizeLabel(template.width, template.height)}`,
		value: template.id,
	}));
}

/** One mapping field per template input, keyed as rows key it. */
export async function getTemplateFields(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const target = renderTarget(this);
	if (!target.templateId) {
		return { fields: [], emptyFieldsNotice: 'Choose a template first' };
	}
	if ((this.getNodeParameter('renderAs', 'page') as string) === 'flow' && !target.flowId) {
		return { fields: [], emptyFieldsNotice: 'Choose a flow first' };
	}
	const { inputs } = await templateInputs(this, target);
	const fields: ResourceMapperField[] = inputs.map((input) => ({
		id: input.key,
		displayName:
			input.type === 'image' ? `${input.label} (image: URL, file name or image ID)` : input.label,
		required: input.required,
		defaultMatch: false,
		canBeUsedToMatch: false,
		display: true,
		type: 'string',
	}));
	return {
		fields,
		emptyFieldsNotice: 'This template has no inputs to fill. It renders as designed.',
	};
}
