import React, { useState } from "react";
import System from "@/models/system";
import { isValidEmail } from "@/utils/email";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import { useTranslation } from "react-i18next";

/**
 * Public sign-up form (multi-user mode + "Allow public email registration" admin toggle).
 *
 * Creates an account with a *required* username + email + password — email is
 * the anti-abuse handle, so unlike the invite flow it cannot be left blank.
 * On success the user is dropped into the normal login form (they can log in
 * with their username or their email).
 */
export default function SignUpModal({ onBackToLogin }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(false);

  const handleRegister = async (e) => {
    setError(null);
    e.preventDefault();
    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) data[key] = value;

    if (!isValidEmail(data.email) || !String(data.email).trim()) {
      setError("A valid email address is required");
      return;
    }

    setLoading(true);
    const { success, error } = await System.registerUser(data);
    setLoading(false);
    if (success) {
      setCreated(true);
      return;
    }
    setError(error);
  };

  if (created) {
    return (
      <div className="flex flex-col justify-center items-center w-[300px] gap-y-4 pt-7 pb-9">
        <h3 className="text-white light:text-slate-950 text-3xl leading-[28px] font-medium text-center">
          Account created
        </h3>
        <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
          Your account is ready. Log in with your username or your email
          address.
        </p>
        <button
          type="button"
          onClick={onBackToLogin}
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
        >
          Continue to login
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleRegister}
      className="flex flex-col justify-center items-center"
    >
      <div className="flex items-start justify-between pt-7 pb-6">
        <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
          <h3 className="text-white light:text-slate-950 text-3xl leading-[28px] font-medium text-center">
            Create your account
          </h3>
          <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
            Sign up with your email to start using workspaces.
          </p>
        </div>
      </div>

      <div className="w-full px-12 flex flex-col gap-y-3">
        <div className="w-full flex flex-col gap-y-2">
          <label className="text-zinc-300 light:text-slate-800 text-sm">
            Username
          </label>
          <input
            name="username"
            type="text"
            className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
            placeholder="My username"
            minLength={USERNAME_MIN_LENGTH}
            maxLength={USERNAME_MAX_LENGTH}
            pattern={USERNAME_PATTERN}
            required={true}
            autoComplete="username"
          />
          <p className="text-zinc-500 light:text-slate-400 text-xs">
            {t("common.username_requirements")}
          </p>
        </div>
        <div className="w-full flex flex-col gap-y-2">
          <label className="text-zinc-300 light:text-slate-800 text-sm">
            Email
          </label>
          <input
            name="email"
            type="email"
            className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
            placeholder="you@example.com"
            required={true}
            autoComplete="email"
          />
          <p className="text-zinc-500 light:text-slate-400 text-xs">
            Required — you can also use your email to log in.
          </p>
        </div>
        <div className="w-full flex flex-col gap-y-2">
          <label className="text-zinc-300 light:text-slate-800 text-sm">
            Password
          </label>
          <input
            name="password"
            type="password"
            className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
            placeholder="Your password"
            required={true}
            minLength={8}
            autoComplete="new-password"
          />
        </div>
        {error && <p className="text-red-400 text-sm">Error: {error}</p>}
      </div>

      <div className="flex items-center px-12 mt-6 w-full flex-col gap-y-6">
        <button
          disabled={loading}
          type="submit"
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
        >
          {loading ? "Creating account..." : "Create account"}
        </button>
        <button
          type="button"
          className="text-zinc-200 light:text-zinc-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-sm"
          onClick={onBackToLogin}
        >
          Already have an account?{" "}
          <b className="font-semibold text-sky-300 light:text-sky-600">
            Log in
          </b>
        </button>
      </div>
    </form>
  );
}
