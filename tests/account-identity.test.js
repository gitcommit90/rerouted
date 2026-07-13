"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  maskAccountEmail,
  maskAccountEmails,
  accountDisplayName,
  accountIdentityLabel,
} = require("../src/renderer/account-identity");

describe("account identity masking", () => {
  it("masks email local parts while preserving a useful prefix and domain", () => {
    assert.equal(maskAccountEmail("fantasticfox@gmail.com"), "fant********@gmail.com");
    assert.equal(maskAccountEmail("a@example.com"), "*@example.com");
    assert.equal(maskAccountEmail("fox@example.com"), "fo*@example.com");
    assert.equal(maskAccountEmail("verylongaccountname@example.com"), "very********@example.com");
  });

  it("scrubs emails embedded in provider account names", () => {
    assert.equal(
      maskAccountEmails("Antigravity (fantasticfox@gmail.com)"),
      "Antigravity (fant********@gmail.com)"
    );
    assert.equal(
      maskAccountEmails("fantasticfox@gmail.com / backup@example.net"),
      "fant********@gmail.com / back**@example.net"
    );
  });

  it("leaves human-readable non-email account labels intact", () => {
    assert.equal(maskAccountEmail("Account 2"), "Account 2");
    assert.equal(maskAccountEmails("Claude Pro"), "Claude Pro");
  });

  it("removes redundant parenthesized emails from provider account names", () => {
    assert.equal(
      accountDisplayName(
        "Antigravity (fantasticfox@gmail.com)",
        "fantasticfox@gmail.com",
        "Antigravity"
      ),
      "Antigravity"
    );
    assert.equal(
      accountDisplayName("Team fantasticfox@gmail.com", "fantasticfox@gmail.com"),
      "Team fant********@gmail.com"
    );
    assert.equal(accountDisplayName("", "", "xAI"), "xAI");
  });

  it("prefers masked email, then profile name, then the stable account alias", () => {
    assert.equal(
      accountIdentityLabel("fantasticfox@gmail.com", "Fantastic Fox", "Account 1"),
      "fant********@gmail.com"
    );
    assert.equal(accountIdentityLabel("", "Fantastic Fox", "Account 1"), "Fantastic Fox");
    assert.equal(
      accountIdentityLabel("", "Owner fantasticfox@gmail.com", "Account 1"),
      "Owner fant********@gmail.com"
    );
    assert.equal(accountIdentityLabel("", "", "Account 1"), "Account 1");
  });
});
