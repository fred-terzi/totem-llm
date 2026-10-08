import UserButton from "./UserButton";
import TotemBalanceBadge from "@/components/TotemBalanceBadge";
import CreditBadge from "@/components/CreditBadge";
import ChatSettingsMenu from "@/components/WorkspaceChat/ChatContainer/ChatSettingsMenu";

export default function UserMenu({ children }) {
  return (
    <>
      <div className="absolute top-3 right-4 md:top-9 md:right-10 z-40 flex items-center gap-2 md:gap-3">
        <ChatSettingsMenu />
        <TotemBalanceBadge />
        <CreditBadge />
        <UserButton />
      </div>
      {children}
    </>
  );
}
