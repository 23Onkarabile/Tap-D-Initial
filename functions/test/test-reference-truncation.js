// test/test-reference-truncation.js
// Run with: node test/test-reference-truncation.js

"use strict";

let failures = 0;

function buildReferences(orderNumber) {
  return {
    payerReference:       String(orderNumber).slice(0, 12),
    beneficiaryReference: String(orderNumber).slice(0, 20),
  };
}

function check(label, condition) {
  if (!condition) failures++;
  console.log(`${condition ? "✅" : "❌"} ${label}`);
}

console.log("── reference truncation test ──\n");

const cases = [
  "GRB-4821",
  "TAPDISH-ORDER-99999999",
  "X",
  "EXACTLY-12-C",
  "EXACTLY-TWENTY-CHARS",
  "",
];

for (const orderNumber of cases) {
  const r = buildReferences(orderNumber);
  console.log(`orderNumber='${orderNumber}' (${orderNumber.length} chars)`);
  console.log(`  payerReference='${r.payerReference}' (${r.payerReference.length}/12)`);
  console.log(`  beneficiaryReference='${r.beneficiaryReference}' (${r.beneficiaryReference.length}/20)`);
  check(`  payerReference within limit`, r.payerReference.length <= 12);
  check(`  beneficiaryReference within limit`, r.beneficiaryReference.length <= 20);
}

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

