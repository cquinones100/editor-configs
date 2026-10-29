# A file-system plugin system for Switchboard

Make mission control's views, and the settings that turn them on and off, come
from plugins found on disk by where they are and the convention they follow, so
anyone can write a plugin, share it as a git repository, and install it without
touching Switchboard itself.

## Today

Switchboard already has sidebar plugins (`lib/sidebar/plugins.js`): a plugin is
one `.js` file exporting `title`, `intervalSeconds`, `sidebar`, `fetch()` and
`open()`. It is loaded only when named in `~/.config/tmux-sidebar/config.json`,
looked for in `~/.config/tmux-sidebar/plugins/` and then
`lib/sidebar/plugins/`, and its items are drawn as a mission control view. One
ships with Switchboard: `github.js`.

What it can't do:

- **Settings.** A plugin can't add a setting; the Settings view lists only
  `tmux/settings.json`, and turning a plugin on means editing a JSON file.
- **Menus.** Enter only opens an item's link. The built-in views have a menu of
  actions on Enter (`itemChoices`, `boardChoices` in `lib/sidebar/daemon.js`).
- **Notifications.** A plugin can't put anything in the sidebar's
  Notifications block.
- **Setup help.** A plugin can't say what it needs or how to set it up, which
  every built-in view now does (`lib/sidebar/setup-help.js`).
- **The built-in views don't use it.** Calendar, Slack, Inbox, Tickets, PRs and
  CI are wired into the daemon by hand, each with its own module, setting and
  cases in `views.js`, `daemon.js` and `render.js`.

## Make it

### A plugin is a folder

```
<name>/
  plugin.json   the manifest
  index.js      the code
  README.md     what it does and how to set it up (optional)
```

Dropping a folder in one of the places below installs it.

### Where plugins are found

In this order, a later one never replacing an earlier one of the same name:

1. `lib/plugins/<name>/`, the ones Switchboard ships.
2. `~/.config/switchboard/plugins/<name>/`, your own, next to your settings.
3. `~/.local/share/switchboard/plugins/<name>/`, the ones installed from a git
   repository (see Distribution).

Keep reading `~/.config/tmux-sidebar/plugins/<name>.js` single files for a
release, as phase 1 converts them, then drop it.

### The manifest

```json
{
  "name": "pagerduty",
  "title": "On call",
  "description": "Incidents assigned to you in PagerDuty",
  "switchboard": 1,
  "refreshSeconds": 120,
  "needs": {
    "commands": ["jq"],
    "keychain": ["pagerduty-api-key"],
    "connectors": []
  },
  "settings": [
    { "key": "pagerduty_team_only", "label": "Only my team", "description": "Only incidents for the team in the plugin's options", "default": false }
  ]
}
```

- `switchboard` is the plugin API version it was written for; a plugin asking
  for a version the daemon doesn't know isn't loaded, and Settings says why.
- `needs` drives the setup help: what is missing is named, with how to get it,
  before the plugin's own `setup()` is asked (below).
- `settings` uses `tmux/settings.json`'s shape. The category defaults to the
  plugin's title.

### Settings come from the folder

`lib/settings.js` and `tmux/settings.sh` read `tmux/settings.json` and then
every plugin's manifest:

- Each plugin gets an on/off setting of its own, `plugin_<name>`. A plugin
  Switchboard ships is on by default; one of yours or one installed from git is
  off until you turn it on (see Trust).
- Its declared settings appear under its category in mission control's
  Settings view, saved in `~/.config/switchboard/settings.json` like any other,
  and set as `@setting_<key>` tmux options.

Nothing central lists plugins or their settings, so adding one changes no file
of Switchboard's.

### What the code exports

`index.js` returns data, never drawing. The daemon draws everything, so a
plugin can't slow the drawing path, start processes on it, or break the screen
with escape codes.

```js
module.exports = {
  // The items, as of now. Runs in the background, every refreshSeconds and
  // when you go to the view; it may take its time and use the network.
  async fetch(ctx) {
    return [{ id, title, detail, body, state: "attention" | "active" | "idle", url, time }];
  },

  // What Enter offers on an item, its usual action first. Without it, Enter
  // offers to open the item's url.
  actions(item, ctx) {
    return [{ key: "o", label: "Open it", run: async () => ctx.open(item.url) }];
  },

  // What goes in the sidebar's Notifications block, or nothing.
  notices(items, ctx) {
    return items.filter((i) => i.state === "attention").map((i) => ({ title: i.title, detail: i.detail, item: i }));
  },

  // When it can't fetch: what's missing and how to set it up, or nothing
  // when all is well. Shown in place of the view's items, wrapped.
  async setup(ctx) {
    if (!(await ctx.keychain("pagerduty-api-key"))) return "PagerDuty isn't set up: …";
  },
};
```

`body` is drawn as `render.js`'s `slackLines` draws a Slack message, so a
plugin can hand over Markdown-ish text with lines, bullets and code.

### The toolkit a plugin gets

`ctx` holds everything a plugin may use, so it needs nothing from Switchboard's
internals:

- `options`: the plugin's settings, as their values.
- `run(command, args)`: a command's output, never through a shell, with a
  timeout.
- `keychain(service)`: a secret from the macOS Keychain.
- `connector(tool, input)`: a call to one of Claude's connectors, through
  `lib/connector.js`, its "not connected" errors turned into setup help.
- `open(url)`: open a link through `tmux/open-url.sh`.
- `log(...)`: a line in the daemon's log, prefixed with the plugin's name.
- `state`: a directory of its own under the sidebar's state directory.
- `tabs`: the open tabs, as the sidebar knows them, read only.

### The built-in views move over

One at a time, each a commit of its own, each proving the API on a real case
before the next:

1. Calendar (`calendar.js`, `calendar-feed.js`): a fetch, an Enter menu with
   RSVP, a notice for the next meeting, and setup help.
2. Slack (`slack.js`, `slack-look.js`): a connector call, seen and dismissed
   state, `body` drawn as Slack's.
3. Inbox, Tickets, PRs, CI.

Tabs, the Work map, Settings and Sessions stay part of the core: they read tmux
and Claude Code, not a service, and the rest of Switchboard depends on them.

### Distribution

A plugin is a git repository with the folder at its root.

- `setup.sh plugin add <git url>` clones it into
  `~/.local/share/switchboard/plugins/<name>/` at its current commit and
  records the repository and commit in `~/.config/switchboard/plugins.json`.
- `setup.sh plugin update [<name>]` fetches, shows the commits since the
  pinned one, and moves the pin only after you say yes, as `tmux/plugins.txt`
  pins tmux's plugins.
- `setup.sh plugin remove <name>` removes it and its pin.
- `M-p`'s "Update Switchboard" also offers updates to installed plugins.

### Trust

A plugin runs code in the daemon, with access to your Keychain and the network,
so one you didn't write is off until you turn it on. Turning it on in Settings
first shows what its manifest says it needs (commands, Keychain entries,
connectors) and where it came from, and asks. This follows the rule in
`CLAUDE.md` that nothing here runs code another repository supplies unless you
have trusted it.

### A test kit

`bin/switchboard-plugin test <folder>` loads a plugin, checks its manifest,
runs `fetch()` with stand-ins for `run`, `keychain` and `connector` (answers
given in a JSON file), and prints its view, menu and notices as text, so a
plugin's author can test it without a live setup or a running daemon.

## Phases

1. **Folders, manifest and settings.** Discovery from the three places, the
   manifest, `plugin_<name>` and declared settings in the Settings view,
   `fetch`, `actions`, `notices` and `setup`, and the toolkit. Convert
   `github.js` into a folder. Document the format in `bin/README.md`.
2. **The built-in views move over**, Calendar first.
3. **Distribution and trust**: `setup.sh plugin`, pinning, the trust prompt,
   update offers, and the test kit.

## Acceptance

- A folder dropped in `~/.config/switchboard/plugins/` with a manifest and an
  `index.js` shows up in Settings, off; turned on, it is a mission control view
  with its items, Enter menu, notifications and setup help, and no file of
  Switchboard's changed.
- Calendar, Slack, Inbox, Tickets, PRs and CI are plugins in `lib/plugins/`,
  behaving as they do today, their settings unchanged for anyone upgrading.
- `setup.sh plugin add <url>` installs a plugin pinned to a commit, and an
  update shows what changed before taking it.
- A plugin that throws, hangs or returns nonsense shows an error in its own
  view and never stops the sidebar or another view.

## Out of scope

- Plugins that change tmux key bindings, the sidebar's layout, or Claude Code's
  hooks.
- A registry or marketplace; a git URL is how a plugin is shared.
- Plugins written in anything but Node.
