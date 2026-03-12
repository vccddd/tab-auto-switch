# Tab Auto Switch

A Chrome extension that automatically cycles through a set of selected tabs at customizable intervals, keeping your dashboards and monitoring pages always in view.

## Features

- Select any combination of tabs to include in the rotation cycle
- Configurable switch interval (per-tab or global)
- Optional page refresh after each tab switch
- Pause/resume cycling without losing your configuration
- Save and load tab presets for quick setup
- Export a single preset to JSON and import presets from JSON files
- Drag-and-drop reordering of tabs in the cycle
- Displays version number in the popup

## Installation

1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder

## Usage

1. Click the extension icon in your browser toolbar
2. Check the tabs you want to include in the rotation
3. Set the switch interval (in seconds) for each tab or use the global default
4. Toggle the switch to start auto-cycling
5. Use the pause button to temporarily suspend cycling without disabling it

## Permissions

| Permission | Purpose |
|------------|---------|
| `tabs` | Query open tabs and switch between them |
| `storage` | Save user configuration (selected tabs, intervals, presets) |
| `scripting` | Inject content scripts to detect user activity |
| `alarms` | Reliable timer for tab-switching intervals (required for MV3 Service Workers) |
| `<all_urls>` | Run content scripts on all pages to detect user activity |

## License

MIT License
