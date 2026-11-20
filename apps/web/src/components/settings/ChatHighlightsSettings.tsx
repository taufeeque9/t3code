import {
  type ChatHighlightRule,
  DEFAULT_CHAT_HIGHLIGHT_RULES,
  MAX_CHAT_HIGHLIGHT_PATTERN_LENGTH,
  MAX_CHAT_HIGHLIGHT_RULES,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { T, useGT, Var } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { getClientSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { highlightRuleProblem } from "../chat/markdownHighlights";
import { Button } from "../ui/button";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import type { DraftInputProps } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { withRulePatch } from "./ChatHighlightsSettings.logic";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SWATCHES = [...new Set(DEFAULT_CHAT_HIGHLIGHT_RULES.map((rule) => rule.color))];

export function ChatHighlightsRow() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const rules = useScopedSettings((settings) => settings.chatHighlightRules);
  const updateSettings = useUpdateScopedSettings();
  const save = (chatHighlightRules: ReadonlyArray<ChatHighlightRule>) =>
    updateSettings({ chatHighlightRules });
  // Edits apply to the saved list as it is when they land: a field that saves as Settings closes
  // must not restore rules a reset or removal dropped since it rendered.
  const latest = () => getClientSettings().chatHighlightRules;
  const change = (id: string, patch: Partial<ChatHighlightRule>) => {
    const next = withRulePatch(latest(), id, patch);
    if (next) save(next);
  };

  return (
    <SettingsRow
      {...setting("chat-highlights")}
      description={gt(
        "Marks phrases in agent replies. A phrase matches whole words in any case; a regex rule uses JavaScript syntax. Where matches overlap, the one that starts first wins, and the rule higher in the list breaks a tie.",
      )}
      resetAction={
        Equal.equals(rules, DEFAULT_CHAT_HIGHLIGHT_RULES) ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset highlights to default")}
            onClick={() => save(DEFAULT_CHAT_HIGHLIGHT_RULES)}
          />
        )
      }
    >
      <div className="flex flex-col gap-1.5 pt-3 pb-2">
        {rules.map((rule, index) => (
          <ChatHighlightRuleFields
            key={rule.id}
            rule={rule}
            number={index + 1}
            onChange={(patch) => change(rule.id, patch)}
            onRemove={() => save(latest().filter((candidate) => candidate.id !== rule.id))}
          />
        ))}
        <div>
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={rules.length >= MAX_CHAT_HIGHLIGHT_RULES}
            onClick={() =>
              save([
                ...latest(),
                {
                  id: randomUUID(),
                  label: "",
                  pattern: "",
                  regex: false,
                  color: SWATCHES[0]!,
                  enabled: true,
                },
              ])
            }
          >
            <PlusIcon />
            <T>Add highlight</T>
          </Button>
          {rules.length >= MAX_CHAT_HIGHLIGHT_RULES ? (
            <span className="ps-2 text-xs text-muted-foreground">
              <T>
                Up to <Var>{MAX_CHAT_HIGHLIGHT_RULES}</Var> highlights
              </T>
            </span>
          ) : null}
        </div>
      </div>
    </SettingsRow>
  );
}

function ChatHighlightRuleFields(props: {
  rule: ChatHighlightRule;
  number: number;
  onChange: (patch: Partial<ChatHighlightRule>) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const { rule, onChange } = props;
  const name = rule.label || gt("Highlight {number}", { number: props.number });
  const problem = highlightRuleProblem(rule);
  const problemId = useId();
  return (
    <div role="group" aria-label={name} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          size="sm"
          checked={rule.enabled}
          onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
          aria-label={gt("Highlight {name}", { name })}
        />
        <FlushedDraftInput
          nativeInput
          size="sm"
          className="w-36"
          value={rule.label}
          maxLength={80}
          placeholder={gt("Label")}
          aria-label={gt("Label for {name}", { name })}
          onCommit={(label) => onChange({ label })}
        />
        <FlushedDraftInput
          nativeInput
          size="sm"
          font="mono"
          className="min-w-40 flex-1"
          value={rule.pattern}
          maxLength={MAX_CHAT_HIGHLIGHT_PATTERN_LENGTH}
          placeholder={rule.regex ? gt("Regular expression") : gt("Phrase")}
          aria-label={gt("Pattern for {name}", { name })}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem ? problemId : undefined}
          spellCheck={false}
          onCommit={(pattern) => onChange({ pattern })}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={rule.regex}
            onCheckedChange={(checked) => onChange({ regex: Boolean(checked) })}
            aria-label={gt("Regex for {name}", { name })}
          />
          <T>Regex</T>
        </label>
        <HighlightColorPicker
          name={name}
          value={rule.color}
          onCommit={(color) => onChange({ color })}
        />
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={gt("Remove {name}", { name })}
          onClick={props.onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {problem ? (
        <p id={problemId} className="text-xs text-destructive">
          {problem === "invalid" ? (
            <T>Invalid regular expression</T>
          ) : (
            <T>May be too slow; avoid nested repetition</T>
          )}
        </p>
      ) : null}
    </div>
  );
}

/** A pending edit to save when the field unmounts, since leaving Settings fires no blur. */
function usePendingEdit() {
  const pending = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Saves an edit still in progress when Settings closes.
  useEffect(() => () => pending.current?.(), []);
  return (edit: (() => void) | null) => {
    pending.current = edit;
  };
}

function FlushedDraftInput({ value, onCommit, normalizeDraft, ...rest }: DraftInputProps) {
  const bag = useCommitOnBlur(value, onCommit, normalizeDraft);
  const setPending = usePendingEdit();
  return (
    <Input
      {...rest}
      {...bag}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        bag.onChange(event);
        const draft = event.target.value;
        setPending(draft === value ? null : () => onCommit(draft));
      }}
      onBlur={() => {
        setPending(null);
        bag.onBlur();
      }}
    />
  );
}

/** Edits stay in the popover and save once when it closes, so a drag writes settings once. */
function HighlightColorPicker(props: {
  name: string;
  value: string;
  onCommit: (color: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState<string | null>(null);
  const setPending = usePendingEdit();
  const preview = (color: string) => {
    setDraft(color);
    setPending(color === props.value ? null : () => props.onCommit(color));
  };
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) return;
        setPending(null);
        if (draft !== null && draft !== props.value) props.onCommit(draft);
        setDraft(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            style={{ backgroundColor: draft ?? props.value }}
            aria-label={gt("Color for {name}", { name: props.name })}
          />
        }
      />
      <PopoverPopup side="bottom" align="end" sideOffset={6} padding="none">
        <HighlightColorPanel value={draft ?? props.value} onChange={preview} />
      </PopoverPopup>
    </Popover>
  );
}

function HighlightColorPanel(props: { value: string; onChange: (color: string) => void }) {
  const gt = useGT();
  // Kept apart from the hex value so the hue survives a drag through grey.
  const [hsv, setHsv] = useState(() => hexToHsv(props.value));
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const change = (next: HsvColor) => {
    setHsv(next);
    props.onChange(hsvToHex(next.h, next.s, next.v));
  };
  const pick = (color: string) => {
    setHsv(hexToHsv(color));
    props.onChange(color.toLowerCase());
  };
  return (
    <div className="w-56 bg-popover">
      <ColorSaturationValuePlane
        label={gt("Highlight color")}
        value={hsv}
        onChange={change}
        variant="edge"
      />
      <div className="grid gap-3 p-3">
        <ColorHueSlider
          label={gt("Highlight color hue")}
          value={hsv.h}
          onChange={(h) => change({ ...hsv, h })}
        />
        <div className="flex items-center gap-1.5">
          {SWATCHES.map((color) => (
            <Button
              key={color}
              type="button"
              size="icon-sm"
              variant="outline"
              style={{ backgroundColor: color }}
              aria-label={color}
              onClick={() => pick(color)}
            />
          ))}
        </div>
        <Input
          nativeInput
          size="compact"
          font="mono"
          value={hexDraft ?? props.value}
          spellCheck={false}
          aria-label={gt("Highlight color hex value")}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setHexDraft(next);
            if (/^#[\da-f]{6}$/i.test(next)) pick(next);
          }}
          onBlur={() => setHexDraft(null)}
        />
      </div>
    </div>
  );
}
