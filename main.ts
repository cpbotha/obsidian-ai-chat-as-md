// Obsidian AI Chat as Markdown copyright 2024 by Charl P. Botha <cpbotha@vxlabs.com>
import {
	type App,
	type Editor,
	type EditorPosition,
	type EmbedCache,
	type MarkdownView,
	type MetadataCache,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type TFile,
	type TextAreaComponent,
	type Vault,
	parseLinktext,
	resolveSubpath,
	type HeadingCache,
	moment,
} from "obsidian";

import OpenAI, { toFile } from "openai";
import type { FileLike } from "openai/uploads";

interface AIChatAsMDSettings {
	apiHost: string;
	openAIAPIKey: string;
	model: string;
	openAIImageGenAPIKey: string;
	systemPrompt: string;
	systemPromptFile: string;
	showUsedModel: boolean;
	debug: boolean;
}

const DEFAULT_SETTINGS: AIChatAsMDSettings = {
	// openai: https://api.openai.com/v1
	// openrouter: https://openrouter.ai/api/v1
	// perplexity: https://api.perplexity.ai (exception here, they don't have the v1)
	apiHost: "https://api.openai.com/v1",
	openAIAPIKey: "",
	// openai: gpt-4o
	// openrouter: anthropic/claude-3.5-sonnet
	model: "gpt-4o",
	openAIImageGenAPIKey: "",
	systemPrompt: `You are an AI assistant, outputting into an Obsidian markdown document. You have access to fenced codeblocks and MathJax notation. When responding:

1. Prioritize brevity and information density. Aim for concise, high-impact answers.
2. Use markdown formatting for text styling and organization, but do not use any headings.
3. I repeat: Do not use any headings.
4. Use fenced codeblocks with language specification for any code snippets.
5. Use MathJax for math: inline $Ax = b$ or block-level $$ E = mc^2 $$
6. Avoid unnecessary elaboration or examples unless specifically requested.
7. Use technical language and jargon appropriate to the topic, assuming user familiarity.
8. Provide direct answers without preamble or excessive context-setting.

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
			image.onerror = (e) => {
				// important to signal the error to the caller via our promise
				reject(`Error loading image: ${e}`);
			};

			image.src = imgSrc;
		}
	);
}
// from https://byby.dev/js-slugify-string thanks!
// modified to make space replacement optional
function slugify(str: string, replaceSpaces = true) {
	let s = String(str)
		.normalize("NFKD") // split accented characters into their base characters and diacritical marks
		.replace(/[\u0300-\u036f]/g, "") // remove all the accents, which happen to be all in the \u03xx UNICODE block.
		.trim() // trim leading or trailing whitespace
		.toLowerCase() // convert to lowercase
		.replace(/[^a-z0-9 -]/g, ""); // remove non-alphanumeric characters

	if (replaceSpaces) {
		s = s
			.replace(/\s+/g, "-") // replace spaces with hyphens
			.replace(/-+/g, "-"); // remove consecutive hyphens
	}

	return s;
}

function initMessages(
	systemMessage: string
): OpenAI.ChatCompletionMessageParam[] {
	const messages: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: systemMessage },
	];
	return messages;
}

interface ChatCompletionContentPartImageBuffer {
	type: "image_buffer";
	image_buffer: ArrayBuffer;
	mime_type: string;
	basename: string;
}

type ExtendedChatCompletionContentPart =
	| OpenAI.Chat.Completions.ChatCompletionContentPart
	| ChatCompletionContentPartImageBuffer;

/**
 * Convert a subsection of a markdown file into a list of OpenAI.ChatCompletionContentPart
 *
 * This will take care of the main text, as well as text (whole file, heading, block) and image embeds.
 *
 * @param startOffset Starting 0-based offset of the range to convert. Pass null / undefined for start of file.
 * @param endOffset Ending non-inclusive 0-based offset of the range to convert. Pass null / undefined for end of file.
 * @param markdownFile
 * @param vault Used to read main file and embedded files
 * @param metadataCache Access file caches (for parsing) and link resolution
 * @param base64Images If True, will convert images to base64 data URLs else ArrayBuffers in part with `type` = "image_buffer" and `image_buffer` = <ArrayBuffer>
 * @param debug If True, will print debug output to console
 * @returns List of content parts, ready for concatenation into OpenAI-style request
 * @raises Error if conversion could not take place. This should not happen in normal operation.
 */
async function convertRangeToContentParts(
	startOffset: number | null,
	endOffset: number | null,
	markdownFile: TFile,
	vault: Vault,
	metadataCache: MetadataCache,
	base64Images: boolean,
	debug: boolean
): Promise<ExtendedChatCompletionContentPart[]> {
	const cache = metadataCache.getFileCache(markdownFile);
	if (!cache) {
		const errMsg = `convertRangeToContentParts() could not find cache for ${markdownFile.path}`;
		console.error(errMsg);
		// if we can't find the cache, there is something seriously wrong, so we interrupt processing completely
		throw new Error(errMsg);
	}
	const embeds = cache?.embeds || [];

	// get the contents so we can extract the text we need
	const markdown = await vault.cachedRead(markdownFile);

	const _startOffset = startOffset ?? 0;
	const _endOffset = endOffset ?? markdown.length;

	if (debug) {
		console.log(
			"convertRangeToContentParts()",
			_startOffset,
			_endOffset,
			"EMBEDS:",
			embeds
		);
	}

	// track end of previous embed+1, or start of the whole block, so we can add text before / between embeds
	let currentStart = _startOffset;

	// intermediate list of text + embeds
	const parts = [];

	// experimentally: embedded external image links e.g. ![](https://some.url/image.jpg) do not get parsed as embeds
	// docs at https://help.obsidian.md/Linking+notes+and+files/Embed+file do call this an embed though
	let embed: EmbedCache | null = null;

	for (embed of embeds) {
		if (
			embed.position.start.offset >= _startOffset &&
			embed.position.end.offset <= _endOffset
		) {
			if (embed.position.start.offset > currentStart) {
				// this means there's text before the embed, let's add it
				// EditorPosition has ch and line
				// however, note that CM6 prefers offsets to the old CM5 line-ch pairs: https://codemirror.net/docs/migration/#positions
				// fortunately, Obsidian's Editor abstraction offers posToOffset and offsetToPos
				parts.push({
					type: "text",
					// previously: AFAICS also from the CM6 docs on sliceDoc, getRange() excludes the end position
					// now: slice() excludes the end position
					text: markdown
						.slice(currentStart, embed.position.start.offset)
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
	if (_endOffset > currentStart) {
		parts.push({
			type: "text",
			text: markdown.slice(currentStart, _endOffset).trim(),
		});
	}

	const contentParts: Array<ExtendedChatCompletionContentPart> = [];
	for (const part of parts) {
		if (part.type === "text" && part.text) {
			contentParts.push(part as OpenAI.ChatCompletionContentPart);
		} else if (part.type === "embed" && part.embed?.link) {
			// obsidian can link to an embed without subdir; could be more than one file with that name
			// getFirstLinkpathDest() with the correct sourcePath (second arg) should return the correct file
			// note also that you HAVE to strip off #subpath from the link, else it returns null
			const parsedLink = parseLinktext(part.embed.link);
			const embeddedFile = metadataCache.getFirstLinkpathDest(
				parsedLink.path,
				markdownFile.path
			);
			if (embeddedFile) {
				if (embeddedFile.extension === "md") {
					let embeddedMarkdown = await vault.cachedRead(embeddedFile);
					if (parsedLink.subpath) {
						const embeddedCache =
							metadataCache.getFileCache(embeddedFile);
						if (embeddedCache) {
							const subpath = resolveSubpath(
								embeddedCache,
								parsedLink.subpath
							);
							if (subpath) {
								if (subpath.type === "heading") {
									// when subpath.next (the next heading) is null, replace with undefined so substring goes to end of file
									embeddedMarkdown =
										embeddedMarkdown.substring(
											subpath.current.position.start
												.offset,
											subpath.next?.position.start
												.offset ?? undefined
										);
								} else {
									// must be block
									embeddedMarkdown =
										embeddedMarkdown.substring(
											subpath.block.position.start.offset,
											subpath.block.position.end.offset
										);
								}
							}
						}
					}
					contentParts.push({ type: "text", text: embeddedMarkdown });
				} else {
					// if it's not markdown, it could be an image, so we try to load it as one
					try {
						if (base64Images) {
							// claude sonnet 3.5 image sizes: https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
							// longest edge should be < 1568
							// openai gpt-4o
							// we need either < 512x512 or < 2000x768 (low or high fidelity)
							const { dataURL, x, y } = await imageToDataURL(
								vault.getResourcePath(embeddedFile),
								1568,
								debug
							);

							// FIXME: alternatively, vault.readBinary() returns ArrayBuffer, ready for openai toFile

							if (debug) {
								// DEBUG: show image in the console -- working on 2024-06-27
								// FIXME: temporarily disabling, because heavy
								// console.log(
								// 	"%c ",
								// 	`font-size:1px; padding: ${x}px ${y}px; background:url(${dataURL}) no-repeat; background-size: contain;`
								// );

								// console.log(dataURL);

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
						} else {
							const ext = embeddedFile.extension.toLowerCase();
							if (["png", "webp", "jpg", "jpeg"].includes(ext)) {
								// It's a supported image type
								const imageBuffer = await vault.readBinary(
									embeddedFile
								);
								const mime_type =
									ext === "jpg"
										? "image/jpeg"
										: `image/${ext}`;
								contentParts.push({
									type: "image_buffer",
									image_buffer: imageBuffer,
									mime_type: mime_type,
									basename: embeddedFile.basename,
								});
							} else {
								console.log(
									`Could not handle embedding type ${ext}`
								);
							}
						}
					} catch (e) {
						console.error("Error copying image", embeddedFile, e);
					}
				}
			}
		}
	}

	return contentParts;
}

// find heading containing the cursor, and then the path of containing headings up the tree
function getHeadingPathToCursor(headings: HeadingCache[], cursorLine: number) {
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
			if (heading.position.start.line <= cursorLine) {
				// ok we found the heading containing the cursor, start from here
				headingPath.unshift(i);
				currentHeading = heading;
			}
		}
	}

	if (!currentHeading) return []; // empty array, no headings to work with

	return headingPath;
}

interface IThreadMessages {
	messages: OpenAI.ChatCompletionMessageParam[];
	// last heading in the headingPath, typically the one containing the cursor
	heading: HeadingCache;
	rangeEnd: EditorPosition;
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
): Promise<IThreadMessages> {
	const cache = app.metadataCache.getFileCache(markdownFile);
	if (!cache)
		throw new Error(`Could not find cache for ${markdownFile.path}`);

	const headings = cache.headings || [];

	const headingPath = getHeadingPathToCursor(
		headings,
		editor.getCursor().line
	);
	if (headingPath.length === 0) {
		throw new Error(`No headings to work with in ${markdownFile.path}`);
	}

	const messages = initMessages(systemMessage);

	// we want to return the last rangeEnd, so that the calling code can move the cursor there
	let rangeEnd: EditorPosition = { line: 0, ch: 0 };
	let heading = null;
	// we want to find embeds in the range
	let rangeEndOffset = -1;
	let rangeStartOffset: number;
	for (const i of headingPath) {
		// determine current heading to next heading / end of file block
		heading = headings[i];
		({ rangeStartOffset, rangeEnd, rangeEndOffset } = getHeadingRange(
			headings,
			i,
			editor
		));

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

			// this is now returned by getHeadingRange()
			//const startOffset = heading.position.end.offset + 1;
			//const endOffset = rangeEndOffset;

			// raised exceptions will propagate to convertThreadToMessages()'s caller and be shown as a notice
			const contentParts = (await convertRangeToContentParts(
				rangeStartOffset,
				rangeEndOffset,
				markdownFile,
				app.vault,
				app.metadataCache,
				true, // base64Images
				debug
			)) as OpenAI.ChatCompletionContentPart[];
			messages.push({
				role: role,
				content: contentParts,
			});
		}
	}

	if (!heading) {
		const errMsg = "Really unexpected that we have no last heading here.";
		console.error(errMsg);
		throw new Error(errMsg);
	}

	return { messages, heading, rangeEnd };
}
/**
 * Return the range of text starting right after heading i and continuing to right before heading i+1 or end of doc.
 * @param headings
 * @param i
 * @param editor
 * @returns
 */
function getHeadingRange(headings: HeadingCache[], i: number, editor: Editor) {
	const heading = headings[i];
	const nextHeading = headings[i + 1];
	let rangeEnd: EditorPosition = { line: 0, ch: 0 };
	// we want to find embeds in the range
	let rangeEndOffset = -1;
	if (nextHeading) {
		const line = nextHeading.position.start.line - 1;
		rangeEnd = {
			line: line,
			ch: editor.getLine(line).length,
		};
		rangeEndOffset = nextHeading.position.start.offset - 1;
	} else {
		// headings[i] is the last heading, so we have to use end of file
		const lastLine = editor.lastLine();
		rangeEnd = {
			line: lastLine,
			ch: editor.getLine(lastLine).length,
		};
		rangeEndOffset = editor.getValue().length;
	}
	return {
		rangeStartOffset: heading.position.end.offset + 1,
		rangeEnd,
		rangeEndOffset,
	};
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
	//editor.refresh();
	// even without refresh, it's more reliable when in source mode!
}

function renderSearchResultsOrCitations(
	roc: CitationsAndSearchResults,
	editor: Editor
) {
	if (roc.search_results && roc.search_results.length > 0) {
		const citationList = roc.search_results
			.map(
				(sr, index) =>
					`${index + 1}. [${sr.title}](${sr.url})${
						sr.date ? ` ${sr.date}` : ""
					}`
			) // nested template strings ok!
			.join("\n"); // Join with newlines
		replaceRangeMoveCursor(editor, `\n\n**Citations:**\n${citationList}`);
	} else if (roc.citations && roc.citations.length > 0) {
		const citationList = roc.citations
			.map((url, index) => `${index + 1}. <${url}>`) // Format as N. <URL>
			.join("\n"); // Join with newlines
		replaceRangeMoveCursor(editor, `\n\n**Citations:**\n${citationList}`);
	}
}

interface SearchResult {
	title: string;
	url: string;
	date: string;
}

interface CitationsAndSearchResults {
	citations?: string[];
	/**
	 * On May 29, perplexity introduced search_results; they will eventually deprecate search_results
	 * https://community.perplexity.ai/t/new-feature-search-results-field-with-richer-metadata/398
	 */
	search_results?: SearchResult[];
}

// Define an interface extending the OpenAI chunk type with optional citations or search_results
interface ChatCompletionChunkWithCitationsOrSearchResults
	extends OpenAI.Chat.Completions.ChatCompletionChunk,
		CitationsAndSearchResults {}

function extractSearchResultsOrCitations(
	chunk: ChatCompletionChunkWithCitationsOrSearchResults,
	roc: CitationsAndSearchResults
) {
	if (chunk.search_results && chunk.search_results.length > 0) {
		roc.search_results = chunk.search_results;
	}

	if (chunk.citations && chunk.citations.length > 0) {
		roc.citations = chunk.citations;
	}
}

/**
 * Ensure that we are in editing source mode to work around AI streaming updating document out of order.
 * @param view
 * @returns
 */
function maybeSwitchToSourceMode(view: MarkdownView) {
	if (view.getMode() === "source" && view.getState().source === false) {
		// https://forum.obsidian.md/t/how-to-get-the-live-preview-status-within-the-typescript-code-for-plugin-development/80996/2
		view.setState({ ...view.getState(), source: true }, { history: false });
		// yes we switched to editing in source mode (from editing in preview mode)
		return true;
	}

	return false;
}

function maybeSwitchBackToPreviewMode(view: MarkdownView, didSwitch: boolean) {
	if (didSwitch) {
		// switch back to preview mode
		view.setState(
			{ ...view.getState(), source: false },
			{
				history: false,
			}
		);
	}
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

				const systemPrompt = await this.getSystemPrompt(markdownFile);
				if (!systemPrompt) {
					return;
				}

				let mhe: IThreadMessages;
				try {
					mhe = await convertCurrentThreadToMessages(
						markdownFile,
						systemPrompt,
						this.app,
						editor,
						this.settings.debug
					);
				} catch (e) {
					new Notice(`Error converting thread to messages: ${e}`);
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

				// DEBUG bypass OpenAI
				// return null;

				let roc: CitationsAndSearchResults = {};

				const didSwitchMode = maybeSwitchToSourceMode(view);
				try {
					const stream = await this.getOpenAIStream(
						mhe.messages,
						model
					);
					// statusBarItemEl.setText("AICM streaming...");
					for await (const chunk of stream) {
						const content = chunk.choices[0]?.delta?.content || "";
						replaceRangeMoveCursor(editor, content);
						if (chunk.usage) {
							// perplexity api does this for every chunk!
							console.log("OpenAI API usage:", chunk.usage);
						}

						extractSearchResultsOrCitations(
							chunk as ChatCompletionChunkWithCitationsOrSearchResults,
							roc
						);

						// openrouter can add exa search results if you append :online to model
						// https://openrouter.ai/docs/features/web-search
						// perplexity and chatgpt have search built in, just remember web_search_options as part of your request
						// https://platform.openai.com/docs/guides/tools-web-search?api-mode=chat
						// note openai limitations! completions = always search, use responses API for tool use
						// conclusions:
						// - perplexity in this context still the best
						// - :online search results are passed to AI, but we never get them back. With multi-turn conversations, we don't know
						//   where and when the search results are being inserted
						// if (chunk.choices[0]?.delta?.annotations) {
						// tested to work 2025-05-27, each annotation is
						// {type: "url_citation", url_citation: {content, start_index, end_index, title: "...", url: "..."}}
						//console.log(chunk.choices[0].delta.annotations);
						// }
					}

					//statusBarItemEl.setText("AICM done.");
				} catch (e) {
					this.handleOpenAIError(e);
				}

				// create numbered list of citations from citations array
				renderSearchResultsOrCitations(roc, editor);

				// BUG: on iPhone, this sometimes starts before the last 2 or 3 characters of AI message
				// tested requestAnimationFrame and setTimeout here, weirdly the first chunk of the AI message came AFTER this heading!
				// BUG is much worse with markdownpreview mode!
				// switch to source mode, do thing, then back? -- Yes, see maybeSwitchToSourceMode()
				const userHeading = `\n\n${"#".repeat(aiLevel + 1)} User\n`;
				replaceRangeMoveCursor(editor, userHeading);

				maybeSwitchBackToPreviewMode(view, didSwitchMode);
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

		this.addCommand({
			id: "generate-or-edit-images",
			name: "Generate or edit images",
			icon: "bot-message-square",
			// https://docs.obsidian.md/Plugins/User+interface/Commands#Editor+commands
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const markdownFile = view.file;
				if (!markdownFile) {
					new Notice("No markdown file open");
					return;
				}

				const cache = this.app.metadataCache.getFileCache(markdownFile);
				if (!cache)
					throw new Error(
						`Could not find cache for ${markdownFile.path}`
					);

				const headings = cache.headings || [];

				const headingPath = getHeadingPathToCursor(
					headings,
					editor.getCursor().line
				);
				if (headingPath.length === 0) {
					throw new Error(
						`No headings to work with in ${markdownFile.path}`
					);
				}

				const thisHeadingIdx = headingPath.slice(-1)[0];
				const { rangeStartOffset, rangeEnd, rangeEndOffset } =
					getHeadingRange(headings, thisHeadingIdx, editor);

				// each part has type "text" or "image_buffer" (because base64Images = false)
				const parts = await convertRangeToContentParts(
					rangeStartOffset,
					rangeEndOffset,
					markdownFile,
					this.app.vault,
					this.app.metadataCache,
					false, // base64Images
					this.settings.debug
				);
				console.log("parts", parts);

				// loop through parts, concatenating all text (= prompt) and making a list of images
				let prompt = "";
				const images: FileLike[] = [];

				for (const part of parts) {
					if (part.type === "text") {
						prompt += `\n${part.text}`;
					} else if (part.type === "image_buffer") {
						images.push(
							await toFile(part.image_buffer, part.basename, {
								type: part.mime_type,
							})
						);
					}
				}

				const openai = await this.getOpenAIImageGen();

				// common options for generation and editing
				const options = {
					model: "gpt-image-1",
					prompt: prompt,
					n: 1,
					size: "1024x1024",
					output_format: "webp",
				};

				let imgResp: OpenAI.Images.ImagesResponse;

				const startSecs = Date.now() / 1000;
				if (images.length > 0) {
					console.log("requesting image EDIT");
					// the image(s) consists of Core.Uploadable which you can setup using openai's toFile()
					imgResp = await openai.images.edit({
						image: images,
						...options,
					} as OpenAI.Images.ImageEditParams);
				} else {
					console.log("requesting image GENERATION");
					// https://platform.openai.com/docs/api-reference/images/create?lang=node.js
					imgResp = await openai.images.generate(
						options as OpenAI.Images.ImageGenerateParams
					);
				}

				const b64_json = imgResp.data?.[0].b64_json;
				console.log("b64_json.length ===> ", b64_json?.length);
				const endSecs = Date.now() / 1000;
				console.log(
					`Image generation took ${endSecs - startSecs} seconds`
				);
				if (b64_json) {
					const imageBuffer = Buffer.from(b64_json, "base64");
					// path is just relative to the vault
					const relName = `${moment().format(
						"YYYYMMDD-HHmmss"
					)}_${slugify(prompt.substring(0, 32))}.webp`;
					this.app.vault.createBinary(relName, imageBuffer);

					const aiLevel = headings[thisHeadingIdx].level + 1;
					// use more characters for the heading
					let aiResp = `\n\n${"#".repeat(aiLevel)} AI: ${slugify(
						prompt.substring(0, 64),
						false
					)}...\n\n`;
					aiResp += `![[${relName}]]\n`;
					replaceRangeMoveCursor(editor, aiResp);
				}
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
		if (this.settings.debug) {
			console.log(`Using model ${model} for "${markdownFile.path}"`);
		}
		return model;
	}

	/**
	 * Determine whether user wants to use a system prompt file and if so which one.
	 *
	 * If the file has a frontmatter key aicmd-system-prompt-file, that will be used, else the default configured system prompt file, else the default configured system prompt text.
	 *
	 * @param markdownFile File that the user is working on
	 * @returns Path to the system prompt file to use or empty string "" if the user wants to use the default system prompt text.
	 */
	getRequestedSystemPromptFile(markdownFile: TFile): string {
		const cache = this.app.metadataCache.getFileCache(markdownFile);
		const systemPromptFile =
			cache?.frontmatter?.["aicmd-system-prompt-file"] ??
			this.settings.systemPromptFile;
		if (this.settings.debug) {
			console.log(
				`Using system prompt file ${systemPromptFile} for "${markdownFile.path}"`
			);
		}
		return systemPromptFile;
	}

	handleOpenAIError(e: Error) {
		// this will give a nice traceback in the console
		console.error("Error while streaming from OpenAI:", e);
		// delay=0 so that the notice stays up until the user dismisses it
		new Notice(
			`An error occurred while communicating with the OpenAI-style service. Details: ${e}`,
			0
		);
	}

	async getOpenAI() {
		// openrouter.ai/api/vi/chat/completions/...
		// api.openai.com/v1/chat/completions/...
		// api.perplexity.ai/chat/completions/... WHOOPS
		// in retrospect, I would have wanted to define this as the API host up to the v1, but now we have to handle the legacy situation
		let baseURL = this.settings.apiHost;
		if (
			baseURL.contains("api.openai.com") ||
			baseURL.contains("openrouter.ai")
		) {
			if (!baseURL.contains("v1")) {
				baseURL += "/v1";
			}
		}
		console.log(`Using API base URL ${baseURL}`);
		let defaultHeaders: Record<string, string | null> = {
			"HTTP-Referer": "https://github.com/cpbotha/obsidian-ai-chat-as-md", // Optional, for including your app on openrouter.ai rankings.
			"X-Title": "Obsidian AI Chat as Markdown", // Optional. Shows in rankings on openrouter.ai.
		};
		if (baseURL.contains("api.perplexity.ai")) {
			defaultHeaders = {
				// openai package adds all of the x-stainless headers
				// however, perplexity API CORS setup then refuses us
				// it also refuses http-referer and x-title, so we don't even add them
				"x-stainless-os": null,
				"x-stainless-runtime": null,
				"x-stainless-arch": null,
				"x-stainless-lang": null,
				"x-stainless-helper-method": null,
				"x-stainless-timeout": null,
				"x-stainless-package-version": null,
				"x-stainless-runtime-version": null,
				"x-stainless-retry-count": null,
			};
		}
		const openai = new OpenAI({
			baseURL: baseURL,
			apiKey: this.settings.openAIAPIKey,
			timeout: 30 * 1000, // 30 seconds
			defaultHeaders: defaultHeaders,
			// we are running in a browser environment, but we are using obsidian settings to get keys, so we can enable this
			dangerouslyAllowBrowser: true,
		});

		return openai;
	}

	async getOpenAIImageGen() {
		const openai = new OpenAI({
			apiKey: this.settings.openAIImageGenAPIKey,
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
			// adding this primarily for perplexity, but it seems some openai models also support it
			// https://docs.perplexity.ai/guides/search-context-size-guide
			// https://platform.openai.com/docs/guides/tools-web-search?api-mode=chat
			// https://openrouter.ai/docs/features/web-search#specifying-search-context-size
			web_search_options: { search_context_size: "medium" },
		});
	}

	async getSystemPrompt(markdownFile: TFile) {
		const systemPromptFilename =
			this.getRequestedSystemPromptFile(markdownFile);
		if (systemPromptFilename) {
			// we expect the user to specify the actual file path relative to the vault, and to include the extension,
			// e.g. "prompts/productivity coach.md". We considered using the same path resolution as for embedded files
			// (see metadataCache.getFirstLinkpathDest()), but that only makes sense for locally specified prompts, not
			// those specified in the global plugin configuration.
			const systemPromptFile =
				this.app.vault.getFileByPath(systemPromptFilename);
			if (!systemPromptFile) {
				new Notice(
					`AI Chat as MD could not read system prompt file "${systemPromptFilename}". Please check its path in the plugin settings or in this file's frontmatter.`
				);
				return null;
			}

			let sysContentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[];
			try {
				sysContentParts = (await convertRangeToContentParts(
					null,
					null,
					systemPromptFile,
					this.app.vault,
					this.app.metadataCache,
					true, // base64Images, so this returns normal ChatCompletionContentPart[]
					this.settings.debug
				)) as OpenAI.Chat.Completions.ChatCompletionContentPart[];
			} catch (e) {
				new Notice(
					`Error parsing system prompt file "${systemPromptFilename}": ${e}`
				);
				return null;
			}

			// concatenate all of the "text" members
			// effectively throwing out type == "image"
			// until there are models that can take image as part of their system prompts
			const systemPrompt = sysContentParts
				.filter((part) => part.type === "text")
				.map((part: OpenAI.ChatCompletionContentPartText) => part.text)
				.join("\n");

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

		const systemPrompt = await this.getSystemPrompt(markdownFile);
		if (!systemPrompt) {
			return;
		}
		const messages = initMessages(systemPrompt);
		try {
			messages.push({
				role: "user",
				content: (await convertRangeToContentParts(
					selStartOffset,
					selEndOffset,
					markdownFile,
					this.app.vault,
					this.app.metadataCache,
					true, // base64Images
					this.settings.debug
				)) as OpenAI.ChatCompletionContentPart[],
			});
		} catch (e) {
			new Notice(
				`Error converting selection to OpenAI-style messages: ${e}`
			);
			return;
		}

		if (this.settings.debug) {
			console.log("About to send to AI:", messages);
		}

		const model = this.getRequestedModel(markdownFile);

		const didSwitchMode = maybeSwitchToSourceMode(view);
		let roc: CitationsAndSearchResults = {};
		try {
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
				// if there are citations in the chunk, save them
				extractSearchResultsOrCitations(
					chunk as ChatCompletionChunkWithCitationsOrSearchResults,
					roc
				);
				if (chunk.usage) {
					console.log("OpenAI API usage:", chunk.usage);
				}
			}
		} catch (e) {
			this.handleOpenAIError(e);
		}

		// create numbered list of citations from citations array
		renderSearchResultsOrCitations(roc, editor);

		replaceRangeMoveCursor(editor, "\n");
		//statusBarItemEl.setText("AICM done.");

		maybeSwitchBackToPreviewMode(view, didSwitchMode);
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
				"OpenAI-style API host up to just before /chat/, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1 or https://api.perplexity.ai"
			)
			.addText((text) =>
				text
					.setPlaceholder(
						"Enter the API host, e.g. https://api.openai.com/v1"
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

		new Setting(containerEl).setName("Image Generation").setHeading();
		new Setting(containerEl)
			.setName("API key for OpenAI image generation")
			.setDesc("Usually of the form sk-xxxx")
			.addText((text) =>
				text
					.setPlaceholder("Enter your secret")
					.setValue(this.plugin.settings.openAIImageGenAPIKey)
					.onChange(async (value) => {
						this.plugin.settings.openAIImageGenAPIKey = value;
						await this.plugin.saveSettings();
					})
			);

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
