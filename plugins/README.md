# Plugins that come with Mirador

Each folder here with a `plugin.json` is a plugin Mirador loads at every start, before the ones in `~/.mirador/plugins`. They are part of Mirador, so Settings lists them without update or remove, and a plugin installed with the same name doesn't load.

They have no build step: Mirador imports the host module as it is and bundles the view, with whatever it imports, into one module when it starts. Editing a file here asks for a host restart, as editing `host/` does.
