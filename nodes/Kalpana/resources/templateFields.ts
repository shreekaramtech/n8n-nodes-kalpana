import type { INodeProperties } from 'n8n-workflow';

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];

export const isVideoFormat = (format: string) => !IMAGE_FORMATS.includes(format);

/** Template, page or flow, the inputs to fill and the file format. */
export const templateFields = (resource: string, operation: string): INodeProperties[] => {
	const show = { resource: [resource], operation: [operation] };
	return [
		{
			displayName: 'Template',
			name: 'template',
			type: 'resourceLocator',
			default: { mode: 'list', value: '' },
			required: true,
			description: 'The Kalpana template to fill',
			displayOptions: { show },
			modes: [
				{
					displayName: 'From List',
					name: 'list',
					type: 'list',
					typeOptions: { searchListMethod: 'searchTemplates', searchable: true },
				},
				{
					displayName: 'ID',
					name: 'id',
					type: 'string',
					placeholder: 'e.g. 0192f8a4-6c1e-7c3a-9b0e-4d2f1a7e5c11',
				},
			],
		},
		{
			displayName: 'Render',
			name: 'renderAs',
			type: 'options',
			noDataExpression: true,
			default: 'page',
			displayOptions: { show },
			options: [
				{
					name: 'A Page',
					value: 'page',
					description: 'One page of the template, as an image or, with its motion, as a video',
				},
				{
					name: 'A Flow',
					value: 'flow',
					description: 'A video that joins some of the template’s pages with transitions',
				},
			],
		},
		{
			displayName: 'Page Name or ID',
			name: 'page',
			type: 'options',
			default: '',
			description:
				'The page to render. Leave empty for the first page. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			typeOptions: { loadOptionsMethod: 'getPages', loadOptionsDependsOn: ['template.value'] },
			displayOptions: { show: { ...show, renderAs: ['page'] } },
		},
		{
			displayName: 'Flow Name or ID',
			name: 'flow',
			type: 'options',
			default: '',
			required: true,
			description:
				'The flow to render as a video. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			typeOptions: { loadOptionsMethod: 'getFlows', loadOptionsDependsOn: ['template.value'] },
			displayOptions: { show: { ...show, renderAs: ['flow'] } },
		},
		{
			displayName: 'Inputs',
			name: 'inputs',
			type: 'resourceMapper',
			noDataExpression: true,
			default: { mappingMode: 'defineBelow', value: null },
			required: true,
			description:
				'The text and images to put in the template. A field left empty keeps the template’s own content.',
			displayOptions: { show },
			typeOptions: {
				loadOptionsDependsOn: ['template.value', 'renderAs', 'page', 'flow'],
				resourceMapper: {
					resourceMapperMethod: 'getTemplateFields',
					hideNoDataError: true,
					mode: 'add',
					fieldWords: { singular: 'input', plural: 'inputs' },
					addAllFields: true,
					multiKeyMatch: false,
					supportAutoMap: true,
				},
			},
		},
		{
			displayName: 'Format',
			name: 'outputFormat',
			type: 'options',
			default: 'png',
			description: 'Images render one moment of a page. Videos need motion or a flow.',
			displayOptions: { show },
			options: [
				{ name: 'GIF (Video)', value: 'gif' },
				{ name: 'JPEG', value: 'jpeg' },
				{ name: 'MP4 (Video)', value: 'mp4' },
				{ name: 'PNG', value: 'png' },
				{ name: 'WebP', value: 'webp' },
			],
		},
	];
};
