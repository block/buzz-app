import { useEffect, useState } from "react";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { CommunityPage, Communities } from "./Communities";
import { DirectActionsProvider } from "./DirectActions";
import { Feedback } from "./Feedback";
import { Operators } from "./Operators";
import { Reports } from "./Reports";
import { useSession } from "./session";
import { NavContext, type CommunityRef } from "./ui";

type Tab = "reports" | "feedback" | "communities" | "operators";

/**
 * The authorized console. The direct-action controller sits above the tabs
 * and community pages, so leaving either keeps a reviewed action.
 */
export function Console() {
  const { context, isOperator } = useSession();
  const [tab, setTab] = useState<Tab>("reports");
  const [community, setCommunity] = useState<CommunityRef | null>(null);
  const connectedHost = hostOf(context.relay);
  const items = [
    { value: "reports" as const, label: "Reports" },
    { value: "feedback" as const, label: "Feedback" },
    { value: "communities" as const, label: "Communities" },
    ...(isOperator
      ? [{ value: "operators" as const, label: "Operators" }]
      : []),
  ];
  const visible = items.some((item) => item.value === tab);
  useEffect(() => {
    if (!visible) setTab("reports");
  }, [visible]);
  const open = (next: CommunityRef) => {
    setCommunity(next);
    setTab("communities");
  };

  return (
    <NavContext.Provider value={{ open, connectedHost }}>
      <DirectActionsProvider>
        <Tabs
          variant="panel"
          label="Relay staff console"
          value={visible ? tab : "reports"}
          items={items}
          onValueChange={(next) => {
            if (next === "communities") setCommunity(null);
            setTab(next);
          }}
          renderPanel={(value) => (
            <div className="pt-3">
              {value === "reports" && <Reports />}
              {value === "feedback" && <Feedback />}
              {value === "communities" &&
                (community ? (
                  <CommunityPage
                    community={community}
                    onBack={() => setCommunity(null)}
                  />
                ) : (
                  <Communities connectedHost={connectedHost} onOpen={open} />
                ))}
              {value === "operators" && isOperator && <Operators />}
            </div>
          )}
        />
      </DirectActionsProvider>
    </NavContext.Provider>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
