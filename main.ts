// Obsidian AI Chat as Markdown copyright 2024 by Charl P. Botha <cpbotha@vxlabs.com>
import {
	type App,
	type Editor,
	type EditorPosition,
	type EmbedCache,
	type MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type TFile,
	type TextAreaComponent,
	type Vault,
} from "obsidian";

import OpenAI from "openai";

interface AIChatAsMDSettings {
	apiHost: string;
	openAIAPIKey: string;
	model: string;
	systemPrompt: string;
	systemPromptFile: string;
	showUsedModel: boolean;
	debug: boolean;
}

const DEFAULT_SETTINGS: AIChatAsMDSettings = {
	// openai: https://api.openai.com
	// openrouter: https://openrouter.ai/api
	apiHost: "https://api.openai.com",
	openAIAPIKey: "",
	// openai: gpt-4o
	// openrouter: anthropic/claude-3.5-sonnet
	model: "gpt-4o",
	systemPrompt: `You are an AI assistant, outputting into an Obsidian markdown document. You have access to fenced codeblocks and MathJax notation. When responding:

1. Prioritize brevity and information density. Aim for concise, high-impact answers.
2. Use markdown formatting for text styling and organization, but avoid using # headings as your output could be streaming into a deeply nested part of the markdown document.
3. Use fenced codeblocks with language specification for any code snippets.
4. Use MathJax for math: inline $ Ax = b $ or block-level $$ E = mc^2 $$
5. Avoid unnecessary elaboration or examples unless specifically requested.
6. Use technical language and jargon appropriate to the topic, assuming user familiarity.
7. Provide direct answers without preamble or excessive context-setting.

Maintain a precise, informative tone. Focus on delivering maximum relevant information in minimum space.`,
	systemPromptFile: "",
	showUsedModel: false,
	debug: false,
};

/// Convert image resource URL to data URL
/// If the passed resource URL can't be drawn to a canvas, an exception will be raised
// based on https://github.com/sissilab/obsidian-image-toolkit/issues/4#issuecomment-908898483
function imageToDataURL(imgSrc: string, maxEdge = 512, debug = false) {
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
					if (debug)
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

function initMessages(
	systemMessage: string
): OpenAI.ChatCompletionMessageParam[] {
	const messages: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: systemMessage },
	];
	return messages;
}

async function convertRangeToContentParts(
	startOffset: number,
	endOffset: number,
	embeds: EmbedCache[],
	editor: Editor,
	vault: Vault,
	debug: boolean
) {
	if (debug) {
		console.log(
			"convertRangeToContentParts()",
			startOffset,
			endOffset,
			"EMBEDS:",
			embeds
		);
	}

	// track end of previous embed+1, or start of the whole block, so we can add text before / between embeds
	let currentStart = startOffset;

	// intermediate list of text + embeds
	const parts = [];

	// experimentally: embedded external image links e.g. ![](https://some.url/image.jpg) do not get parsed as embeds
	// docs at https://help.obsidian.md/Linking+notes+and+files/Embed+file do call this an embed though
	let embed: EmbedCache | null = null;

	for (embed of embeds) {
		if (
			embed.position.start.offset >= startOffset &&
			embed.position.end.offset <= endOffset
		) {
			if (embed.position.start.offset > currentStart) {
				// this means there's text before the embed, let's add it
				// EditorPosition has ch and line
				// however, note that CM6 prefers offsets to the old CM5 line-ch pairs: https://codemirror.net/docs/migration/#positions
				// fortunately, Obsidian's Editor abstraction offers posToOffset and offsetToPos
				parts.push({
					type: "text",
					// AFAICS also from the CM6 docs on sliceDoc, getRange() excludes the end position
					text: editor
						.getRange(
							editor.offsetToPos(currentStart),
							editor.offsetToPos(embed.position.start.offset)
						)
						.trim(),
				});
			}
			// TODO: check that the embed is an image / other processable type
			parts.push({
				type: "embed",
				embed,
			});
			currentStart = embed.position.end.offset + 1;
		}
	}

	// take care of last bit of text
	if (endOffset > currentStart) {
		parts.push({
			type: "text",
			text: editor
				.getRange(
					editor.offsetToPos(currentStart),
					editor.offsetToPos(endOffset)
				)
				.trim(),
		});
	}

	const contentParts: Array<OpenAI.ChatCompletionContentPart> = [];
	for (const part of parts) {
		if (part.type === "text" && part.text) {
			contentParts.push(part as OpenAI.ChatCompletionContentPart);
		} else if (part.type === "embed" && part.embed?.link) {
			const embeddedFile = vault.getFileByPath(part.embed.link);
			if (embeddedFile) {
				try {
					// claude sonnet 3.5 image sizes: https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
					// longest edge should be < 1568
					// openai gpt-4o
					// we need either < 512x512 or < 2000x768 (low or high fidelity)
					const { dataURL, x, y } = await imageToDataURL(
						vault.getResourcePath(embeddedFile),
						1568,
						debug
					);

					// DEBUG: show image in the console -- working on 2024-06-27
					if (debug) {
						console.log(
							"%c ",
							`font-size:1px; padding: ${x}px ${y}px; background:url(${dataURL}) no-repeat; background-size: contain;`
						);

						console.log(dataURL);

						console.log(
							`Adding image "${part.embed.link}" at size ${x}x${y} to messages.`
						);
					}

					contentParts.push({
						type: "image_url",
						image_url: {
							url: dataURL,
						},
					});
				} catch (e) {
					console.error("Error copying image", embeddedFile, e);
				}
			}
		}
	}

	return contentParts;
}

// find current cursor position, determine its heading path, then convert that path into messages
// app needed for: metadataCache, vault
// editor needed for: getCursor, getLine, lastLine, getRange, etc.
async function convertCurrentThreadToMessages(
	markdownFile: TFile,
	systemMessage: string,
	app: App,
	editor: Editor,
	debug = false
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

	const messages = initMessages(systemMessage);

	// we want to return the last rangeEnd, so that the calling code can move the cursor there
	let rangeEnd: EditorPosition = { line: 0, ch: 0 };
	let heading = null;
	// we want to find embeds in the range
	let rangeEndOffset = -1;
	for (const i of headingPath) {
		// determine current heading to next heading / end of file block
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
			// this is a user message, so we do multi-part / ContentPart[]

			const embeds = cache.embeds || [];
			const startOffset = heading.position.end.offset + 1;
			const endOffset = rangeEndOffset;

			const contentParts = await convertRangeToContentParts(
				startOffset,
				endOffset,
				embeds,
				editor,
				app.vault,
				debug
			);

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

export default class AIChatAsMDPlugin extends Plugin {
	settings: AIChatAsMDSettings;

	async onload() {
		await this.loadSettings();

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText("AICM loaded");

		this.addCommand({
			id: "complete-thread",
			name: "Send current thread to AI",
			icon: "bot-message-square",
			// https://docs.obsidian.md/Plugins/User+interface/Commands#Editor+commands
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				// await view.save();
				const markdownFile = view.file;
				if (!markdownFile) {
					new Notice("No markdown file open");
					return;
				}

				const systemPrompt = await this.getSystemPrompt();
				if (!systemPrompt) {
					return;
				}

				const mhe = await convertCurrentThreadToMessages(
					markdownFile,
					systemPrompt,
					this.app,
					editor,
					this.settings.debug
				);
				if (!mhe) {
					new Notice("No headings found");
					return;
				}

				editor.setCursor(mhe.rangeEnd);

				const model = this.getRequestedModel(markdownFile);

				// create heading that's one level deeper than the one we are replying to
				const aiLevel = mhe.heading.level + 1;
				let aiHeading = `\n\n${"#".repeat(aiLevel)} AI`;
				// if the user configured it, show the used model in the heading
				if (this.settings.showUsedModel) {
					aiHeading += ` (model:: ${model})`;
				}
				aiHeading += "\n";

				replaceRangeMoveCursor(editor, aiHeading);

				if (this.settings.debug) {
					console.log("About to send to AI:", mhe.messages);
				}

				const stream = await this.getOpenAIStream(mhe.messages, model);
				// statusBarItemEl.setText("AICM streaming...");
				for await (const chunk of stream) {
					const content = chunk.choices[0]?.delta?.content || "";
					replaceRangeMoveCursor(editor, content);
					if (chunk.usage) {
						console.log("OpenAI API usage:", chunk.usage);
					}
				}
				//statusBarItemEl.setText("AICM done.");

				// BUG: on iPhone, this sometimes starts before the last 2 or 3 characters of AI message
				const userHeading = `\n\n${"#".repeat(aiLevel + 1)} User\n`;
				replaceRangeMoveCursor(editor, userHeading);
			},
		});

		this.addCommand({
			id: "complete-selection",
			name: "Send selected text to AI and append the response",
			icon: "bot-message-square",
			// https://docs.obsidian.md/Plugins/User+interface/Commands#Editor+commands
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.completeSelection(editor, view);
			},
		});

		this.addCommand({
			id: "complete-selection-and-replace",
			name: "Send selected text to AI and REPLACE it with the response",
			icon: "bot-message-square",
			// https://docs.obsidian.md/Plugins/User+interface/Commands#Editor+commands
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.completeSelection(editor, view, "replace");
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

	/**
	 * Determine which model to use for the current markdown file
	 *
	 * If the file has a frontmatter key aicmd-model, that will be used, else the default configured model.
	 *
	 * @param markdownFile the markdown file from which the frontmatter is to be read
	 */
	getRequestedModel(markdownFile: TFile) {
		const cache = this.app.metadataCache.getFileCache(markdownFile);
		const model =
			cache?.frontmatter?.["aicmd-model"] ?? this.settings.model;
		return model;
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

	async getOpenAIStream(
		messages: OpenAI.ChatCompletionMessageParam[],
		model: string
	) {
		const openai = await this.getOpenAI();

		return openai.chat.completions.create({
			model: model,
			messages: messages,
			stream: true,
		});
	}

	async getSystemPrompt() {
		if (this.settings.systemPromptFile) {
			const systemPromptFile = this.app.vault.getFileByPath(
				this.settings.systemPromptFile
			);
			if (!systemPromptFile) {
				new Notice(
					`AI Chat as MD could not read system prompt file "${this.settings.systemPromptFile}". Please fix its path in the plugin settings.`
				);
				return null;
			}
			const systemPrompt = await this.app.vault.cachedRead(
				systemPromptFile
			);
			return systemPrompt;
		}

		return this.settings.systemPrompt;
	}

	async completeSelection(
		editor: Editor,
		view: MarkdownView,
		mode: "replace" | "append" = "append"
	) {
		if (!editor.somethingSelected()) {
			return;
		}
		const markdownFile = view.file;
		if (!markdownFile) {
			new Notice("No markdown file open");
			return;
		}

		// await view.save();
		const cache = this.app.metadataCache.getFileCache(markdownFile);
		if (!cache) return null;

		// from..to could be flipped if user selected from the back to the front
		// we make sure that it's from lowest to highest offset
		// BTW: wow javascript, making me supply a compareFn to sort numbers seesh!
		const [selStartOffset, selEndOffset] = [
			editor.getCursor("from"),
			editor.getCursor("to"),
		]
			.map((pos) => editor.posToOffset(pos))
			.sort((a, b) => a - b);

		const systemPrompt = await this.getSystemPrompt();
		if (!systemPrompt) {
			return;
		}
		const messages = initMessages(systemPrompt);
		messages.push({
			role: "user",
			content: await convertRangeToContentParts(
				selStartOffset,
				selEndOffset,
				cache.embeds || [],
				editor,
				this.app.vault,
				this.settings.debug
			),
		});

		if (this.settings.debug) {
			console.log("About to send to AI:", messages);
		}

		const model = this.getRequestedModel(markdownFile);
		const stream = await this.getOpenAIStream(messages, model);
		//statusBarItemEl.setText("AICM streaming...");

		if (mode === "append") {
			// in case the user selected from back to front, we move the cursor to the end
			editor.setCursor(editor.offsetToPos(selEndOffset));
			replaceRangeMoveCursor(editor, "\n\n");
		} else {
			editor.replaceSelection("");
		}

		for await (const chunk of stream) {
			const content = chunk.choices[0]?.delta?.content || "";
			replaceRangeMoveCursor(editor, content);
			if (chunk.usage) {
				console.log("OpenAI API usage:", chunk.usage);
			}
		}
		replaceRangeMoveCursor(editor, "\n");
		//statusBarItemEl.setText("AICM done.");
	}
}

class AIChatAsMDSettingsTab extends PluginSettingTab {
	plugin: AIChatAsMDPlugin;

	constructor(app: App, plugin: AIChatAsMDPlugin) {
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
					.setValue(this.plugin.settings.apiHost)
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

		let systemPromptTextArea: TextAreaComponent;
		const systemPromptSetting = new Setting(containerEl)
			.setName("System prompt")
			.addTextArea((textArea) => {
				systemPromptTextArea = textArea;
				return textArea
					.setPlaceholder("Enter the system prompt")
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					});
			})
			.addExtraButton((button) => {
				button
					.setIcon("lucide-rotate-ccw")
					.setTooltip("Reset to default")
					.onClick(() => {
						systemPromptTextArea.setValue(
							DEFAULT_SETTINGS.systemPrompt
						);
						// setValue() above does not trigger the onChange() hanndler
						// so here we help it
						systemPromptTextArea.onChanged();
					});
			});

		new Setting(containerEl).setName("Advanced").setHeading();

		// this.app.vault.getMarkdownFiles()
		// the path in each of these files is relative to the vault, which is exactly what I want for this.app.vault.getFileByPath()
		new Setting(containerEl)
			.setName("Use (markdown) file as system prompt")
			.setDesc(
				"Enter the path, relative to your vault, of any file that the plugin should use as the system prompt, " +
					"instead of the text above. " +
					"Examples: `sysprompt-swdev.md`, `top-folder/system prompt 1.md`"
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.systemPromptFile).onChange(
					async (value) => {
						this.plugin.settings.systemPromptFile = value.trim();
						await this.plugin.saveSettings();

						//systemPromptSetting.setDisabled(value !== "");
					}
				);
			});
		new Setting(containerEl)
			.setName("Show used model")
			.setDesc("Add used model to the end of each AI heading")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showUsedModel)
					.onChange(async (value) => {
						this.plugin.settings.showUsedModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Debug output in developer console")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
