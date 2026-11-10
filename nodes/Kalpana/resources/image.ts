import { createHash } from 'crypto';
import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { RowBuilder } from '../shared/rows';
import { kalpanaApiRequest } from '../shared/transport';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export const imageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['image'] } },
		options: [
			{
				name: 'Upload',
				value: 'upload',
				description: 'Add an image to the workspace, for templates’ image inputs',
				action: 'Upload image',
			},
		],
		default: 'upload',
	},
];

const show = { resource: ['image'], operation: ['upload'] };

export const imageFields: INodeProperties[] = [
	{
		displayName: 'Source',
		name: 'source',
		type: 'options',
		noDataExpression: true,
		default: 'binary',
		displayOptions: { show },
		options: [
			{
				name: 'File',
				value: 'binary',
				description: 'An image file from an earlier node, such as a download or a form upload',
			},
			{
				name: 'URL',
				value: 'url',
				description: 'An image on the web, from a domain on the workspace’s whitelist',
			},
		],
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryProperty',
		type: 'string',
		required: true,
		default: 'data',
		description: 'The name of the binary field that holds the image (PNG, JPEG or WebP)',
		displayOptions: { show: { ...show, source: ['binary'] } },
	},
	{
		displayName: 'Image URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://cdn.shopify.com/s/files/product.jpg',
		description:
			'A public image address. Its domain must be on the workspace’s whitelist, under Workspace Settings > Domain Whitelisting.',
		displayOptions: { show: { ...show, source: ['url'] } },
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. red-sneaker.jpg',
		description:
			'The name the image gets in Kalpana. Leave empty to keep the file’s or the address’s own name.',
		displayOptions: { show },
	},
];

export async function uploadImage(
	this: IExecuteFunctions,
	itemIndex: number,
	rows: RowBuilder,
): Promise<INodeExecutionData> {
	const source = this.getNodeParameter('source', itemIndex) as string;
	const fileName = (this.getNodeParameter('fileName', itemIndex, '') as string).trim();
	const workspaceId = await rows.workspace();

	if (source === 'url') {
		const url = (this.getNodeParameter('url', itemIndex) as string).trim();
		const body: Record<string, string> = { workspaceId, url };
		if (fileName) body.filename = fileName;
		const asset = await kalpanaApiRequest<{ id: string; filename: string | null }>(
			this,
			'POST',
			'/assets/from-url',
			body,
			undefined,
			itemIndex,
		);
		return {
			json: { image: asset.id, fileName: asset.filename },
			pairedItem: { item: itemIndex },
		};
	}

	const field = this.getNodeParameter('binaryProperty', itemIndex) as string;
	const binary = this.helpers.assertBinaryData(itemIndex, field);
	if (!IMAGE_TYPES.includes(binary.mimeType)) {
		throw new NodeOperationError(
			this.getNode(),
			`The file is ${binary.mimeType}, not an image Kalpana takes`,
			{
				itemIndex,
				description: 'Upload a PNG, JPEG or WebP image',
			},
		);
	}
	const data = await this.helpers.getBinaryDataBuffer(itemIndex, field);
	const contentHash = createHash('sha256').update(data).digest('hex');
	const name =
		fileName || binary.fileName || `${contentHash.slice(0, 12)}.${binary.fileExtension ?? 'png'}`;

	// Kalpana hands out a signed address per new file; a file the workspace
	// already holds gets none and is only recorded.
	const { uploads } = await kalpanaApiRequest<{
		uploads: { contentHash: string; uploadUrl: string | null }[];
	}>(
		this,
		'POST',
		'/assets/uploads',
		{
			workspaceId,
			files: [{ contentHash, contentType: binary.mimeType, sizeBytes: data.length }],
		},
		undefined,
		itemIndex,
	);
	const uploadUrl = uploads[0]?.uploadUrl;
	if (uploadUrl) {
		await this.helpers.httpRequest({
			method: 'PUT',
			url: uploadUrl,
			body: data,
			headers: { 'Content-Type': binary.mimeType },
			json: false,
		});
	}
	const { assets, failed } = await kalpanaApiRequest<{
		assets: { id: string; filename: string | null }[];
		failed: { contentHash: string; message: string }[];
	}>(
		this,
		'POST',
		'/assets/uploads/complete',
		{ workspaceId, files: [{ contentHash, filename: name }] },
		undefined,
		itemIndex,
	);
	const [asset] = assets;
	if (!asset) {
		throw new NodeOperationError(
			this.getNode(),
			failed[0]?.message ?? 'Kalpana did not record the image',
			{
				itemIndex,
			},
		);
	}
	return {
		json: { image: asset.id, fileName: asset.filename ?? name },
		pairedItem: { item: itemIndex },
	};
}
