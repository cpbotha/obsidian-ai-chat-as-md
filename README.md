# Obsidian plugin: AI Chat as Markdown

AI Chat as Markdown lets GPT-4 Omni / Claude 3.5 talk directly into your Obsidian Markdown notes.

It relies on nesting of headings, and thus you can have multiple conversations and even branching conversations in the same note.

Please see [the documented branching conversation example](https://github.com/cpbotha/obsidian-ai-chat-as-md/blob/master/docs/example_nesting.md) to understand how that works.

The plugin supports images, so that you can talk about the images and diagrams that are embedded in your markdown, with models that support this, such os Omni and Claude 3.5.

It can be configured via the Obsidian plugin settings to use any OpenAI-compatible API server.

## Demos

- [Desktop first demo](https://youtu.be/_079Pi6UvgM?si=AJlnYs55XfYc4E5T)
- [iPhone first demo](https://youtu.be/ZkXqeaQJAFw?si=Bbj_Wnf8F_Sy714O)

## Screenshots and examples

Please go to the dedicated [screenshots page](./screenshots/screenshots.md)

## Features

- Multiple branching chats as nested headings anywhere in your notes, see [nesting example](./docs/example_nesting.md)
- Optionally configure different AI models for each markdown file via the frontmatter, e.g. `aicmd-model: perplexity/sonar`. For that file, that will override the conventional plugin config
- Render citations as returned by some search-integrated models like Perplexity's Sonar range.
- Generate and edit images from within your markdown documents. See [screenshots](./screenshots/screenshots.md)
- Use markdown files as system prompts. Use this for example to build up a library of system prompts for different applications.
- Optionally configure a different system prompt file for each note via the frontmatter, e.g. `aicmd-system-prompt-file: ai-chats/system prompt productivity.md`
- Use Obsidian embeds to construct modular and dynamic system prompts, see [screenshots](./screenshots/screenshots.md)

## Quickstart

- [Install plugin via community plugins](https://obsidian.md/plugins?id=ai-chat-as-md)
- In Obsidian settings, under `AI Chat as Markdown` configure API Host (e.g. `https://api.openai.com/`), API key (`sk-xxxxx`), model name (e.g. `gpt-4o`)
- In your Obsidian note, add example text `# My heading\nAre you there?`, position cursor inside, then, **in edit mode**, invoke via command palette `AI Chat as Markdown: Send current thread to AI`. Answer should appear under new sub-heading titled `## AI`.
  - You could also just select some text, and then invoke `AI Chat as Markdown: Send selected text to AI and append the response`.

## Manually installing the plugin

- Copy over `main.js`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Inspired by

- [gptel LLM client for Emacs](https://github.com/karthink/gptel), and especially its branching context feature
- [ChatGPT-MD Obsidian plugin](https://github.com/bramses/chatgpt-md), but I preferred to use the official OpenAI nodejs library and to use the gptel-style nested heading approach

## Dev quickstart

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `corepack enable`
- `yarn` to install dependencies (we use Yarn PnP)
- `yarn run dev` to start compilation in watch mode.

## Dev Tasks

- [X] support Obsidian embeds (aka transclusion) so that system prompts can be enriched with additional notes (planned for 1.5.0)
- [X] Send embedded images to the model
- [X] settings for default model, key, etc.
- [X] setup yarn PnP style packages
- [X] Add README section explaining the nesting to conversation algorithm
- [X] Make debug mode configurable, then feature-flag logging behind that

### Maybe

- [ ] implement user-friendly file selector for the system prompt file setting
- [X] enable per-document / yaml-header overrides of model, system prompt, etc.
- [X] Optionally add used model to each AI heading
- [ ] ignore `%...%` comment blocks

## Dev publish new version

See [Create a new release](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin#Step+2+Create+a+release)

- Update [manifest.json](./manifest.json) and [CHANGELOG.md](./manifest.json).
- `yarn run build`

- Create [new github release](https://github.com/cpbotha/obsidian-ai-chat-as-md/releases) and tag with e.g. 1.1.5
  - Upload the freshly built `main.js` and updated `manifest.json` as binary attachments.
