# UltiSync

An Obsidian plugin that synchronizes selected vault files with a single GitHub
repository through GitHub's Git Database REST API. It runs on Obsidian Desktop
and on iOS.

The plugin does not shell out to Git, and it never force-pushes. It talks to the
GitHub API directly, so no Git binary is required on either device.

## Before you start

Use a disposable test vault and a disposable test repository until you have
verified the behavior you depend on. This plugin writes to your vault and to
your repository.

## Network use and privacy

UltiSync talks to exactly one remote service: the GitHub REST API at
`https://api.github.com`. It is used to read and write the repository you
configure — refs, commits, trees and blobs — and nothing else.

There is no telemetry, no analytics, no update check, and no server operated by
this plugin's author. Your notes and your access token are sent only to GitHub,
using a token you create yourself. The author never receives any of your data
and has no way to.

## Features

- Refs, commits, trees and blobs via the GitHub Git Database REST API
- Fine-grained personal access token authentication
- Sync on demand, an immediate push, and a first-run initial pull
- A starting-point comparison that lets a vault merge with, replace, or be
  replaced by the repository, with every loss listed and confirmed first
- Debounced automatic push after local changes settle
- Polling and a pull on app activation while Obsidian is in the foreground
- Independent pull and push extension filters, and ignored path prefixes
- SHA-256 local content tracking against remote blob SHAs
- Full remote tree snapshot recorded at the last synced commit
- Content-based rename detection across devices
- Three-way merge of Markdown changed in both places
- Conflict copies and explicit keep-local / keep-remote resolution
- Status bar, ribbon icon and commands

## Requirements

Build:

- Node.js 18 or newer
- npm

GitHub:

- A repository with at least one commit
- A fine-grained personal access token scoped to that repository
- Repository permission: **Contents: Read and write**

The plugin pins the GitHub REST API version it sends in the
`X-GitHub-Api-Version` header.

## Build

```bash
npm install
npm run build
```

The production build emits `main.js`. The plugin runtime needs three files:

```text
manifest.json
main.js
styles.css
```

For a watch build:

```bash
npm run dev
```

## Install

Copy the three runtime files into your vault:

```text
<VAULT>/.obsidian/plugins/ultisync/
```

Then open **Settings → Community plugins**, disable Restricted mode if it is on,
enable **UltiSync**, and open the plugin settings.

On iOS the same three files go in the same location. Build on a desktop and
transfer them into the vault using whatever file transfer method you already
use for that vault.

## Configuration

In the plugin settings, set:

```text
GitHub owner:           your GitHub username or organization
GitHub repository:      repository name
Branch:                 main
Personal access token:  your fine-grained PAT
```

Scope the token to the target repository and grant it only the Contents
read/write permission. Nothing else is needed.

The token field is a password input, and the token is never written to a log or
a commit. On Obsidian 1.11.4 and later it is held in Obsidian's own secret
storage for the vault. On earlier versions there is no secret storage, so it is
stored in plain text in the plugin's data file inside the vault's configuration
folder. UltiSync never syncs that folder, but anything that copies your whole
vault — iCloud, Dropbox, Obsidian Sync, a backup — copies the token with it.
You can revoke it on GitHub at any time.

Uninstalling the plugin removes its folder but not the vault's secret store,
and Obsidian gives a plugin no chance to act at uninstall time. So the next
installation of UltiSync in that vault, finding no data file but a token in
the store, clears the token rather than adopting it. The reset arrow at the
top of the settings tab clears it immediately.

Use **Test connection** to verify authentication, repository access and the
branch. It reports the branch ref and the current commit SHA.

## Extensions

The pull and push lists are independent, and both default to:

```text
.md .canvas .base .png .jpg .jpeg .webp .svg
```

Audio, video and PDF are supported and one checkbox away, but are off by
default — see [Repository size and large files](#repository-size-and-large-files)
below. Settings are local to each installation, so a phone and a desktop can
carry different configurations.

The selectable set is the file types Obsidian itself supports:

```text
.md .canvas .base
.png .jpg .jpeg .gif .webp .svg .bmp .avif
.pdf
.mp3 .wav .m4a .ogg .3gp .flac
.mp4 .webm .ogv .mov .mkv
```

Matching is case-insensitive. **Select all** and **Clear all** are available.

## Repository size and large files

GitHub publishes these limits, and they apply to your repository:

- Files over 50 MiB push successfully but produce a warning from Git. UltiSync
  sends them and notes them in the activity log.
- Files over 100 MiB are blocked outright. UltiSync does not attempt them; it
  names them and lets the rest of the push through.
- GitHub recommends repositories stay "ideally less than 1 GB, and less than
  5 GB is strongly recommended", and may email you asking for corrective action
  if a repository strains its infrastructure.

Nothing in GitHub's terms restricts what kind of files you keep in a repository,
so syncing images, PDFs or audio is fine as far as that goes. The thing worth
knowing is mechanical: Git keeps every version of every file forever. A 4 MB
image edited ten times occupies 40 MB of history permanently, and removing it
means rewriting history. Text compresses and deduplicates well; media does not.

That is why audio, video and PDF are off by default. Turn them on if you want
them — just size the repository for a growing archive rather than for the
current contents of your vault.

## Ignored paths

One path or path prefix per line:

```text
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

Ignored paths are never pulled or pushed. The vault's `.trash` folder and
Obsidian's configuration folder (`.obsidian` unless you have changed it) are
always ignored, which is why the plugin's own data file never reaches GitHub.

## Commands

```text
Sync now
Show status
Show conflicts
Open status panel
Open settings
```

Push and reset are buttons in the plugin settings under **Danger zone**. Both
work whether the Sync switch is on or off, and both show their progress in the
button itself while they run. Pulling is automatic, and **Sync now** forces a
full cycle.

Commits created by the plugin look like:

```text
Sync from desktop at 2026-08-16 11:45:22
```

## Behavior

### Linking a vault

The first time credentials are saved, or Sync is switched on for a vault that
has never been linked, the plugin compares the vault with the repository and
puts the result to you before anything moves. Files that exist on both sides
with the same bytes are recorded as synced and never transferred.

Two questions follow, each only when it applies:

- **Which version wins** for files that exist in both places with different
  contents. There is no shared history to merge from, so one side has to.
  Choosing this vault replaces GitHub's copy in the linking commit; choosing
  GitHub trashes the local copy and downloads GitHub's.
- **What to do with files only one side has.** *Keep both* downloads GitHub's
  extras and uploads the vault's. *Use only this vault* deletes GitHub's extras
  from the repository. *Use only GitHub* moves the vault's extras to the trash.

Anything a choice loses is listed and confirmed before the plugin acts. A file
deleted from GitHub remains in the repository's history; a trashed file follows
Obsidian's own **Deleted files** setting.

Pressing **Push** on a vault that has never been linked runs the same
comparison, and the choice made there is what carries the push out. Sync stays
off in that case; only the switch turns it on.

Saving credentials that point at a different repository or branch clears the
vault's synchronization record first. Tracking built against one repository
would read as mass deletions against another. Saving a new token for the same
repository changes nothing else.

### Automatic push

A relevant local create, modify, delete or rename marks the vault dirty and
starts a timer. Every further relevant event resets it. The push happens once
the delay has elapsed since the last modification.

### Pull

The branch head is read first. Tree and blob data are only fetched when the
remote SHA has changed.

### iOS

There is no continuous background execution. The plugin checks on activation,
and polls only while the app is visible.

### Conflicts

When a path changed both locally and remotely since the last synchronized
state, the plugin does not pick a winner. It keeps the local file and writes a
remote conflict copy where possible. **Show conflicts** offers keep local, keep
remote, or clear. Binary files are never merged.

A conflict record is sticky. It is removed only by an explicit resolution, or
when the plugin observes that both sides now hold identical bytes. That check
runs on every pull and push, and also on the quiet path where the branch has
not moved, because two devices frequently settle a conflict by converging on
the same content. The comparison uses the recorded `lastSyncedTree`, so it
costs no request.

### Stale branch reads

Branch heads are read conditionally, and GitHub's ref reads are eventually
consistent. A read taken shortly after a push can return the previous head,
either from GitHub or from a 304 served out of the local ETag cache.

The platform's own HTTP cache is bypassed for these reads. Obsidian's
`requestUrl` goes through Chromium's cache on desktop and the system cache on
iOS, and GitHub marks API responses cacheable for a minute, which is long
enough for a five-second poll to keep reporting a branch that has moved.

Before applying anything, the plugin asks GitHub how the returned head relates
to the commit it last synced. A head that is `behind` or `identical` is treated
as stale: nothing is applied, the cached ETag is dropped so the next poll asks
for a fresh body, and the pull ends.

Without that check the vault flickers. Files the device just pushed still carry
their new blob SHA locally, so against a stale tree each of them reads as a
remote change, gets overwritten with its previous contents, and is restored on
the following poll.

### A synced commit GitHub no longer knows

If the commit this vault last synced to has been rewritten away — a force push
or a recreated branch — GitHub answers the comparison with 404. That is
treated as the two sides having diverged: the remote tree is reconciled with
deletions withheld, and synchronization carries on. Only a 404 that the
repository itself answers, when the branch is read again, switches Sync off.

### Deletions

A path counts as deleted only when the tree this vault last synced to contained
it and the current remote tree does not. The full tree is recorded alongside
`lastSyncedCommit`, so a file this device never pulled is never mistaken for one
that was removed.

Deletions are applied only when GitHub reports the remote commit as `ahead` of
the last synced commit. A stale read reads as `behind`, and nothing is deleted.

Deletions propagate in both directions. Removed files are trashed rather than
destroyed outright: the plugin hands them to Obsidian, which puts them wherever
your **Deleted files** preference under **Files and links** says. Three guards
limit the blast radius:

- A push is refused when the vault reports no eligible files while the tracking
  table is populated. That indicates an index that has not finished building,
  not an instruction to delete everything.
- A file the other device edited since this one last saw it is reported as a
  collision rather than removed.
- A batch of more than twenty deletions is held back on an automatic push and
  reported. Pushing manually sends it after a confirmation listing the files.

### Renames

A rename arrives as one path disappearing and another appearing. When the blob
SHA of the vanished path matches a newly appeared path, the local file is moved
instead of being deleted and downloaded again. This runs on every pull, since a
rename preserves content.

A file renamed and edited in the same commit has a different SHA, and is handled
as a deletion plus a download.

### Returning to a device

Bringing Obsidian back to the foreground checks the branch at once, and at most
every five minutes also runs the thorough check: file counts against the
recorded tree, and files whose size on disk disagrees with GitHub while
claiming to be the same blob. Clicking in and out of the window does not pay
for that tree read each time.

### Rate limits

Branch reads are conditional, so an unchanged branch answers `304 Not Modified`
and costs nothing against GitHub's hourly budget. If GitHub does refuse for a
rate limit, UltiSync stops asking rather than retrying on the next tick: it
honours the `retry-after` header when GitHub sends one, otherwise waits for the
window named by `x-ratelimit-reset`, otherwise a minute. Repeated refusals back
off exponentially. The status bar says when synchronization resumes.

### Files outside the extension filters

Remote files whose extension is not in the pull list are ignored locally, and
are not deleted from GitHub. Local files whose extension is not in the push list
are not pushed.

## Limitations

- One repository and one branch per installation
- No device locking
- No force push
- No continuous background synchronization on iOS
- The recursive tree response must fit within GitHub's tree response limit
- The repository needs an initial commit before the first initial pull

## Project layout

```text
src/
├── main.ts
├── platform.ts
├── types.ts
├── TokenStore.ts
├── github/
│   └── GitHubClient.ts
├── sync/
│   ├── ChangeDetector.ts
│   ├── ConflictDetector.ts
│   ├── MergeAttempt.ts
│   ├── Migrations.ts
│   ├── PullManager.ts
│   ├── PushManager.ts
│   ├── RenameRecord.ts
│   ├── SetupCheck.ts
│   ├── SetupPlan.ts
│   ├── SyncManager.ts
│   ├── SyncState.ts
│   ├── TextMerge.ts
│   └── Verify.ts
├── ui/
│   ├── ConfirmModal.ts
│   ├── ConflictModal.ts
│   ├── SettingsTab.ts
│   ├── SetupCheckModal.ts
│   ├── StatusBar.ts
│   └── SyncPanelView.ts
└── vault/
    ├── PathFilter.ts
    └── VaultScanner.ts
```

## Support

Having trouble or found a bug?

- 🐛 **Bug:** [open an issue](https://github.com/msachet5/obsidian-ultisync/issues/new?labels=bug)
- 💡 **Feature request:** [open an issue](https://github.com/msachet5/obsidian-ultisync/issues/new?labels=enhancement)
- ❓ **Question:** [ask in Discussions](https://github.com/msachet5/obsidian-ultisync/discussions)

Anything that names something to build or fix belongs in
[Issues](https://github.com/msachet5/obsidian-ultisync/issues), bugs and feature
requests alike, so there is one queue to work through. Discussions is for
everything else: setup help, questions about how a part of this works, and ideas
that are not a request yet.

Please check the [existing issues](https://github.com/msachet5/obsidian-ultisync/issues)
and [discussions](https://github.com/msachet5/obsidian-ultisync/discussions)
first, in case it has already been answered. Posting needs a free GitHub
account. There is no anonymous route on purpose: nearly every report about a
sync problem needs a follow-up question, and an anonymous one cannot be
answered.

A bug report is most useful with your UltiSync version, your Obsidian version
and whether you are on desktop or mobile. **Settings → UltiSync → Report a
bug** opens an issue with all three already filled in.

For anything security-related, please contact me privately through my
[GitHub profile](https://github.com/msachet5) rather than posting it publicly. A
token pasted into a public issue is a token you have to revoke.

## Buy me a coffee

UltiSync is free and stays free. If it has been useful, you can buy me a coffee
at [buymeacoffee.com/sachetmulimani](https://buymeacoffee.com/sachetmulimani).

This is entirely optional and changes nothing about the plugin: there are no
paid tiers and no features held back.

## License

MIT. See [LICENSE](LICENSE).
