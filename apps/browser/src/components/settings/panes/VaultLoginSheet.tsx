import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { confirm, copyText } from "../../../state/app/system";
import type { ManagerPlugin } from "../../../state/site/passwordManagerChoice";
import type { Space, VaultItem, VaultUri } from "../../../state/vaults/store";
import { deleteLogin, generatePassword, revealLogin, saveLogin, updateLogin, type LoginChanges, type LoginSecrets } from "../../../state/vaults/logins";
import { useVaultAccount } from "../../../state/vaults/hooks";
import { siteOf } from "../../../state/vaults/search";
import { closeSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, DialogActions, DialogTitle, PopUp, Sheet, space, Symbol, Text, TextField } from "../../ui";
import { useTheme } from "../../ui/theme";
import { monoFace } from "../../ui/tokens";
import { hostLabel } from "../../pages/PageLayout";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row } from "../Form";

export type Login = VaultItem & { space: Space };

type Draft = { title: string; username: string; password: string; uris: VaultUri[]; totp: string; notes: string };

const BLANK_URI: VaultUri = { uri: "", match: null };
const emptyDraft = (): Draft => ({ title: "", username: "", password: "", uris: [BLANK_URI], totp: "", notes: "" });
const cleanUris = (uris: VaultUri[]) => uris.map((u) => ({ ...u, uri: u.uri.trim() })).filter((u) => u.uri);

export function changesOf(item: VaultItem, draft: Draft, secrets: LoginSecrets): LoginChanges {
  const changes: LoginChanges = {};
  const uris = cleanUris(draft.uris);
  if (draft.title.trim() !== item.title) changes.title = draft.title.trim();
  if (draft.username !== item.username) changes.username = draft.username;
  if (draft.password !== (secrets.password ?? "")) changes.password = draft.password;
  if (JSON.stringify(uris) !== JSON.stringify(item.uris)) changes.uris = uris;
  if (draft.totp.trim() !== (secrets.totp ?? "")) changes.totp = draft.totp.trim() || null;
  if (draft.notes !== (secrets.notes ?? "")) changes.notes = draft.notes || null;
  return changes;
}

const conflictWords = "This login changed in another app. Close and reopen it to see the latest version.";

export function VaultLoginSheet({ plugin, login, accounts }: { plugin: ManagerPlugin; login: Login | null; accounts: { space: Space; name: string }[] }) {
  const theme = useTheme();
  const [target, setTarget] = useState<Space | null>(login?.space ?? accounts[0]?.space ?? null);
  const live = useVaultAccount(login?.space ?? { plugin: plugin.name, account: "" });
  const item = login ? (live?.items?.find((x) => x.id === login.id) ?? login) : null;
  const [secrets, setSecrets] = useState<LoginSecrets | null>(login ? null : {});
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(!login);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );
  useEffect(() => {
    if (login && live?.state !== "unlocked") closeSettingsSheet();
  }, [live?.state]);
  if (!target) return null;

  const loadSecrets = async (): Promise<LoginSecrets | null> => {
    if (secrets) return secrets;
    if (!item) return null;
    const values = await revealLogin(target, item);
    if (values && open.current) setSecrets(values);
    return values;
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setUri = (i: number, uri: string) => set({ uris: draft.uris.map((x, j) => (j === i ? { uri, match: x.uri.trim() === uri.trim() ? x.match : null } : x)) });
  const removeUri = (i: number) => set({ uris: draft.uris.length === 1 ? [BLANK_URI] : draft.uris.filter((_, j) => j !== i) });

  const startEditing = async () => {
    const values = await loadSecrets();
    if (!values || !item) return;
    setDraft({ title: item.title, username: item.username, password: values.password ?? "", uris: item.uris.length ? item.uris : [BLANK_URI], totp: values.totp ?? "", notes: values.notes ?? "" });
    setEditing(true);
  };
  const generate = async () => {
    const password = await generatePassword(plugin.name);
    if (password) set({ password });
  };

  const save = async () => {
    setError("");
    setBusy(true);
    const answer = item
      ? await updateLogin(target, item, changesOf(item, draft, secrets ?? {}))
      : await saveLogin(target, { ...draft, title: draft.title.trim(), uris: cleanUris(draft.uris), totp: draft.totp.trim() });
    if (!open.current) return;
    setBusy(false);
    if (!answer.ok) return setError(answer.code === "conflict" ? conflictWords : `Couldn't save: ${answer.message}`);
    closeSettingsSheet();
  };

  const remove = async () => {
    if (!item) return;
    setBusy(true);
    const { confirmed } = await confirm({
      title: `Delete “${item.title}”?`,
      message: `It stays in ${plugin.title}'s trash for 30 days.`,
      confirmTitle: "Delete",
      destructive: true,
    });
    if (!confirmed) return setBusy(false);
    const answer = await deleteLogin(target, item);
    if (!open.current) return;
    setBusy(false);
    if (!answer.ok) return setError(answer.code === "conflict" ? conflictWords : `Couldn't delete: ${answer.message}`);
    closeSettingsSheet();
  };

  const canSave = !!draft.title.trim() && !!draft.password && !busy;
  const site = item?.uris.map((u) => siteOf(u.uri)).find(Boolean) ?? null;
  const cancel = () => {
    setError("");
    if (item) setEditing(false);
    else closeSettingsSheet();
  };

  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle icon={site ? <Favicon url={site} size={20} /> : undefined}>{item ? item.title : "New Password"}</DialogTitle>
      <View style={SHEET_BODY}>
        {editing ? (
          <Group>
            {!item && accounts.length > 1 ? (
              <Row title="Account">
                <PopUp
                  value={target.account}
                  options={accounts.map((a) => ({ value: a.space.account, title: a.name }))}
                  onChange={(id) => setTarget(accounts.find((a) => a.space.account === id)?.space ?? target)}
                  minWidth={240}
                />
              </Row>
            ) : null}
            <Row title="Title">
              <TextField value={draft.title} onChangeText={(title) => set({ title })} placeholder="GitHub" width={260} autoFocus={!item} />
            </Row>
            <Row title="Username">
              <TextField value={draft.username} onChangeText={(username) => set({ username })} width={260} />
            </Row>
            <Row title="Password">
              <Box row gap="xs" style={CENTER}>
                <TextField value={draft.password} onChangeText={(password) => set({ password })} width={228} mono />
                <Button variant="icon" icon="arrow.triangle.2.circlepath" size="m" tooltip="Generate a Password" onPress={() => void generate()} />
              </Box>
            </Row>
            {draft.uris.map((u, i) => (
              <Row key={i} title={i === 0 ? "Websites" : ""}>
                <Box row gap="xs" style={CENTER}>
                  <TextField value={u.uri} onChangeText={(uri) => setUri(i, uri)} placeholder="https://example.com" width={228} mono />
                  <Button variant="icon" icon="xmark.circle.fill" size="m" tooltip="Remove Website" disabled={draft.uris.length === 1 && !u.uri} onPress={() => removeUri(i)} />
                </Box>
              </Row>
            ))}
            <Row>
              <Button title="Add Website" onPress={() => set({ uris: [...draft.uris, BLANK_URI] })} />
            </Row>
            <Row title="Verification Code" description="Paste the setup key or otpauth:// link from the website.">
              <TextField value={draft.totp} onChangeText={(totp) => set({ totp })} placeholder="Setup key" width={260} mono />
            </Row>
            <Row title="Notes">
              <TextField value={draft.notes} onChangeText={(notes) => set({ notes })} multiline width={260} />
            </Row>
          </Group>
        ) : item ? (
          <Group>
            <Row title="Username">
              <Box row gap="xs" style={CENTER}>
                <Text selectable>{item.username || "(none)"}</Text>
                {item.username ? <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => copyText(item.username)} tooltip="Copy Username" /> : null}
              </Box>
            </Row>
            <Row title="Password">
              <Box row gap="xs" style={CENTER}>
                <Text selectable style={shown && secrets ? monoFace() : undefined}>
                  {shown && secrets ? (secrets.password ?? "") : "••••••••"}
                </Text>
                <Button
                  variant="icon"
                  icon={shown ? "eye.slash" : "eye"}
                  size="m"
                  tooltip={shown ? "Hide" : "Show"}
                  onPress={() => void (shown ? setShown(false) : loadSecrets().then((v) => v && setShown(true)))}
                />
                <Button variant="icon" icon="doc.on.doc" size="m" tooltip="Copy Password" onPress={() => void loadSecrets().then((v) => v?.password && copyText(v.password))} />
              </Box>
            </Row>
            {item.uris.map((u, i) => (
              <Row key={i} title={i === 0 ? "Websites" : ""} description={u.uri}>
                <Text size="small" tone="textSecondary">
                  {hostLabel(u.uri)}
                </Text>
              </Row>
            ))}
            {item.hasTotp ? <Row title="Verification Code" description="Ardia fills the current code for you." /> : null}
            {item.hasNotes ? (
              <Row title="Notes" description={shown && secrets ? secrets.notes : "Hidden until you show the password."}>
                {shown ? null : <Symbol name="lock.fill" size={12} color={theme.textTertiary} style={SMALL_ICON} />}
              </Row>
            ) : null}
            {item.organization ? <Row title="Shared" description="From an organization. Edits apply to everyone in it." /> : null}
          </Group>
        ) : null}
        {error ? (
          <Text size="caption" tone="destructive" style={ERROR}>
            {error}
          </Text>
        ) : null}
      </View>
      <DialogActions leading={item ? <Button title="Delete" kind="destructive" disabled={busy} onPress={() => void remove()} /> : undefined}>
        {editing ? (
          <>
            <Button title="Cancel" disabled={busy} onPress={cancel} />
            <Button title="Save" kind="primary" disabled={!canSave} onPress={() => void save()} />
          </>
        ) : (
          <>
            <Button title="Edit" onPress={() => void startEditing()} />
            <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
          </>
        )}
      </DialogActions>
    </Sheet>
  );
}

const SMALL_ICON = { width: 14, height: 14 } as const;
const SHEET_BODY = { marginTop: space.xl } as const;
const ERROR = { marginTop: space.ml } as const;
const CENTER = { alignItems: "center" } as const;
