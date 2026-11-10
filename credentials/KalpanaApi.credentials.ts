import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class KalpanaApi implements ICredentialType {
	name = 'kalpanaApi';

	displayName = 'Kalpana API';

	icon: Icon = {
		light: 'file:../nodes/Kalpana/kalpana.svg',
		dark: 'file:../nodes/Kalpana/kalpana.dark.svg',
	};

	documentationUrl = 'https://docs.kalpana.one/api-reference/getting-started/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A key from Organization > API keys in Kalpana. It starts with sk- and works in the one workspace it was made for.',
		},
		{
			displayName: 'Kalpana URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.kalpana.one',
			description: 'Leave as it is unless Kalpana support gives you another address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-api-key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}/api',
			url: '/workspaces',
			method: 'GET',
		},
	};
}
