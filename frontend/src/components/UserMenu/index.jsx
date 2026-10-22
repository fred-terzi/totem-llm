import UserButton from "./UserButton";
import TotemBalanceBadge from "@/components/TotemBalanceBadge";
import CreditBadge from "@/components/CreditBadge";
import BuyCreditsModal from "@/components/Modals/BuyCredits";
import Payments from "@/models/payments";
import FileExplorerButton from "@/components/FileExplorerButton";
import ChatSettingsMenu from "@/components/WorkspaceChat/ChatContainer/ChatSettingsMenu";
import { ChatSidebarProvider } from "@/components/WorkspaceChat/ChatContainer/ChatSidebar";
import { useEffect, useState } from "react";

export default function UserMenu({ children }) {
  // Payments feature gate (F1/AC1): the badge's buy affordance (click →
  // modal) renders ONLY when the server reports the feature on. The `204`
  // response from a probe session creation is the discovery signal per the
  // spec — the probe below passes an invalid packId on purpose: when the
  // feature is on the server answers 400 (packId validated AFTER the gate),
  // when off it answers 204 before auth/validation. No session is created,
  // nothing is rate-limit-relevant beyond one request per page load.
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [showBuyModal, setShowBuyModal] = useState(false);

  useEffect(() => {
    let mounted = true;
    Payments.paymentsEnabled().then((enabled) => {
      if (mounted) setPaymentsEnabled(enabled);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <ChatSidebarProvider>
      <div className="absolute top-3 right-4 md:top-9 md:right-10 z-40 flex items-center gap-2 md:gap-3">
        <ChatSettingsMenu />
        <TotemBalanceBadge />
        <CreditBadge
          onClick={paymentsEnabled ? () => setShowBuyModal(true) : undefined}
          title={
            paymentsEnabled
              ? undefined // badge's default "…click to buy more" tooltip
              : "Credits"
          }
        />
        <FileExplorerButton />
        <UserButton />
      </div>
      {showBuyModal && (
        <BuyCreditsModal onClose={() => setShowBuyModal(false)} />
      )}
      {children}
    </ChatSidebarProvider>
  );
}
