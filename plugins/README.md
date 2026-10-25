# Plugins that come with Mirador

Each folder here with a `plugin.json` is a plugin Mirador loads at every start, before the ones in `~/.mirador/plugins`. They are part of Mirador, so Settings lists them without update or remove, and a plugin installed with the same name doesn't load.

They have no build step: Mirador imports the host module as it is and bundles the view, with whatever it imports, into one module when it starts. Editing a file here asks for a host restart, as editing `host/` does.

A plugin's settings go in its `plugin.json`, as `settings`: each with an `id`, a `label`, an optional `hint`, its `choices` (a `value` and a `label` each) and the `default` value. Settings shows them under the plugin, and Mirador keeps what the user chose, the same in every browser. An item type that sets `opensWithRoom: { setting: "<id>" }` opens full screen or beside the chat as that setting says, so its choices must be `fullscreen` and `beside`; the code review plugin's "Open reviews" is one.
