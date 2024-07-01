# Obsidian plugin: AI Chat as Markdown

AI Chat as Markdown lets GPT-4 Omni / Claude 3.5 talk directly into your Obsidian Markdown notes.

It relies on nesting of headings, and thus you can have multiple conversations and even branching conversations in the same note.

Please see [the documented branching conversation example](./docs/example_nesting.md) to understand how that works.

The plugin supports images, so that you can talk about the images and diagrams that are embedded in your markdown, with models that support this, such os Omni and Claude 3.5.

It can be configured via the Obsidian plugin settings to use any OpenAI-compatible API server.

As of 2024-06-29 this plugin is heavy WIP, but it should be usable.

## Demos

- [Desktop first demo](https://youtu.be/_079Pi6UvgM?si=AJlnYs55XfYc4E5T)
- [iPhone first demo](https://youtu.be/ZkXqeaQJAFw?si=Bbj_Wnf8F_Sy714O)

## Manually installing the plugin

- Copy over `main.js`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Dev quickstart

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `corepack enable`
- `yarn` to install dependencies (we use Yarn PnP)
- `yarn run dev` to start compilation in watch mode.

## Dev Tasks

- [X] Send embedded images to the model
- [X] settings for default model, key, etc.
- [X] setup yarn PnP style packages
- [ ] Add README section explaining the nesting to conversation algorithm
- [ ] Make debug mode configurable, then feature-flag logging behind that

### Maybe

- [ ] enable per-document / yaml-header overrides of model, system prompt, etc.
- [ ] ignore `%...%` comment blocks
- [ ] Add used model as comment block (or some other mechanism) to each AI response section

## Dev publish new version

See [Create a new release](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin#Step+2+Create+a+release)

- Update [manifest.json](./manifest.json) and [CHANGELOG.md](./manifest.json).
- `yarn run build`

- Create [new github release](https://github.com/cpbotha/obsidian-ai-chat-as-md/releases) and tag with e.g. 1.1.5
  - Upload the freshly built `main.js` and updated `manifest.json` as binary attachments.
