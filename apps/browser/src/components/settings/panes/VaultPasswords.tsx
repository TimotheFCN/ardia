import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { plural } from "../../../state/browser/model";
import type { ManagerPlugin } from "../../../state/site/passwordManagerChoice";
import { loadItems, whyNotReady, type Space } from "../../../state/vaults/store";
import { accountLabels, addAccount, serverHost, signOut } from "../../../state/vaults/accounts";
import { lock, setUnlockMode, unlock, unlockWithTouchId } from "../../../state/vaults/unlock";
import { syncNow } from "../../../state/vaults/logins";
import { useSpaceAccounts, useVaultAccount, useVaultBase, useVaultCapabilities, useVaultLogins } from "../../../state/vaults/hooks";
import { searchLogins, type VaultLogin } from "../../../state/vaults/search";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, DialogActions, DialogTitle, PopUp, SearchField, Sheet, space, Symbol, Text, TextField, Toggle, type Option } from "../../ui";
import { useTheme } from "../../ui/theme";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";
import { settingsLayout } from "../tokens";
import { ProfileSubPage } from "./ProfileSubPage";
import { WindowedRows } from "../WindowedRows";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { VaultLoginSheet, type Login } from "./VaultLoginSheet";

const SELF = "\u0000self";
const STATE_WORDS: Record<string, string> = { unlocked: "Unlocked", locked: "Locked" };
const UNLOCK_WORDS: Record<string, string> = { touchId: PLATFORM_TERMS.quickUnlock, touchIdAfterQuit: PLATFORM_TERMS.quickUnlock };

export function VaultPasswordsPage({ profileId, plugin }: { profileId: string; plugin: ManagerPlugin }) {
  const theme = useTheme();
  const base = useVaultBase(profileId);
  const { ready, views } = useSpaceAccounts(plugin.name, plugin.title, base);
  const capabilities = useVaultCapabilities(plugin.name);
  const [query, setQuery] = useState("");
  const names = useMemo(() => accountLabels(views), [views]);
  const unlocked = views.filter((v) => v.account.state === "unlocked");
  const unlockedKey = unlocked.map((v) => v.space.account).join("|");
  useEffect(() => {
    for (const v of unlocked) void loadItems(v.space);
  }, [unlockedKey]);
  const logins = useVaultLogins(views);
  const shown = useMemo(() => searchLogins(logins, query), [logins, query]);
  const many = views.length > 1;
  const nameOf = (s: Space) => names.get(s.account) ?? s.account;

  const openLogin = (login: Login | null) =>
    showSettingsSheet(<VaultLoginSheet plugin={plugin} login={login} accounts={unlocked.map((v) => ({ space: v.space, name: nameOf(v.space) }))} />);
  const opener = useRef(openLogin);
  opener.current = openLogin;
  const openRow = useMemo(() => (login: VaultLogin) => opener.current(login), []);
  const openSignIn = () => showSettingsSheet(<SignInSheet plugin={plugin} base={base} />);

  const unlockSpace = async () => {
    const locked = views.filter((v) => v.account.state === "locked").map((v) => v.space);
    const opened = await unlockWithTouchId(locked, plugin.title);
    if (!opened.length && locked[0]) await unlock(locked[0]);
  };

  if (!ready) {
    return (
      <ProfileSubPage>
        <SectionHeader title="Passwords" />
        <Group>
          <Row title={`${plugin.title} isn't ready`} description={`Its helper: ${whyNotReady(plugin.name)}.`} />
        </Group>
      </ProfileSubPage>
    );
  }

  return (
    <ProfileSubPage>
      <SectionHeader
        title={`${plugin.title} Accounts`}
        description="This profile fills logins from these accounts."
        action={views.length ? <Button title="Add Account…" onPress={openSignIn} /> : undefined}
      />
      <Group>
        {views.length === 0 ? (
          <Row title={`Sign in to ${plugin.title}`} description="Fill logins in this profile from your vault.">
            <Button title="Sign In…" kind="primary" onPress={openSignIn} />
          </Row>
        ) : (
          views.map((v) => (
            <Row
              key={v.space.account}
              icon={<Symbol name="person.crop.circle" size={18} color={theme.icon} style={ICON} />}
              title={nameOf(v.space)}
              description={[serverHost(v.account.server), STATE_WORDS[v.account.state ?? ""], UNLOCK_WORDS[v.account.unlock]].filter(Boolean).join(" · ")}
              onPress={() => showSettingsSheet(<AccountSheet space={v.space} name={nameOf(v.space)} />)}
            >
              {v.account.state === "unlocked" ? <Button title="Lock" onPress={() => void lock(v.space)} /> : <Button title="Unlock" onPress={() => void unlock(v.space)} />}
            </Row>
          ))
        )}
      </Group>

      {views.length > 0 && !unlocked.length ? (
        <Box gap="ml" style={LOCKED}>
          <Symbol name="lock.fill" size={26} color={theme.textTertiary} style={LOCK_ICON} />
          <Text size="title" weight="medium">
            Passwords are locked
          </Text>
          <Text size="small" tone="textSecondary">
            {`Unlock ${plugin.title} to see them.`}
          </Text>
          <Button title="Unlock" kind="primary" onPress={() => void unlockSpace()} />
        </Box>
      ) : null}

      {unlocked.length ? (
        <>
          <SectionHeader
            title={plural(logins.length, "Saved Password")}
            action={
              <Box row gap="s" style={CENTER}>
                <SearchField value={query} onChangeText={setQuery} placeholder="Search" width={200} />
                {capabilities?.manage ? <Button variant="icon" icon="plus" size="m" tooltip="Add Password" onPress={() => openLogin(null)} /> : null}
              </Box>
            }
          />
          <Group>
            {shown.length === 0 ? (
              <Row title={query ? "No passwords match" : "No saved passwords"} />
            ) : (
              <WindowedRows
                items={shown}
                rowHeight={settingsLayout.listRow}
                keyOf={loginKey}
                render={(x) => <LoginRow login={x} account={many ? nameOf(x.space) : null} onOpen={capabilities?.manage ? openRow : null} />}
              />
            )}
          </Group>
        </>
      ) : null}
    </ProfileSubPage>
  );
}

const loginKey = (x: VaultLogin) => `${x.space.account}|${x.id}`;

const LoginRow = memo(function LoginRow({ login, account, onOpen }: { login: VaultLogin; account: string | null; onOpen: ((login: VaultLogin) => void) | null }) {
  const theme = useTheme();
  return (
    <Row
      icon={login.site ? <Favicon url={login.site} /> : <Symbol name="key" size={15} color={theme.icon} style={ICON} />}
      title={<Text numberOfLines={1}>{login.title}</Text>}
      description={
        <Text size="caption" tone="textSecondary" numberOfLines={1} style={DESCRIPTION}>
          {[login.username || "(no username)", account].filter(Boolean).join(" · ")}
        </Text>
      }
      onPress={onOpen ? () => onOpen(login) : undefined}
    />
  );
});

function SignInSheet({ plugin, base }: { plugin: ManagerPlugin; base: string }) {
  const capabilities = useVaultCapabilities(plugin.name);
  const servers: Option<string>[] = [
    ...(capabilities?.servers ?? []).map((s) => ({ value: s.id, title: s.detail ? `${s.name} (${s.detail})` : s.name })),
    ...(capabilities?.selfHosted ? [{ value: SELF, title: "Self-hosted…", separatorBefore: true }] : []),
  ];
  const [server, setServer] = useState(servers[0]?.value ?? SELF);
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const where = server === SELF ? address.trim() : server;
  const ready = !!where && /.+@.+/.test(email.trim()) && !busy;

  const signIn = async () => {
    setBusy(true);
    const done = await addAccount(plugin.name, plugin.title, base, where, email);
    setBusy(false);
    if (done) closeSettingsSheet();
  };

  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle>{`Sign in to ${plugin.title}`}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          <Row title="Server">
            <PopUp value={server} options={servers} onChange={setServer} minWidth={220} />
          </Row>
          {server === SELF ? (
            <Row title="Address">
              <TextField value={address} onChangeText={setAddress} placeholder="https://vault.example" width={240} mono />
            </Row>
          ) : null}
          <Row title="Email" description="Next, Ardia asks for your master password.">
            <TextField value={email} onChangeText={setEmail} placeholder="you@example.com" width={240} autoFocus onSubmit={() => ready && void signIn()} />
          </Row>
        </Group>
      </View>
      <DialogActions>
        <Button title="Cancel" disabled={busy} onPress={closeSettingsSheet} />
        <Button title="Continue" kind="primary" disabled={!ready} onPress={() => void signIn()} />
      </DialogActions>
    </Sheet>
  );
}

function AccountSheet({ space: vault, name }: { space: Space; name: string }) {
  const account = useVaultAccount(vault);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!account || account.state === "signedOut") closeSettingsSheet();
  }, [account?.state]);
  if (!account) return null;
  const touchId = account.unlock !== "password";

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    await work();
    setBusy(false);
  };
  const sync = async () => {
    const synced = await syncNow(vault);
    setNote(synced.ok ? "Up to date." : `Couldn't sync: ${synced.message}`);
  };

  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle>{name}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          <Row title="Server" description={account.server} />
          <Row title={`Unlock with ${PLATFORM_TERMS.quickUnlock}`} description={`Use ${PLATFORM_TERMS.quickUnlock} instead of your master password until you quit Ardia.`}>
            <Toggle value={touchId} disabled={busy} onChange={(on) => void run(() => setUnlockMode(vault, on ? "touchId" : "password"))} />
          </Row>
          {touchId ? (
            <Row title={`${PLATFORM_TERMS.quickUnlock} when Ardia starts`} description="Skip the master password after Ardia restarts.">
              <Toggle value={account.unlock === "touchIdAfterQuit"} disabled={busy} onChange={(on) => void run(() => setUnlockMode(vault, on ? "touchIdAfterQuit" : "touchId"))} />
            </Row>
          ) : null}
          <Row title="Sync" description={note || "Get changes made in other apps."}>
            <Button title="Sync Now" disabled={busy || account.state !== "unlocked"} onPress={() => void run(sync)} />
          </Row>
        </Group>
      </View>
      <DialogActions leading={<Button title="Sign Out…" kind="destructive" disabled={busy} onPress={() => void run(() => signOut(vault, name))} />}>
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

const ICON = { width: 20, height: 20 } as const;
const LOCKED = { alignItems: "center", marginTop: settingsLayout.emptyTop } as const;
const LOCK_ICON = { width: 36, height: 36 } as const;
const SHEET_BODY = { marginTop: space.xl } as const;
const CENTER = { alignItems: "center" } as const;
const DESCRIPTION = { marginTop: space.xxs } as const;
