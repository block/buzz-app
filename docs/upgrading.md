# Upgrading from the old Buzz app

This page is for people using the Buzz desktop app from
[block/buzz](https://github.com/block/buzz). The new Buzz app lives here, in
block/buzz-app. It adds plugins and remote agents.

## Get the new app

Download the latest release from [buzz.xyz](https://buzz.xyz) or view
[all releases](https://github.com/block/buzz-app/releases). Available for
macOS, Windows and Linux.

The old app's updater does not deliver the new app, so this is a fresh install.

## What's new: plugins

Buzz is now built on plugins, so anyone can make it work the way they want. The
core of the app is made of plugins too:

- **Messages**: channels, direct messages and threads.
- **Agents**: where you create and manage agents.
- **Claude** and **Codex**: each agent integration is its own plugin.
- **Huddles**: audio conversations.

Plugins you add use the same building blocks, so they can go as far as the
built-in ones.

To get and manage plugins:

1. Open **Settings → Plugins → Manage plugins**. Use the **All plugins** and
   **Essentials** tabs or the search field to find a plugin. Built-in plugins
   are turned on and off here.
2. To add a plugin, choose **Add**. To add from a folder, drop the plugin
   folder in or choose **Browse**. To add from Git, fill in
   **Git or GitHub repository** and choose **Find**.
3. Buzz shows the access the plugin asks for. Review it, then choose
   **Install plugin**.

Plugins are trusted code that runs inside the app, so add only ones you trust.

To write your own, read the [plugin authoring guide](plugin-authoring-guide.md)
and try the [example plugins](../examples/plugins/README.md). The plugin API is
still a preview and may change, so an app update can break a plugin.

## What's new: remote agents

A remote agent runs on a hosted machine instead of your computer. It keeps
working when Buzz is closed or your laptop is off. It cannot open files on your
computer.

Builderlab is the hosted service, built into Buzz, that runs these agents. You
sign in with a Builderlab account to use them.

If remote agents are available for your account, create one like this:

1. Open **Agents** and choose **New agent**, then **Create a new agent**. If
   you have no agents yet, choose **Create your first agent** instead.
2. In the **Harness** menu, pick **Builderlab** under **Remote**.
3. Choose **Sign in** beside Harness and sign in with your Builderlab account.
4. Choose a model and a thinking level.
5. Choose **Create agent**, read the introduction, then choose **Let’s go**.

Your remote agents are listed under **Remote agents** in
**Settings → Plugins → Builderlab**.

Local agents still work as before. They run on your own computer and appear
under **Local** in the same **Harness** menu.

## Next steps

New to this app? The [README](../README.md) covers getting started.
