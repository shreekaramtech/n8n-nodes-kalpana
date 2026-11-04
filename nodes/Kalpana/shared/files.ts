import type { IBinaryKeyData, IExecuteFunctions, IWebhookFunctions } from 'n8n-workflow';

/** Downloads a rendered file from its signed link into an item's binary data. */
export const downloadFile = async (
	context: IExecuteFunctions | IWebhookFunctions,
	url: string,
	fileName: string,
	contentType: string,
	binaryProperty: string,
): Promise<IBinaryKeyData> => {
	const data = (await context.helpers.httpRequest({
		method: 'GET',
		url,
		encoding: 'arraybuffer',
		json: false,
	})) as ArrayBuffer;
	return {
		[binaryProperty]: await context.helpers.prepareBinaryData(
			Buffer.from(data),
			fileName,
			contentType || undefined,
		),
	};
};
