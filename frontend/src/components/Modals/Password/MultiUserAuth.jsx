import React, { useEffect, useState } from "react";
import System from "../../../models/system";
import { AUTH_TOKEN, AUTH_USER } from "../../../utils/constants";
import paths from "../../../utils/paths";
import showToast from "@/utils/toast";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import RecoveryCodeModal from "@/components/Modals/DisplayRecoveryCodeModal";
import SignUpModal from "@/components/Modals/Password/SignUpModal";
import { useTranslation } from "react-i18next";
import { t } from "i18next";

/**
 * Wallet connect button with SIWE (Sign-In with Ethereum) flow.
 * Requires a wallet extension (MetaMask, Rainbow, etc.) to be installed.
 */
const WalletConnectButton = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // EIP-1193 injected provider (MetaMask, Rainbow, Brave, …). Present in
  // desktop browsers with a wallet extension and inside mobile wallet
  // in-app browsers. Plain mobile Safari/Chrome have none — for those we
  // show a deep link into MetaMask (no SDK, no relay, nothing to break).
  const hasWallet = typeof window !== "undefined" && !!window.ethereum;
  const isMobile =
    typeof navigator !== "undefined" &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // MetaMask universal deep link — opens the current URL inside MetaMask's
  // in-app browser, where window.ethereum IS injected. Works on Android
  // and iOS, no SDK required.
  const metaMaskDappUrl =
    typeof window !== "undefined"
      ? `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}`
      : "https://metamask.app.link";

  const handleConnect = async () => {
    setError(null);
    if (!hasWallet) {
      setError(
        isMobile
          ? "No wallet found in this browser. Open this site in the MetaMask app's built-in browser, or install the MetaMask extension on desktop."
          : "No wallet detected. Please install MetaMask or another wallet extension."
      );
      return;
    }
    setLoading(true);
    try {
      // Step 1: Request wallet account (prompts user to connect if needed)
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      if (!accounts || accounts.length === 0) {
        throw new Error("No wallet account available.");
      }
      const address = accounts[0];

      // Step 2: Get nonce + message from server
      const { nonce, message } = await System.walletNonce();
      if (!nonce || !message) {
        throw new Error("Could not get signing message.");
      }

      // Step 3: Sign the message with the wallet
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [message, address],
      });
      if (!signature) throw new Error("Signature was rejected.");

      // Step 4: Verify signature on server, get JWT
      const result = await System.walletVerify({ signature, nonce });
      if (result.valid && result.token && result.user) {
        window.localStorage.setItem(AUTH_USER, JSON.stringify(result.user));
        window.localStorage.setItem(AUTH_TOKEN, result.token);
        window.location = paths.home();
      } else {
        throw new Error(result.message || "Wallet login failed.");
      }
    } catch (e) {
      console.error("[wallet] login failed:", e.message);
      setError(e.message || "Wallet connection failed.");
      setLoading(false);
    }
  };

  return (
    <>
      <div className="flex items-center w-[300px] my-3">
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
          or
        </span>
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
      </div>
      <button
        type="button"
        onClick={handleConnect}
        disabled={loading}
        className="text-zinc-200 light:text-slate-700 hover:bg-zinc-800 light:hover:bg-slate-200 text-sm rounded-lg border border-zinc-600 light:border-slate-400 h-[38px] w-[300px] flex items-center justify-center gap-x-2 transition-colors"
      >
        {/* Ethereum diamond icon */}
        <svg width="18" height="18" viewBox="0 0 32 32" fill="currentColor">
          <path d="M16 2L5.5 16.746L16 23.199L26.5 16.746L16 2Z" opacity=".7" />
          <path d="M16 25.288L5.5 18.799L16 30L26.5 18.799L16 25.288Z" />
        </svg>
        {loading ? "Connecting..." : "Connect Wallet"}
      </button>
      {error && (
        <p className="text-red-400 text-xs mt-2 text-center">{error}</p>
      )}
      {isMobile && !hasWallet && (
        <a
          href={metaMaskDappUrl}
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-[300px] flex items-center justify-center gap-x-2 mt-2 transition-colors"
        >
          Open this site in MetaMask
        </a>
      )}
    </>
  );
};

const RecoveryForm = ({ onSubmit, setShowRecoveryForm }) => {
  const [username, setUsername] = useState("");
  const [recoveryCodeInputs, setRecoveryCodeInputs] = useState(
    Array(2).fill("")
  );

  const handleRecoveryCodeChange = (index, value) => {
    const updatedCodes = [...recoveryCodeInputs];
    updatedCodes[index] = value;
    setRecoveryCodeInputs(updatedCodes);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const recoveryCodes = recoveryCodeInputs.filter(
      (code) => code.trim() !== ""
    );
    onSubmit(username, recoveryCodes);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col justify-center items-center"
    >
      <div className="flex items-start justify-between pt-7 pb-9">
        <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
          <div className="flex gap-x-1">
            <h3 className="text-white light:text-slate-950 text-3xl leading-[28px] font-medium text-center white-space-nowrap block">
              {t("login.password-reset.title")}
            </h3>
          </div>
          <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
            {t("login.password-reset.description")}
          </p>
        </div>
      </div>
      <div className="w-full px-12">
        <div className="w-full flex flex-col gap-y-3">
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              {t("login.multi-user.placeholder-username")}
            </label>
            <input
              name="username"
              type="text"
              className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              {t("login.password-reset.recovery-codes")}
            </label>
            {recoveryCodeInputs.map((code, index) => (
              <input
                key={index}
                type="text"
                name={`recoveryCode${index + 1}`}
                className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
                value={code}
                onChange={(e) =>
                  handleRecoveryCodeChange(index, e.target.value)
                }
                required
                autoComplete="off"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
        <button
          type="submit"
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
        >
          {t("login.password-reset.title")}
        </button>
        <button
          type="button"
          className="text-zinc-200 light:text-zinc-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-sm flex gap-x-1"
          onClick={() => setShowRecoveryForm(false)}
        >
          {t("login.password-reset.back-to-login")}
        </button>
      </div>
    </form>
  );
};

const ResetPasswordForm = ({ onSubmit }) => {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(newPassword, confirmPassword);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col justify-center items-center"
    >
      <div className="flex items-start justify-between pt-7 pb-9">
        <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
          <div className="flex gap-x-1">
            <h3 className="text-white light:text-slate-950 text-[38px] leading-[28px] font-medium text-center white-space-nowrap block">
              Reset Password
            </h3>
          </div>
          <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
            Enter your new password.
          </p>
        </div>
      </div>
      <div className="w-full px-12">
        <div className="w-full flex flex-col gap-y-3">
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              New Password
            </label>
            <input
              type="password"
              name="newPassword"
              className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              Confirm Password
            </label>
            <input
              type="password"
              name="confirmPassword"
              className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
        </div>
      </div>
      <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
        <button
          type="submit"
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
        >
          Reset Password
        </button>
      </div>
    </form>
  );
};

export default function MultiUserAuth() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [downloadComplete, setDownloadComplete] = useState(false);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [showRecoveryForm, setShowRecoveryForm] = useState(false);
  const [showResetPasswordForm, setShowResetPasswordForm] = useState(false);
  const [showSignUp, setShowSignUp] = useState(false);
  const [canSignUp, setCanSignUp] = useState(false);
  const [customAppName, setCustomAppName] = useState(null);

  const {
    isOpen: isRecoveryCodeModalOpen,
    openModal: openRecoveryCodeModal,
    closeModal: closeRecoveryCodeModal,
  } = useModal();

  const handleLogin = async (e) => {
    setError(null);
    setLoading(true);
    e.preventDefault();
    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) data[key] = value;
    const { valid, user, token, message, recoveryCodes } =
      await System.requestToken(data);
    if (valid && !!token && !!user) {
      setUser(user);
      setToken(token);

      if (recoveryCodes) {
        setRecoveryCodes(recoveryCodes);
        openRecoveryCodeModal();
      } else {
        window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
        window.localStorage.setItem(AUTH_TOKEN, token);
        window.location = paths.home();
      }
    } else {
      setError(message);
      setLoading(false);
    }
    setLoading(false);
  };

  const handleDownloadComplete = () => setDownloadComplete(true);
  const handleResetPassword = () => setShowRecoveryForm(true);
  const handleRecoverySubmit = async (username, recoveryCodes) => {
    const { success, resetToken, error } = await System.recoverAccount(
      username,
      recoveryCodes
    );

    if (success && resetToken) {
      window.localStorage.setItem("resetToken", resetToken);
      setShowRecoveryForm(false);
      setShowResetPasswordForm(true);
    } else {
      showToast(error, "error", { clear: true });
    }
  };

  const handleResetSubmit = async (newPassword, confirmPassword) => {
    const resetToken = window.localStorage.getItem("resetToken");

    if (resetToken) {
      const { success, error } = await System.resetPassword(
        resetToken,
        newPassword,
        confirmPassword
      );

      if (success) {
        window.localStorage.removeItem("resetToken");
        setShowResetPasswordForm(false);
        showToast("Password reset successful", "success", { clear: true });
      } else {
        showToast(error, "error", { clear: true });
      }
    } else {
      showToast("Invalid reset token", "error", { clear: true });
    }
  };

  useEffect(() => {
    if (downloadComplete && user && token) {
      window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
      window.localStorage.setItem(AUTH_TOKEN, token);
      window.location = paths.home();
    }
  }, [downloadComplete, user, token]);

  useEffect(() => {
    const fetchCustomAppName = async () => {
      const { appName } = await System.fetchCustomAppName();
      setCustomAppName(appName || "");
      setLoading(false);
    };
    fetchCustomAppName();
    // Sign-up option is only offered when the admin has opened the door.
    const fetchPublicRegistration = async () => {
      const { publicRegistration } = await System.publicRegistration();
      setCanSignUp(publicRegistration);
    };
    fetchPublicRegistration();
  }, []);

  if (showRecoveryForm) {
    return (
      <RecoveryForm
        onSubmit={handleRecoverySubmit}
        setShowRecoveryForm={setShowRecoveryForm}
      />
    );
  }

  if (showResetPasswordForm)
    return <ResetPasswordForm onSubmit={handleResetSubmit} />;

  if (showSignUp)
    return (
      <SignUpModal
        onBackToLogin={() => {
          setShowSignUp(false);
          setError(null);
        }}
      />
    );

  return (
    <>
      <form
        onSubmit={handleLogin}
        className="flex flex-col justify-center items-center"
      >
        <div className="flex items-start justify-between pt-7 pb-9">
          <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
            <div className="flex gap-x-1">
              <h3 className="text-white light:text-slate-950 text-[38px] leading-[28px] font-medium text-center white-space-nowrap block">
                {t("login.multi-user.welcome")}
              </h3>
            </div>
            <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
              {t("login.sign-in", { appName: customAppName || "Totem LLM" })}
            </p>
          </div>
        </div>

        {/* Wallet login (primary) */}
        <div className="flex items-center w-[300px] flex-col gap-y-6">
          <WalletConnectButton />
        </div>

        {/* Official install — password login */}
        <div className="flex items-center w-[300px] mt-3">
          <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
          <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
            Totem Official Installs
          </span>
          <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        </div>

        <div className="w-full px-12 mt-3">
          <div className="w-full flex flex-col gap-y-3">
            <div className="w-full flex flex-col gap-y-2">
              <label className="text-zinc-300 light:text-slate-800 text-sm">
                {t("login.multi-user.placeholder-username")}
              </label>
              <input
                name="username"
                type="text"
                className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
                placeholder="Username or email"
                required={true}
                autoComplete="username"
              />
              <p className="text-zinc-500 light:text-slate-400 text-xs">
                You can log in with your username or your account email.
              </p>
            </div>
            <div className="w-full px-0 flex flex-col gap-y-2">
              <label className="text-zinc-300 light:text-slate-800 text-sm">
                {t("login.multi-user.placeholder-password")}
              </label>
              <input
                name="password"
                type="password"
                className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
                required={true}
                autoComplete="off"
              />
            </div>
            {error && <p className="text-red-400 text-sm">Error: {error}</p>}
          </div>
        </div>

        <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
          <button
            disabled={loading}
            type="submit"
            className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
          >
            {loading
              ? t("login.multi-user.validating")
              : t("login.multi-user.login")}
          </button>
          <button
            type="button"
            className="text-zinc-200 light:text-zinc-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-sm flex gap-x-1"
            onClick={handleResetPassword}
          >
            {t("login.multi-user.forgot-pass")}?
            <b className="font-semibold text-sky-300 light:text-sky-600">
              {t("login.multi-user.reset")}
            </b>
          </button>
          {canSignUp && (
            <button
              type="button"
              className="text-zinc-200 light:text-zinc-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-sm"
              onClick={() => {
                setError(null);
                setShowSignUp(true);
              }}
            >
              No account?{" "}
              <b className="font-semibold text-sky-300 light:text-sky-600">
                Sign up
              </b>
            </button>
          )}
        </div>
      </form>

      <ModalWrapper isOpen={isRecoveryCodeModalOpen} noPortal={true}>
        <RecoveryCodeModal
          recoveryCodes={recoveryCodes}
          onDownloadComplete={handleDownloadComplete}
          onClose={closeRecoveryCodeModal}
        />
      </ModalWrapper>
    </>
  );
}
