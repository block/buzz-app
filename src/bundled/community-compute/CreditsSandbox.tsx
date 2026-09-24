import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./CreditsSandbox.module.css";

/** Browser-only fallback for the isolated local demo. */
const STORAGE_KEY = "buzz.compute-credits-sandbox.v1";
const DEMO_TOKENS_PER_CREDIT = 1_000;

type LocalEntry = {
  id: string;
  delta: number;
  tokens: number;
  createdAt: number;
};
type SharedEntry = {
  id: string;
  kind: string;
  consumerDelta: number;
  providerDelta: number;
  tokens: number;
  createdAt: number;
};
type SharedWallet = {
  role: "consumer" | "provider";
  ledger: {
    consumerBalance: number;
    providerBalance: number;
    tokensServed: number;
    entries: SharedEntry[];
  };
};

function readEntries(): LocalEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is LocalEntry =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        Number.isSafeInteger(entry.delta) &&
        Number.isSafeInteger(entry.tokens) &&
        Number.isSafeInteger(entry.createdAt),
    );
  } catch {
    return [];
  }
}

function createEntry(delta: number, tokens: number): LocalEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    delta,
    tokens,
    createdAt: Date.now(),
  };
}

function nativeWalletEnabled() {
  return isTauri();
}

export function CreditsSandbox() {
  const [entries, setEntries] = useState(readEntries);
  const [shared, setShared] = useState<SharedWallet | null>(null);
  const [tokens, setTokens] = useState("10000");
  const [spend, setSpend] = useState("2");
  const [message, setMessage] = useState("");
  const seedAttempted = useRef(false);
  const native = nativeWalletEnabled();
  const balance = entries.reduce((total, entry) => total + entry.delta, 0);
  const tokenCount = Number(tokens);
  const earnAmount = Math.floor(tokenCount / DEMO_TOKENS_PER_CREDIT);
  const spendAmount = Number(spend);

  useEffect(() => {
    if (native) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      setMessage("Browser storage is unavailable; changes last until refresh.");
    }
  }, [entries, native]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        let wallet = await invoke<SharedWallet>(
          "community_compute_demo_wallet",
        );
        if (active && wallet.role === "consumer" && !seedAttempted.current) {
          seedAttempted.current = true;
          const legacyBalance = entries.reduce(
            (total, entry) => total + entry.delta,
            0,
          );
          const ledger = await invoke<SharedWallet["ledger"]>(
            "community_compute_demo_seed_legacy",
            { amount: Math.max(0, legacyBalance) },
          );
          wallet = { ...wallet, ledger };
        }
        if (active) setShared(wallet);
      } catch (error) {
        if (active)
          setMessage(
            error instanceof Error
              ? error.message
              : "The local demo wallet is unavailable.",
          );
      } finally {
        polling = false;
        if (active) timer = setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [entries, native]);

  async function runNativeCommand(
    command: string,
    args?: Record<string, unknown>,
  ) {
    try {
      const ledger = await invoke<SharedWallet["ledger"]>(command, args);
      if (shared) setShared({ ...shared, ledger });
      setMessage("Updated the local simulated credit ledger.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function earnCredits() {
    if (
      !Number.isSafeInteger(tokenCount) ||
      tokenCount < DEMO_TOKENS_PER_CREDIT
    ) {
      setMessage("Enter at least 1,000 simulated served tokens.");
      return;
    }
    const earned = Math.floor(tokenCount / DEMO_TOKENS_PER_CREDIT);
    setEntries((current) => [...current, createEntry(earned, tokenCount)]);
    setMessage(
      `Added ${earned} simulated credits to this browser’s demo ledger.`,
    );
  }

  function spendCredits() {
    if (!Number.isSafeInteger(spendAmount) || spendAmount <= 0) {
      setMessage("Enter a whole number of demo credits to spend.");
      return;
    }
    if (spendAmount > balance) {
      setMessage("The demo balance is too low for that spend.");
      return;
    }
    setEntries((current) => [...current, createEntry(-spendAmount, 0)]);
    setMessage(`Spent ${spendAmount} simulated credits.`);
  }

  function resetDemo() {
    if (native) {
      void runNativeCommand("community_compute_demo_reset");
      return;
    }
    setEntries([]);
    setMessage("The local demo ledger was cleared.");
  }

  const sharedBalance = shared
    ? shared.role === "provider"
      ? shared.ledger.providerBalance
      : shared.ledger.consumerBalance
    : 0;
  const shownEntries = shared
    ? [...shared.ledger.entries]
        .filter((entry) =>
          shared.role === "provider"
            ? entry.providerDelta !== 0
            : entry.consumerDelta !== 0,
        )
        .reverse()
        .map((entry) => ({
          id: entry.id,
          label:
            entry.kind === "served-tokens"
              ? shared.role === "provider"
                ? "Simulated serving"
                : "Simulated compute use"
              : entry.kind === "demo-spend"
                ? shared.role === "provider"
                  ? "Demo spend received"
                  : "Simulated compute spend"
                : "Demo credit top-up",
          delta:
            shared.role === "provider"
              ? entry.providerDelta
              : entry.consumerDelta,
          tokens: entry.tokens,
        }))
    : [...entries].reverse().map((entry) => ({
        id: entry.id,
        label: entry.delta > 0 ? "Simulated serving" : "Simulated spend",
        delta: entry.delta,
        tokens: entry.tokens,
      }));

  return (
    <section className={styles.panel} aria-label="Simulated credits sandbox">
      <div className={styles.header}>
        <div>
          <h2 className="m-0 text-label-sm">Credits sandbox</h2>
          <p className="m-0 text-body-sm text-secondary">
            {native
              ? `Local demo only · this app is the ${shared?.role ?? "test"}`
              : "Local browser demo · not connected to compute or a wallet"}
          </p>
        </div>
        <span className={styles.badge}>SIMULATED</span>
      </div>

      {native && shared ? (
        <div className={styles.balance}>
          <span className="text-body-sm text-secondary">
            {shared.role === "provider"
              ? "Provider demo balance"
              : "Consumer demo balance"}
          </span>
          <strong className="text-title">{sharedBalance} credits</strong>
        </div>
      ) : (
        <div className={styles.balance}>
          <span className="text-body-sm text-secondary">Demo balance</span>
          <strong className="text-title">{balance} credits</strong>
        </div>
      )}

      <p className="m-0 text-body-sm text-secondary">
        {native
          ? "In this local simulation, 1,000 served tokens move 1 demo credit from Consumer to Provider. No real value, payment, or request blocking."
          : "Example rule: 1 demo credit per 1,000 simulated served tokens. These values are illustrative and have no cash value or redemption."}
      </p>

      {native ? (
        <div className={styles.actions}>
          {shared?.role === "consumer" && (
            <div className={styles.field}>
              <span className="text-label-sm">Consumer demo credits</span>
              <Button
                onClick={() =>
                  void runNativeCommand(
                    "community_compute_demo_add_consumer_credits",
                    { amount: 10 },
                  )
                }
              >
                Add 10 demo credits
              </Button>
            </div>
          )}
          {shared?.role === "consumer" && (
            <div className={styles.field}>
              <label htmlFor="credits-sandbox-spend" className="text-label-sm">
                Simulate a compute spend
              </label>
              <input
                id="credits-sandbox-spend"
                className={styles.input}
                inputMode="numeric"
                min="1"
                step="1"
                type="number"
                value={spend}
                onChange={(event) => setSpend(event.target.value)}
              />
              <Button
                onClick={() =>
                  void runNativeCommand("community_compute_demo_spend", {
                    amount: spendAmount,
                  })
                }
                disabled={spendAmount > sharedBalance}
              >
                Spend demo credits
              </Button>
            </div>
          )}
          {shared?.role === "provider" && (
            <p className="m-0 text-body-sm text-secondary">
              Tokens served this session:{" "}
              {shared.ledger.tokensServed.toLocaleString()}. Keep this page open
              during the test to sync demo credits.
            </p>
          )}
        </div>
      ) : (
        <div className={styles.actions}>
          <div className={styles.field}>
            <label htmlFor="credits-sandbox-tokens" className="text-label-sm">
              Simulate tokens served
            </label>
            <input
              id="credits-sandbox-tokens"
              className={styles.input}
              inputMode="numeric"
              min="1000"
              step="1000"
              type="number"
              value={tokens}
              onChange={(event) => setTokens(event.target.value)}
            />
            <Button onClick={earnCredits}>
              Add{" "}
              {Number.isFinite(earnAmount) && earnAmount > 0 ? earnAmount : 0}{" "}
              demo credits
            </Button>
          </div>
          <div className={styles.field}>
            <label htmlFor="credits-sandbox-spend" className="text-label-sm">
              Simulate spending credits
            </label>
            <input
              id="credits-sandbox-spend"
              className={styles.input}
              inputMode="numeric"
              min="1"
              step="1"
              type="number"
              value={spend}
              onChange={(event) => setSpend(event.target.value)}
            />
            <Button onClick={spendCredits} disabled={spendAmount > balance}>
              Spend demo credits
            </Button>
          </div>
        </div>
      )}

      <div className={styles.ledgerHeader}>
        <h3 className="m-0 text-label-sm">Demo ledger</h3>
        <Button onClick={resetDemo} disabled={shownEntries.length === 0}>
          Reset demo
        </Button>
      </div>
      {shownEntries.length ? (
        <ol className={styles.ledger}>
          {shownEntries.map((entry) => (
            <li key={entry.id}>
              <span>
                {entry.label}
                {entry.tokens > 0
                  ? ` · ${entry.tokens.toLocaleString()} tokens`
                  : ""}
              </span>
              <strong>
                {entry.delta > 0 ? "+" : ""}
                {entry.delta} credits
              </strong>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-body-sm text-secondary">
          No demo entries yet. Add credits or serve compute to try the ledger.
        </p>
      )}
      <p aria-live="polite" className="m-0 text-body-sm text-secondary">
        {message}
      </p>
    </section>
  );
}
