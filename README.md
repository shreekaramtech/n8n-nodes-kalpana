# @kalpana-one/n8n-nodes-kalpana

This is an n8n community node. It lets you use [Kalpana](https://kalpana.one) in your n8n workflows.

Kalpana turns a design into a reusable template, then fills it with your data to make finished images and videos: product ads, listing images, event badges, social posts. With this node, any workflow can make a creative the moment something happens (a new order, a form reply, a new product) or turn a whole list into a batch, then send the files on.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `@kalpana-one/n8n-nodes-kalpana`.

## Operations

### Kalpana

**Creative**

- **Create**: fill a template with one item's data and render it. Each input item makes one creative. The node waits for the file and adds it to the item as binary data, so the next node can email, post or store it. Image fields accept a web address, a file name from your Kalpana images, or an image ID.
- **Get**: get a creative's status and file by its job ID, for a creative created without waiting.

**Batch**

- **Create**: make one batch with a row for every input item, for example every row of a sheet. It can start rendering at once or stay a draft to check in Kalpana first. Lists over 1,000 rows become several batches.
- **Get**: get a batch's progress.
- **Get Files**: get the files a batch rendered, one item per file, optionally as binary data.
- **Render**: start rendering a draft batch.

**Image**

- **Upload**: add an image to the workspace from a file in the workflow or a web address. The output's `image` value goes straight into a template's image field.

The node can also be used as a tool by n8n's AI Agent.

### Kalpana Trigger

Starts a workflow when:

- **Creative Rendered**: one creative has rendered, from a batch or on its own. It can add the file to the item as binary data.
- **Batch Finished**: every row of a batch run has rendered, failed or been cancelled.

Events can be limited to chosen templates. Each delivery is checked against its `Kalpana-Signature`, and unsigned or altered requests are refused.

## Credentials

You need a Kalpana account ([sign up free](https://app.kalpana.one/signup)) and an API key.

1. In Kalpana, open **Organization > API keys** and choose **Create key**.
2. Pick the workspace the workflows will use. A key works in one workspace.
3. Give the key this access:
   - **Templates**: Read
   - **Creatives**: Read
   - **Assets**: Write, to upload images or use image addresses
   - **Batches**: Write
   - **Renders**: Write
   - **Webhooks**: Write, for the Kalpana Trigger
4. Copy the key (it starts with `sk-` and is shown once) into the **Kalpana API** credential in n8n.

Rendering spends the workspace's credits. The Kalpana Trigger needs a workspace on a paid plan.

## Compatibility

Built with `@n8n/node-cli` 0.54 and `n8n-workflow` 2.45. Checked on n8n 2.35.7.

## Usage

**Picking the template.** Choose a template from the list, then a page or a flow. A page renders as an image, or as a video when the page has motion. A flow is a video that joins several pages with transitions. The **Inputs** list then shows the template's text and image layers. Map each one to a field of the incoming item, or switch to **Map Automatically** when the item's field names match the layer names. A field left empty keeps the template's own content.

**Images from the web.** An image field given an address (`https://...`) is imported into the workspace before rendering. The address's domain must be on the workspace's whitelist, under **Workspace Settings > Domain Whitelisting** (`cdn.shopify.com` is there by default). For files that are not online, use **Image > Upload** first.

**Waiting.** **Creative > Create** saves the job, starts it and waits for the file. Most images come back in the same call. Longer renders, such as videos, are checked every 5 seconds for up to 10 minutes by default (change it under **Options > Timeout**). If the connection drops while it waits, the node asks again about the same job, so it never renders or charges twice. To skip waiting, turn off **Wait for File**: the render starts and the node returns the job ID at once, and the Kalpana Trigger or **Creative > Get** collects the file.

**Errors and retries.** An error after the job was made names its job ID, so the file can still be collected with **Creative > Get**. n8n's **Retry On Fail** runs the node again from the start and makes a new job, so a retry after a render that did start can render and charge again.

**Animated templates as images.** An image of an animated page shows one moment of its motion: the moment the designer chose, or the last frame. Set **Options > Still Time** to pick another.

**Example workflows**

- New Shopify product → Kalpana: Create creative (product photo and price) → Google Drive: upload file
- Google Sheets: get rows → Kalpana: Create batch → Kalpana Trigger (Batch Finished) → Kalpana: Get batch files → Slack: send files
- Form submission → Kalpana: Create creative (name and photo on an event badge) → Gmail: send with attachment

## Development

This package uses pnpm.

```bash
pnpm install
pnpm run lint
pnpm run build
pnpm run dev
```

`pnpm run dev` starts the latest n8n at http://localhost:5678 with this package linked, and needs Node.js 24. Releases are published by the `Publish` GitHub workflow when a version tag is pushed, with npm provenance, as n8n requires for verified nodes.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Kalpana API reference](https://docs.kalpana.one/api-reference)
- [Kalpana webhooks](https://docs.kalpana.one/api-reference/webhooks/receiving)
- Support: support@kalpana.one

## Version history

### 0.1.0

First release: Creative (Create, Get), Batch (Create, Get, Get Files, Render), Image (Upload) and the Kalpana Trigger (Creative Rendered, Batch Finished).
