import { useState } from "react";
import { View } from "react-native";
import { usePage } from "../../state/tabs/pageState";
import { acceptVaultSave, dismissVaultSave } from "../../state/vaults/save";
import { hostOrOrigin } from "../../lib/url";
import { Box, Button, PanelCloseButton, Popover, POPOVER_WIDTH, PopUp, Text, TextField, tracking } from "../ui";
import { PromptBody } from "./Prompts";
import { usePromptInputGuard, Well } from "./PromptParts";

export function VaultSavePrompt({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const offer = usePage(tabId, (p) => p.vaultSave);
  const [username, setUsername] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = usePromptInputGuard(offer ? String(offer.id) : null);
  if (!offer) return null;
  const site = hostOrOrigin(offer.origin);
  const update = offer.update;
  const name = username ?? offer.username;
  const target = account ?? offer.accounts[0]?.account ?? "";
  const reset = () => {
    setUsername(null);
    setAccount(null);
    setBusy(false);
  };
  const dismiss = guard(() => {
    dismissVaultSave(tabId);
    reset();
  });
  const save = guard(() => {
    setBusy(true);
    void acceptVaultSave(tabId, { account: target, username: name }).then((saved) => (saved ? reset() : setBusy(false)));
  });
  return (
    <Popover key={offer.id} width={POPOVER_WIDTH.m} top={top} right={right} modal={false}>
      <View>
        <PromptBody
          icons={["key.fill"]}
          title={update ? `Update password in ${offer.title}?` : `Save to ${offer.title}?`}
          message={update ? `For “${update.title}” on ${site}` : `Fill it next time you visit ${site}`}
          detail={
            <Well gap="s">
              {update ? (
                <Text lines={1} size="small" weight="medium">
                  {name || "No username"}
                </Text>
              ) : (
                <TextField value={name} onChangeText={setUsername} placeholder="Username" />
              )}
              <Text lines={1} size="small" tone="textSecondary" style={{ letterSpacing: tracking.wide }}>
                {"•".repeat(12)}
              </Text>
              {!update && offer.accounts.length > 1 ? (
                <Box row>
                  <PopUp value={target} options={offer.accounts.map((a) => ({ value: a.account, title: a.name }))} onChange={setAccount} minWidth={200} />
                </Box>
              ) : null}
            </Well>
          }
        >
          <Button variant="pill" title="Not Now" onPress={dismiss} />
          <Button variant="pill" title={busy ? "Saving…" : update ? "Update" : "Save"} primary onPress={busy ? () => {} : save} />
        </PromptBody>
        <PanelCloseButton onPress={dismiss} />
      </View>
    </Popover>
  );
}
