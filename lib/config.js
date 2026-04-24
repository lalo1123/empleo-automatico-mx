// Central configuration for extension-side runtime.
// This file is the single source of truth for the backend API base URL.
//
// To switch to dev, flip USE_DEV to true (or install a dev build of the
// extension). The extension never needs a build step — this is just a
// hard-coded flag, no env vars.

const USE_DEV = false;

export const API_BASE_URL = USE_DEV
  ? "http://localhost:8787/v1"
  : "https://api.empleo.skybrandmx.com/v1";

// Marketing / landing URLs surfaced in UI copy.
export const MARKETING_BASE_URL = "https://empleo.skybrandmx.com";
export const BILLING_URL = `${MARKETING_BASE_URL}/account/billing`;
export const SIGNUP_URL = `${MARKETING_BASE_URL}/signup`;
