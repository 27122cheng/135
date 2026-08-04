"use client";

import { USER_SETTABLE_KEYS, type UserSettableKey } from "./api-key-names";

/**
 * Client-side storage for API keys the user pastes into /settings.
 *
 * Kept in localStorage and sent with each signal request, so the app works
 * without touching Vercel environment variables or redeploying. The tradeoff
 * is stated in the UI: localStorage is readable by any script running on the
 * page, so for a shared deployment the environment-variable route is the
 * safer one. Keys are never sent anywhere except this app's own API.
 */

const STORAGE_KEY = "user-api-keys-v1";

export type UserKeys = Partial<Record<UserSettableKey, string>>;

export function loadUserKeys(): UserKeys {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: UserKeys = {};
    for (const name of USER_SETTABLE_KEYS) {
      const v = parsed[name];
      if (typeof v === "string" && v.trim()) out[name] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function saveUserKeys(keys: UserKeys): void {
  if (typeof window === "undefined") return;
  const cleaned: UserKeys = {};
  for (const name of USER_SETTABLE_KEYS) {
    const v = keys[name];
    if (v && v.trim()) cleaned[name] = v.trim();
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}

/** Header for signal requests; empty object when nothing is configured. */
export function userKeyHeaders(): Record<string, string> {
  const keys = loadUserKeys();
  return Object.keys(keys).length > 0 ? { "x-user-keys": JSON.stringify(keys) } : {};
}
