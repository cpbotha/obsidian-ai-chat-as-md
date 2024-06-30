// Obsidian AI Chat as Markdown copyright 2024 by Charl P. Botha <cpbotha@vxlabs.com>
import {
	type EmbedCache,
	type MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type Editor,
	type EditorPosition,
	type TFile,
} from "obsidian";

import OpenAI from "openai";

interface AIChatAsMDSettings {
	apiHost: string;
	openAIAPIKey: string;
	model: string;
	systemPrompt: string;
}

const DEFAULT_SETTINGS: AIChatAsMDSettings = {
	// openai: https://api.openai.com
	// openrouter: https://openrouter.ai/api
	apiHost: "https://api.openai.com",
	openAIAPIKey: "sk-xxxx",
	// openai: gpt-4o
	// openrouter: anthropic/claude-3.5-sonnet
	model: "gpt-4o",
	systemPrompt: `You are an AI assistant, outputting into an Obsidian markdown document. You have access to fenced codeblocks and MathJax notation. When responding:

1. Prioritize brevity and information density. Aim for concise, high-impact answers.
2. Use markdown formatting for text styling and organization, but avoid using # headings as your output could be streaming into a deeply nested part of the markdown document.
3. Use fenced codeblocks with language specification for any code snippets.
4. Use MathJax for math: inline $ Ax = b $ or block-level $$ E = mc^2 $$
5. Reference other document parts with [[internal links]].
6. Avoid unnecessary elaboration or examples unless specifically requested.
7. Use technical language and jargon appropriate to the topic, assuming user familiarity.
8. Provide direct answers without preamble or excessive context-setting.

Maintain a precise, informative tone. Focus on delivering maximum relevant information in minimum space.`,
};

// based on https://github.com/sissilab/obsidian-image-toolkit/issues/4#issuecomment-908898483
function imageToDataURL(imgSrc: string, maxEdge = 512) {
	return new Promise<{ dataURL: string; x: number; y: number }>(
		(resolve, reject) => {
			const image = new Image();
			image.crossOrigin = "anonymous";
			image.onload = () => {
				const dims = [image.width, image.height];
				const longestEdgeIndex = dims[0] > dims[1] ? 0 : 1;
				if (dims[longestEdgeIndex] > maxEdge) {
					const downscaleFactor = maxEdge / dims[longestEdgeIndex];
					for (let i = 0; i < 2; i++) {
						dims[i] = Math.round(dims[i] * downscaleFactor);
					}
					console.log(`resizing to ${dims[0]} x ${dims[1]}`);
				}
				const canvas = document.createElement("canvas");
				canvas.width = dims[0];
				canvas.height = dims[1];
				const ctx = canvas.getContext("2d");
				if (ctx === null) {
					reject("Could not get 2d context from canvas");
					return;
				}
				ctx.drawImage(image, 0, 0, dims[0], dims[1]);

				// toDataURL() returns e.g. data:image/png;base64,....
				// https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
				// we webp which should give smaller files for the same quality
				// https://developers.google.com/speed/webp/docs/webp_study
				const dataURL = canvas.toDataURL("image/webp");
				resolve({ dataURL, x: dims[0], y: dims[1] });
			};

			image.src = imgSrc;
		}
	);
}

// find current cursor position, determine its heading path, then convert that path into messages
// app needed for: metadataCache, vault
// editor needed for: getCursor, getLine, lastLine, getRange, etc.
async function convertToMessages(
	markdownFile: TFile,
	systemMessage: string,
	app: App,
	editor: Editor
) {
	const cache = app.metadataCache.getFileCache(markdownFile);
	if (!cache) return null;
	const headings = cache.headings || [];

	// find heading containing the cursor, and then the path of containing headings up the tree
	const headingPath = [];
	let currentHeading = null;
	for (let i = headings.length - 1; i >= 0; i--) {
		const heading = headings[i];
		if (currentHeading) {
			// we've already found currentHeading, containing the cursor
			// so here we're tracing the path from the cursor up to the topmost heading
			if (
				heading.position.start.line <
					currentHeading.position.start.line &&
				heading.level < currentHeading.level
			) {
				headingPath.unshift(i);
				currentHeading = heading;
			}
		} else {
			// we are still searching for the currentHeading (containing the cursor)
			if (heading.position.start.line <= editor.getCursor().line) {
				// ok we found the heading containing the cursor, start from here
				headingPath.unshift(i);
				currentHeading = heading;
			}
		}
	}

	if (!currentHeading) return null;

	const messages: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: systemMessage },
	];
	// we want to return the last rangeEnd, so that the calling code can move the cursor there
	let rangeEnd: EditorPosition = { line: 0, ch: 0 };
	let heading = null;
	// we want to find embeds in the range
	let rangeEndOffset = -1;
	for (const i of headingPath) {
		heading = headings[i];
		const nextHeading = headings[i + 1];
		if (nextHeading) {
			const line = nextHeading.position.start.line - 1;
			rangeEnd = {
				line: line,
				ch: editor.getLine(line).length,
			};
			rangeEndOffset = nextHeading.position.start.offset - 1;
		} else {
			// this is the last heading, so we have to use end of file
			const lastLine = editor.lastLine();
			rangeEnd = {
				line: lastLine,
				ch: editor.getLine(lastLine).length,
			};
			rangeEndOffset = editor.getValue().length;
		}

		const uHeading = heading.heading.toUpperCase();
		const role =
			uHeading.startsWith("AI") || uHeading.startsWith("ASSISTANT")
				? "assistant"
				: "user";

		if (role === "assistant") {
			// assistant can only have content as a single string!
			const m = editor.getRange(
				{ line: heading.position.end.line + 1, ch: 0 },
				rangeEnd
			);
			messages.push({ role: role, content: m });
		} else {
			// user message, so we do multi-part
			let currentStart = heading.position.end.offset + 1;

			const parts = [];

			const embeds = cache.embeds || [];

			let embed: EmbedCache | null = null;
			for (embed of embeds) {
				if (
					embed.position.start.offset > heading.position.end.offset &&
					embed.position.end.offset < rangeEndOffset
				) {
					if (embed.position.start.offset > currentStart) {
						// this means there's text before the embed, let's add it
						// EditorPosition has ch and line
						// however, note that CM6 prefers offsets to the old CM5 line-ch pairs: https://codemirror.net/docs/migration/#positions
						// fortunately, Obsidian's Editor abstraction offers posToOffset and offsetToPos
						parts.push({
							type: "text",
							text: editor
								.getRange(
									editor.offsetToPos(currentStart),
									editor.offsetToPos(
										embed.position.start.offset
									)
								)
								.trim(),
						});
					}
					// TODO: check that the embed is an image / other processable type
					parts.push({
						type: "embed",
						embed,
					});
					currentStart = embed.position.end.offset;
				}
			}

			// take care of last bit of text
			if (rangeEndOffset > currentStart) {
				parts.push({
					type: "text",
					text: editor
						.getRange(
							editor.offsetToPos(currentStart),
							editor.offsetToPos(rangeEndOffset)
						)
						.trim(),
				});
			}

			const contentParts: Array<OpenAI.ChatCompletionContentPart> = [];
			for (const part of parts) {
				if (part.type === "text" && part.text) {
					contentParts.push(part as OpenAI.ChatCompletionContentPart);
				} else if (part.type === "embed" && part.embed?.link) {
					const f = app.vault.getFileByPath(part.embed.link);
					if (f) {
						try {
							// claude sonnet 3.5 image sizes: https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
							// longest edge should be < 1568
							// openai gpt-4o
							// we need either < 512x512 or < 2000x768 (low or high fidelity)
							const { dataURL, x, y } = await imageToDataURL(
								app.vault.getResourcePath(f),
								1568
							);

							// DEBUG: show image in the console -- working on 2024-06-27
							// console.log(
							// 	"%c ",
							// 	`font-size:1px; padding: ${x}px ${y}px; background:url(${dataURL}) no-repeat; background-size: contain;`
							// );

							// console.log(dataURL);

							console.log(
								`Adding image "${part.embed.link}" at size ${x}x${y} to messages.`
							);
							contentParts.push({
								type: "image_url",
								image_url: {
									url: dataURL,
								},
							});
						} catch (e) {
							console.error("Error copying image", f, e);
						}
					}
				}
			}

			messages.push({
				role: role,
				content: contentParts,
			});
		}
	}

	if (!heading) {
		console.error("Unexpected that we have no last heading here.");
		return null;
	}

	return { messages, heading, rangeEnd };
}

// replace range, but also move cursor ahead to be located right after the inserted multi-line text
function replaceRangeMoveCursor(editor: Editor, text: string) {
	const cursor = editor.getCursor();
	editor.replaceRange(text, cursor);
	const lines = text.split("\n");
	editor.setCursor({
		line: cursor.line + lines.length - 1,
		// if only one line, we have to add the new text length to existing
		// if more than one line, then the final line determines the ch position
		ch:
			(lines.length === 1 ? cursor.ch : 0) +
			lines[lines.length - 1].length,
	});
}

export default class MyPlugin extends Plugin {
	settings: AIChatAsMDSettings;

	async onload() {
		await this.loadSettings();

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("AICM: AI Chat as MD loaded.");

		this.addCommand({
			id: "ai-chat-complete",
			name: "Send current thread to AI",
			// https://docs.obsidian.md/Plugins/User+interface/Commands#Editor+commands
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const markdownFile = view.file;
				if (!markdownFile) {
					new Notice("No markdown file open");
					return;
				}
				const mhe = await convertToMessages(
					markdownFile,
					this.settings.systemPrompt,
					this.app,
					editor
				);
				if (!mhe) {
					new Notice("No headings found");
					return;
				}

				editor.setCursor(mhe.rangeEnd);
				// create heading that's one level deeper than the one we are replying to
				const aiLevel = mhe.heading.level + 1;
				const aiHeading = `\n\n${"#".repeat(aiLevel)} AI\n`;

				replaceRangeMoveCursor(editor, aiHeading);

				//console.log("DEBUG:", mhe.messages);
				console.log(
					`About to send ${mhe.messages.length} messages to AI.`
				);
				const stream = await this.getOpenAIStream(mhe.messages);
				statusBarItemEl.setText("AICM streaming...");
				for await (const chunk of stream) {
					const content = chunk.choices[0]?.delta?.content || "";
					replaceRangeMoveCursor(editor, content);
					if (chunk.usage) {
						console.log("OpenAI API usage:", chunk.usage);
					}
				}
				statusBarItemEl.setText("AICM done.");

				// BUG: on iPhone, this sometimes starts before the last 2 or 3 characters of AI message
				const userHeading = `\n\n${"#".repeat(aiLevel + 1)} User\n`;
				replaceRangeMoveCursor(editor, userHeading);
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new AIChatAsMDSettingsTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async getOpenAI() {
		const openai = new OpenAI({
			// "https://openrouter.ai/api/v1" or "https://api.openai.com/v1"
			baseURL: `${this.settings.apiHost}/v1`,
			apiKey: this.settings.openAIAPIKey,
			defaultHeaders: {
				"HTTP-Referer":
					"https://github.com/cpbotha/obsidian-ai-chat-as-md", // Optional, for including your app on openrouter.ai rankings.
				"X-Title": "Obsidian AI Chat as Markdown", // Optional. Shows in rankings on openrouter.ai.
			},
			// we are running in a browser environment, but we are using obsidian settings to get keys, so we can enable this
			dangerouslyAllowBrowser: true,
		});

		return openai;
	}

	async getOpenAIStream(messages: OpenAI.ChatCompletionMessageParam[]) {
		const openai = await this.getOpenAI();

		return openai.chat.completions.create({
			model: this.settings.model,
			messages: messages,
			stream: true,
		});
	}
}

class AIChatAsMDSettingsTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("API host")
			.setDesc(
				"OpenAI-style API host, e.g. https://api.openai.com or https://openrouter.ai/api"
			)
			.addText((text) =>
				text
					.setPlaceholder(
						"Enter the API host, e.g. https://api.openai.com"
					)
					.setValue("https://openrouter.ai/api")
					.onChange(async (value) => {
						this.plugin.settings.apiHost = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Usually of the form sk-xxxx")
			.addText((text) =>
				text
					.setPlaceholder("Enter your secret")
					.setValue(this.plugin.settings.openAIAPIKey)
					.onChange(async (value) => {
						this.plugin.settings.openAIAPIKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model name")
			.setDesc(
				"E.g. gpt-4o for OpenAI or anthropic/claude-3.5-sonnet for OpenRouter"
			)
			.addText((text) =>
				text
					.setPlaceholder("gpt-4o")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("System Prompt")
			.addTextArea((textArea) =>
				textArea
					.setPlaceholder("Enter the system prompt")
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
