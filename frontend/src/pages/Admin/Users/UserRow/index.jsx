import { useRef, useState } from "react";
import { titleCase } from "text-case";
import Admin from "@/models/admin";
import { microToCredits, creditsToMicro } from "@/utils/credits";
import EditUserModal from "./EditUserModal";
import showToast from "@/utils/toast";
import { useModal } from "@/hooks/useModal";
import ModalWrapper from "@/components/ModalWrapper";

const ModMap = {
  admin: ["admin", "manager", "default"],
  manager: ["manager", "default"],
  default: [],
};

export default function UserRow({ currUser, user, onCreditsUpdated }) {
  const rowRef = useRef(null);
  const canModify = ModMap[currUser?.role || "default"].includes(user.role);
  const [suspended, setSuspended] = useState(user.suspended === 1);
  const [granting, setGranting] = useState(false);
  const { isOpen, openModal, closeModal } = useModal();
  const handleSuspend = async () => {
    if (
      !window.confirm(
        `Are you sure you want to suspend ${user.username}?\nAfter you do this they will be logged out and unable to log back into this instance of AnythingLLM until unsuspended by an admin.`
      )
    )
      return false;

    const { success, error } = await Admin.updateUser(user.id, {
      suspended: suspended ? 0 : 1,
    });
    if (!success) showToast(error, "error", { clear: true });
    if (success) {
      showToast(
        `User ${!suspended ? "has been suspended" : "is no longer suspended"}.`,
        "success",
        { clear: true }
      );
      setSuspended(!suspended);
    }
  };
  const handleGrantCredits = async () => {
    // Display + prompt in CREDITS (1 credit = $0.001); converted to the µ$ API
    // contract via creditsToMicro (the endpoint's µ$ body contract is unchanged).
    const currentCredits = microToCredits(user.credits_balance);
    const raw = window.prompt(
      `Add credits to ${user.username}\n\nCurrent balance: ${currentCredits.toLocaleString("en-US")} credits\nEnter amount to add (in credits):`,
      "100"
    );
    if (raw === null) return;
    const amount = parseInt(raw, 10);
    if (!amount || amount <= 0) {
      showToast("Please enter a valid positive number.", "error", {
        clear: true,
      });
      return;
    }
    if (
      !window.confirm(
        `Add ${amount.toLocaleString("en-US")} credits to ${user.username}?`
      )
    )
      return;

    setGranting(true);
    const { success, error } = await Admin.grantCredits(
      user.id,
      creditsToMicro(amount)
    );
    setGranting(false);

    if (success) {
      showToast(
        `Added ${amount.toLocaleString("en-US")} credits to ${user.username}.`,
        "success",
        { clear: true }
      );
      onCreditsUpdated?.();
    } else {
      showToast(error || "Failed to add credits.", "error", { clear: true });
    }
  };

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Are you sure you want to delete ${user.username}?\nAfter you do this they will be logged out and unable to use this instance of AnythingLLM.\n\nThis action is irreversible.`
      )
    )
      return false;
    const { success, error } = await Admin.deleteUser(user.id);
    if (!success) showToast(error, "error", { clear: true });
    if (success) {
      rowRef?.current?.remove();
      showToast("User deleted from system.", "success", { clear: true });
    }
  };

  return (
    <>
      <tr
        ref={rowRef}
        className="bg-transparent text-white text-opacity-80 text-xs font-medium border-b border-white/10 h-10"
      >
        <th scope="row" className="px-6 whitespace-nowrap">
          {user.username}
        </th>
        <td className="px-6">{titleCase(user.role)}</td>
        <td className="px-6">{user.createdAt}</td>
        <td className="px-6 whitespace-nowrap">
          {/* credits_balance is µ$ internally — display credits (1 credit = 1 000 µ$),
              matching what the user's own GET /credits balance shows. */}
          {user.credits_balance != null
            ? `${microToCredits(user.credits_balance).toLocaleString("en-US")}`
            : "—"}
        </td>
        <td className="px-6 flex items-center gap-x-6 h-full mt-2">
          {canModify && (
            <button
              onClick={openModal}
              className="text-xs font-medium text-white/80 light:text-black/80 rounded-lg hover:text-white hover:light:text-gray-500 px-2 py-1 hover:bg-white hover:bg-opacity-10"
            >
              Edit
            </button>
          )}
          {currUser?.role === "admin" && (
            <button
              onClick={handleGrantCredits}
              disabled={granting}
              className="text-xs font-medium text-white/80 light:text-black/80 hover:light:text-green-500 hover:text-green-300 rounded-lg px-2 py-1 hover:bg-white hover:light:bg-green-50 hover:bg-opacity-10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {granting ? "Adding…" : "+ Credits"}
            </button>
          )}
          {currUser?.id !== user.id && canModify && (
            <>
              <button
                onClick={handleSuspend}
                className="text-xs font-medium text-white/80 light:text-black/80 hover:light:text-orange-500 hover:text-orange-300 rounded-lg px-2 py-1 hover:bg-white hover:light:bg-orange-50 hover:bg-opacity-10"
              >
                {suspended ? "Unsuspend" : "Suspend"}
              </button>
              <button
                onClick={handleDelete}
                className="text-xs font-medium text-white/80 light:text-black/80 hover:light:text-red-500 hover:text-red-300 rounded-lg px-2 py-1 hover:bg-white hover:light:bg-red-50 hover:bg-opacity-10"
              >
                Delete
              </button>
            </>
          )}
        </td>
      </tr>
      <ModalWrapper isOpen={isOpen}>
        <EditUserModal
          currentUser={currUser}
          user={user}
          closeModal={closeModal}
        />
      </ModalWrapper>
    </>
  );
}
