import {
	type App,
	type Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	EditorPosition,
} from "obsidian";
import OpenAI from "openai";
// Remember to rename these classes and interfaces!

interface AIChatAsMDSettings {
	openAIAPIKey: string;
}

const DEFAULT_SETTINGS: AIChatAsMDSettings = {
	openAIAPIKey: "sk-xxxx",
};

// find current cursor position, determine its heading path, then convert that path into messages
function convertToMessages(app: App, editor: Editor, view: MarkdownView) {
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

	for (const i of headingPath) {
		const heading = headings[i];
		const nextHeading = headings[i + 1];
		let rangeEnd: EditorPosition;
		if (nextHeading) {
			// discovered that ch: -1 is the end of the line
			rangeEnd = {
				line: nextHeading.position.start.line - 1,
				ch: -1,
			};
		} else {
			const lastLine = editor.lastLine();
			rangeEnd = {
				line: lastLine,
				ch: editor.getLine(lastLine).length,
			};
		}
		// EditorPosition has ch and line
		const m = editor.getRange(
			{ line: heading.position.end.line + 1, ch: 0 },
			rangeEnd
		);

		console.log(`${i} ${heading.heading} ===> ${m} <====`);
		//console.log(heading.heading);
	}

	// for later when I need to fish out images
	// https://docs.obsidian.md/Reference/TypeScript+API/EmbedCache
	// cache.embeds;
}

async function getOpenAI() {
	const openai = new OpenAI({
		baseURL: "https://openrouter.ai/api/v1",
		apiKey: this.settings.openAIAPIKey,
		defaultHeaders: {
			"HTTP-Referer": "https://github.com/cpbotha/obsidian-ai-chat-as-md", // Optional, for including your app on openrouter.ai rankings.
			"X-Title": "Obsidian AI Chat as Markdown", // Optional. Shows in rankings on openrouter.ai.
		},
		// we are running in a browser environment, but we are using obsidian settings to get keys, so we can enable this
		dangerouslyAllowBrowser: true,
	});

	const completion = await openai.chat.completions.create({
		model: "anthropic/claude-3.5-sonnet",
		messages: [{ role: "user", content: "Say this is a test" }],
	});
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
		ch: lines.length === 1 ? cursor.ch : 0 + lines[lines.length - 1].length,
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
				convertToMessages(this.app, editor, view);

				//replaceRangeMoveCursor(editor, "hello there!\nhow you doing?");
				//editor.replaceRange("hello there", editor.getCursor());
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
