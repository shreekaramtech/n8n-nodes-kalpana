import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { kalpanaApiRequest, keyWorkspace, type KalpanaContext } from './transport';

/** A layer a row can fill, keyed as `modifications` names it. */
export type TemplateInput = {
	key: string;
	label: string;
	type: 'text' | 'image';
};

export type TemplateInputs = {
	id: string;
	name: string;
	/** The page a job renders: the one chosen, else the template's first. */
	pageId: string | null;
	pages: { id: string; name: string }[];
	flows: { id: string; name: string; pageIds: string[] }[];
	inputs: TemplateInput[];
};

/** Get a template, cut to what the node reads. */
type TemplateDetail = {
	id: string;
	name: string;
	pages: {
		id: string | null;
		name: string;
		variables?: Record<string, { node_type?: string }>;
	}[];
	flows?: { id: string; name: string; flow?: { steps?: { page?: string }[] } | null }[];
};

/** Get a template summary: each page's layer names. */
type TemplateLayers = {
	pages: { id: string | null; nodes?: Record<string, { name?: string }> }[];
};

type TemplateListItem = {
	id: string;
	name: string;
	width: number | null;
	height: number | null;
};

export type RenderTarget = { templateId: string; pageId?: string; flowId?: string };

/** The layers a page's rows fill, keyed by `prefix` + layer id. Colours are
 * left out: the API cannot set them yet. */
const pageInputs = (
	page: TemplateDetail['pages'][number],
	names: Record<string, { name?: string }>,
	prefix = '',
	labelPrefix = '',
): TemplateInput[] =>
	Object.entries(page.variables ?? {}).flatMap(([id, variable]) => {
		const type = variable.node_type ?? 'text';
		if (type !== 'text' && type !== 'image') return [];
		return [{ key: `${prefix}${id}`, label: `${labelPrefix}${names[id]?.name ?? id}`, type }];
	});

/**
 * The template's pages, flows and the layers rows fill on one page or flow.
 * A page's layers are keyed by id. A flow's are keyed `<pageId>@<layer id>`
 * with the page's name in the label, since its pages can share layer names.
 */
export const templateInputs = async (
	context: KalpanaContext,
	target: RenderTarget,
	workspace?: string,
	itemIndex?: number,
): Promise<TemplateInputs> => {
	const qs = { workspace: workspace ?? (await keyWorkspace(context)).id };
	const path = `/templates/${encodeURIComponent(target.templateId)}`;
	const [template, layers] = await Promise.all([
		kalpanaApiRequest<TemplateDetail>(context, 'GET', path, undefined, qs, itemIndex),
		kalpanaApiRequest<TemplateLayers>(context, 'GET', `${path}/summary`, undefined, qs, itemIndex),
	]);
	const pages = template.pages.flatMap((page) =>
		page.id ? [{ id: page.id, name: page.name }] : [],
	);
	const flows = (template.flows ?? []).map((flow) => ({
		id: flow.id,
		name: flow.name,
		pageIds: [
			...new Set((flow.flow?.steps ?? []).flatMap((step) => (step.page ? [step.page] : []))),
		],
	}));
	const namesOf = (pageId: string | null) =>
		layers.pages.find((page) => page.id === pageId)?.nodes ?? {};

	let inputs: TemplateInput[] = [];
	const pageId = target.flowId ? null : (target.pageId ?? pages[0]?.id ?? null);
	if (target.flowId) {
		const flow = flows.find((item) => item.id === target.flowId);
		const shown = template.pages.filter((page) => page.id && flow?.pageIds.includes(page.id));
		inputs = shown.flatMap((page) =>
			pageInputs(page, namesOf(page.id), `${page.id}@`, `${page.name}: `),
		);
	} else {
		const page = template.pages.find((item) => item.id === pageId) ?? template.pages[0];
		if (page) inputs = pageInputs(page, namesOf(page.id));
	}
	return { id: template.id, name: template.name, pageId, pages, flows, inputs };
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

/** Templates listed per call by the search box. Kalpana allows up to 100. */
const TEMPLATES_PAGE = 50;
/** Pages read for a dropdown of every template: up to 500 templates. */
const TEMPLATE_PAGES_MAX = 5;
const TEMPLATES_DROPDOWN_PAGE = 100;

const listTemplates = async (
	context: ILoadOptionsFunctions,
	qs: IDataObject,
): Promise<{ templates: TemplateListItem[]; total: number }> =>
	await kalpanaApiRequest(context, 'GET', '/templates', undefined, {
		workspace: (await keyWorkspace(context)).id,
		...qs,
	});

export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = paginationToken ? Number(paginationToken) : 1;
	const qs: IDataObject = { page, limit: TEMPLATES_PAGE };
	if (filter) qs.search = filter;
	const { templates, total } = await listTemplates(this, qs);
	return {
		results: templates.map((template) => ({
			name: `${template.name}${sizeLabel(template.width, template.height)}`,
			value: template.id,
		})),
		paginationToken: page * TEMPLATES_PAGE < total ? String(page + 1) : undefined,
	};
}

const chosenTemplate = (context: ILoadOptionsFunctions) =>
	(context.getNodeParameter('template', '', { extractValue: true }) as string) || '';

export async function getPages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const templateId = chosenTemplate(this);
	if (!templateId) return [];
	const { pages } = await templateInputs(this, { templateId });
	return pages.map((page, index) => ({ name: page.name || `Page ${index + 1}`, value: page.id }));
}

export async function getFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const templateId = chosenTemplate(this);
	if (!templateId) return [];
	const { flows } = await templateInputs(this, { templateId });
	return flows.map((flow) => ({ name: flow.name, value: flow.id }));
}

export async function getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const all: TemplateListItem[] = [];
	for (let page = 1; page <= TEMPLATE_PAGES_MAX; page++) {
		const { templates, total } = await listTemplates(this, {
			page,
			limit: TEMPLATES_DROPDOWN_PAGE,
		});
		all.push(...templates);
		if (!templates.length || all.length >= total) break;
	}
	return all.map((template) => ({
		name: `${template.name}${sizeLabel(template.width, template.height)}`,
		value: template.id,
	}));
}

/** One mapping field per layer a row can fill, keyed as `modifications` names it. */
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
		required: false,
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
