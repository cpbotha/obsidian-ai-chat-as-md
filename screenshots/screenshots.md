# AI Chat as Markdown screenshots

## Citation support

Some models like the Perplexity Sonar range have built-in grounding with web search results. When it notices this, the plugin will render the citations list after the AI answer.

Here I am using `perplexity/sonar` via [OpenRouter](https://openrouter.ai/).

![screenshot showing perplexity sonar citations list](./obsidian-ai-chat-as-md-perplexity-sonar-citations-20250402.png)

## Image generation and editing

Configure the plugin with a separate OpenAI API key for image generation and you'll be able to use OpenAI's `gpt-image-1` for conversational image generation and editing.

This function, `AI Chat as Markdown: Generate or edit images`, only sends the section containing your cursor, including any images you embed in that section. If there are no images and only text in the current section, it will request a text-to-image generation. If there are images, it will request an edit based on your prompt.

You can easily add text to the new section created by the AI generation / edit, and continue with more edits. This works with generated images, but of course any other images that you insert.

> [!NOTE]
> At the time of writing (2025-05-05) an image generation or edit easily takes up to a minute.

![screenshot showing image generation demo](./obsidian-ai-chat-as-md-image-gen-espresso.png)

## Markdown files as system prompts

Here we've added a special "Memories and facts" section to the system prompt markdown file:

![Screenshot showing file as system prompt with memories](./obsidian-ai-chat-as-md-file-as-system-prompt.png)

Please see the [example system prompt markdown file](./docs/example_system_prompt.md).

## Modular system prompts

Since the 1.5.0 version of the plugin, it supports one level of transclusion / embeds (use `![[my other file]]` in obsidian) in your conversations, but also in your system prompt files!

Here is an example of a modular system prompt where the core prompt is embedded, as well as memories and facts but also two files that change over time: My Emacs org-mode agenda, and my weekly Kanban which is just a markdown file thanks to [the Obsidian Kanban plugin](https://github.com/mgmeyers/obsidian-kanban):
![modular system prompt thanks to obsidian embed support](./obsidian-ai-chat-as-md-modular-system-prompt.png)

In the following example chat, you can see how it has accessed "live" data from my agenda to help me plan my activities:
![ai recommends which activities I can tackle](./obsidian-ai-chat-as-md-test-sysprompt-agenda-kanban.png)

You can optionally configure a system prompt file in the frontmatter with the `aicmd-system-prompt-file` variable. This means you can easily setup different (modular) prompts for different notes.

## Locally configure used model in the frontmatter

You can make local changes to the currently used AI model by setting an optional property in the frontmatter. Here I've used it to test both GPT-4o Mini and Claude 3.5 Sonnet on the same stupid question. In this case, I have enabled the optional `Show used model` which will add the used model to each AI heading as a DataView-style hidden inline field.

![Screenshot showing two models answering the same question](./obsidian-ai-chat-as-md-frontmatter-model.png)
