# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] - 2024-07-07

### Fixed

- Bug fix release to get new system prompt file setting actually in

## [1.3.0] - 2024-07-07

### Added

- Add advanced option to use a markdown file in your vault as the system prompt. Besides the default instructions, you can for example add a list of memories.
- Reset system prompt to default

### Fixed

- Bug in configuring the API host, could not set anything but openrouter, sorry!

### Changed

- Updates to the README

## [1.2.0] - 2024-07-04

### Added

- New command to send selection to AI and then replace that selection with the response

### Fixed

- Review comments from [Obsidian Releases community review](https://github.com/obsidianmd/obsidian-releases/pull/3802#issuecomment-2209357530)

### Removed

- Plugin status messages on the status bar

## [1.1.0] - 2024-07-01

### Added

- New command to send whole selection to AI, ignoring heading hierarchy, and then append response right after
- Documentation about branching conversation
- Configurable debug mode to get super verbose console.log output

### Fixed

- Plugin metadata (description)
- Bug where an image right at the end of a section / selection would be ignored

## [1.0.0] - 2024-06-30

### Added

- First release of Obsidian AI Chat as Markdown
- Configure different OpenAI providers
- Support multiple conversations and conversation branches through the nesting of headings
