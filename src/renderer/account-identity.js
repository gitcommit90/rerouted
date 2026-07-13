"use strict";

(function exposeAccountIdentity(root) {
  const EMAIL_PATTERN =
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi;

  function maskAccountEmail(value) {
    const email = String(value || "").trim();
    const separator = email.lastIndexOf("@");
    if (separator <= 0 || separator === email.length - 1) return email;

    const local = email.slice(0, separator);
    const domain = email.slice(separator + 1);
    const visible = local.length === 1 ? 0 : Math.min(4, local.length - 1);
    const hidden = Math.min(8, Math.max(1, local.length - visible));
    return `${local.slice(0, visible)}${"*".repeat(hidden)}@${domain}`;
  }

  function maskAccountEmails(value) {
    return String(value || "").replace(EMAIL_PATTERN, (email) => maskAccountEmail(email));
  }

  function accountDisplayName(name, email, fallback = "") {
    let displayName = String(name || fallback);
    const address = String(email || "").trim();
    const suffix = address ? ` (${address})` : "";
    if (suffix && displayName.endsWith(suffix)) {
      displayName = displayName.slice(0, -suffix.length);
    }
    return maskAccountEmails(displayName);
  }

  function accountIdentityLabel(email, profileName, fallback = "") {
    const address = String(email || "").trim();
    if (address) return maskAccountEmail(address);
    return maskAccountEmails(profileName || fallback);
  }

  const api = {
    maskAccountEmail,
    maskAccountEmails,
    accountDisplayName,
    accountIdentityLabel,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReroutedAccountIdentity = api;
})(typeof window !== "undefined" ? window : null);
