import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	batchFields,
	batchOperations,
	createBatches,
	getBatch,
	getBatchFiles,
	renderBatch,
} from './resources/batch';
import {
	createCreative,
	creativeFields,
	creativeOperations,
	getCreative,
} from './resources/creative';
import { imageFields, imageOperations, uploadImage } from './resources/image';
import { RowBuilder } from './shared/rows';
import { getFlows, getPages, getTemplateFields, searchTemplates } from './shared/templates';
import { nodeError } from './shared/transport';

export class Kalpana implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Kalpana',
		name: 'kalpana',
		icon: { light: 'file:kalpana.svg', dark: 'file:kalpana.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Fill Kalpana templates with data and render images and videos',
		defaults: { name: 'Kalpana' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'kalpanaApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Batch', value: 'batch' },
					{ name: 'Creative', value: 'creative' },
					{ name: 'Image', value: 'image' },
				],
				default: 'creative',
			},
			...creativeOperations,
			...creativeFields,
			...batchOperations,
			...batchFields,
			...imageOperations,
			...imageFields,
		],
	};

	methods = {
		listSearch: { searchTemplates },
		loadOptions: { getPages, getFlows },
		resourceMapping: { getTemplateFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const rows = new RowBuilder(this);

		// A batch takes every item at once: one row each.
		if (resource === 'batch' && operation === 'create') {
			try {
				return [await createBatches.call(this, rows)];
			} catch (error) {
				if (this.continueOnFail()) {
					return [[{ json: { error: (error as Error).message }, pairedItem: { item: 0 } }]];
				}
				throw nodeError(this.getNode(), error);
			}
		}

		const returnData: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'creative' && operation === 'create') {
					returnData.push(await createCreative.call(this, i, rows));
				} else if (resource === 'creative' && operation === 'get') {
					returnData.push(await getCreative.call(this, i));
				} else if (resource === 'batch' && operation === 'get') {
					returnData.push(...(await getBatch.call(this, i)));
				} else if (resource === 'batch' && operation === 'render') {
					returnData.push(...(await renderBatch.call(this, i)));
				} else if (resource === 'batch' && operation === 'getFiles') {
					returnData.push(...(await getBatchFiles.call(this, i)));
				} else if (resource === 'image' && operation === 'upload') {
					returnData.push(await uploadImage.call(this, i, rows));
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not known for "${resource}"`,
						{ itemIndex: i },
					);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					// The description names the job when one was made, to collect it later.
					const { message, description } = error as { message: string; description?: string };
					returnData.push({
						json: description ? { error: message, description } : { error: message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw nodeError(this.getNode(), error, i);
			}
		}
		return [returnData];
	}
}
