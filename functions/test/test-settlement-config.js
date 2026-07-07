// test/test-settlement-config.js
// Run with: node test/test-settlement-config.js

"use strict";

let failures = 0;

function checkSettlementConfig(name, bankId, accountNumber) {
  if (!name || !bankId || !accountNumber) {
    throw new Error(
      "TapDish settlement account is not fully configured. " +
      "Set TAPDISH_SETTLEMENT_ACCOUNT_NAME, TAPDISH_SETTLEMENT_BANK_ID, " +
      "and TAPDISH_SETTLEMENT_ACCOUNT_NUMBER before creating payment requests."
    );
  }
  return true;
}

function check(label, condition) {
  if (!condition) failures++;
  console.log(`${condition ? "✅" : "❌"} ${label}`);
}

console.log("── settlement account config validation test ──\n");

try {
  checkSettlementConfig("TapDish Pty Ltd", "fnb", "62123456789");
  check("Valid config passes check", true);
} catch (e) {
  check("Valid config passes check", false);
}

try {
  checkSettlementConfig("TapDish Pty Ltd", undefined, "62123456789");
  check("Missing bankId correctly caught", false);
} catch (e) {
  check("Missing bankId correctly caught", e.message.includes("not fully configured"));
}

try {
  checkSettlementConfig("TapDish Pty Ltd", "fnb", undefined);
  check("Missing accountNumber correctly caught", false);
} catch (e) {
  check("Missing accountNumber correctly caught", e.message.includes("not fully configured"));
}

try {
  checkSettlementConfig(undefined, "fnb", "62123456789");
  check("Missing name correctly caught", false);
} catch (e) {
  check("Missing name correctly caught", e.message.includes("not fully configured"));
}

try {
  checkSettlementConfig(undefined, undefined, undefined);
  check("Fully missing config correctly caught", false);
} catch (e) {
  check("Fully missing config correctly caught", e.message.includes("not fully configured"));
}

try {
  checkSettlementConfig("", "", "");
  check("Empty-string config correctly caught", false);
} catch (e) {
  check("Empty-string config correctly caught", e.message.includes("not fully configured"));
}

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

