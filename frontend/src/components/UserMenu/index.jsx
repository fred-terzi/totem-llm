import UserButton from "./UserButton";
import TotemBalanceBadge from "@/components/TotemBalanceBadge";

export default function UserMenu({ children }) {
  return (
    <div className="w-auto h-auto">
      <TotemBalanceBadge />
      <UserButton />
      {children}
    </div>
  );
}
