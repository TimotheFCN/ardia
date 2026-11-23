# Bitwarden plugin (prototype)

A password-manager plugin that fills from Bitwarden or Vaultwarden through
[rbw-ng](https://github.com/TimotheFCN/rbw-ng)'s embedded agent, and it uses `passwordManager.fill: "tool"`, the mode
`docs/plugins.md` reserved for managers with their own vault.

Its sidecar is `bridge/`, a small Rust program that speaks Ardia's plugin channel. It starts
`rbw-agent --embedded --accounts` from the plugin's folder and carries messages both ways: Ardia's vault calls become
the agent's requests (the account moves out of the call's input), the agent's answers, errors and events become
Ardia's `result`, `vault.ready` and `vault.event`, and calls that aren't the browser's own vault calls are refused.
It holds no keys; rbw-ng knows nothing of Ardia.

Each Ardia profile has its own Bitwarden accounts, one or several, each in an agent process of its own (`--accounts`):
signing in, locking and signing out in one space leaves the others alone, and a private window uses its profile's
accounts.

The vault stays in the agent: Ardia gets the logins' names and usernames, and a password or code only for the login
being filled, only on a page whose address the login matches. The protocol is
[rbw-ng's docs/embedding.md](https://github.com/TimotheFCN/rbw-ng/blob/embedded/docs/embedding.md).

## What this branch changes in Ardia

| Where | What |
| --- | --- |
| `extras/bitwarden-plugin/` | The plugin: its manifest, `bridge/` (its sidecar, between Ardia's channel and rbw-ng's agent), and the install script |
| `lib/pluginPasswordManager.ts`, `lib/pluginManifest.ts` | `fill: "tool"` is accepted, and needs a sidecar |
| `state/plugins/tools.ts` | A `vault` call kind; `callVault` sends it with Ardia as the caller, and keeps a verb's error code |
| `state/plugins/channelApi.ts` | The sidecar's `vault.ready` and `vault.event` |
| `state/vaults/` | The vault state (`store.ts`), accounts and sign-in (`accounts.ts`), the unlock choice and Touch ID through `passwords.confirmOwner` (`unlock.ts`), viewing and changing logins (`logins.ts`), the key's menu (`menu.ts`, drawn by `components/site/VaultMenu.tsx`) and filling (`fill.ts`) |
| `components/settings/panes/VaultPasswords.tsx`, `VaultLoginSheet.tsx` | A vault manager's Passwords page: accounts, how each unlocks, and its logins with view, add, edit and delete sheets |
| `state/plugins/surfaces.ts` | `showQuickPick`, the quick pick without the plugin-prompt count, for the first sign-in |
| `components/plugins/PluginQuickPick.tsx`, `components/settings/WindowedRows.tsx`, `state/settings/settingsScroll.ts` | Long lists (the quick pick, a settings page) build only the rows on screen |
| `PasswordsModule.swift`, `packages/hostapi/schema/passwords.ts` (and its generated files) | `passwords.confirmOwner`: a Touch ID (or Mac password) check that always asks |
| `state/site/passwordManagerChoice.ts`, `passwordManager.ts` | A vault manager's profiles get the key in `host` mode; its click opens Ardia's fill |
| `ArdiaWebView+FieldProviders.mm`, `+PageMessages.mm`, `WebKitTab+FieldProviders.swift`, `page_script.js` | In `host` mode the key reports the click and the focused field instead of opening macOS's Passwords panel, and sits beside a site's own show-password button |
| `DialogsModule.swift`, `PromptOptions.swift`, `dialogs.ts` | The native prompt takes `secure`: an `NSSecureTextField`, text kept as typed. Master passwords go through it, not a React Native field |
| `page_script.js`, `ArdiaWebView+PageMessages.mm`, `WebKitTab+FieldProviders.swift`, `pageEvents.ts` | In a vault profile, a submitted login reaches JS as the `vaultLogin` page event |
| `state/vaults/save.ts`, `components/site/VaultSavePrompt.tsx` | The offer to save or update a login after a submit, or after Use Strong Password |
| `NATIVE_API_VERSION`, `apiVersion` | 96 → 97 for the native changes |

## Trying it on a Mac

You need what `CONTRIBUTING.md` asks for (an Apple Silicon Mac, Xcode, CocoaPods, Node, pnpm 12), and Rust
(`curl https://sh.rustup.rs -sSf | sh`).

1. Build and start this branch:

   ```sh
   git clone --branch bitwarden-plugin https://github.com/TimotheFCN/ardia
   cd ardia
   pnpm install
   pnpm pods
   pnpm dev      # Metro; leave it running
   pnpm macos    # in a second terminal
   ```

2. Install the plugin into the dev instance, then quit and reopen the dev app:

   ```sh
   extras/bitwarden-plugin/install.sh --data-dir "$HOME/Library/Application Support/Ardia Dev"
   ```

   It fetches rbw-ng's `embedded` branch (`RBW_NG_REF` picks another) into `extras/bitwarden-plugin/.build`, builds
   `rbw-agent` and the bridge, and copies them with `plugin.json` to `<data dir>/config/plugins/bitwarden`.
   `--rbw PATH` builds a checkout you already have.

3. In Ardia: Settings › Plugins › Bitwarden › Turn On, then Settings › Profiles › Passwords › Password manager ›
   Bitwarden.

4. A vault to test with. Your own Bitwarden account works (bitwarden.com, bitwarden.eu or self-hosted), or a
   throwaway Vaultwarden (with Docker Desktop):

   ```sh
   docker run -d --name vw -p 127.0.0.1:8089:80 -e SIGNUPS_ALLOWED=true vaultwarden/server:latest
   ```

   Create an account at http://localhost:8089 and add a login for `https://github.com`. In Ardia, sign in with
   Self-hosted… and `http://localhost:8089`.

5. Open https://github.com/login and click the key in the username or password field:
   - the first time, Ardia asks where the vault is, the email and the master password (and a two-step or new-device
     code if the server wants one);
   - then Ardia's vault menu opens under the field: the site's logins with their usernames, grouped by account when
     the space has several. Pick one to fill it;
   - typing in its search field searches every login. Picking one saved for another site asks first, naming both
     sites: **Fill and Remember Site** adds the site to the login, **Fill Once** doesn't;
   - **Unlock** rows unlock a locked account, and **Use Strong Password** fills a new password (and its confirmation
     field) and offers to save the login right away. From the password field it fills that field; from the email
     field it fills the form's empty password fields;
   - **Manage Passwords…** opens the page below; the lock button locks every account of the space;
   - in a two-step code field, the key fills the current code of a login that has one;
   - Edit › AutoFill › Passwords… opens the same menu from the menu bar. A site's own show-password button keeps its
     place: the key sits just before it.
   After you sign in or sign up with a password Bitwarden doesn't have, Ardia offers **Save to
   Bitwarden?** (or **Update password in Bitwarden?** when the username is already saved for the site).
6. Settings › Profiles › (the profile) › Passwords now shows Bitwarden instead of Ardia's own passwords:
   - **Bitwarden Accounts**: each account with Lock or Unlock. Click one for its server, the Touch ID switches
     (below), **Sync Now** and **Sign Out…**. **Add Account…** signs another account in to the same profile.
   - **Unlock with Touch ID** (on by default): after the master password once, Touch ID unlocks until Ardia quits.
     Off, Ardia asks for the master password every time. **Touch ID when Ardia starts** asks you to confirm and for the
     master password once, then Touch ID works after a restart too.
   - **Saved Passwords**: search, **+** to add a login (the arrows button generates a password), and click one to
     see it. **Show** and **Copy** ask for Touch ID first; **Edit** changes the title, username, password, websites,
     verification code and notes; **Delete** moves it to Bitwarden's trash.

The agent logs at info level to the plugin's log in `<data dir>/PluginData/bitwarden/`, never a secret.

## Not in the prototype yet

- A save offer after a sign-in that doesn't submit a form or press a button (some single-page apps), and the username of
  a sign-in split over two pages: the offer leaves the username for you to type.
- Touch ID after a restart keeps its key in Ardia's Keychain entry and releases it after a Touch ID check in Ardia. A
  Keychain item behind `biometryCurrentSet`, so macOS itself asks, needs Ardia's signing (the data protection keychain).
- Filling inside cross-origin frames: the fill script runs in the top frame.
- A lock timeout setting (the agent's `configure` has it).
- Passkeys.
