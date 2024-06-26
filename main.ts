import {
	type EmbedCache,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type Editor,
	type EditorPosition,
	type HeadingCache,
	type TFile,
	arrayBufferToBase64,
} from "obsidian";

import OpenAI from "openai";

interface AIChatAsMDSettings {
	openAIAPIKey: string;
}

const DEFAULT_SETTINGS: AIChatAsMDSettings = {
	openAIAPIKey: "sk-xxxx",
};

function isImageFile(file: TFile): boolean {
	// https://platform.openai.com/docs/guides/vision/what-type-of-files-can-i-upload
	const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp"];
	return imageExtensions.includes(file.extension.toLowerCase());
}

// find current cursor position, determine its heading path, then convert that path into messages
async function convertToMessages(app: App, editor: Editor, view: MarkdownView) {
	const f = view.file;
	if (!f) return null;
	const cache = app.metadataCache.getFileCache(f);
	if (!cache) return null;
	const headings = cache.headings || [];

	// store indices of headings from the top-most to where the cursor is
	const headingPath = [];
	let currentHeading = null;
	for (let i = headings.length - 1; i >= 0; i--) {
		const heading = headings[i];
		if (currentHeading) {
			if (
				heading.position.start.line <
					currentHeading.position.start.line &&
				heading.level < currentHeading.level
			) {
				headingPath.unshift(i);
				currentHeading = heading;
			}
		} else {
			if (heading.position.start.line <= editor.getCursor().line) {
				// ok we found the heading containing the cursor, start from here
				headingPath.unshift(i);
				currentHeading = heading;
			}
		}
	}

	if (!currentHeading) return null;

	const messages: OpenAI.ChatCompletionMessageParam[] = [];
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
					const f = this.app.vault.getFileByPath(part.embed.link);
					// check that f is an image
					if (f && isImageFile(f)) {
						//https://github.com/xRyul/obsidian-image-converter/blob/master/src/main.ts#L1719
						console.log(this.app.vault.getResourcePath(f));
						// ArrayBuffer
						const imageData = await this.app.vault.readBinary(f);
						const base64 = arrayBufferToBase64(imageData);
						contentParts.push({
							type: "image_url",
							image_url: {
								url: `data:image/${f.extension};base64,${base64}`,
							},
						});
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

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon(
			"dice",
			"Sample Plugin",
			(evt: MouseEvent) => {
				// Called when the user clicks the icon.
				new Notice("This is a notice!");
			}
		);
		// Perform additional things with the ribbon
		ribbonIconEl.addClass("my-plugin-ribbon-class");

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Status Bar Text");

		this.addCommand({
			id: "ai-chat-complete",
			name: "Do the thing",
			// https://docs.obsidian.md/Plugins/User+interface/Commands#Editor+commands
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const mhe = await convertToMessages(this.app, editor, view);
				if (!mhe) {
					new Notice("No headings found");
					return;
				}
				console.log(mhe.messages);

				return;

				editor.setCursor(mhe.rangeEnd);
				// create heading that's one level deeper than the one we are replying to
				const aiLevel = mhe.heading.level + 1;
				const aiHeading = `\n\n${"#".repeat(aiLevel)} AI\n`;

				replaceRangeMoveCursor(editor, aiHeading);

				const stream = await this.getOpenAIStream(mhe.messages);
				for await (const chunk of stream) {
					const content = chunk.choices[0]?.delta?.content || "";
					replaceRangeMoveCursor(editor, content);
				}

				const userHeading = `\n\n${"#".repeat(aiLevel + 1)} User\n`;
				replaceRangeMoveCursor(editor, userHeading);
			},
		});

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "open-sample-modal-simple",
			name: "Open sample modal (simple)",
			callback: () => {
				new SampleModal(this.app).open();
			},
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: "sample-editor-command",
			name: "Sample editor command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection("Sample Editor Command");
			},
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: "open-sample-modal-complex",
			name: "Open sample modal (complex)",
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("click", evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000)
		);
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
			baseURL: "https://openrouter.ai/api/v1",
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

		// TODO: consider system prompt
		return openai.chat.completions.create({
			// TODO: setting
			model: "anthropic/claude-3.5-sonnet",
			messages: messages,
			stream: true,
		});
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Woah!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Setting #1")
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder("Enter your secret")
					.setValue(this.plugin.settings.openAIAPIKey)
					.onChange(async (value) => {
						this.plugin.settings.openAIAPIKey = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
