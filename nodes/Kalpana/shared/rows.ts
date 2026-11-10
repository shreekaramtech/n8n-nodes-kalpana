import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import type { RenderTarget, TemplateInputs } from './templates';
import { templateInputs } from './templates';
import { kalpanaApiRequest, keyWorkspace } from './transport';

const URL_VALUE = /^https?:\/\//i;

/**
 * Turns mapped field values into Kalpana rows. Image fields given a web
 * address are imported into the workspace first, since rows take an image's
 * id or file name. One instance per execution, so each template's inputs
 * load once and each address imports once.
 */
export class RowBuilder {
	private readonly inputs = new Map<string, Promise<TemplateInputs>>();

	private readonly imported = new Map<string, Promise<string>>();

	private workspaceId?: Promise<string>;

	constructor(private readonly context: IExecuteFunctions) {}

	template(target: RenderTarget, itemIndex: number) {
		const cacheKey = `${target.templateId}:${target.pageId ?? ''}:${target.flowId ?? ''}`;
		let inputs = this.inputs.get(cacheKey);
		if (!inputs) {
			inputs = this.workspace().then(
				async (workspace) => await templateInputs(this.context, target, workspace, itemIndex),
			);
			this.inputs.set(cacheKey, inputs);
		}
		return inputs;
	}

	async row(target: RenderTarget, itemIndex: number): Promise<IDataObject> {
		const mapped = (this.context.getNodeParameter('inputs.value', itemIndex, {}) ??
			{}) as IDataObject;
		const { inputs } = await this.template(target, itemIndex);
		const images = new Set(inputs.filter((i) => i.type === 'image').map((i) => i.key));
		const row: IDataObject = {};
		for (const [key, raw] of Object.entries(mapped)) {
			// An empty field keeps the template's own text or image.
			if (raw === null || raw === undefined || raw === '') continue;
			const value = typeof raw === 'string' ? raw : String(raw);
			row[key] =
				images.has(key) && URL_VALUE.test(value.trim())
					? await this.importImage(value.trim(), itemIndex)
					: value;
		}
		return row;
	}

	private importImage(url: string, itemIndex: number) {
		let id = this.imported.get(url);
		if (!id) {
			id = this.workspace().then(async (workspaceId) => {
				const asset = await kalpanaApiRequest<{ id: string }>(
					this.context,
					'POST',
					'/assets/from-url',
					{ workspaceId, url },
					undefined,
					itemIndex,
				);
				return asset.id;
			});
			this.imported.set(url, id);
		}
		return id;
	}

	workspace() {
		this.workspaceId ??= keyWorkspace(this.context).then((workspace) => workspace.id);
		return this.workspaceId;
	}
}
