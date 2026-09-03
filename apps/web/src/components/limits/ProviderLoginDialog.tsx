import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export interface ProviderLoginTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

function failureMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * Two-step account sign-in: the server starts the provider CLI and hands back
 * an authorization URL, then the code the browser returns is passed back to the
 * waiting CLI.
 */
export function ProviderLoginDialog(props: {
  readonly target: ProviderLoginTarget | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSignedIn: () => void;
}) {
  const { target, onOpenChange, onSignedIn } = props;
  const startLogin = useAtomCommand(serverEnvironment.startProviderLogin, {
    reportFailure: false,
  });
  const submitLogin = useAtomCommand(serverEnvironment.submitProviderLogin, {
    reportFailure: false,
  });

  const [loginId, setLoginId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Each target opens its own sign-in, so nothing from a previous account may
  // survive into it.
  useEffect(() => {
    setLoginId(null);
    setAuthorizeUrl(null);
    setCode("");
    setError(null);
    setBusy(false);
    if (!target) {
      return;
    }
    let cancelled = false;
    setBusy(true);
    void (async () => {
      const result = await startLogin({
        environmentId: target.environmentId,
        input: { instanceId: target.instanceId },
      });
      if (cancelled) {
        return;
      }
      setBusy(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setError(failureMessage(result, "The sign-in could not be started."));
        }
        return;
      }
      setLoginId(result.value.loginId);
      setAuthorizeUrl(result.value.authorizeUrl);
      globalThis.open(result.value.authorizeUrl, "_blank", "noopener,noreferrer");
    })();
    return () => {
      cancelled = true;
    };
  }, [startLogin, target]);

  // An empty code is meaningful: the provider's own browser callback may have
  // completed the sign-in, and the server then just waits for its CLI to exit.
  const submit = useCallback(async () => {
    if (!target || loginId === null) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await submitLogin({
      environmentId: target.environmentId,
      input: { loginId, code: code.trim() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(result, "The sign-in code was not accepted."));
      }
      return;
    }
    onSignedIn();
    onOpenChange(false);
  }, [code, loginId, onOpenChange, onSignedIn, submitLogin, target]);

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to {target?.displayName ?? "provider"}</DialogTitle>
          <DialogDescription>
            Approve the sign-in in your browser. If it hands you back a code, paste it here;
            otherwise just select Continue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5">
          {authorizeUrl === null ? (
            <p className="text-sm text-muted-foreground">
              {error === null ? "Starting sign-in…" : "Sign-in could not be started."}
            </p>
          ) : (
            <>
              <a
                className="inline-flex items-center gap-1.5 text-sm text-primary underline underline-offset-4"
                href={authorizeUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLinkIcon className="size-3.5" />
                Open the sign-in page again
              </a>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor="provider-login-code">
                  Code from the browser <span className="text-muted-foreground">(if shown)</span>
                </label>
                <Input
                  autoFocus
                  id="provider-login-code"
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="Paste the code here"
                  value={code}
                />
              </div>
            </>
          )}
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter variant="bare">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Cancel
          </Button>
          <Button disabled={busy || loginId === null} onClick={() => void submit()} size="sm">
            {busy ? "Finishing…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
